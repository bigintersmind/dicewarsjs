#!/usr/bin/env node

/**
 * ml-bot Phase-3 headline gate (PLAN step 7) — PPO policy vs `ai_lookahead@596f781`.
 *
 * The last link of the repack → export → register → gate chain. Given a policy
 * exported by `ml/dicewars_bc/export_weights.py` (the repacked PPO actor, a bare
 * `EdgePolicyNet` in BC-checkpoint format), this:
 *
 *   1. dynamic-imports the weights module and **parity-checks** its pure-JS forward
 *      against the Python reference fixture (mandatory — a broken export can't
 *      masquerade as a real win-rate signal);
 *   2. registers it as a bot via `makeBC({ policy })` — exactly the in-browser path;
 *   3. runs a seat-fair multi-seed FFA sweep of {candidate, the decisive built-in
 *      field including the bar}, and reports the candidate's and the bar's win% with
 *      95% CIs **plus the paired per-run win% delta** and a BEAT/TIE/BEHIND verdict.
 *
 * The gate PASSES only on `BEAT` — a statistically significant win% edge over
 * `ai_lookahead` (the bar per [D-7]; judge on win%, never ELO). A tiny *tracer*
 * policy is expected to land at ~TIE/BEHIND (≈ the BC clone, ~12.5% vs ~17%); the
 * machinery proven here is what a real strength run is graded by.
 *
 * Usage:
 *   npm run ppo:gate                                  # 20 runs x 150 games, default weights
 *   npm run ppo:gate -- --runs 30 --games 200
 *   npm run ppo:gate -- --weights src/ai/bcPolicyWeights.js \
 *                       --fixture tests/fixtures/bc/forwardCases.json --name BCanchor
 *                       # ^ validates the whole harness against the known BC anchor
 *   npm run ppo:gate -- --weights <cand>.weights.js --name Cand \
 *                       --bar ScratchLong=ml/runs/ppo-scratch-long/scratch.weights.js
 *                       # ^ head-to-head vs a non-built-in bar seated from a weights
 *                       #   export (PERSONAS §10.7 Wave-0 loader; [D-31] §4 bars)
 */

import { existsSync } from 'node:fs';

import { runMatch } from '../src/arena/matchRunner.js';
import { reportBotErrors } from '../src/arena/botErrorReport.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { getArg } from './lib/cli-args.mjs';
import { loadExportedPolicy, siblingFixturePath } from './lib/load-bc-policy.mjs';
import { mean, meanCi } from './lib/stats.mjs';
import {
  DEFAULT_CANDIDATE_NAME,
  LOOKAHEAD_PIN,
  buildGateField,
  classifyGate,
  missingWeightsHelp,
  pairedDelta,
  runGateSweep,
  sweepPlan,
  verdictLine,
} from './lib/ppo-gate-core.mjs';

const args = process.argv.slice(2);

const DEFAULT_WEIGHTS = 'src/ai/ppoPolicyWeights.js';
const DEFAULT_FIXTURE = 'tests/fixtures/bc/ppoForwardCases.json';

const weightsPath = getArg(args, 'weights', DEFAULT_WEIGHTS);
/*
 * Fixture default: the canonical PPO fixture for the default weights; otherwise the
 * sibling `<name>.fixture.json` (the capacity-probe convention).
 */
const defaultFixture =
  weightsPath === DEFAULT_WEIGHTS ? DEFAULT_FIXTURE : siblingFixturePath(weightsPath);
const fixturePath = getArg(args, 'fixture', defaultFixture);

/*
 * Since PR #74 the shipped PPO sits IN the gate field as the baseline seat ([D-27]
 * kept it there), so the candidate needs a non-colliding name. A bare `npm run ppo:gate` (default weights =
 * `ppoPolicyWeights.js`) therefore seats the shipped policy twice — as 'PPO' (baseline)
 * and 'Candidate' — which doubles as a calibration probe: the two seats hold
 * byte-identical policies, so their win% should agree within noise.
 */
