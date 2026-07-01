#!/usr/bin/env node

/**
 * BC STOP-bias sweep (ml-bot Phase 2 — STOP-de-bias diagnostic, Step 0).
 *
 * The trained BC clone over-predicts STOP (~68% of decisions in Python-val, ~71% realized
 * in-arena, vs ~45% for the teacher) and so plays too passively to win — the corrected
 * `stopBias = 0` control wins only ~3.6% (docs/ml-bot/RESULTS.md). Before paying for a
 * class-weighted/focal-CE retrain on the GPU box, this script answers — for free, with
 * NO retraining, over the already-exported weights — whether that failure is just a
 * miscalibrated STOP threshold.
 *
 * It sweeps an inference-time STOP-logit bias (`makeBC({stopBias})`, src/ai/ai_bc.js):
 * for each bias it runs the SAME field as the parity run (the 7 heuristic built-ins +
 * one BC variant) over identical seed blocks, and reports BC's win% (with 95% CI) and
 * its realized STOP rate, with Lookahead's win% as a stable yardstick. `stopBias = 0`
 * reproduces the corrected control (~3.6% win).
 *
 * How to read it:
 *   - If some bias lifts BC's win% materially off 0 AND pushes its STOP rate from ~71%
 *     toward the teacher's ~45% → the failure is STOP-threshold miscalibration; GREEN-LIGHT
 *     the retrain and target that STOP rate.
 *   - If no bias moves win% off ~0 (attacks/game climbs but attack-win-rate collapses, i.e.
 *     passivity just becomes suicide) → per-step debias won't help; skip the retrain and
 *     escalate (GNN / PPO warm-start).
 *
 * Usage:
 *   npm run arena:bc-stopbias                                  # 20 runs x 150 games, bias 0,0.5,1,2,3,4
 *   npm run arena:bc-stopbias -- --runs 12 --games 150         # fewer runs (quicker)
 *   npm run arena:bc-stopbias -- --bias 0,1,2,4,6              # custom bias grid
 *   npm run arena:bc-stopbias -- --seedbase 100               # a disjoint seed replication
 */

import { runArena } from '../src/arena/arenaRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { getArg } from './lib/cli-utils.mjs';

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

const seedBase = parseInt(getArg(args, 'seedbase', '0'), 10);
if (!Number.isFinite(seedBase) || seedBase < 0) {
  console.error('Invalid --seedbase value. Must be a non-negative integer.');
  process.exit(1);
}

const biases = getArg(args, 'bias', '0,0.5,1,2,3,4')
  .split(',')
  .map(s => Number(s.trim()));
if (biases.length === 0 || biases.some(b => !Number.isFinite(b))) {
  console.error('Invalid --bias value. Comma-separated finite numbers, e.g. --bias 0,0.5,1,2,3,4');
  process.exit(1);
}

/*
 * The reference field is the parity-run field with the built-in BC removed; each bias
 * config re-adds its own BC variant. Every config sees identical seed blocks (baseSeed
 * is independent of bias), so the comparison across biases is paired on the same maps.
 */
const baseField = BUILT_IN_BOTS.filter(b => b.name !== 'BC' && !b.persona).map(b => ({
  name: b.name,
  fn: b.fn,
}));
const YARDSTICK = 'Lookahead';
if (!baseField.some(b => b.name === YARDSTICK)) {
  console.error(`Reference bot "${YARDSTICK}" is not in BUILT_IN_BOTS — cannot anchor the sweep.`);
  process.exit(1);
}

const STRIDE = Math.max(1_000_000, gamesPerRun * 1000);

// --- Statistics helpers (95% Student-t CI; mirrors scripts/arena-sweep.mjs) ---

// 95% two-sided Student's t critical values by degrees of freedom (df = runs - 1).
const T95 = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  11: 2.201,
  12: 2.179,
  13: 2.16,
  14: 2.145,
  15: 2.131,
  16: 2.12,
  17: 2.11,
  18: 2.101,
  19: 2.093,
  20: 2.086,
  21: 2.08,
  22: 2.074,
  23: 2.069,
  24: 2.064,
  25: 2.06,
  26: 2.056,
  27: 2.052,
  28: 2.048,
  29: 2.045,
  30: 2.042,
};
// For df > 30 the t distribution is close enough to normal to use 1.96.
const tCrit = df => T95[df] ?? 1.96;

/** Mean and 95% confidence half-width for a sample array. */
function meanCi(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance) / Math.sqrt(n);
  return { mean, ci: tCrit(n - 1) * stdErr };
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

// --- Run the sweep ---

console.log(
  `BC STOP-bias sweep: ${biases.length} bias values x ${runCount} runs x ${gamesPerRun} games ` +
    `(${biases.length * runCount * gamesPerRun} games total)`
);
console.log(`Field (${baseField.length + 1}): ${baseField.map(b => b.name).join(', ')}, BC<bias>`);
console.log(
  `Yardstick: ${YARDSTICK}.  STOP-rate target ≈ 45% (teacher); the untuned clone sits at ~71%.\n`
);

