#!/usr/bin/env node

/**
 * ml-bot Phase-3 ceiling probe — capacity → win% confirmation (throwaway harness).
 *
 * The capacity sweep (3 EdgePolicyNet widths, all STOP-calibrated via --select-by stop-cal)
 * showed val move-match is essentially FLAT across a 10x param range (102k→1.0M: 56.75%→
 * 57.33%). Move-match is the known-misleading proxy, so this hardens the verdict on the REAL
 * metric: it arena-evaluates each exported checkpoint (native stopBias=0) in its own field
 * over identical paired seed blocks and reports win% with 95% CIs. If win% is flat across
 * the capacity range too, "not capacity-limited" holds on the metric that actually gates
 * Phase 3, not just the proxy.
 *
 * Pre-flight: each export ships a JS<->Python parity fixture; we replay it through bcForward
 * and abort if the wider forward doesn't reproduce the reference logits — so a numerically
 * broken wide net can't masquerade as a real win-rate signal.
 *
 * The "deployed" row (default bcPolicyWeights.js, the PR #55 calibrated 102k model) is a
 * known anchor (~6.4% native) that validates the harness reproduces the established number.
 *
 * Usage:
 *   node scripts/_probe-capacity-arena.mjs                       # 15 runs x 130 games (defaults)
 *   node scripts/_probe-capacity-arena.mjs --runs 12 --games 150
 *   WEIGHTS_DIR=/path/to/probe-exports node scripts/_probe-capacity-arena.mjs
 */

import { resolve } from 'node:path';

import { runArena } from '../src/arena/arenaRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { getArg } from './lib/cli-utils.mjs';
import { loadExportedPolicy, countParams } from './lib/load-bc-policy.mjs';
import { meanCi, mean } from './lib/stats.mjs';

const args = process.argv.slice(2);
const runCount = parseInt(getArg(args, 'runs', '15'), 10);
const gamesPerRun = parseInt(getArg(args, 'games', '130'), 10);
const seedBase = parseInt(getArg(args, 'seedbase', '0'), 10);
if (!Number.isFinite(runCount) || runCount < 2) throw new Error('--runs must be an integer >= 2');
if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) throw new Error('--games must be >= 1');

/*
 * Inference STOP-bias grid: each width is compared at its PEAK win% (matched arena operating
 * point), not at bias 0 — because stop-cal selection matched VAL STOP, but ARENA STOP diverges
 * (more for longer-trained nets), so bias 0 would compare nets at different, degraded STOP rates.
 */
const BIASES = getArg(args, 'bias', '0,1,2')
  .split(',')
  .map(s => Number(s.trim()));
if (BIASES.some(b => !Number.isFinite(b)))
  throw new Error('--bias must be comma-separated numbers');

const WEIGHTS_DIR = getArg(args, 'weights-dir', process.env.WEIGHTS_DIR || '');
if (!WEIGHTS_DIR) {
  throw new Error(
    'No weights dir. Pass --weights-dir <path> or set WEIGHTS_DIR. It must hold the exported ' +
      'candidate weights (<config>.weights.js) + their parity fixtures (<config>.fixture.json), ' +
      'produced by `python -m dicewars_bc.export_weights --ckpt … --out <config>.weights.js --fixture …`.'
  );
}

// name → exported weights file (null = deployed default in bcPolicyWeights.js)
const CONFIGS = [
  { name: 'deployed', file: null },
  { name: 'c0_base', file: 'c0_base.weights.js' },
  { name: 'c1_wide', file: 'c1_wide.weights.js' },
  { name: 'c2_large', file: 'c2_large.weights.js' },
];

const YARDSTICK = 'Lookahead';
const baseField = BUILT_IN_BOTS.filter(b => b.name !== 'BC').map(b => ({ name: b.name, fn: b.fn }));
if (!baseField.some(b => b.name === YARDSTICK)) throw new Error(`${YARDSTICK} missing from field`);

const STRIDE = Math.max(1_000_000, gamesPerRun * 1000);

/*
 * Load + MANDATORY parity pre-flight (the only check that a candidate's JS forward
 * reproduces the Python reference, so a numerically broken net can't masquerade as a
 * real win-rate signal). Shared with the PPO gate via load-bc-policy.mjs; the sibling
 * `<config>.fixture.json` is derived by the loader.
 */
const loadPolicy = file =>
  loadExportedPolicy({ weightsPath: resolve(WEIGHTS_DIR, file), label: file });

