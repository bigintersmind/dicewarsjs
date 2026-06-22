#!/usr/bin/env node
/*
 * ml-bot gate harness (D-5): seat-fair sweep + paired significance, e.g.
 * Expectimax vs Strategist. Retained for re-running the gate on future candidates.
 *
 * Provides what `npm run arena:sweep` alone cannot:
 *   1. SEAT-COUNTERBALANCED field sweep — each map seed is replayed through all 7
 *      cyclic seat rotations so every bot occupies every seat equally often.
 *      Removes the residual round-robin seat-count bias (D-5). Reports per-bot
 *      mean win% with 95% t-CIs across runs.
 *   2. PAIRED per-game head-to-head sign test — in every game both bots are
 *      present; compare their placements. Map/seed variance cancels, giving a
 *      high-power significance test that Expectimax out/under-places Strategist.
 *   3. 2-PLAYER deterministic head-to-head (seat-counterbalanced) — isolates the
 *      two bots with no noisy third parties; fully reproducible.
 */
import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { updateEloRatings, DEFAULT_RATING } from '../src/arena/elo.js';
import { makeExpectimax } from '../src/ai/ai_expectimax.js';
import { adaptLegacyBot } from '../src/arena/legacyBotAdapter.js';

const EX = 'Expectimax';

// --- args ---
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
/*
 * Optional candidate override: `--cand '{"baseThreshold":1.2,...}'` swaps the
 * Expectimax slot for makeExpectimax(cfg), so a tuned config can be gated without
 * first landing it in DEFAULT_PARAMS. Omitted ⇒ the shipped ai_expectimax.
 */
const candArg = arg('cand', '');
const field = BUILT_IN_BOTS.map(b =>
  candArg && b.name === EX
    ? { name: EX, fn: adaptLegacyBot(makeExpectimax(JSON.parse(candArg)), EX) }
    : { name: b.name, fn: b.fn }
);
const N = field.length; // 7
/*
 * Reference bot for the paired + 2-player head-to-head tests. Defaults to
 * Lookahead — the gate's opponent of record since D-7 (it is the field-strongest
 * bot). Pass `--vs Strategist` to compare against the secondary reference instead.
 */
const ST = arg('vs', 'Lookahead');
if (!field.some(b => b.name === ST)) {
  throw new Error(`--vs must name a built-in bot (got "${ST}")`);
}
/*
 * Crash loudly on a bad count instead of silently skipping the loop. A
 * non-numeric flag (e.g. `--runs abc`) makes parseInt return NaN, `n < NaN` is
 * false, every loop is skipped, and the script prints a full `NaN ± NaN` table
 * as if it were valid. The strict regex also rejects garbage-suffixed values
 * (`--runs 2O`), which parseInt would otherwise silently truncate to 2.
 */
const intArg = (k, d) => {
  const raw = arg(k, d);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`--${k} must be a positive integer (got "${raw}")`);
  }
  return parseInt(raw, 10);
};
const RUNS = intArg('runs', '20'); // blocks for CI
const SEEDS_PER_RUN = intArg('seeds', '40'); // distinct map seeds per block
const STRIDE = 1_000_000;
/*
 * Offset the seed range by `--seedbase B` (default 0): block r uses seeds
 * (B + r) * STRIDE + 1 .. + SEEDS_PER_RUN. A large offset (e.g. 100) yields maps
 * disjoint from the default range, for independent confirmation of a candidate.
 */
const SEEDBASE = intArg('seedbase', '1') - 1; // intArg requires ≥1; shift so default 1 ⇒ offset 0

// --- stats helpers ---
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
const tCrit = df => T95[df] ?? 1.96;
function meanCi(v) {
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const ci = tCrit(n - 1) * (Math.sqrt(variance) / Math.sqrt(n));
  return { mean, ci };
}
// Standard normal CDF (Abramowitz-Stegun 7.1.26) for the sign-test p-value.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014337 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// seat s (0..N-1) is occupied by field[(s - r + N) % N] under rotation r.
function rotatedField(arr, r) {
  const out = new Array(arr.length);
  for (let s = 0; s < arr.length; s++)
    out[s] = arr[(((s - r) % arr.length) + arr.length) % arr.length];
  return out;
}

// ----- (1)+(2) Seat-counterbalanced FULL FIELD sweep + paired sign test -----
console.log(
  `Seat-counterbalanced field sweep: ${RUNS} runs x ${SEEDS_PER_RUN} seeds x ${N} rotations = ${RUNS * SEEDS_PER_RUN * N} games`
);
const winPctByRun = Object.fromEntries(field.map(b => [b.name, []]));
const eloByName = Object.fromEntries(field.map(b => [b.name, DEFAULT_RATING]));
let exBetter = 0,
  stBetter = 0,
  h2hTie = 0,
  exWinsGame = 0,
  stWinsGame = 0;
const t0 = Date.now();

