#!/usr/bin/env node

/**
 * Bot Benchmark Tool
 *
 * Measures bot performance: timing, win rate, ELO, and placement.
 *
 * Usage:
 *   npm run benchmark-bot -- bots/my-bot.js             # 50 games
 *   npm run benchmark-bot -- bots/my-bot.js --games 200  # 200 games
 *   npm run benchmark-bot -- Adaptive                     # benchmark built-in bot
 */

import { getArg, getPositionalArg, resolveBot, colors } from './lib/cli-utils.mjs';
import { runArena } from '../src/arena/arenaRunner.js';
import { BUILT_IN_BOTS, PLAYER_VISIBLE_BOTS } from '../src/arena/builtInBots.js';

const args = process.argv.slice(2);
const identifier = getPositionalArg(args);
const gameCount = parseInt(getArg(args, 'games', '50'), 10);

if (!identifier) {
  console.error('Usage: npm run benchmark-bot -- <file|bot-name> [--games N]');
  console.error('\nExamples:');
  console.error('  npm run benchmark-bot -- bots/my-bot.js');
  console.error('  npm run benchmark-bot -- bots/my-bot.js --games 200');
  console.error('  npm run benchmark-bot -- Adaptive');
  console.error(`\nBuilt-in bots: ${BUILT_IN_BOTS.map(b => b.name).join(', ')}`);
  process.exit(1);
}

if (!Number.isFinite(gameCount) || gameCount < 1) {
  console.error('Invalid --games value. Must be a positive integer.');
  process.exit(1);
}

// --- Resolve target bot ---

let targetBot;
try {
  targetBot = resolveBot(identifier);
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error(`\nBuilt-in bots: ${BUILT_IN_BOTS.map(b => b.name).join(', ')}`);
  process.exit(1);
}

const sourceLabel = targetBot.source === 'builtin' ? '(built-in)' : `(from ${identifier})`;
console.log(`Benchmarking: ${colors.bold}${targetBot.name}${colors.reset} ${sourceLabel}`);

if (targetBot.warnings?.length) {
  for (const w of targetBot.warnings) {
    console.log(`  ${colors.yellow}Warning:${colors.reset} ${w}`);
  }
}

// --- Wrap with timing ---

let totalMs = 0;
let callCount = 0;
let errorCount = 0;

function timedBot(state) {
  const start = performance.now();
  try {
    return targetBot.fn(state);
  } catch (err) {
    errorCount++;
    throw err;
  } finally {
    totalMs += performance.now() - start;
    callCount++;
  }
}

// --- Build bots array ---

/*
 * When benchmarking a built-in, replace it with the timed version
 * When benchmarking a file bot, add it alongside the player-visible roster (rename on collision).
 * Opponents are drawn from PLAYER_VISIBLE_BOTS, not the full registry: that excludes the hidden
 * BC/PPO dev-harness nets, which players never face. (The target bot may still BE a
 * hidden built-in resolved by name; only the opponent field is the visible roster.)
 */
let targetName = targetBot.name;
let opponents;

if (targetBot.source === 'builtin') {
  opponents = PLAYER_VISIBLE_BOTS.filter(b => b.name !== targetBot.name).map(b => ({
    name: b.name,
    fn: b.fn,
  }));
} else {
  if (BUILT_IN_BOTS.some(b => b.name === targetName)) {
    targetName = `${targetName} (custom)`;
  }
  opponents = PLAYER_VISIBLE_BOTS.map(b => ({ name: b.name, fn: b.fn }));
}

const bots = [{ name: targetName, fn: timedBot }, ...opponents];

// --- Run arena ---

console.log(`Running ${gameCount} games against ${opponents.length} opponents...\n`);

const startTime = Date.now();

let result;
try {
  result = runArena({
    bots,
    gameCount,
    baseSeed: 1,
    onGameComplete: i => {
      if ((i + 1) % 10 === 0 || i + 1 === gameCount) {
        process.stdout.write(`\rGames: ${i + 1}/${gameCount}`);
      }
    },
  });
} catch (err) {
  console.error(`\nBenchmark failed: ${err.message}`);
  process.exit(1);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s\n`);

// --- Extract target bot stats ---

const targetStats = result.bots.find(b => b.name === targetName);

if (!targetStats) {
  console.error(`Error: Could not find stats for "${targetName}" in arena results.`);
  console.error(`Available bots: ${result.bots.map(b => b.name).join(', ')}`);
  process.exit(1);
}

// --- Print results ---

console.log(`Results for ${colors.bold}"${targetName}"${colors.reset}:\n`);

console.log('  Timing');
console.log(`    Total time:     ${totalMs.toFixed(1)} ms`);
console.log(`    Moves:          ${callCount.toLocaleString()}`);
console.log(`    Avg ms/move:    ${callCount > 0 ? (totalMs / callCount).toFixed(3) : '0.000'} ms`);
if (errorCount > 0) {
  console.log(`    Errors:         ${errorCount}`);
}

console.log();
console.log('  Performance');
console.log(`    ELO:            ${targetStats.elo}`);
console.log(
  `    Wins:           ${targetStats.wins}/${targetStats.gamesPlayed} (${targetStats.gamesPlayed > 0 ? ((targetStats.wins / targetStats.gamesPlayed) * 100).toFixed(1) : '0.0'}%)`
);
console.log(`    Avg Placement:  ${targetStats.avgPlacement}`);
console.log(`    Attack Win Rate: ${(targetStats.attackWinRate * 100).toFixed(1)}%`);
/*
 * Arena-side forced-end counts. A non-zero `errors` means the bot threw on some turns —
 * a broken/mis-registered bot can otherwise hide behind a clean low win% / low ELO (#53).
 * runArena already console.warns above a high error fraction; this surfaces the raw counts.
 */
if (targetStats.errors > 0 || targetStats.invalidMoves > 0 || targetStats.maxMovesHit > 0) {
  console.log(
    `    Forced ends:    ${targetStats.errors} error(s), ` +
      `${targetStats.invalidMoves} invalid move(s), ${targetStats.maxMovesHit} cap-hit turn(s)`
  );
}

console.log();
console.log('  Comparison (all bots by ELO):');

const header = ['Rank', 'Bot', 'ELO', 'Win%'];
const rows = result.bots.map((bot, i) => [
  String(i + 1),
  bot.name,
  String(bot.elo),
  bot.gamesPlayed > 0 ? `${((bot.wins / bot.gamesPlayed) * 100).toFixed(1)}%` : '0%',
]);

const allRows = [header, ...rows];
const widths = header.map((_, col) => Math.max(...allRows.map(row => row[col].length)));

function formatRow(row) {
  return `    ${row.map((cell, i) => cell.padStart(widths[i])).join('  ')}`;
}

console.log(formatRow(header));
console.log(`    ${widths.map(w => '-'.repeat(w)).join('  ')}`);
rows.forEach(row => console.log(formatRow(row)));
