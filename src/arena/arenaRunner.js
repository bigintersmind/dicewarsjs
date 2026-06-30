/**
 * Arena Runner
 *
 * Runs multiple matches between bots and aggregates statistics.
 * Supports a progress callback after each game completes.
 *
 * @module arena/arenaRunner
 */

import { runMatch } from './matchRunner.js';
import { updateEloRatings, DEFAULT_RATING } from './elo.js';
import { reportBotErrors } from './botErrorReport.js';

/**
 * @typedef {Object} ArenaBotStat
 * @property {string} name            - Bot name
 * @property {number} wins            - Total wins
 * @property {number} gamesPlayed     - Total games played
 * @property {number} avgPlacement    - Average placement (1-based)
 * @property {number} avgTerritories  - Average final territories
 * @property {number} avgAttacks      - Average attacks per game
 * @property {number} attackWinRate   - Attack success rate (0–1)
 * @property {number} elo             - Current ELO rating
 * @property {number} errors          - Total turns that ended in an error (forced-end signal —
 *   a non-zero count means this bot's win%/ELO may not be a meaningful measurement; see #53)
 * @property {number} invalidMoves    - Total invalid moves attempted across the run
 * @property {number} maxMovesHit     - Total turns force-ended by the per-turn move cap
 */

/**
 * @typedef {Object} ArenaResult
 * @property {ArenaBotStat[]}                   bots       - Aggregated bot stats
 * @property {number}                           totalGames   - Total games completed
 * @property {number}                           failedGames  - Games that threw errors
 * @property {number}                           avgTurns     - Average turns per game
 * @property {import('./matchRunner.js').MatchResult[]} matches - Individual match results
 */

/**
 * Run an arena: multiple matches between bots with stats aggregation.
 *
 * @param {Object} config
 * @param {Array<{name: string, fn: Function}>} config.bots - Bot configurations
 * @param {number} [config.gameCount=100]    - Number of games to run
 * @param {number} [config.baseSeed=1]       - Base seed (each game uses baseSeed + gameIndex)
 * @param {number} [config.maxTurns=500]     - Max turns per game
 * @param {Function} [config.onGameComplete] - Callback: (gameIndex, matchResult) after each game
 * @param {Object<string, number>} [config.initialRatings] - Starting ELO ratings by bot name
 * @param {boolean} [config.recordHistory] - Forwarded to each match; pass `false` for
 *   training-mode self-play (skips per-move history). Omit for default (history on).
 * @param {boolean} [config.recordTrajectory] - Forwarded to each match; when true, each
 *   MatchResult carries a `trajectory` record. NOTE: runArena retains every MatchResult in
 *   `matches[]`, so this holds all trajectories in memory — fine for small sweeps, but the
 *   at-scale self-play harness (scripts/selfplay.mjs, task 5) calls runMatch directly and
 *   streams trajectories to JSONL rather than going through runArena.
 * @param {(step: import('./trajectoryExport.js').TrajectoryStep) => void} [config.onStep] -
 *   Forwarded per-decision callback (custom streaming sink).
 * @returns {ArenaResult}
 */