console.log(
  `Capacity→win% confirm: ${CONFIGS.length} configs x ${BIASES.length} biases x ${runCount} runs x ${gamesPerRun} games ` +
    `(${CONFIGS.length * BIASES.length * runCount * gamesPerRun} games total)`
);
console.log(
  `Field (${baseField.length + 1}): ${baseField.map(b => b.name).join(', ')}, BC<config@bias>`
);
console.log(
  `Biases: ${BIASES.join(', ')} — compare each width at its PEAK win% (matched arena STOP).`
);
console.log(`Weights dir: ${WEIGHTS_DIR}\n`);

const startTime = Date.now();
const rows = [];

for (const cfg of CONFIGS) {
  let policy = undefined;
  let parity = null;
  if (cfg.file) ({ policy, parity } = await loadPolicy(cfg.file));
  const refPolicy = policy ?? (await import('../src/ai/bcPolicyWeights.js')).BC_POLICY;
  const nParams = countParams(refPolicy);

  for (const bias of BIASES) {
    const counter = { stops: 0, decisions: 0 };
    const bcFn = makeBC({
      stopBias: bias,
      policy, // undefined → deployed default
      onDecision: stopped => {
        counter.decisions++;
        if (stopped) counter.stops++;
      },
    });
    const field = [...baseField, { name: 'BC', fn: bcFn }];

    const bcWin = [];
    const lookWin = [];
    const bcAtkWin = [];
    for (let run = 0; run < runCount; run++) {
      const result = runArena({
        bots: field,
        gameCount: gamesPerRun,
        baseSeed: (seedBase + run) * STRIDE + 1,
      });
      if (result.aborted || result.failedGames > 0) {
        throw new Error(
          `run degraded (${cfg.name}@${bias}, run ${run + 1}): failed=${result.failedGames} aborted=${result.aborted}`
        );
      }
      const bc = result.bots.find(b => b.name === 'BC');
      const look = result.bots.find(b => b.name === YARDSTICK);
      bcWin.push((bc.wins / bc.gamesPlayed) * 100);
      lookWin.push((look.wins / look.gamesPlayed) * 100);
      bcAtkWin.push(bc.attackWinRate);
      process.stdout.write(`\r[${cfg.name}@${bias}] run ${run + 1}/${runCount}        `);
    }

    const w = meanCi(bcWin);
    const lw = meanCi(lookWin);
    rows.push({
      config: cfg.name,
      params: nParams,
      bias,
      parity: parity == null ? '—' : parity.toExponential(1),
      winMean: w.mean,
      bcWin: `${w.mean.toFixed(1)} ± ${w.ci.toFixed(1)}`,
      stopPct: counter.decisions > 0 ? ((counter.stops / counter.decisions) * 100).toFixed(1) : '—',
      atkWin: (mean(bcAtkWin) * 100).toFixed(1),
      lookWin: `${lw.mean.toFixed(1)} ± ${lw.ci.toFixed(1)}`,
    });
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s\n`);

const header = [
  'config',
  'params',
  'bias',
  'parity',
  'BC win% (CI)',
  'BC STOP%',
  'BC atk-win%',
  `${YARDSTICK} win% (CI)`,
];
const table = [
  header,
  ...rows.map(r => [
    r.config,
    r.params.toLocaleString(),
    String(r.bias),
    r.parity,
    r.bcWin,
    r.stopPct,
    r.atkWin,
    r.lookWin,
  ]),
];
const widths = header.map((_, col) => Math.max(...table.map(row => row[col].length)));
const fmt = row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
console.log(fmt(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
table.slice(1).forEach(row => console.log(fmt(row)));

// Per-config PEAK win% (the matched-operating-point comparison that isolates capacity).
console.log('\nPEAK win% per config (best bias = matched arena operating point):');
for (const cfg of CONFIGS) {
  const cfgRows = rows.filter(r => r.config === cfg.name);
  const best = cfgRows.reduce((a, b) => (b.winMean > a.winMean ? b : a));
  console.log(
    `  ${cfg.name.padEnd(9)} ${best.params.toLocaleString().padStart(10)} params  →  peak ${best.bcWin}  @ bias ${best.bias} (STOP ${best.stopPct}%)`
  );
}
console.log(
  `\nRead: if PEAK win% is flat across the 10x param range, capacity is confirmed NOT the bottleneck on the real (win%) metric — escalate to features/architecture, not a bigger MLP.`
);
