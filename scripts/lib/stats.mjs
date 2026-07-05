/**
 * Small-sample statistics shared by the arena sweep + ml-bot gate scripts.
 *
 * Each "run" in a sweep is one independent seed block; we report the mean across
 * runs with a 95% confidence half-width using Student's t (the run count is small,
 * so the normal approximation under-covers). Extracted here so `arena-sweep.mjs`,
 * `_probe-capacity-arena.mjs`, and `ppo-gate.mjs` share one implementation.
 *
 * @module scripts/lib/stats
 */

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

/**
 * 95% t critical value for `df` degrees of freedom. For df > 30 the t
 *  distribution is close enough to normal to use 1.96. (Approximation note: at
 *  df 31 the exact quantile is 2.040, so a CI-excludes-0 test built on this
 *  fallback runs at an effective one-sided ≈ 0.03 rather than 0.025 — every
 *  registered gate/signature budget is ≤ 20 runs and unaffected; a > 31-run
 *  protocol should extend the table or invert `tSf` instead.)
 */
export const tCrit = df => T95[df] ?? 1.96;

// One-sided α = 0.05 Student's t critical values (= the two-sided 90% quantile),
// df = runs - 1. Used by the strength-curve run-paired regression/plateau tests
// ([D-29]), which are directional by design — the two-sided T95 table above would
// test them at an effective α of 0.025 per side.
const T95_ONE_SIDED = {
  1: 6.314,
  2: 2.92,
  3: 2.353,
  4: 2.132,
  5: 2.015,
  6: 1.943,
  7: 1.895,
  8: 1.86,
  9: 1.833,
  10: 1.812,
  11: 1.796,
  12: 1.782,
  13: 1.771,
  14: 1.761,
  15: 1.753,
  16: 1.746,
  17: 1.74,
  18: 1.734,
  19: 1.729,
  20: 1.725,
  21: 1.721,
  22: 1.717,
  23: 1.714,
  24: 1.711,
  25: 1.708,
  26: 1.706,
  27: 1.703,
  28: 1.701,
  29: 1.699,
  30: 1.697,
};

/**
 * One-sided α = 0.05 t critical value for `df` degrees of freedom. For df > 30
 *  falls back to the normal approximation 1.645.
 */
export const tCritOneSided = df => T95_ONE_SIDED[df] ?? 1.645;

/** Plain arithmetic mean of a sample array. */
export const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Mean and standard error for a sample array (the shared primitive under
 * {@link meanCi} and the one-sided curve tests).
 * @param {number[]} values - one entry per independent run
 * @returns {{ mean: number, se: number, n: number }}
 */
export function meanSe(values) {
  const n = values.length;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return { mean: m, se: Math.sqrt(variance) / Math.sqrt(n), n };
}

/**
 * Mean and 95% confidence half-width for a sample array.
 * @param {number[]} values - one entry per independent run
 * @returns {{ mean: number, ci: number }}
 */
export function meanCi(values) {
  const { mean: m, se, n } = meanSe(values);
  return { mean: m, ci: tCrit(n - 1) * se };
}

// --- Exact Student-t tail probability -------------------------------------------------------
//
// The Holm step-down across the persona confirmatory family (EVAL_HARNESS §3.3) needs real
// p-values, not just the fixed-α critical values above: its per-rank thresholds α/(m−rank+1)
// land at arbitrary levels no lookup table covers. Standard construction: the t survival
// function via the regularized incomplete beta, computed with a Lanczos log-gamma and a
// modified-Lentz continued fraction. Pinned against scipy.stats.t.sf to ~1e-8 in stats.test.js
// (plus the closed forms at df=1/2 and both critical-value tables above as cross-checks).

// Lanczos approximation coefficients (g = 7, n = 9) for lnGamma.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Natural log of the gamma function (Lanczos; |error| < 1e-13 on the domain used here). */
function lnGamma(x) {
  if (x < 0.5) {
    // Reflection formula keeps the approximation on its accurate half-line.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  let acc = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) acc += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

/** Continued fraction for the regularized incomplete beta (modified Lentz). */
function betacf(x, a, b) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) return h;
  }
  // Unreachable for the t-distribution's (a = df/2, b = 1/2) domain; fail loud, never return a
  // half-converged tail probability.
  throw new Error(`betacf: no convergence (x=${x}, a=${a}, b=${b})`);
}

