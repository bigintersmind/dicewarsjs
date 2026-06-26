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
 */

import { existsSync } from 'node:fs';

import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { getArg } from './lib/cli-args.mjs';
import { loadExportedPolicy, siblingFixturePath } from './lib/load-bc-policy.mjs';
import { mean, meanCi } from './lib/stats.mjs';
import {
  LOOKAHEAD_PIN,
  buildGateField,
  classifyGate,
  missingWeightsHelp,
  pairedDelta,
  rotatedField,
  shouldAbort,
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

const candidateName = getArg(args, 'name', 'PPO');
const barName = getArg(args, 'bar', 'Lookahead');
const stopBias = Number(getArg(args, 'stop-bias', '0'));

const runCount = parseInt(getArg(args, 'runs', '20'), 10);
const gamesPerRun = parseInt(getArg(args, 'games', '150'), 10);
const seedBase = parseInt(getArg(args, 'seedbase', '0'), 10);
if (!Number.isFinite(runCount) || runCount < 2) throw new Error('--runs must be an integer >= 2');
if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) throw new Error('--games must be >= 1');
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
const field = buildGateField(BUILT_IN_BOTS, candidateFn, candidateName, barName);

/*
 * Seat-fair design (the gate requires it; matchRunner maps bots[i] → seat i, and
 * MapGenerator hands out territory by seat, so a fixed field would let seat advantage
 * confound the candidate-vs-bar delta). Each run replays SEEDS_PER_RUN distinct maps,
 * and every map is played through all N seat rotations so each bot occupies every seat
 * exactly once — counterbalanced exactly like scripts/_baseline.mjs. `--games` is the
 * per-run game budget, rounded down to whole rotation sets (SEEDS_PER_RUN × N).
 */
const N = field.length;
const seedsPerRun = Math.max(1, Math.round(gamesPerRun / N));
const gamesPerRunActual = seedsPerRun * N;
const STRIDE = Math.max(1_000_000, gamesPerRunActual * 1000);

console.log(
  `Phase-3 gate: ${candidateName} vs ${barName}@${LOOKAHEAD_PIN} — ` +
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
const candWin = [];
const barWin = [];
const candAtkWin = [];
let failedGames = 0;
let attempts = 0; // every match tried (success or fail) — the abort denominator
const startTime = Date.now();

for (let run = 0; run < runCount; run++) {
  let candWins = 0;
  let barWins = 0;
  let candAttacks = 0;
  let candAttackWins = 0;
  let games = 0;
  for (let s = 0; s < seedsPerRun; s++) {
    const seed = (seedBase + run) * STRIDE + s + 1;
    for (let r = 0; r < N; r++) {
      attempts++;
      let res;
      try {
        res = runMatch({ bots: rotatedField(field, r), seed });
      } catch (err) {
        failedGames++;
        /*
         * Count real attempts, not successes: a run whose every match throws leaves
         * `games` at 0, so a successes-based denominator would pin the abort and let a
         * catastrophic sweep through to a NaN verdict.
         */
        if (shouldAbort(failedGames, attempts)) {
          console.error(`\nGate aborted: ${failedGames}/${attempts} matches failed (>50%).`);
          process.exit(1);
        }
        console.error(`\n[gate] match failed (seed ${seed}, rot ${r}): ${err.message}`);
        continue;
      }
      games++;
      if (res.winnerName === candidateName) candWins++;
      else if (res.winnerName === barName) barWins++;
      const candStat = res.botStats.find(b => b.name === candidateName);
      candAttacks += candStat.attacksMade;
      candAttackWins += candStat.attacksWon;
    }
  }
  /*
   * A run with zero completed games (every match failed but stayed under the abort
   * threshold) would make win% = 0/0 = NaN, which classifyGate silently reads as a
   * TIE. Fail loud instead of grading a broken run.
   */
  if (games === 0) {
    console.error(
      `\nGate aborted: run ${run + 1} completed 0 of ${gamesPerRunActual} attempted games ` +
        `— win% (and the verdict) would be NaN.`
    );
    process.exit(1);
  }
  candWin.push((candWins / games) * 100);
  barWin.push((barWins / games) * 100);
  candAtkWin.push(candAttacks > 0 ? candAttackWins / candAttacks : 0);
  process.stdout.write(`\rRuns: ${run + 1}/${runCount}`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nCompleted in ${elapsed}s${failedGames ? ` (${failedGames} games failed)` : ''}\n`);

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
    `test at α≈0.025). Bar = ${barName}@${LOOKAHEAD_PIN} (in-repo HEAD differs only in ` +
    `comments — behaviorally pinned). A small true edge needs more --runs to clear the CI.`
);
