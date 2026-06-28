#!/usr/bin/env node

/**
 * Behavioral-Eval Harness — CLI (Phase 1)
 *
 * Profiles bots across a seat-fair seed sweep on behavioral axes (aggression, dice
 * reserve, kills, turns-to-win, placement, …) and reports each axis as mean ± 95% CI,
 * plus a PAIRED comparison of every profiled bot against a control. This answers "is
 * the bot DIFFERENT, and how?" — the complement to `ppo:gate`'s "is it STRONGER?".
 * Full spec + rationale: docs/ml-bot/EVAL_HARNESS.md.
 *
 * Pairing is the fixed-standard-field design (agreed): every profiled bot occupies the
 * one profiled seat in an IDENTICAL opponent field, so all face the same opponents and
 * the control comparison is paired at the seed/map level (NOT within-game — honest about
 * its strength). Personas are deliberately NOT pitted against each other.
 *
 * Phase 1 runs against existing built-ins (the persona bots don't exist yet). Its
 * acceptance test: two known-different built-ins separate on the expected axis.
 *
 * Usage:
 *   npm run behavior:profile                                   # defaults: Strategist vs Defensive control
 *   npm run behavior:profile -- --bots Strategist,Expectimax --control Defensive --runs 10 --games 30
 *   npm run behavior:profile -- --opponents Default,Adaptive,Example,Expectimax,Lookahead --reference Lookahead
 *   npm run behavior:profile -- --json > profile.json
 */

import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { rotatedField } from './lib/ppo-gate-core.mjs';
import { getArg, hasFlag } from './lib/cli-utils.mjs';
import {
  makeCapture,
  profileGameFromCapture,
  reduceRun,
  summarizeAxis,
  compareToControl,
  AXES,
} from './lib/behavior-core.mjs';

const args = process.argv.slice(2);

const runCount = parseInt(getArg(args, 'runs', '10'), 10);
const gamesPerRun = parseInt(getArg(args, 'games', '30'), 10);
const referenceName = getArg(args, 'reference', 'Lookahead');
const controlName = getArg(args, 'control', 'Defensive');
const botNames = getArg(args, 'bots', 'Strategist')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const opponentNames = getArg(args, 'opponents', 'Default,Adaptive,Example,Expectimax,Lookahead')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const quarantine = !hasFlag(args, 'no-quarantine');
const asJson = hasFlag(args, 'json');

if (!Number.isFinite(runCount) || runCount < 2) {
  console.error('Invalid --runs: need an integer >= 2 (a CI needs >= 2 runs).');
  process.exit(1);
}
if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) {
  console.error('Invalid --games: need a positive integer.');
  process.exit(1);
}

// --- Resolve bots from the registry ---

const byName = new Map(BUILT_IN_BOTS.map(b => [b.name, b]));
const resolve = name => {
  const b = byName.get(name);
  if (!b) {
    console.error(`Unknown bot "${name}". Available: ${[...byName.keys()].join(', ')}`);
    process.exit(1);
  }
  return { name: b.name, fn: b.fn };
};

const opponents = opponentNames.map(resolve);
// The control is profiled like any other bot so the comparison shares the same seed blocks.
const profiledNames = [...new Set([...botNames, controlName])];
const profiled = profiledNames.map(resolve);

// --- Validate the fixed-field invariants (keeps every field identical in size & opponents) ---

const oppSet = new Set(opponentNames);
const collide = profiledNames.filter(n => oppSet.has(n));
if (collide.length) {
  console.error(
    `Profiled bot(s) [${collide.join(', ')}] also appear in --opponents. The profiled seat must ` +
      `be disjoint from the fixed opponent field so every field is identical. Remove them from one side.`
  );
  process.exit(1);
}
if (!oppSet.has(referenceName)) {
  console.error(`--reference "${referenceName}" must be one of --opponents (it fills a seat).`);
  process.exit(1);
}
if (opponents.length < 1) {
  console.error('Need at least one opponent.');
  process.exit(1);
}

const fieldSize = opponents.length + 1; // profiled seat + fixed opponents
const STRIDE = Math.max(1_000_000, gamesPerRun * 1000);

const log = (...a) => console.error(...a); // human output → stderr so --json owns stdout

