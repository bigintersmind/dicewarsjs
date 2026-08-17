/**
 * Tournament System
 *
 * Round-robin and single-elimination tournament formats.
 * Orchestrates multiple arena matches and aggregates standings.
 *
 * @module arena/tournament
 */

import { runMatch, assertNoHandicap } from './matchRunner.js';
import { updateEloRatings, DEFAULT_RATING } from './elo.js';
import { reportBotErrors } from './botErrorReport.js';

/**
 * @typedef {Object} TournamentBotConfig
 * @property {string}   name - Bot display name
 * @property {Function} fn   - Bot function
 */

/**
 * @typedef {Object} TournamentStanding
 * @property {string} name        - Bot name
 * @property {number} wins        - Total match wins
 * @property {number} losses      - Total match losses
 * @property {number} gamesPlayed - Total games
 * @property {number} elo         - ELO rating
 * @property {number} points      - Tournament points (3 per win, 1 per stalemate)
 * @property {number} errors      - Total turns that ended in an error (forced-end signal —
 *   a non-zero count means this bot's standing may not be a meaningful measurement; see #53)
 * @property {number} invalidMoves - Total invalid moves attempted across the tournament
 * @property {number} maxMovesHit  - Total turns force-ended by the per-turn move cap
 */

/**
 * @typedef {Object} TournamentMatch
 * @property {string[]} botNames     - Names of participating bots
 * @property {number[]} playerIndices - Indices into the bots array
 * @property {import('./matchRunner.js').MatchResult} result
 */

/**
 * @typedef {Object} TournamentResult
 * @property {'round-robin'|'single-elimination'} type
 * @property {TournamentStanding[]} standings - Ordered by points/ELO
 * @property {import('./botErrorReport.js').FlaggedBot[]} flagged - Bots whose turn-level
 *   error fraction exceeded the threshold — their standing is not a meaningful measurement.
 *   Empty in a clean run; the UI renders it as a per-row badge so a broken bot can't
 *   masquerade as a real result past `console.warn` (#53, #92).
 * @property {TournamentMatch[][]}  rounds    - Matches grouped by round
 * @property {number}               totalGames
 * @property {number}               failedGames - Games that threw errors
 * @property {string|null}          champion  - Winner name
 */

/**
 * Run a round-robin tournament.
 * Every combination of playersPerGame bots plays gamesPerPairing games.
 *
 * @param {Object} config
 * @param {TournamentBotConfig[]} config.bots
 * @param {number} [config.gamesPerPairing=3]  - Games per matchup
 * @param {number} [config.playersPerGame]      - Players per game (default: all bots)
 * @param {number} [config.baseSeed=1]
 * @param {number} [config.maxTurns=500]
 * @param {Function} [config.onMatchComplete] - (roundIndex, matchIndex, result)
 * @returns {TournamentResult}
 * @throws {Error} If `config.handicap` is set — tournament standings are always unhandicapped.
 */