/** Regularized incomplete beta I_x(a, b), the CDF of the beta distribution. */
function regIncBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  // Use the continued fraction on whichever side converges fast, mirror on the other.
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(x, a, b)) / a;
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

/**
 * Student-t upper-tail probability P(T ≥ t) at `df` degrees of freedom — the one-sided
 * p-value of an observed t statistic. Exact for any df ≥ 1 (no table, no normal cutover).
 *
 * @param {number} t  - observed t statistic
 * @param {number} df - degrees of freedom (> 0)
 * @returns {number} P(T ≥ t) ∈ [0, 1]
 */
export function tSf(t, df) {
  if (!Number.isFinite(t)) throw new Error(`tSf: t must be finite (got ${t})`);
  if (!Number.isFinite(df) || df <= 0) {
    throw new Error(`tSf: df must be a positive finite number (got ${df})`);
  }
  // P(|T| ≥ |t|) = I_x(df/2, 1/2) with x = df/(df + t²); halve for one tail, mirror for t < 0.
  const halfTail = 0.5 * regIncBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? halfTail : 1 - halfTail;
}

/**
 * Holm–Bonferroni step-down adjustment over a family of named tests (EVAL_HARNESS §3.3).
 *
 * Controls family-wise error at `alpha` with no independence assumption. `familySize` is the
 * REGISTERED family size m — it may exceed the tests supplied (grading two of a registered
 * four-persona family still adjusts as m = 4; the unrun tests simply cannot reject), but never
 * the reverse: silently shrinking m is the classic way to un-adjust a family, so that throws.
 * A test with `p: null` (not computable — e.g. a persona with no comparable data) stays in the
 * family and can never reject.
 *
 * Decision rule: reject ⇔ pAdj ≤ alpha, where pAdj is the monotone step-down adjusted p-value
 * pAdj_(i) = max_(j ≤ i) min(1, (m − j + 1) · p_(j)) over the ascending-p order — algebraically
 * identical to the textbook "reject while p_(i) ≤ α/(m − i + 1), stop at the first failure".
 *
 * @param {Array<{name: string, p: number|null}>} tests
 * @param {{ alpha?: number, familySize?: number }} [opts]
 * @returns {Array<{name: string, p: number|null, pAdj: number|null, threshold: number|null,
 *   rank: number|null, reject: boolean}>} in the input order
 */
export function holmAdjust(tests, { alpha = 0.05, familySize = tests.length } = {}) {
  if (!Array.isArray(tests) || tests.length === 0) {
    throw new Error('holmAdjust: tests must be a non-empty array');
  }
  const names = tests.map(t => t?.name);
  if (names.some(n => typeof n !== 'string' || n === '')) {
    throw new Error('holmAdjust: every test needs a non-empty string name');
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`holmAdjust: duplicate test names in [${names.join(', ')}]`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error(`holmAdjust: alpha must be in (0, 1) (got ${alpha})`);
  }
  if (!Number.isInteger(familySize) || familySize < tests.length) {
    throw new Error(
      `holmAdjust: familySize (${familySize}) must be an integer >= the ${tests.length} supplied ` +
        `test(s) — the registered family may exceed the tests run this session, never the reverse`
    );
  }
  for (const t of tests) {
    if (t.p == null) continue;
    if (!Number.isFinite(t.p) || t.p < 0 || t.p > 1) {
      throw new Error(`holmAdjust: test "${t.name}" has invalid p ${t.p} (need null or 0..1)`);
    }
  }
  const scored = tests.filter(t => t.p != null).map(t => ({ name: t.name, p: t.p }));
  scored.sort((x, y) => x.p - y.p);
  const byName = new Map();
  let runningAdj = 0;
  scored.forEach((t, i) => {
    const rank = i + 1;
    runningAdj = Math.max(runningAdj, Math.min(1, (familySize - rank + 1) * t.p));
    byName.set(t.name, {
      p: t.p,
      pAdj: runningAdj,
      threshold: alpha / (familySize - rank + 1),
      rank,
      reject: runningAdj <= alpha,
    });
  });
  return tests.map(t => ({
    name: t.name,
    ...(byName.get(t.name) ?? { p: null, pAdj: null, threshold: null, rank: null, reject: false }),
  }));
}