const candidateName = getArg(args, 'name', DEFAULT_CANDIDATE_NAME);
/*
 * `--bar` accepts a built-in field name ('Lookahead', 'PPO') or a `Name=weights.js`
 * spec (the PERSONAS §10.7 Wave-0 loader): the exported net is parity-checked like
 * the candidate and seated as an EXTRA bar seat, making non-built-in head-to-head
 * bars runnable (e.g. the [D-31] §4 primary bar vs `ppo-scratch-long`). The bar
 * fixture defaults to the sibling `<name>.fixture.json`; override with --bar-fixture.
 */
const barArg = getArg(args, 'bar', 'Lookahead');
const barEq = barArg.indexOf('=');
const barName = barEq === -1 ? barArg : barArg.slice(0, barEq);
const barWeightsPath = barEq === -1 ? null : barArg.slice(barEq + 1);
if (barEq !== -1 && (!barName || !barWeightsPath)) {
  throw new Error(`--bar spec "${barArg}" must be Name=path/to/foo.weights.js`);
}
const barFixturePath = getArg(
  args,
  'bar-fixture',
  barWeightsPath ? siblingFixturePath(barWeightsPath) : null
);
const stopBias = Number(getArg(args, 'stop-bias', '0'));

const runCount = parseInt(getArg(args, 'runs', '20'), 10);
const gamesPerRun = parseInt(getArg(args, 'games', '150'), 10);
const seedBase = parseInt(getArg(args, 'seedbase', '0'), 10);
if (!Number.isFinite(runCount) || runCount < 2) throw new Error('--runs must be an integer >= 2');
if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) throw new Error('--games must be >= 1');
if (!Number.isFinite(seedBase)) throw new Error('--seedbase must be an integer');
if (!Number.isFinite(stopBias)) throw new Error('--stop-bias must be a number');

if (!existsSync(weightsPath)) {
  console.error(missingWeightsHelp(weightsPath));
  process.exit(1);
}

// --- Load + parity-check the candidate policy -----------------------------------
let policy;
let parity;
let params;
try {
  ({ policy, parity, params } = await loadExportedPolicy({
    weightsPath,
    fixturePath,
    label: candidateName,
  }));
} catch (err) {
  console.error(`\nGate aborted: ${err.message}`);
  process.exit(1);
}

// --- Load + parity-check the bar policy, when --bar is a Name=weights.js spec ----
let barFn;
let barLabel = `${barName}@${LOOKAHEAD_PIN}`;
if (barWeightsPath) {
  try {
    const bar = await loadExportedPolicy({
      weightsPath: barWeightsPath,
      fixturePath: barFixturePath,
      label: barName,
    });
    barFn = makeBC({ policy: bar.policy });
    barLabel = `${barName}=${barWeightsPath} (${bar.params.toLocaleString()} params, parity ${bar.parity.toExponential(1)})`;
  } catch (err) {
    console.error(`\nGate aborted: ${err.message}`);
    process.exit(1);
  }
}

// --- Build the field: makeBC({ policy }) is exactly the in-browser registration --
const counter = { stops: 0, decisions: 0 };
const candidateFn = makeBC({
  policy,
  stopBias,
  onDecision: stopped => {
    counter.decisions++;
    if (stopped) counter.stops++;
  },
});
const field = buildGateField(BUILT_IN_BOTS, candidateFn, candidateName, barName, barFn);

/*
 * Seat-fair design (the gate requires it; matchRunner maps bots[i] → seat i, and
 * MapGenerator hands out territory by seat, so a fixed field would let seat advantage
 * confound the candidate-vs-bar delta). Each run replays seedsPerRun distinct maps,
 * and every map is played through all N seat rotations so each bot occupies every seat
 * exactly once — counterbalanced exactly like scripts/_baseline.mjs. `--games` is the
 * per-run game budget, rounded to whole rotation sets (seedsPerRun × N) — e.g. the
 * default 150 on the 9-seat field gives 17 seeds × 9 = 153 games/run. The sweep loop
 * itself lives in runGateSweep ([D-29] extraction) so the strength-curve scorer drives
 * the identical methodology; this CLI stays a thin arg-parse + report wrapper.
 */
const N = field.length;
const { seedsPerRun, gamesPerRunActual } = sweepPlan(N, gamesPerRun);

