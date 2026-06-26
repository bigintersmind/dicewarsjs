/**
 * Small-sample statistics (`scripts/lib/stats.mjs`) — the engine behind every
 * arena-sweep CI and every BEAT/TIE/BEHIND gate verdict.
 *
 * It had no direct test: its only exercise was a zero-variance case through the gate,
 * which multiplies the variance / stderr / t-critical machinery by 0 and asserts
 * nothing. These pin the t-table, the Bessel (n-1) correction, and the 1/√n stderr
 * against hand-computed values so a transcription slip can't silently reshape the CIs.
 */
import { mean, meanCi, tCrit } from '../../scripts/lib/stats.mjs';

describe('mean', () => {
  it('is the plain arithmetic mean', () => {
    expect(mean([10, 12, 14])).toBeCloseTo(12, 10);
    expect(mean([5])).toBe(5);
  });
});

describe('tCrit', () => {
  it('returns the tabulated 95% two-sided value for small df', () => {
    expect(tCrit(1)).toBe(12.706);
    expect(tCrit(2)).toBe(4.303);
    expect(tCrit(19)).toBe(2.093); // df for the default 20-run gate
    expect(tCrit(30)).toBe(2.042); // last tabulated row
  });

  it('falls back to the normal approximation (1.96) for df > 30', () => {
    expect(tCrit(31)).toBe(1.96);
    expect(tCrit(50)).toBe(1.96);
    expect(tCrit(1000)).toBe(1.96);
  });
});

describe('meanCi', () => {
  it('matches a hand-computed mean + 95% t half-width', () => {
    /*
     * sample [10, 12, 14]: mean 12, deviations ∓2/0/±2 → Σ(x−m)² = 8.
     * var = 8 / (n−1=2) = 4, sd = 2, stderr = 2/√3 = 1.154700…,
     * df = 2 → tCrit 4.303, ci = 4.303 × 1.154700 = 4.968676…
     */
    const { mean: m, ci } = meanCi([10, 12, 14]);
    expect(m).toBeCloseTo(12, 10);
    expect(ci).toBeCloseTo(4.968676, 5);
  });

  it('uses the Bessel-corrected (n−1) variance, not the population variance', () => {
    /*
     * Population variance (÷n) would give ci = 4.303 × √(8/3)/√3 = 4.0569.
     * The n−1 path gives 4.9687 — so a value > 4.5 proves Bessel correction.
     */
    const { ci } = meanCi([10, 12, 14]);
    expect(ci).toBeGreaterThan(4.5);
  });

  it('uses the 1.96 normal approximation through meanCi for df > 30', () => {
    /*
     * 32 points alternating 10/14: mean 12, each deviation ±2 → Σ(x−m)² = 128.
     * var = 128/31, sd = 2.0321, stderr = sd/√32 = 0.35921, df = 31 → tCrit 1.96,
     * ci = 1.96 × 0.35921 = 0.70405 — pins the whole formula on the fallback branch.
     */
    const sample = Array.from({ length: 32 }, (_, i) => (i % 2 === 0 ? 10 : 14));
    const { mean: m, ci } = meanCi(sample);
    expect(m).toBeCloseTo(12, 10);
    expect(ci).toBeCloseTo(0.7041, 3);
  });
});