log(
  `Behavioral profile: ${runCount} runs × ${gamesPerRun} games × ${fieldSize} rotations ` +
    `(${runCount * gamesPerRun * fieldSize} matches/bot)`
);
log(`  profiled: ${profiledNames.join(', ')}   control: ${controlName}`);
log(
  `  field (${fieldSize} seats): [profiled] + ${opponentNames.join(', ')}   ref: ${referenceName}`
);
log(`  quarantine forced-end games: ${quarantine ? 'on' : 'off'}\n`);

// --- Sweep: profile each bot in the one profiled seat of an identical field ---

const NULL_RUN = Object.fromEntries(AXES.map(a => [a, null]));
let quarantined = 0;
let played = 0;

// Quarantine policy (§3.7): drop a game if ANY seat shows a forced-end signal.
const isForcedEnd = s => s.errors > 0 || s.invalidMoves > 0 || s.maxMovesHit > 0;

/** Run the full seed×rotation sweep for one profiled bot; returns reduceRun() per run. */
function sweepBot(bot) {
  const baseField = [bot, ...opponents]; // profiled bot at index 0
  const perRun = [];
  for (let run = 0; run < runCount; run++) {
    const baseSeed = run * STRIDE + 1;
    const profiles = [];
    for (let s = 0; s < gamesPerRun; s++) {
      const seed = baseSeed + s;
      for (let rot = 0; rot < fieldSize; rot++) {
        // Under rotation `rot`, field[0] (the profiled bot) sits at seat `rot`.
        const field = rotatedField(baseField, rot);
        const pi = rot;
        const { capture, onTurn, onStep } = makeCapture(pi);
        const result = runMatch({ bots: field, seed, onTurn, onStep });
        played += 1;
        if (quarantine && result.botStats.some(isForcedEnd)) {
          quarantined += 1;
          continue;
        }
        profiles.push(profileGameFromCapture(result, pi, capture));
      }
    }
    perRun.push(profiles.length ? reduceRun(profiles) : { ...NULL_RUN });
    process.stderr.write(`\r  ${bot.name}: run ${run + 1}/${runCount}`); // in-place progress
  }
  log('');
  return perRun;
}

const start = Date.now();
const runsByBot = new Map(profiled.map(bot => [bot.name, sweepBot(bot)]));
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
log(
  `\nDone in ${elapsed}s — ${played} matches, ${quarantined} quarantined ` +
    `(${((quarantined / played) * 100).toFixed(2)}%)\n`
);

// --- Aggregate + compare ---

const controlRuns = runsByBot.get(controlName);
const report = {
  config: {
    runs: runCount,
    games: gamesPerRun,
    rotations: fieldSize,
    stride: STRIDE,
    reference: referenceName,
    control: controlName,
    opponents: opponentNames,
    fieldSize,
    quarantine: { on: quarantine, rate: played ? quarantined / played : 0 },
  },
  bots: profiled.map(bot => {
    const perRun = runsByBot.get(bot.name);
    const metrics = Object.fromEntries(
      AXES.map(axis => [axis, summarizeAxis(perRun.map(r => r[axis]))])
    );
    const vsControl = bot.name === controlName ? null : compareToControl(perRun, controlRuns);
    return { name: bot.name, metrics, vsControl };
  }),
};

// --- Output ---

if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const fmt = m =>
  m == null ? '—' : m.ci == null ? m.mean.toFixed(2) : `${m.mean.toFixed(2)}±${m.ci.toFixed(2)}`;
const headline = ['winPct', 'aggression', 'avgDiceReserve', 'kills', 'turnsToWin', 'avgPlacement'];

log(['Bot'.padEnd(14), ...headline.map(h => h.padStart(16))].join(''));
log('-'.repeat(14 + headline.length * 16));
for (const b of report.bots) {
  log([b.name.padEnd(14), ...headline.map(h => fmt(b.metrics[h]).padStart(16))].join(''));
}
log('');
for (const b of report.bots) {
  if (!b.vsControl) continue;
  const moved = AXES.filter(a => b.vsControl[a] && b.vsControl[a].verdict !== 'SAME').map(
    a => `${a} ${b.vsControl[a].verdict} (Δ${b.vsControl[a].delta.toFixed(2)})`
  );
  log(`${b.name} vs ${controlName}: ${moved.length ? moved.join(', ') : 'no axis differs'}`);
}
