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
 *  distribution is close enough to normal to use 1.96.
 */
export const tCrit = df => T95[df] ?? 1.96;

/** Plain arithmetic mean of a sample array. */
export const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Mean and 95% confidence half-width for a sample array.
 * @param {number[]} values - one entry per independent run
 * @returns {{ mean: number, ci: number }}
 */
export function meanCi(values) {
  const n = values.length;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  const stdErr = Math.sqrt(variance) / Math.sqrt(n);
  return { mean: m, ci: tCrit(n - 1) * stdErr };
}
