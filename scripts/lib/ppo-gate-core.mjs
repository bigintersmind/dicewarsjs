/**
 * Pure logic for the Phase-3 PPO headline gate — kept out of the CLI so it is unit
 * testable without spinning up an arena.
 *
 * The gate (PLAN step 7 / the phase evaluation gate): a candidate policy must beat
 * `ai_lookahead` on `arena:sweep` **win%** with a **statistically significant**
 * edge, seat/turn-order controlled. We measure both bots in the *same* games over
 * the same seed blocks, so the per-run difference is **paired** — a far tighter
 * test of "is the candidate actually ahead" than comparing two independent CIs.
 * Judge on win%, never ELO (ELO rewards survival/placement; see RESULTS.md).
 *
 * @module scripts/lib/ppo-gate-core
 */

import { meanCi } from './stats.mjs';

/**
 * The bar the gate is measured against (pinned per [D-7]). The in-repo
 *  `ai_lookahead` differs from this SHA only in comments (verified), so it is the
 *  behavioral bar — RESULTS.md already treats it as `@596f781`.
 */
export const LOOKAHEAD_PIN = '596f781';

/**
 * Default display name for the gate candidate. Must NOT collide with any
 * `BUILT_IN_BOTS` name: since PR #74 seated `ai_ppo` ("PPO") in the gate field as
 * the strength baseline (an arrangement [D-27] kept), the old default of 'PPO' made
 * a bare `npm run ppo:gate` throw at field construction. Pinned against the real
 * registry by `tests/scripts/ppoGateCore.test.js`.
 */
export const DEFAULT_CANDIDATE_NAME = 'Candidate';

/**
 * Mean + 95% CI of the per-run paired difference `a[i] - b[i]`.
 *
 * @param {number[]} a - candidate per-run win% (one entry per seed block)
 * @param {number[]} b - bar (Lookahead) per-run win%, same blocks/order
 * @returns {{ mean: number, ci: number, lo: number, hi: number }}
 */
