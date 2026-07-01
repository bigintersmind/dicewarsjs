#!/usr/bin/env node

/**
 * ML Round-Robin — a seat-fair free-for-all (FFA) sweep among a chosen set of bots.
 *
 * Why this exists (and why `arena:sweep` isn't enough for ranking the ML bots against
 * each other): `matchRunner` maps `bots[i] → seat i`, and `MapGenerator` hands out
 * territory by seat index, so seat/turn-order advantage is large — replaying ONE seed
 * through the N cyclic seat rotations can hand the win to a different bot each time.
 * `arena:sweep` keeps seats fixed, so its ranking is partly a seat artifact. This script
 * borrows the **seat-fair** methodology proven in `ppo:gate`/`_baseline.mjs` — every seed
 * is played through all N seat rotations so each bot occupies each seat exactly once — and
 * generalizes the gate's *paired* per-run delta to an entire field:
 *
 *   - a per-bot table of **win%**, **avg placement**, and **top-2 rate**, each with a 95%
 *     CI over independent seed blocks (Student's t);
 *   - a full **pairwise paired-Δ win%** matrix — because all bots play the SAME games over
 *     the SAME seed blocks, every A-vs-B comparison is paired (a far tighter test than two
 *     independent CIs), exactly like the gate.
 *
 * Judge on **win%** first (the gate's rule per [D-7] — ELO/placement reward survival, which
 * is a different question). Win% and avg placement can disagree, and that disagreement is
 * often the whole story: a survival-tuned net can top the placement/ELO table while a
 * finisher tops outright wins. This harness surfaces both so the split is visible.
 *
 * Calibration probe: `PPO` and `Conqueror` ship the SAME weights (Conqueror = ppo-long under
 * a friendly name). Include both and their paired Δ should sit on ~0 within CI — a built-in
 * check that the sweep is actually seat-fair and has enough samples. A large PPO-vs-Conqueror
 * gap means the run is under-powered or the seat balancing is off, not a real strength signal.
 *
 * Usage:
 *   npm run arena:ml                                   # 5 ML bots, 25 runs x 24 seeds x 5 rot
 *   npm run arena:ml -- --bots BC,PPO,Conqueror,Blitz,Survivor --runs 30 --seeds 30
 *   npm run arena:ml -- --bots BC,PPO,Conqueror,Blitz,Survivor,Lookahead   # + external anchor
 *   npm run arena:ml -- --run-start 25 --runs 25 --out shard.json          # shardable
 *
 * @module scripts/ml-roundrobin
 */

import { writeFileSync } from 'node:fs';

import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { rotatedField, pairedDelta } from './lib/ppo-gate-core.mjs';
import { meanCi } from './lib/stats.mjs';
import { getArg } from './lib/cli-args.mjs';

const args = process.argv.slice(2);

const botsArg = getArg(args, 'bots', 'BC,PPO,Conqueror,Blitz,Survivor');
const runCount = parseInt(getArg(args, 'runs', '25'), 10);
const seedsPerRun = parseInt(getArg(args, 'seeds', '24'), 10);
const runStart = parseInt(getArg(args, 'run-start', '0'), 10);
const maxTurns = parseInt(getArg(args, 'max-turns', '500'), 10);
const outPath = getArg(args, 'out', null);
const label = getArg(args, 'label', 'ml-rr');

if (!Number.isFinite(runCount) || runCount < 2) {
  console.error('Invalid --runs. Need an integer >= 2 (a CI needs >= 2 runs).');
  process.exit(1);
}
if (!Number.isFinite(seedsPerRun) || seedsPerRun < 1) {
  console.error('Invalid --seeds. Must be a positive integer.');
  process.exit(1);
}

// --- Resolve the field (any BUILT_IN_BOTS name, incl. the hidden BC/PPO nets) ----
const names = botsArg
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const field = names.map(n => {
  const b = BUILT_IN_BOTS.find(x => x.name === n);
  if (!b) {
    console.error(`Unknown bot "${n}". Available: ${BUILT_IN_BOTS.map(x => x.name).join(', ')}`);
    process.exit(1);
  }
  return { name: b.name, fn: b.fn };
});

const N = field.length;
if (N < 2) {
  console.error('Need at least 2 bots for a round-robin.');
  process.exit(1);
}

/*
 * Each run is an independent seed block; stride blocks far enough apart that a run's
 * `seedsPerRun` consecutive seeds never collide with the next block. A run's seeds are
 * keyed off the GLOBAL run index (runStart + local) so shards with disjoint --run-start
 * ranges draw disjoint seeds and can be aggregated as if run in one process.
 */
const STRIDE = Math.max(1_000_000, seedsPerRun * N * 1000);
const fairShare = 100 / N;

// Per-run, per-bot metric vectors (one entry per run).
const winPct = Object.fromEntries(field.map(b => [b.name, []]));
const avgPlace = Object.fromEntries(field.map(b => [b.name, []]));
const top2Pct = Object.fromEntries(field.map(b => [b.name, []]));

let attempts = 0; // every match tried (success or fail) — the abort denominator
let failed = 0;
let totalTurns = 0;
let completedGames = 0;
const startTime = Date.now();

