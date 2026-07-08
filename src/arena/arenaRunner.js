/**
 * Arena Runner
 *
 * Runs multiple matches between bots and aggregates statistics.
 * Supports a progress callback after each game completes.
 *
 * @module arena/arenaRunner
 */

import { runMatch } from './matchRunner.js';
import { createArenaAccumulator, accumulateMatch, finalizeArenaStats } from './arenaAccumulator.js';

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
 * @property {import('./botErrorReport.js').FlaggedBot[]} flagged - Bots whose turn-level
 *   error fraction exceeded the threshold — their win%/ELO is not a meaningful measurement.
 *   Empty in a clean run. Callers route this to durable leaderboards / UI badges so a broken
 *   bot can't masquerade as a real result past `console.warn` (#53, #92).
 * @property {number}                           totalGames   - Total games completed
 * @property {number}                           failedGames  - Games that threw errors
 * @property {boolean}                          aborted      - True if the run bailed after
 *   the match failure rate exceeded 50%
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

  // ELO ratings + per-bot stat accumulators (shared with ArenaScreen's loop).
  const acc = createArenaAccumulator(bots, initialRatings);

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

    accumulateMatch(acc, result);

    if (onGameComplete) onGameComplete(i, result);
  }

  /*
   * Build final stats + flag broken bots. finalizeArenaStats warns loudly about any bot
   * that errored on most of its turns (broken, not losing — its win%/ELO is meaningless)
   * so every runArena consumer (benchmark-bot, bc-stopbias-sweep, the CLI sweeps) surfaces
   * it, and returns the `flagged[]` so the daily tournament / UI can route it onward. (#53)
   */
  const { bots: botStats, flagged } = finalizeArenaStats(acc, bots, { label: '[Arena]' });

  return {
    bots: botStats,
    flagged,
    totalGames: matches.length,
    failedGames,
    aborted,
    avgTurns: matches.length > 0 ? +(totalTurns / matches.length).toFixed(1) : 0,
    matches,
  };
}
