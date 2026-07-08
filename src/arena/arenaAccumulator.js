/**
 * Arena Accumulator
 *
 * The shared accumulate-and-report loop behind an arena ranking run: per-bot stat
 * accumulation, ELO updates, final stat build, and the {@link reportBotErrors}
 * broken-bot flag pass. Both the headless {@link module:arena/arenaRunner} and the
 * in-browser `ArenaScreen` run their own match loops (one drives games synchronously,
 * the other one-per-macrotask so Preact can paint), but the per-match bookkeeping is
 * identical — so it lives here as one tested unit rather than copy-pasted into each.
 * A drift between the two forks is exactly how a broken bot could show a meaningless
 * rating in the UI with no test catching it (#53, #92 item 3).
 *
 * @module arena/arenaAccumulator
 */

import { updateEloRatings, DEFAULT_RATING } from './elo.js';
import { reportBotErrors } from './botErrorReport.js';

/**
 * @typedef {Object} ArenaAccumulator
 * @property {Object<string, number>} ratings - Live ELO ratings keyed by bot name
 * @property {Object<string, Object>} accum   - Per-bot running totals keyed by bot name
 */

/**
 * Create a fresh accumulator for a set of bots.
 *
 * @param {Array<{name: string}>} bots - Bot configs (only `name` is read)
 * @param {Object<string, number>} [initialRatings] - Starting ELO by bot name;
 *   bots absent from it start at {@link DEFAULT_RATING}.
 * @returns {ArenaAccumulator}
 */
export function createArenaAccumulator(bots, initialRatings) {
  const ratings = {};
  const accum = {};
  for (const bot of bots) {
    ratings[bot.name] = initialRatings?.[bot.name] ?? DEFAULT_RATING;
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
  return { ratings, accum };
}

/**
 * Fold one completed match's per-bot stats into the accumulator and update ELO
 * from the match placements. Mutates `acc` in place.
 *
 * @param {ArenaAccumulator} acc
 * @param {import('./matchRunner.js').MatchResult} matchResult
 */
export function accumulateMatch(acc, matchResult) {
  const { accum, ratings } = acc;

  for (const stat of matchResult.botStats) {
    const a = accum[stat.name];
    a.gamesPlayed++;
    a.totalPlacement += stat.placement;
    a.totalTerritories += stat.finalTerritories;
    a.totalAttacks += stat.attacksMade;
    a.totalAttackWins += stat.attacksWon;
    a.errors += stat.errors;
    a.invalidMoves += stat.invalidMoves;
    a.maxMovesHit += stat.maxMovesHit;
    if (matchResult.winner === stat.playerIndex) {
      a.wins++;
    }
  }

  const eloPlayers = matchResult.placements.map(playerIdx => {
    const botStat = matchResult.botStats.find(s => s.playerIndex === playerIdx);
    return { name: botStat.name, elo: ratings[botStat.name] };
  });
  const updatedRatings = updateEloRatings(eloPlayers);
  for (const r of updatedRatings) {
    ratings[r.name] = r.elo;
  }
}

/**
 * Build the final per-bot stats, run the broken-bot flag pass, and sort by ELO.
 *
 * Turns a silent failure into a loud one: a bot that errors on most of its turns is
 * broken, not losing, and its win%/ELO is meaningless — {@link reportBotErrors} warns
 * about it and the returned `flagged[]` lets callers route that signal onward (durable
 * leaderboards, UI badges) instead of letting it die at `console.warn` (#53, #92).
 *
 * @param {ArenaAccumulator} acc
 * @param {Array<{name: string}>} bots - Bot configs (only `name` is read); defines
 *   both the output rows and their initial (pre-sort) order.
 * @param {Object} [options]
 * @param {string} [options.label='[Arena]'] - Log prefix for the flag warnings
 * @param {(message: string) => void} [options.warn] - Warn sink (injectable for tests)
 * @returns {{ bots: import('./arenaRunner.js').ArenaBotStat[], flagged: import('./botErrorReport.js').FlaggedBot[] }}
 */
export function finalizeArenaStats(acc, bots, options = {}) {
  const { accum, ratings } = acc;
  const { label = '[Arena]', warn } = options;

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

  const flagged = reportBotErrors(
    bots.map(bot => ({
      name: bot.name,
      errors: accum[bot.name].errors,
      attacks: accum[bot.name].totalAttacks,
      invalidMoves: accum[bot.name].invalidMoves,
      maxMovesHit: accum[bot.name].maxMovesHit,
    })),
    { label, ...(warn ? { warn } : {}) }
  );

  botStats.sort((a, b) => b.elo - a.elo);

  return { bots: botStats, flagged };
}