export function runRoundRobin(config) {
  const {
    bots,
    gamesPerPairing = 3,
    playersPerGame = bots.length,
    baseSeed = 1,
    maxTurns = 500,
    onMatchComplete,
  } = config;

  assertNoHandicap(config, 'runRoundRobin');

  const botNames = new Set(bots.map(b => b.name));
  if (botNames.size !== bots.length) {
    throw new Error('Bot names must be unique');
  }

  const ratings = {};
  const stats = {};
  for (const bot of bots) {
    ratings[bot.name] = DEFAULT_RATING;
    stats[bot.name] = {
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      points: 0,
      attacks: 0,
      turns: 0,
      errors: 0,
      invalidMoves: 0,
      maxMovesHit: 0,
    };
  }

  const pairings = generatePairings(bots, playersPerGame);
  const rounds = [];
  let seedCounter = baseSeed;
  let totalGames = 0;
  let failedGames = 0;

  for (let roundIdx = 0; roundIdx < pairings.length; roundIdx++) {
    const pairing = pairings[roundIdx];
    const roundMatches = [];

    for (let gameIdx = 0; gameIdx < gamesPerPairing; gameIdx++) {
      const matchBots = pairing.map(idx => ({
        name: bots[idx].name,
        fn: bots[idx].fn,
      }));

      let result;
      try {
        result = runMatch({
          bots: matchBots,
          seed: seedCounter++,
          maxTurns,
        });
      } catch (err) {
        console.error(
          `[Tournament] Round-robin match failed (seed ${seedCounter - 1}):`,
          err.message
        );
        failedGames++;
        continue;
      }

      totalGames++;

      updateMatchStats(stats, ratings, result);

      roundMatches.push({
        botNames: matchBots.map(b => b.name),
        playerIndices: pairing,
        result,
      });

      if (onMatchComplete) {
        onMatchComplete(roundIdx, gameIdx, result);
      }
    }

    rounds.push(roundMatches);
  }

  const standings = bots
    .map(bot => ({
      name: bot.name,
      wins: stats[bot.name].wins,
      losses: stats[bot.name].losses,
      gamesPlayed: stats[bot.name].gamesPlayed,
      elo: ratings[bot.name],
      points: stats[bot.name].points,
      errors: stats[bot.name].errors,
      invalidMoves: stats[bot.name].invalidMoves,
      maxMovesHit: stats[bot.name].maxMovesHit,
    }))
    .sort((a, b) => b.points - a.points || b.elo - a.elo);

  /*
   * Surface broken bots loudly: a bot that errors on most of its turns isn't losing the
   * tournament, it's failing to play — its standing is not a meaningful measurement. Return
   * the flagged list too so the Tournament screen can badge those rows. (#53, #92)
   */
  const flagged = reportBotErrors(
    bots.map(bot => ({
      name: bot.name,
      errors: stats[bot.name].errors,
      turns: stats[bot.name].turns,
      attacks: stats[bot.name].attacks,
      invalidMoves: stats[bot.name].invalidMoves,
      maxMovesHit: stats[bot.name].maxMovesHit,
    })),
    { label: '[Tournament]' }
  );

  return {
    type: 'round-robin',
    standings,
    flagged,
    rounds,
    totalGames,
    failedGames,
    champion: standings.length > 0 ? standings[0].name : null,
  };
}

/**
 * Run a single-elimination tournament.
 * Bots are paired in brackets; the winner of each series advances.
 *
 * @param {Object} config
 * @param {TournamentBotConfig[]} config.bots
 * @param {number} [config.gamesPerRound=3]  - Games per matchup (best-of)
 * @param {number} [config.baseSeed=1]
 * @param {number} [config.maxTurns=500]
 * @param {Function} [config.onMatchComplete]
 * @returns {TournamentResult}
 * @throws {Error} If `config.handicap` is set — tournament standings are always unhandicapped.
 */
