#!/usr/bin/env node

/**
 * CLI Arena Runner
 *
 * Runs bot matches headlessly and prints an ELO ranking table.
 *
 * Usage:
 *   npm run arena                          # 100 games with all player-visible bots
 *   npm run arena -- --games 50            # 50 games
 *   npm run arena -- --bots Default,Adaptive  # specific built-in bots only
 *   npm run arena -- --bots PPO,BC,Conqueror  # hidden dev nets are still requestable by name
 */

import { runArena } from '../src/arena/arenaRunner.js';
import { BUILT_IN_BOTS, PLAYER_VISIBLE_BOTS } from '../src/arena/builtInBots.js';
import { getArg } from './lib/cli-utils.mjs';

// --- Parse CLI args ---

const args = process.argv.slice(2);

const gameCount = parseInt(getArg(args, 'games', '100'), 10);
if (!Number.isFinite(gameCount) || gameCount < 1) {
  console.error('Invalid --games value. Must be a positive integer.');
  process.exit(1);
}
const botFilter = getArg(args, 'bots', null);

// --- Select bots ---

let bots;
if (botFilter) {
  const names = botFilter.split(',').map(s => s.trim());
  bots = BUILT_IN_BOTS.filter(b => names.includes(b.name));

  const found = bots.map(b => b.name);
  const missing = names.filter(n => !found.includes(n));
  if (missing.length > 0) {
    console.error(`Unknown bot(s): ${missing.join(', ')}`);
    console.error(`Available: ${BUILT_IN_BOTS.map(b => b.name).join(', ')}`);
    process.exit(1);
  }
} else {
  /*
   * Default field = the player-visible roster. Excludes the hidden dev-harness
   * nets (BC/PPO) — players never face them. Request them by name if needed.
   */
  bots = [...PLAYER_VISIBLE_BOTS];
}

if (bots.length < 2) {
  console.error('Need at least 2 bots to run an arena.');
  process.exit(1);
}

// --- Run arena ---

console.log(
  `Running ${gameCount} games with ${bots.length} bots: ${bots.map(b => b.name).join(', ')}`
);
console.log();

const startTime = Date.now();

let result;
try {
  result = runArena({
    bots: bots.map(b => ({ name: b.name, fn: b.fn })),
    gameCount,
    baseSeed: 1,
    onGameComplete: i => {
      if ((i + 1) % 10 === 0 || i + 1 === gameCount) {
        process.stdout.write(`\rGames: ${i + 1}/${gameCount}`);
      }
    },
  });
} catch (err) {
  console.error(`\nArena failed: ${err.message}`);
  process.exit(1);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s (avg ${result.avgTurns} turns/game)\n`);

if (result.failedGames > 0) {
  console.log(`Warning: ${result.failedGames} game(s) failed\n`);
}

// --- Print results table ---

const header = ['Rank', 'Bot', 'ELO', 'Wins', 'Win%', 'Avg Place', 'Atk Win%'];
const rows = result.bots.map((bot, i) => [
  String(i + 1),
  bot.name,
  String(bot.elo),
  String(bot.wins),
  bot.gamesPlayed > 0 ? `${((bot.wins / bot.gamesPlayed) * 100).toFixed(1)}%` : '0%',
  String(bot.avgPlacement),
  `${(bot.attackWinRate * 100).toFixed(1)}%`,
]);

// Calculate column widths
const allRows = [header, ...rows];
const widths = header.map((_, col) => Math.max(...allRows.map(row => row[col].length)));

function formatRow(row) {
  return row.map((cell, i) => cell.padStart(widths[i])).join('  ');
}

console.log(formatRow(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
rows.forEach(row => console.log(formatRow(row)));