export function runArena(config) {
  const {
    bots,
    gameCount = 100,
    baseSeed = 1,
    maxTurns = 500,
    onGameComplete,
    initialRatings,
    recordHistory,
    recordTrajectory,
    onStep,
  } = config;

  const names = new Set(bots.map(b => b.name));
  if (names.size !== bots.length) {
    throw new Error('Bot names must be unique');
  }

  const matches = [];

  // Initialize ELO ratings (use provided initial ratings if available)
  const ratings = {};
  for (const bot of bots) {
    ratings[bot.name] = initialRatings?.[bot.name] ?? DEFAULT_RATING;
  }

  // Per-bot accumulators
  const accum = {};
  for (const bot of bots) {
    accum[bot.name] = {
      wins: 0,
      gamesPlayed: 0,
      totalPlacement: 0,
      totalTerritories: 0,
      totalAttacks: 0,
      totalAttackWins: 0,
      errors: 0,
      invalidMoves: 0,
      maxMovesHit: 0,
    };
  }

  let totalTurns = 0;

  let failedGames = 0;
  let aborted = false;

  for (let i = 0; i < gameCount; i++) {
    let result;
    try {
      result = runMatch({
        bots,
        seed: baseSeed + i,
        maxTurns,
        recordHistory,
        recordTrajectory,
        onStep,
      });
    } catch (err) {
      console.error(`[Arena] Match ${i} failed (seed ${baseSeed + i}):`, err.message);
      failedGames++;
      if (onGameComplete) onGameComplete(i, null);

      // Abort if failure rate exceeds 50% after at least 5 attempts
      const gamesAttempted = i + 1;
      if (gamesAttempted >= 5 && failedGames / gamesAttempted > 0.5) {
        console.warn(
          `[Arena] Aborting: ${failedGames}/${gamesAttempted} games failed (>50% failure rate)`
        );
        aborted = true;
        break;
      }
      continue;
    }

    matches.push(result);
    totalTurns += result.turnCount;

    for (const stat of result.botStats) {
      const a = accum[stat.name];
      a.gamesPlayed++;
      a.totalPlacement += stat.placement;
      a.totalTerritories += stat.finalTerritories;
      a.totalAttacks += stat.attacksMade;
      a.totalAttackWins += stat.attacksWon;
      a.errors += stat.errors;
      a.invalidMoves += stat.invalidMoves;
      a.maxMovesHit += stat.maxMovesHit;
      if (result.winner === stat.playerIndex) {
        a.wins++;
      }
    }

    const eloPlayers = result.placements.map(playerIdx => {
      const botStat = result.botStats.find(s => s.playerIndex === playerIdx);
      return { name: botStat.name, elo: ratings[botStat.name] };
    });

    const updatedRatings = updateEloRatings(eloPlayers);
    for (const r of updatedRatings) {
      ratings[r.name] = r.elo;
    }

    if (onGameComplete) onGameComplete(i, result);
  }

  // Build final stats
  const botStats = bots.map(bot => {
    const a = accum[bot.name];
    return {
      name: bot.name,
      wins: a.wins,
      gamesPlayed: a.gamesPlayed,
      avgPlacement: a.gamesPlayed > 0 ? +(a.totalPlacement / a.gamesPlayed).toFixed(2) : 0,
      avgTerritories: a.gamesPlayed > 0 ? +(a.totalTerritories / a.gamesPlayed).toFixed(1) : 0,
      avgAttacks: a.gamesPlayed > 0 ? +(a.totalAttacks / a.gamesPlayed).toFixed(1) : 0,
      attackWinRate: a.totalAttacks > 0 ? +(a.totalAttackWins / a.totalAttacks).toFixed(3) : 0,
      elo: ratings[bot.name],
      errors: a.errors,
      invalidMoves: a.invalidMoves,
      maxMovesHit: a.maxMovesHit,
    };
  });

  /*
   * Turn a silent failure into a loud one: a bot that errors on most of its turns is
   * broken, not losing, and its win%/ELO is meaningless. Warn before returning so every
   * runArena consumer (benchmark-bot, bc-stopbias-sweep, the CLI sweeps) surfaces it. (#53)
   */
  reportBotErrors(
    bots.map(bot => ({
      name: bot.name,
      errors: accum[bot.name].errors,
      attacks: accum[bot.name].totalAttacks,
      invalidMoves: accum[bot.name].invalidMoves,
      maxMovesHit: accum[bot.name].maxMovesHit,
    })),
    { label: '[Arena]' }
  );

  // Sort by ELO descending
  botStats.sort((a, b) => b.elo - a.elo);

  return {
    bots: botStats,
    totalGames: matches.length,
    failedGames,
    aborted,
    avgTurns: matches.length > 0 ? +(totalTurns / matches.length).toFixed(1) : 0,
    matches,
  };
}