export function runSingleElimination(config) {
  const { bots, gamesPerRound = 3, baseSeed = 1, maxTurns = 500, onMatchComplete } = config;

  assertNoHandicap(config, 'runSingleElimination');

  const botNames = new Set(bots.map(b => b.name));
  if (botNames.size !== bots.length) {
    throw new Error('Bot names must be unique');
  }

  const ratings = {};
  const stats = {};
  for (const bot of bots) {
    ratings[bot.name] = DEFAULT_RATING;
    stats[bot.name] = {
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      points: 0,
      attacks: 0,
      turns: 0,
      errors: 0,
      invalidMoves: 0,
      maxMovesHit: 0,
    };
  }

  // Pad to power of 2 if needed
  let bracket = [...bots];
  while (bracket.length > 1 && (bracket.length & (bracket.length - 1)) !== 0) {
    bracket.push(null); // bye
  }

  const rounds = [];
  let seedCounter = baseSeed;
  let totalGames = 0;
  let failedGames = 0;

  while (bracket.length > 1) {
    const roundMatches = [];
    const nextBracket = [];

    for (let i = 0; i < bracket.length; i += 2) {
      const botA = bracket[i];
      const botB = bracket[i + 1];

      // Handle byes
      if (!botB) {
        nextBracket.push(botA);
        continue;
      }
      if (!botA) {
        nextBracket.push(botB);
        continue;
      }

      // Play best-of series
      let winsA = 0;
      let winsB = 0;

      for (let g = 0; g < gamesPerRound; g++) {
        const matchBots = [
          { name: botA.name, fn: botA.fn },
          { name: botB.name, fn: botB.fn },
        ];

        let result;
        try {
          result = runMatch({
            bots: matchBots,
            seed: seedCounter++,
            maxTurns,
          });
        } catch (err) {
          console.error(
            `[Tournament] Elimination match failed (seed ${seedCounter - 1}):`,
            err.message
          );
          failedGames++;
          continue;
        }

        totalGames++;

        updateMatchStats(stats, ratings, result);

        if (result.winner === 0) winsA++;
        else if (result.winner === 1) winsB++;

        roundMatches.push({
          botNames: [botA.name, botB.name],
          playerIndices: [bots.indexOf(botA), bots.indexOf(botB)],
          result,
        });

        if (onMatchComplete) {
          onMatchComplete(rounds.length, g, result);
        }
      }

      // Advance the series winner; on tie, use ELO as tiebreaker
      if (winsA > winsB) {
        nextBracket.push(botA);
      } else if (winsB > winsA) {
        nextBracket.push(botB);
      } else {
        nextBracket.push(ratings[botA.name] >= ratings[botB.name] ? botA : botB);
      }
    }

    rounds.push(roundMatches);
    bracket = nextBracket;
  }

  const standings = bots
    .map(bot => ({
      name: bot.name,
      wins: stats[bot.name].wins,
      losses: stats[bot.name].losses,
      gamesPlayed: stats[bot.name].gamesPlayed,
      elo: ratings[bot.name],
      points: stats[bot.name].points,
      errors: stats[bot.name].errors,
      invalidMoves: stats[bot.name].invalidMoves,
      maxMovesHit: stats[bot.name].maxMovesHit,
    }))
    .sort((a, b) => b.points - a.points || b.elo - a.elo);

  /*
   * Surface broken bots loudly: a bot that errors on most of its turns isn't losing the
   * tournament, it's failing to play — its standing is not a meaningful measurement. Return
   * the flagged list too so the Tournament screen can badge those rows. (#53, #92)
   */
  const flagged = reportBotErrors(
    bots.map(bot => ({
      name: bot.name,
      errors: stats[bot.name].errors,
      turns: stats[bot.name].turns,
      attacks: stats[bot.name].attacks,
      invalidMoves: stats[bot.name].invalidMoves,
      maxMovesHit: stats[bot.name].maxMovesHit,
    })),
    { label: '[Tournament]' }
  );

  const champion = bracket.length === 1 && bracket[0] ? bracket[0].name : null;

  return {
    type: 'single-elimination',
    standings,
    flagged,
    rounds,
    totalGames,
    failedGames,
    champion,
  };
}

/**
 * Update stats and ELO ratings from a single match result.
 * Handles stalemates (winner === null) as draws.
 *
 * @param {Object} stats - Mutable stats accumulator keyed by bot name
 * @param {Object} ratings - Mutable ELO ratings keyed by bot name
 * @param {import('./matchRunner.js').MatchResult} result
 */
function updateMatchStats(stats, ratings, result) {
  const isStalemate = result.winner === null;

  for (const botStat of result.botStats) {
    const s = stats[botStat.name];
    s.gamesPlayed++;
    s.attacks += botStat.attacksMade;
    s.turns += botStat.turns;
    s.errors += botStat.errors;
    s.invalidMoves += botStat.invalidMoves;
    s.maxMovesHit += botStat.maxMovesHit;
    if (isStalemate) {
      s.points += 1;
    } else if (result.winner === botStat.playerIndex) {
      s.wins++;
      s.points += 3;
    } else {
      s.losses++;
    }
  }

  const eloPlayers = result.placements.map(playerIdx => {
    const botStat = result.botStats.find(bs => bs.playerIndex === playerIdx);
    return { name: botStat.name, elo: ratings[botStat.name] };
  });
  const updated = updateEloRatings(eloPlayers);
  for (const r of updated) {
    ratings[r.name] = r.elo;
  }
}

/**
 * Generate all unique pairings of `size` bots from the pool.
 * For 2-player pairings from [A, B, C, D]: AB, AC, AD, BC, BD, CD.
 *
 * @param {TournamentBotConfig[]} bots
 * @param {number} size - Players per game
 * @returns {number[][]} Array of bot-index arrays
 */
function generatePairings(bots, size) {
  if (size >= bots.length) {
    // All bots in one game
    return [bots.map((_, i) => i)];
  }

  const result = [];
  const indices = Array.from({ length: bots.length }, (_, i) => i);

  function combine(start, combo) {
    if (combo.length === size) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < indices.length; i++) {
      combo.push(indices[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  }

  combine(0, []);
  return result;
}