for (let run = 0; run < RUNS; run++) {
  const wins = Object.fromEntries(field.map(b => [b.name, 0]));
  let games = 0;
  for (let s = 0; s < SEEDS_PER_RUN; s++) {
    const seed = (SEEDBASE + run) * STRIDE + s + 1;
    for (let r = 0; r < N; r++) {
      const bots = rotatedField(field, r);
      const res = runMatch({ bots, seed });
      games++;
      if (res.winnerName) wins[res.winnerName]++;
      // ELO update (sequential, by placement order of names)
      const order = res.placements.map(pi => {
        const bs = res.botStats.find(x => x.playerIndex === pi);
        return { name: bs.name, elo: eloByName[bs.name] };
      });
      for (const u of updateEloRatings(order)) eloByName[u.name] = u.elo;
      // paired head-to-head: placement (lower = better)
      const exP = res.botStats.find(x => x.name === EX).placement;
      const stP = res.botStats.find(x => x.name === ST).placement;
      if (exP < stP) exBetter++;
      else if (stP < exP) stBetter++;
      else h2hTie++;
      if (res.winnerName === EX) exWinsGame++;
      else if (res.winnerName === ST) stWinsGame++;
    }
  }
  for (const b of field) winPctByRun[b.name].push((wins[b.name] / games) * 100);
  process.stdout.write(`\r  run ${run + 1}/${RUNS}`);
}
const secs = (Date.now() - t0) / 1000;
const totalGames = RUNS * SEEDS_PER_RUN * N;
console.log(`\n  done in ${secs.toFixed(0)}s (${(totalGames / secs).toFixed(1)} g/s)\n`);

console.log('Seat-fair marginal win% (95% CI) + path-dependent ELO:');
const rows = field
  .map(b => {
    const w = meanCi(winPctByRun[b.name]);
    return { name: b.name, win: w.mean, ci: w.ci, elo: eloByName[b.name] };
  })
  .sort((a, b) => b.win - a.win);
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(11)} ${r.win.toFixed(1).padStart(5)} ± ${r.ci.toFixed(1).padStart(4)}   elo ${Math.round(r.elo)}`
  );
}
console.log(`  (fair share = ${(100 / N).toFixed(1)}%)\n`);

// paired sign test on ex-vs-st placement (exclude ties)
const nPair = exBetter + stBetter;
const phat = exBetter / nPair;
const z = (exBetter - nPair / 2) / Math.sqrt(nPair / 4);
const pTwoSided = 2 * (1 - normCdf(Math.abs(z)));
console.log(`Paired per-game head-to-head (Expectimax vs ${ST} placement, seat-fair):`);
console.log(
  `  Expectimax placed higher in ${exBetter} games, ${ST} higher in ${stBetter}, ties ${h2hTie}`
);
console.log(
  `  head-to-head win rate (ex / non-ties) = ${(phat * 100).toFixed(1)}%   z = ${z.toFixed(2)}   p(two-sided) = ${pTwoSided.toExponential(2)}`
);
console.log(
  `  outright game wins: Expectimax ${exWinsGame}, ${ST} ${stWinsGame} (of ${totalGames})\n`
);

/*
 * ----- (3) 2-player deterministic head-to-head, seat-counterbalanced -----
 * Use the same field entries as above, so the EX slot honors any --cand override.
 */
const H2H_GAMES = intArg('h2h', '2000');
const pair = [field.find(b => b.name === EX), field.find(b => b.name === ST)];
let exW = 0,
  stW = 0,
  draws = 0;
const t1 = Date.now();
for (let g = 0; g < H2H_GAMES; g++) {
  // counterbalance seats: even g -> [EX,ST], odd g -> [ST,EX]; same seed pairs both orders
  const seed = SEEDBASE * STRIDE + Math.floor(g / 2) + 1;
  const bots = g % 2 === 0 ? pair : [pair[1], pair[0]];
  const res = runMatch({ bots, seed });
  if (res.winnerName === EX) exW++;
  else if (res.winnerName === ST) stW++;
  else draws++;
}
const h2hSecs = (Date.now() - t1) / 1000;
const decided = exW + stW;
const z2 = (exW - decided / 2) / Math.sqrt(decided / 4);
const p2 = 2 * (1 - normCdf(Math.abs(z2)));
console.log(
  `2-player deterministic head-to-head vs ${ST}: ${H2H_GAMES} games (seat-counterbalanced), ${h2hSecs.toFixed(0)}s`
);
console.log(
  `  Expectimax ${exW} wins (${((exW / H2H_GAMES) * 100).toFixed(1)}%), ${ST} ${stW} (${((stW / H2H_GAMES) * 100).toFixed(1)}%), draws ${draws}`
);
console.log(
  `  win rate among decided = ${((exW / decided) * 100).toFixed(1)}%   z = ${z2.toFixed(2)}   p(two-sided) = ${p2.toExponential(2)}`
);
