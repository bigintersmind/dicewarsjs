/**
 * Small-sample statistics (`scripts/lib/stats.mjs`) — the engine behind every
 * arena-sweep CI and every BEAT/TIE/BEHIND gate verdict.
 *
 * It had no direct test: its only exercise was a zero-variance case through the gate,
 * which multiplies the variance / stderr / t-critical machinery by 0 and asserts
 * nothing. These pin the t-table, the Bessel (n-1) correction, and the 1/√n stderr
 * against hand-computed values so a transcription slip can't silently reshape the CIs.
 */
import { mean, meanCi, tCrit, tCritOneSided, tSf, holmAdjust } from '../../scripts/lib/stats.mjs';

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

describe('tSf — exact Student-t upper-tail probability', () => {
  it('matches scipy.stats.t.sf reference values to ~1e-8', () => {
    // Generated with scipy 1.13.1 (see the PR notes); pins the Lanczos + continued-fraction path.
    const REF = [
      [2.262, 9, 0.0250064228],
      [1.833, 9, 0.05000897],
      [12.706, 1, 0.0250004012],
      [1.0, 2, 0.2113248654],
      [2.5, 4, 0.0333832724],
      [0.5, 7, 0.3162035678],
      [3.3, 19, 0.0018826754],
      [-1.5, 6, 0.9078596319],
      [4.2426406871, 4, 0.0066177998],
    ];
    for (const [t, df, p] of REF) {
      expect(tSf(t, df)).toBeCloseTo(p, 8);
    }
  });

  it('matches the closed forms at df=1 (Cauchy) and df=2', () => {
    // df=1: P(T ≥ t) = 1/2 − atan(t)/π; df=2: P(T ≥ t) = (1 − t/√(2+t²))/2.
    for (const t of [0.3, 1, 2.5, 7]) {
      expect(tSf(t, 1)).toBeCloseTo(0.5 - Math.atan(t) / Math.PI, 12);
      expect(tSf(t, 2)).toBeCloseTo(0.5 * (1 - t / Math.sqrt(2 + t * t)), 12);
    }
    expect(tSf(1, 1)).toBeCloseTo(0.25, 12); // the textbook Cauchy quartile
  });

  it('inverts both critical-value tables (the internal consistency check)', () => {
    // tCrit is the two-sided 95% quantile ⇒ upper tail 0.025; tCritOneSided ⇒ 0.05. The
    // tables are rounded to 3 decimals, so agreement to ~1e-4 pins both against tSf.
    for (let df = 1; df <= 30; df++) {
      expect(tSf(tCrit(df), df)).toBeCloseTo(0.025, 4);
      expect(tSf(tCritOneSided(df), df)).toBeCloseTo(0.05, 4);
    }
  });

  it('is symmetric, anchored at 0.5 for t=0, and normal in the large-df limit', () => {
    for (const [t, df] of [
      [1.7, 5],
      [0.4, 12],
      [3.1, 28],
    ]) {
      expect(tSf(-t, df)).toBeCloseTo(1 - tSf(t, df), 12);
    }
    expect(tSf(0, 7)).toBeCloseTo(0.5, 12);
    expect(tSf(1.6449, 1e6)).toBeCloseTo(0.0499953746, 8); // ≈ the normal 5% quantile
  });

  it('is monotone decreasing in t', () => {
    let prev = 1;
    for (const t of [-3, -1, 0, 0.5, 1, 2, 4, 10]) {
      const p = tSf(t, 9);
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it('throws on non-finite t and invalid df (never a silent NaN tail)', () => {
    expect(() => tSf(NaN, 5)).toThrow(/t must be finite/);
    expect(() => tSf(Infinity, 5)).toThrow(/t must be finite/);
    expect(() => tSf(1, 0)).toThrow(/df must be a positive/);
    expect(() => tSf(1, -2)).toThrow(/df must be a positive/);
    expect(() => tSf(1, NaN)).toThrow(/df must be a positive/);
  });
});

describe('holmAdjust — Holm–Bonferroni step-down over a named family', () => {
  it('matches the hand-worked 4-test example (rank thresholds, adjusted p, decisions)', () => {
    /*
     * p = [0.01, 0.04, 0.03, 0.005], m = 4, α = 0.05. Ascending: 0.005, 0.01, 0.03, 0.04.
     * Thresholds α/(m−rank+1): 0.0125, 0.0167, 0.025, 0.05.
     * Step-down: 0.005 ✓, 0.01 ✓, 0.03 ✗ STOP (0.04 blocked despite 0.04 ≤ 0.05).
     * pAdj (monotone max of (m−rank+1)·p): 0.02, 0.03, 0.06, 0.06.
     */
    const out = holmAdjust([
      { name: 'A', p: 0.01 },
      { name: 'B', p: 0.04 },
      { name: 'C', p: 0.03 },
      { name: 'D', p: 0.005 },
    ]);
    expect(out.map(r => r.name)).toEqual(['A', 'B', 'C', 'D']); // input order preserved
    expect(out.map(r => r.reject)).toEqual([true, false, false, true]);
    expect(out.map(r => r.rank)).toEqual([2, 4, 3, 1]);
    const byName = Object.fromEntries(out.map(r => [r.name, r]));
    expect(byName.D.pAdj).toBeCloseTo(0.02, 12);
    expect(byName.A.pAdj).toBeCloseTo(0.03, 12);
    expect(byName.C.pAdj).toBeCloseTo(0.06, 12);
    expect(byName.B.pAdj).toBeCloseTo(0.06, 12); // monotone: never below an earlier rank
    expect(byName.D.threshold).toBeCloseTo(0.0125, 12);
    expect(byName.B.threshold).toBeCloseTo(0.05, 12);
  });

  it('a mid-family failure blocks every later rank (step-down, not per-rank Bonferroni)', () => {
    // Sorted: 0.001 ✓ (thr 0.0167), 0.026 ✗ (thr 0.025) — so 0.03 is NOT rejected even
    // though its own raw p (0.03) is under its own rank threshold (0.05).
    const out = holmAdjust([
      { name: 'A', p: 0.001 },
      { name: 'B', p: 0.026 },
      { name: 'C', p: 0.03 },
    ]);
    expect(out.map(r => r.reject)).toEqual([true, false, false]);
    expect(out.find(r => r.name === 'C').pAdj).toBeCloseTo(0.052, 12); // inherits B's 2×0.026
  });

  it('honors a registered familySize larger than the tests supplied', () => {
    // One graded test of a registered 4-family: rank-1 threshold is α/4, not α.
    const [only] = holmAdjust([{ name: 'Blitz', p: 0.02 }], { familySize: 4 });
    expect(only.threshold).toBeCloseTo(0.0125, 12);
    expect(only.pAdj).toBeCloseTo(0.08, 12);
    expect(only.reject).toBe(false); // would have "passed" un-adjusted at α = 0.05
  });

  it('a null p stays in the family but never rejects and never consumes a rank', () => {
    const out = holmAdjust([
      { name: 'A', p: 0.01 },
      { name: 'B', p: null },
    ]);
    expect(out[1]).toMatchObject({ name: 'B', p: null, pAdj: null, rank: null, reject: false });
    // A is still adjusted at m = 2 (the family includes the unscored test).
    expect(out[0].threshold).toBeCloseTo(0.025, 12);
    expect(out[0].reject).toBe(true);
  });

  it('handles tied p-values without dropping either', () => {
    const out = holmAdjust([
      { name: 'A', p: 0.02 },
      { name: 'B', p: 0.02 },
    ]);
    expect(out.map(r => r.reject)).toEqual([true, true]); // pAdj = 0.04 for both
    expect(out[0].pAdj).toBeCloseTo(0.04, 12);
    expect(out[1].pAdj).toBeCloseTo(0.04, 12);
  });

  it('rejects invalid input loudly (family shrink, duplicates, bad p, bad alpha)', () => {
    const two = [
      { name: 'A', p: 0.01 },
      { name: 'B', p: 0.02 },
    ];
    expect(() => holmAdjust(two, { familySize: 1 })).toThrow(/never the reverse/);
    expect(() =>
      holmAdjust([
        { name: 'A', p: 0.01 },
        { name: 'A', p: 0.02 },
      ])
    ).toThrow(/duplicate test names/);
    expect(() => holmAdjust([{ name: 'A', p: 1.5 }])).toThrow(/invalid p/);
    expect(() => holmAdjust([{ name: 'A', p: NaN }])).toThrow(/invalid p/);
    expect(() => holmAdjust([{ name: '', p: 0.5 }])).toThrow(/non-empty string name/);
    expect(() => holmAdjust([])).toThrow(/non-empty array/);
    expect(() => holmAdjust(two, { alpha: 0 })).toThrow(/alpha/);
    expect(() => holmAdjust(two, { alpha: 1 })).toThrow(/alpha/);
  });
});