for (let run = 0; run < runCount; run++) {
  const globalRun = runStart + run;
  const wins = Object.fromEntries(field.map(b => [b.name, 0]));
  const placeSum = Object.fromEntries(field.map(b => [b.name, 0]));
  const top2 = Object.fromEntries(field.map(b => [b.name, 0]));
  let games = 0;

  for (let s = 0; s < seedsPerRun; s++) {
    const seed = globalRun * STRIDE + s + 1;
    for (let r = 0; r < N; r++) {
      attempts++;
      let res;
      try {
        res = runMatch({ bots: rotatedField(field, r), seed, maxTurns });
      } catch (err) {
        failed++;
        // Count real attempts, not successes: a run where every match throws must still
        // trip the abort rather than pin a successes-only denominator (mirrors ppo:gate).
        if (attempts >= 5 && failed / attempts > 0.5) {
          console.error(`\n[${label}] aborted: ${failed}/${attempts} matches failed (>50%).`);
          process.exit(1);
        }
        console.error(`\n[${label}] match failed (seed ${seed}, rot ${r}): ${err.message}`);
        continue;
      }
      games++;
      completedGames++;
      totalTurns += res.turnCount;
      if (res.winnerName) wins[res.winnerName]++;
      for (const st of res.botStats) {
        placeSum[st.name] += st.placement;
        if (st.placement <= 2) top2[st.name]++;
      }
    }
  }

  if (games === 0) {
    console.error(`\n[${label}] aborted: run ${run + 1} completed 0 games — CI would be NaN.`);
    process.exit(1);
  }
  for (const b of field) {
    winPct[b.name].push((wins[b.name] / games) * 100);
    avgPlace[b.name].push(placeSum[b.name] / games);
    top2Pct[b.name].push((top2[b.name] / games) * 100);
  }
  process.stderr.write(`\r[${label}] runs ${run + 1}/${runCount}`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// --- Per-bot summary (sorted by mean win%) --------------------------------------
const summary = field
  .map(b => ({
    name: b.name,
    win: meanCi(winPct[b.name]),
    place: meanCi(avgPlace[b.name]),
    top2: meanCi(top2Pct[b.name]),
  }))
  .sort((a, b) => b.win.mean - a.win.mean);

// --- Pairwise paired-Δ win% (upper triangle, in field order) --------------------
const pairs = [];
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const a = field[i].name;
    const b = field[j].name;
    const d = pairedDelta(winPct[a], winPct[b]);
    const sig = d.lo > 0 || d.hi < 0; // 95% CI excludes 0
    pairs.push({ a, b, ...d, sig });
  }
}
pairs.sort((x, y) => Math.abs(y.mean) - Math.abs(x.mean));

// --- Print report ----------------------------------------------------------------
console.error(''); // finish the progress line
console.log(
  `\nML round-robin [${label}] — seat-fair FFA, ${N} bots: ${field.map(b => b.name).join(', ')}`
);
console.log(
  `${runCount} runs x ${seedsPerRun} seeds x ${N} rotations = ${runCount * seedsPerRun * N} games ` +
    `(${completedGames} completed${failed ? `, ${failed} failed` : ''}) in ${elapsed}s, ` +
    `avg ${(totalTurns / Math.max(1, completedGames)).toFixed(0)} turns/game`
);
console.log(`Fair-share win% = ${fairShare.toFixed(1)}%  ·  judging on WIN% first (seat-fair)\n`);

const header = ['Rank', 'Bot', 'Win% (95% CI)', 'AvgPlace (95% CI)', 'Top2% (95% CI)'];
const rows = summary.map((r, i) => [
  String(i + 1),
  r.name,
  `${r.win.mean.toFixed(1)} ± ${r.win.ci.toFixed(1)}`,
  `${r.place.mean.toFixed(2)} ± ${r.place.ci.toFixed(2)}`,
  `${r.top2.mean.toFixed(1)} ± ${r.top2.ci.toFixed(1)}`,
]);
const table = [header, ...rows];
const widths = header.map((_, c) => Math.max(...table.map(row => row[c].length)));
const fmt = row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
console.log(fmt(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
rows.forEach(r => console.log(fmt(r)));

console.log(`\nPairwise paired Δ win% (row − col; SIG = 95% CI excludes 0):`);
for (const p of pairs) {
  const d = `${p.mean >= 0 ? '+' : ''}${p.mean.toFixed(1)} ± ${p.ci.toFixed(1)} pp`;
  const flag = p.sig ? 'SIG' : '~ns';
  console.log(`  ${flag}  ${p.a} − ${p.b}: ${d}  [${p.lo.toFixed(1)}, ${p.hi.toFixed(1)}]`);
}

// Calibration: PPO and Conqueror are identical weights — their Δ should sit on ~0.
if (field.some(b => b.name === 'PPO') && field.some(b => b.name === 'Conqueror')) {
  const cal = pairedDelta(winPct.PPO, winPct.Conqueror);
  const ok = cal.lo <= 0 && cal.hi >= 0;
  console.log(
    `\nCalibration (PPO ≡ Conqueror, same weights): Δ ${cal.mean >= 0 ? '+' : ''}` +
      `${cal.mean.toFixed(1)} ± ${cal.ci.toFixed(1)} pp [${cal.lo.toFixed(1)}, ${cal.hi.toFixed(1)}] ` +
      `→ ${ok ? 'OK (CI spans 0, seat-fair holds)' : 'WARN (CI excludes 0 — under-powered or seat bias)'}`
  );
}

// --- Optional machine-readable dump ----------------------------------------------
if (outPath) {
  const payload = {
    label,
    field: field.map(b => b.name),
    config: { runCount, seedsPerRun, runStart, N, maxTurns, gamesPerRun: seedsPerRun * N },
    completedGames,
    failed,
    avgTurns: +(totalTurns / Math.max(1, completedGames)).toFixed(1),
    perRun: { winPct, avgPlace, top2Pct },
    summary: summary.map(r => ({
      name: r.name,
      winMean: r.win.mean,
      winCi: r.win.ci,
      placeMean: r.place.mean,
      placeCi: r.place.ci,
      top2Mean: r.top2.mean,
      top2Ci: r.top2.ci,
    })),
    pairs,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${outPath}`);
}