export function pairedDelta(a, b) {
  if (a.length !== b.length) {
    throw new Error(`pairedDelta: length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length < 2) {
    throw new Error('pairedDelta: need >= 2 runs for a confidence interval');
  }
  const diffs = a.map((v, i) => v - b[i]);
  const { mean, ci } = meanCi(diffs);
  return { mean, ci, lo: mean - ci, hi: mean + ci };
}

/**
 * Classify the gate outcome from a paired-delta CI.
 *
 * - `BEAT`   — the whole 95% CI is above 0 → a significant win% edge (gate PASSES).
 * - `BEHIND` — the whole 95% CI is below 0 → significantly worse than the bar.
 * - `TIE`    — the CI straddles 0 → no significant edge either way.
 *
 * @param {{ lo: number, hi: number }} delta - from {@link pairedDelta}
 * @returns {'BEAT'|'TIE'|'BEHIND'}
 */
export function classifyGate({ lo, hi }) {
  if (lo > 0) return 'BEAT';
  if (hi < 0) return 'BEHIND';
  return 'TIE';
}

/** Minimum match attempts before the failure-rate abort can trip (need a trend first). */
export const ABORT_MIN_ATTEMPTS = 5;

/**
 * Whether the gate should abort mid-sweep because matches are failing en masse.
 *
 * True once enough matches have been *attempted* (>= {@link ABORT_MIN_ATTEMPTS}) AND
 * more than half of those attempts threw. The denominator is real attempts
 * (successes + failures), NOT successes — a successes-only count stays pinned when
 * every match in a run fails, which would let a catastrophic run slip past the guard
 * and push a NaN win% into the verdict (`classifyGate` would then read NaN as a TIE).
 *
 * @param {number} failed - matches that threw so far (cumulative across the sweep)
 * @param {number} attempts - matches tried so far, success or fail (cumulative)
 * @returns {boolean}
 */
export function shouldAbort(failed, attempts) {
  return attempts >= ABORT_MIN_ATTEMPTS && failed / attempts > 0.5;
}

/** Human-readable one-liner for a gate verdict. */
export function verdictLine(verdict, delta) {
  const d = `${delta.mean >= 0 ? '+' : ''}${delta.mean.toFixed(1)} ± ${delta.ci.toFixed(1)} pp`;
  switch (verdict) {
    case 'BEAT':
      return `✅ BEAT — candidate is significantly ahead of the bar (Δwin% ${d}, CI above 0). Gate PASSES.`;
    case 'BEHIND':
      return `❌ BEHIND — candidate is significantly behind the bar (Δwin% ${d}, CI below 0).`;
    default:
      return `~ TIE — no significant win% edge (Δwin% ${d}, CI spans 0). Gate is OPEN.`;
  }
}

/**
 * Build the gate field: the built-in heuristic + PPO bots with the BC clone and the
 * shippable personas dropped, plus the candidate in its place. Dropping `ai_bc` (a
 * near-identical clone) and the `persona`-tagged bots (Conqueror/Blitz/Survivor — these
 * are challengers measured AGAINST the field, not part of it) keeps the field at 8 seats
 * (one full FFA table), so the documented gate baselines stay fixed as personas are added.
 *
 * @param {Array<{ name: string, fn: Function }>} builtInBots - BUILT_IN_BOTS
 * @param {Function} candidateFn - the candidate move fn (makeBC result)
 * @param {string} candidateName - display name (e.g. 'Candidate'; must not collide
 *   with a built-in name — 'PPO' is taken by the seated baseline since [D-27])
 * @param {string} [barName='Lookahead'] - the bar's display name; asserted present
 * @returns {Array<{ name: string, fn: Function }>}
 */
export function buildGateField(builtInBots, candidateFn, candidateName, barName = 'Lookahead') {
  const base = builtInBots
    .filter(b => b.name !== 'BC' && !b.persona)
    .map(b => ({ name: b.name, fn: b.fn }));
  if (!base.some(b => b.name === barName)) {
    throw new Error(`gate bar "${barName}" missing from the built-in field`);
  }
  if (base.some(b => b.name === candidateName)) {
    throw new Error(`candidate name "${candidateName}" collides with a built-in bot`);
  }
  return [...base, { name: candidateName, fn: candidateFn }];
}

/**
 * Counterbalanced seat assignment: seat `s` (0..N-1) is occupied by
 * `field[(s - r + N) % N]` under rotation `r`. Replaying one seed through all N
 * rotations puts every bot in every seat exactly once, so seat/territory advantage
 * (MapGenerator assigns territory by seat index) cancels — the "seat-fair" the gate
 * requires. Mirrors `scripts/_baseline.mjs`'s rotation (the established Phase-0 gate
 * methodology), so the PPO gate is measured the same way the shipped bots were.
 *
 * @template T
 * @param {T[]} field - the bots in field order
 * @param {number} r - rotation index (0..field.length-1)
 * @returns {T[]} the rotated seating
 */
export function rotatedField(field, r) {
  const n = field.length;
  const out = new Array(n);
  for (let s = 0; s < n; s++) out[s] = field[(((s - r) % n) + n) % n];
  return out;
}

/**
 * The actionable "no weights yet" message — the exact commands that produce
 * `src/ai/ppoPolicyWeights.js` from a trained PPO checkpoint.
 * @param {string} weightsPath
 * @returns {string}
 */
export function missingWeightsHelp(weightsPath) {
  return [
    `No PPO weights at ${weightsPath}. Produce them from a trained PPO checkpoint first:`,
    '',
    '  1. (shodan / a box with torch+sb3-contrib) run the PPO tracer → repacked BC-format .pt:',
    '       python -m dicewars_ppo.train_tracer \\',
    '         --checkpoint checkpoints/v2-base/bc_model.pt --out checkpoints/ppo-tracer.pt',
    '',
    '  2. (a box with torch) export the repacked checkpoint to JS weights + parity fixture:',
    '       npm run ppo:export',
    '       # = python -m dicewars_bc.export_weights --ckpt checkpoints/ppo-tracer.pt \\',
    '       #     --out ../src/ai/ppoPolicyWeights.js --fixture ../tests/fixtures/bc/ppoForwardCases.json',
    '',
    '  3. (here) re-run the gate:  npm run ppo:gate',
  ].join('\n');
}
