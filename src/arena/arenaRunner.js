/**
 * Arena Runner
 *
 * Runs multiple matches between bots and aggregates statistics.
 * Supports progress callbacks and chunked execution to avoid blocking the UI.
 *
 * @module arena/arenaRunner
 */

import { runMatch } from './matchRunner.js';
import { updateEloRatings, DEFAULT_RATING } from './elo.js';

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
 */

/**
 * @typedef {Object} ArenaResult
 * @property {ArenaBotStat[]}                   bots       - Aggregated bot stats
 * @property {number}                           totalGames - Total games run
 * @property {number}                           avgTurns   - Average turns per game
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
 * @returns {ArenaResult}
 */
export function runArena(config) {
  const { bots, gameCount = 100, baseSeed = 1, maxTurns = 500, onGameComplete } = config;

  const matches = [];

  // Initialize ELO ratings
  const ratings = {};
  for (const bot of bots) {
    ratings[bot.name] = DEFAULT_RATING;
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
    };
  }

  let totalTurns = 0;

  let failedGames = 0;

  for (let i = 0; i < gameCount; i++) {
    let result;
    try {
      result = runMatch({
        bots,
        seed: baseSeed + i,
        maxTurns,
      });
    } catch (err) {
      console.error(`[Arena] Match ${i} failed (seed ${baseSeed + i}):`, err.message);
      failedGames++;
      if (onGameComplete) onGameComplete(i, null);
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
    };
  });

  // Sort by ELO descending
  botStats.sort((a, b) => b.elo - a.elo);

  return {
    bots: botStats,
    totalGames: matches.length,
    avgTurns: matches.length > 0 ? +(totalTurns / matches.length).toFixed(1) : 0,
    matches,
  };
}