const startTime = Date.now();
const rows = [];

for (const bias of biases) {
  /*
   * One BC variant per bias, reused across runs so its STOP counter aggregates the
   * realized STOP rate over every BC decision in the whole config. The arena calls bots
   * with a BotState (runBotDirect), so the raw makeBC fn is used directly — no adapter.
   */
  const counter = { stops: 0, decisions: 0 };
  const bcFn = makeBC({
    stopBias: bias,
    onDecision: stopped => {
      counter.decisions++;
      if (stopped) counter.stops++;
    },
  });
  const field = [...baseField, { name: 'BC', fn: bcFn }];

  const bcWin = [];
  const lookWin = [];
  const bcElo = [];
  const bcPlace = [];
  const bcAtk = [];
  const bcAtkWin = [];

  for (let run = 0; run < runCount; run++) {
    let result;
    try {
      result = runArena({
        bots: field,
        gameCount: gamesPerRun,
        baseSeed: (seedBase + run) * STRIDE + 1,
      });
    } catch (err) {
      console.error(`\nSweep failed (bias ${bias}, run ${run + 1}):`);
      console.error(err); // full stack + cause, not just .message
      if (rows.length) {
        console.error('\nCompleted rows before the failure:');
        console.table(rows);
      }
      process.exit(1);
    }

    /*
     * Refuse to fold a degraded run into the averaged diagnostic. runArena does NOT throw
     * on the abort path — it returns normally with aborted:true (plus any per-match failures
     * in failedGames), so the try/catch above never sees it. A diagnostic whose entire signal
     * lives in the 0–6% win band must not silently average a 0% that means "the arena fell
     * over" together with a 0% that means "the clone turtled" — fail loud instead.
     */
    if (result.aborted || result.failedGames > 0) {
      console.error(
        `\nSweep run degraded (bias ${bias}, run ${run + 1}): ${result.failedGames} game(s) ` +
          `failed, aborted=${result.aborted}. Refusing to average a partial run into the diagnostic.`
      );
      process.exit(1);
    }

    const bc = result.bots.find(b => b.name === 'BC');
    const look = result.bots.find(b => b.name === YARDSTICK);
    if (bc.gamesPlayed !== gamesPerRun || look.gamesPlayed !== gamesPerRun) {
      console.error(
        `\nUnexpected gamesPlayed (bias ${bias}, run ${run + 1}): BC=${bc.gamesPlayed}, ` +
          `${YARDSTICK}=${look.gamesPlayed}, expected ${gamesPerRun}.`
      );
      process.exit(1);
    }
    bcWin.push((bc.wins / bc.gamesPlayed) * 100);
    lookWin.push((look.wins / look.gamesPlayed) * 100);
    bcElo.push(bc.elo);
    bcPlace.push(bc.avgPlacement);
    bcAtk.push(bc.avgAttacks);
    bcAtkWin.push(bc.attackWinRate);

    process.stdout.write(`\r[bias ${bias}] run ${run + 1}/${runCount}        `);
  }

  const w = meanCi(bcWin);
  const lw = meanCi(lookWin);
  rows.push({
    bias,
    bcWin: `${w.mean.toFixed(1)} ± ${w.ci.toFixed(1)}`,
    stopPct: counter.decisions > 0 ? ((counter.stops / counter.decisions) * 100).toFixed(1) : '—',
    bcElo: String(Math.round(mean(bcElo))),
    bcPlace: mean(bcPlace).toFixed(2),
    bcAtk: mean(bcAtk).toFixed(1),
    bcAtkWin: (mean(bcAtkWin) * 100).toFixed(1),
    lookWin: `${lw.mean.toFixed(1)} ± ${lw.ci.toFixed(1)}`,
  });
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s\n`);

// --- Print results table ---

const header = [
  'stopBias',
  'BC win% (CI)',
  'BC STOP%',
  'BC ELO',
  'BC place',
  'BC atk/g',
  'BC atk-win%',
  `${YARDSTICK} win% (CI)`,
];
const table = [
  header,
  ...rows.map(r => [
    String(r.bias),
    r.bcWin,
    r.stopPct,
    r.bcElo,
    r.bcPlace,
    r.bcAtk,
    r.bcAtkWin,
    r.lookWin,
  ]),
];
const widths = header.map((_, col) => Math.max(...table.map(row => row[col].length)));
const formatRow = row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');

console.log(formatRow(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
table.slice(1).forEach(row => console.log(formatRow(row)));

console.log(
  `\nRead: a bias that lifts BC win% off ~0 while its STOP% falls toward ~45% ⇒ STOP-threshold\n` +
    `miscalibration (green-light the retrain, target that STOP%). If win% stays ~0 while atk/g\n` +
    `climbs and atk-win% drops ⇒ aggression just turns suicidal — escalate instead of retraining.`
);