console.log(
  `Phase-3 gate: ${candidateName} vs ${barLabel} — ` +
    `${runCount} runs x ${seedsPerRun} seeds x ${N} seat rotations ` +
    `(${runCount * gamesPerRunActual} games total)`
);
console.log(
  `Weights: ${weightsPath}  (${params.toLocaleString()} params, parity ${parity.toExponential(1)})`
);
console.log(`Fixture: ${fixturePath}`);
console.log(`Field (${N}): ${field.map(b => b.name).join(', ')}`);
console.log(`stopBias=${stopBias}  judging on WIN% (paired, seat-fair), not ELO\n`);

// --- Run the sweep (seat-counterbalanced) ---------------------------------------
const startTime = Date.now();

let sweep;
try {
  sweep = await runGateSweep({
    field,
    matchFn: runMatch,
    runs: runCount,
    gamesPerRun,
    seedBase,
    tallyNames: [candidateName, barName],
    onRunComplete: (done, total) => process.stdout.write(`\rRuns: ${done}/${total}`),
    onMatchError: ({ seed, rotation, error }) =>
      console.error(`\n[gate] match failed (seed ${seed}, rot ${rotation}): ${error.message}`),
  });
} catch (err) {
  console.error(`\nGate aborted: ${err.message}`);
  process.exit(1);
}

const { failedGames } = sweep;
const candWin = sweep.perRun[candidateName].winPct;
const barWin = sweep.perRun[barName].winPct;
const candAtkWin = sweep.perRun[candidateName].attackWinRate;

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s${failedGames ? ` (${failedGames} games failed)` : ''}\n`);

/*
 * Broken-candidate check (#92 item 5): the verdict below is driven purely by win%, so a
 * runtime-broken candidate — a makeBC registration / coordinate-space bug the static parity
 * check can't catch — wins ~0 games and grades as a legit 0% BEHIND, indistinguishable from a
 * weak-but-working policy. Surface any tallied bot whose per-turn error fraction is out of
 * bounds so a wasted run reads as "broken", not "weak". The failure direction is safe (a
 * 0%-win broken bot can't falsely PASS a must-BEAT gate), so this warns without changing the
 * exit code — it's diagnosis, mirroring the arena path's finalizeArenaStats call shape.
 */
reportBotErrors(
  [candidateName, barName].map(name => ({ name, ...sweep.errorTotals[name] })),
  { label: '[gate]' }
);

// --- Report ----------------------------------------------------------------------
const cw = meanCi(candWin);
const bw = meanCi(barWin);
const delta = pairedDelta(candWin, barWin);
const verdict = classifyGate(delta);
const stopPct =
  counter.decisions > 0 ? ((counter.stops / counter.decisions) * 100).toFixed(1) : '—';

const rows = [
  ['Metric', 'Value'],
  [`${candidateName} win% (95% CI)`, `${cw.mean.toFixed(1)} ± ${cw.ci.toFixed(1)}`],
  [`${barName} win% (95% CI)`, `${bw.mean.toFixed(1)} ± ${bw.ci.toFixed(1)}`],
  [
    'Paired Δ win% (cand − bar)',
    `${delta.mean >= 0 ? '+' : ''}${delta.mean.toFixed(1)} ± ${delta.ci.toFixed(1)}  [${delta.lo.toFixed(1)}, ${delta.hi.toFixed(1)}]`,
  ],
  [`${candidateName} STOP%`, stopPct],
  [`${candidateName} attack-win%`, (mean(candAtkWin) * 100).toFixed(1)],
];
const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
const fmt = r => r.map((cell, i) => cell.padEnd(widths[i])).join('  ');
console.log(fmt(rows[0]));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
rows.slice(1).forEach(r => console.log(fmt(r)));

console.log(`\n${verdictLine(verdict, delta)}`);
console.log(
  `\nGate = BEAT only — the paired Δwin% 95% CI strictly above 0 (a conservative one-sided ` +
    `test at α≈0.025). Bar = ${barLabel}${
      barWeightsPath ? '' : ' (in-repo HEAD differs only in comments — behaviorally pinned)'
    }. A small true edge needs more --runs to clear the CI.`
);
