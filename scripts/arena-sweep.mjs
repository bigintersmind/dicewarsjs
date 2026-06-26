#!/usr/bin/env node

/**
 * CLI Arena Sweep Runner
 *
 * Runs the headless arena across multiple independent seed blocks and reports
 * each bot's mean win rate and ELO with 95% confidence intervals (Student's t).
 * Use this when you want to know whether a ranking is statistically real rather
 * than a lucky-seed artifact — a single `npm run arena` run is deterministic but
 * reflects only one seed block.
 *
 * Usage:
 *   npm run arena:sweep                                   # 20 runs x 150 games
 *   npm run arena:sweep -- --runs 30 --games 100          # custom run/game counts
 *   npm run arena:sweep -- --bots Claude,Defensive        # specific built-in bots
 */

import { runArena } from '../src/arena/arenaRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { getArg } from './lib/cli-utils.mjs';
import { meanCi } from './lib/stats.mjs';

// --- Parse CLI args ---

const args = process.argv.slice(2);

const runCount = parseInt(getArg(args, 'runs', '20'), 10);
if (!Number.isFinite(runCount) || runCount < 2) {
  console.error('Invalid --runs value. Must be an integer >= 2 (need >= 2 runs for a CI).');
  process.exit(1);
}

const gamesPerRun = parseInt(getArg(args, 'games', '150'), 10);
if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) {
  console.error('Invalid --games value. Must be a positive integer.');
  process.exit(1);
}

const botFilter = getArg(args, 'bots', null);

/*
 * Each run consumes `gamesPerRun` consecutive seeds (baseSeed + gameIndex);
 * stride the blocks far enough apart that they never overlap.
 */
const STRIDE = Math.max(1_000_000, gamesPerRun * 1000);

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
  bots = [...BUILT_IN_BOTS];
}

if (bots.length < 2) {
  console.error('Need at least 2 bots to run an arena.');
  process.exit(1);
}

const botArgs = bots.map(b => ({ name: b.name, fn: b.fn }));

// --- Run the sweep ---

console.log(
  `Sweeping ${runCount} runs x ${gamesPerRun} games (${runCount * gamesPerRun} total) ` +
    `with ${bots.length} bots: ${bots.map(b => b.name).join(', ')}`
);
console.log();

const winPct = Object.fromEntries(botArgs.map(b => [b.name, []]));
const elo = Object.fromEntries(botArgs.map(b => [b.name, []]));

const startTime = Date.now();

for (let run = 0; run < runCount; run++) {
  let result;
  try {
    result = runArena({
      bots: botArgs,
      gameCount: gamesPerRun,
      baseSeed: run * STRIDE + 1,
    });
  } catch (err) {
    console.error(`\nSweep failed on run ${run + 1}: ${err.message}`);
    process.exit(1);
  }

  for (const bot of result.bots) {
    winPct[bot.name].push(bot.gamesPlayed > 0 ? (bot.wins / bot.gamesPlayed) * 100 : 0);
    elo[bot.name].push(bot.elo);
  }

  process.stdout.write(`\rRuns: ${run + 1}/${runCount}`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s\n`);

// --- Print results table ---

const fairShare = (100 / bots.length).toFixed(1);
console.log(`Fair-share win rate with ${bots.length} bots = ${fairShare}%\n`);

const rows = botArgs
  .map(b => {
    const w = meanCi(winPct[b.name]);
    const e = meanCi(elo[b.name]);
    return {
      name: b.name,
      win: `${w.mean.toFixed(1)} ± ${w.ci.toFixed(1)}`,
      elo: `${Math.round(e.mean)} ± ${Math.round(e.ci)}`,
      eloMean: e.mean,
    };
  })
  .sort((a, b) => b.eloMean - a.eloMean);

const header = ['Rank', 'Bot', 'Win% (95% CI)', 'ELO (95% CI)'];
const table = [header, ...rows.map((r, i) => [String(i + 1), r.name, r.win, r.elo])];
const widths = header.map((_, col) => Math.max(...table.map(row => row[col].length)));

const formatRow = row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');

console.log(formatRow(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
table.slice(1).forEach(row => console.log(formatRow(row)));
