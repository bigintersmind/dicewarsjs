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
if (botNames.length === 0) {
  console.error('Invalid --bots: need at least one bot to profile.');
  process.exit(1);
}
// A duplicate opponent would make every game throw "Bot names must be unique" deep in the sweep;
// catch the typo here with a message that points at the actual cause.
if (new Set(opponentNames).size !== opponentNames.length) {
  console.error(
    `--opponents has duplicate names: [${opponentNames.join(', ')}]. Each seat must be distinct.`
  );
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

// Quarantine policy (§3.7): drop a game if ANY seat shows a forced-end signal.
const isForcedEnd = s => s.errors > 0 || s.invalidMoves > 0 || s.maxMovesHit > 0;

// A NULL_RUN has winPct === null (no game contributed); a live run always has a numeric winPct
// (0 if it never won). So this counts the runs that actually carry behavioral data.
const liveRunCount = perRun => perRun.filter(r => r.winPct != null).length;

/**
 * Run the full seed×rotation sweep for one profiled bot. Returns the per-run reduceRun() plus
 * per-bot played/quarantined tallies so the report can surface how much sample each bot kept
 * (a fully-quarantined bot must NOT look like a measured "no difference" — see the output below).
 */
function sweepBot(bot) {
  const baseField = [bot, ...opponents]; // profiled bot at index 0
  const perRun = [];
  let played = 0;
  let quarantined = 0;
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
        let result;
        try {
          result = runMatch({ bots: field, seed, onTurn, onStep });
        } catch (err) {
          // Surface which game blew up rather than dying with a context-free stack far from its
          // cause (this is inside runCount×games×rotations×bots iterations).
          throw new Error(
            `runMatch threw (bot=${bot.name} seed=${seed} rot=${rot}): ${err.message}`,
            { cause: err }
          );
        }
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
  return { perRun, played, quarantined };
}

const start = Date.now();
const sweepByBot = new Map(profiled.map(bot => [bot.name, sweepBot(bot)]));
const runsByBot = new Map([...sweepByBot].map(([name, s]) => [name, s.perRun]));
const totalPlayed = [...sweepByBot.values()].reduce((a, s) => a + s.played, 0);
const totalQuarantined = [...sweepByBot.values()].reduce((a, s) => a + s.quarantined, 0);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
log(
  `\nDone in ${elapsed}s — ${totalPlayed} matches, ${totalQuarantined} quarantined ` +
    `(${totalPlayed ? ((totalQuarantined / totalPlayed) * 100).toFixed(2) : '0.00'}%)\n`
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
    quarantine: {
      on: quarantine,
      rate: totalPlayed ? totalQuarantined / totalPlayed : 0,
      // Per-bot rate (§3.7): a flaky opponent can gut one bot's sample without moving the pool rate.
      ratePerBot: Object.fromEntries(
        [...sweepByBot].map(([name, s]) => [name, s.played ? s.quarantined / s.played : 0])
      ),
    },
  },
  bots: profiled.map(bot => {
    const perRun = runsByBot.get(bot.name);
    const metrics = Object.fromEntries(
      AXES.map(axis => [axis, summarizeAxis(perRun.map(r => r[axis]))])
    );
    const vsControl = bot.name === controlName ? null : compareToControl(perRun, controlRuns);
    return { name: bot.name, metrics, vsControl, liveRuns: liveRunCount(perRun) };
  }),
};

// --- Output ---

if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

// A bare value (no ±) means only ONE run contributed to that axis (winners-only sparsity); mark it
// `nN` so it isn't mistaken for a tight CI.
const fmt = m =>
  m == null
    ? '—'
    : m.ci == null
      ? `${m.mean.toFixed(2)} n${m.n}`
      : `${m.mean.toFixed(2)}±${m.ci.toFixed(2)}`;
const headline = ['winPct', 'aggression', 'avgDiceReserve', 'kills', 'turnsToWin', 'avgPlacement'];

// Flag any bot whose sample was reduced by quarantine, so a low-n result isn't read as robust.
for (const b of report.bots) {
  const rate = report.config.quarantine.ratePerBot[b.name] ?? 0;
  if (b.liveRuns === 0) {
    log(
      `  WARNING: ${b.name} — all ${runCount} runs fully quarantined ` +
        `(${(rate * 100).toFixed(1)}% of games); no behavioral data.`
    );
  } else if (b.liveRuns < runCount) {
    log(
      `  NOTE: ${b.name} — only ${b.liveRuns}/${runCount} runs carry data ` +
        `(quarantine ${(rate * 100).toFixed(1)}%).`
    );
  } else if (rate > 0.1) {
    log(`  NOTE: ${b.name} — quarantine rate ${(rate * 100).toFixed(1)}% (sample reduced).`);
  }
}
log('');

log(['Bot'.padEnd(14), ...headline.map(h => h.padStart(16))].join(''));
log('-'.repeat(14 + headline.length * 16));
for (const b of report.bots) {
  log([b.name.padEnd(14), ...headline.map(h => fmt(b.metrics[h]).padStart(16))].join(''));
}
log('');
for (const b of report.bots) {
  if (!b.vsControl) continue;
  // Distinguish "measured, no difference" from "no data to compare" — both used to print the same
  // "no axis differs" line, hiding a failed measurement as a real null result.
  const comparable = AXES.filter(a => b.vsControl[a]);
  if (comparable.length === 0) {
    log(
      `${b.name} vs ${controlName}: NO COMPARABLE DATA (insufficient paired runs after quarantine)`
    );
    continue;
  }
  const moved = comparable
    .filter(a => b.vsControl[a].verdict !== 'SAME')
    .map(a => {
      const c = b.vsControl[a];
      const nNote = c.n < runCount ? ` n${c.n}` : ''; // paired n below full run count
      return `${a} ${c.verdict} (Δ${c.delta.toFixed(2)}${nNote})`;
    });
  const minN = Math.min(...comparable.map(a => b.vsControl[a].n));
  const dataNote = minN < runCount ? ` [min paired n=${minN}/${runCount}]` : '';
  log(
    `${b.name} vs ${controlName}: ${moved.length ? moved.join(', ') : 'no axis differs'}${dataNote}`
  );
}
