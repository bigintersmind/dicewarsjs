/**
 * PPO throughput-probe pure helpers (ml-bot Phase 3 — [D-19], tracer step 3).
 *
 * Unit-tests only the deterministic, pure pieces of the probe (PRNG, stub action selector,
 * histogram percentiles, MAX_EDGES recommendation, episode sharding). The heavy throughput
 * RUN (runProbeShard / runSelfPlayEpisode) is intentionally NOT exercised here — it's a
 * measurement script, run via `npm run ppo:throughput-probe`, kept out of the unit suite.
 */

import {
  mulberry32,
  makeStubChooseAction,
  percentilesFromHist,
  recommendMaxEdges,
  splitEpisodes,
  mergeShards,
} from '../../scripts/lib/ppo-probe-core.mjs';

describe('mulberry32', () => {
  it('is deterministic for a given seed and varies across seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);

    const c = mulberry32(43);
    expect([c(), c(), c()]).not.toEqual(seqA);
  });
});

describe('makeStubChooseAction', () => {
  it('random: returns an in-range legal index, deterministic given the PRNG', () => {
    const pick1 = makeStubChooseAction('random', mulberry32(7));
    const pick2 = makeStubChooseAction('random', mulberry32(7));
    for (const n of [1, 2, 5, 64, 130]) {
      const encoded = { moves: new Array(n) };
      const i = pick1(encoded);
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(n);
      expect(pick2({ moves: new Array(n) })).toBe(i); // same PRNG → same picks
    }
  });

  it('stop: always returns the trailing STOP index (numEdges - 1)', () => {
    const pick = makeStubChooseAction('stop');
    expect(pick({ moves: new Array(1) })).toBe(0);
    expect(pick({ moves: new Array(8) })).toBe(7);
  });

  it('rejects an unknown mode', () => {
    expect(() => makeStubChooseAction('greedy')).toThrow(/unknown learner mode/);
  });
});

describe('percentilesFromHist', () => {
  it('computes nearest-rank percentiles, max, and mean', () => {
    const hist = new Array(60).fill(0);
    hist[2] = 10;
    hist[5] = 80;
    hist[50] = 10; // total 100
    const p = percentilesFromHist(hist, [50, 90, 99, 100]);
    expect(p.total).toBe(100);
    expect(p[50]).toBe(5);
    expect(p[90]).toBe(5);
    expect(p[99]).toBe(50);
    expect(p[100]).toBe(50);
    expect(p.max).toBe(50);
    expect(p.mean).toBeCloseTo(9.2, 6);
  });

  it('handles an empty histogram', () => {
    const p = percentilesFromHist(new Array(10).fill(0), [50, 100]);
    expect(p.total).toBe(0);
    expect(p[50]).toBe(0);
    expect(p[100]).toBe(0);
    expect(p.max).toBe(0);
  });
});

describe('recommendMaxEdges', () => {
  it('returns the next power of two ≥ p100 (min 8)', () => {
    expect(recommendMaxEdges(5)).toBe(8);
    expect(recommendMaxEdges(50)).toBe(64);
    expect(recommendMaxEdges(64)).toBe(64);
    expect(recommendMaxEdges(65)).toBe(128);
    expect(recommendMaxEdges(128)).toBe(128);
    expect(recommendMaxEdges(129)).toBe(256);
  });
});

describe('splitEpisodes', () => {
  it('splits into contiguous balanced chunks that sum to the total', () => {
    expect(splitEpisodes(300, 6)).toEqual([50, 50, 50, 50, 50, 50]);
    expect(splitEpisodes(301, 6)).toEqual([51, 50, 50, 50, 50, 50]);
    const tiny = splitEpisodes(5, 8);
    expect(tiny.reduce((a, b) => a + b, 0)).toBe(5);
    expect(tiny).toEqual([1, 1, 1, 1, 1, 0, 0, 0]);
  });
});

describe('mergeShards', () => {
  it('sums histograms, scalars, and per-bot timing; never carries elapsedMs', () => {
    const s1 = {
      elapsedMs: 100,
      learnerDecisions: 10,
      totalTurns: 5,
      episodesRun: 2,
      wins: 1,
      eliminations: 1,
      overflow: 0,
      hist: [0, 1, 2],
      botMs: { ai_bc: 3 },
      botCalls: { ai_bc: 6 },
    };
    const s2 = {
      elapsedMs: 200,
      learnerDecisions: 20,
      totalTurns: 7,
      episodesRun: 3,
      wins: 0,
      eliminations: 2,
      overflow: 1,
      hist: [1, 0, 4, 5],
      botMs: { ai_bc: 2, ai_lookahead: 9 },
      botCalls: { ai_bc: 4, ai_lookahead: 3 },
    };
    const m = mergeShards([s1, s2]);
    expect(m.learnerDecisions).toBe(30);
    expect(m.totalTurns).toBe(12);
    expect(m.episodesRun).toBe(5);
    expect(m.wins).toBe(1);
    expect(m.eliminations).toBe(3);
    expect(m.overflow).toBe(1);
    expect(m.hist).toEqual([1, 1, 6, 5]); // element-wise, ragged lengths zero-extended
    expect(m.botMs).toEqual({ ai_bc: 5, ai_lookahead: 9 });
    expect(m.botCalls).toEqual({ ai_bc: 10, ai_lookahead: 3 });
    expect(m).not.toHaveProperty('elapsedMs'); // wall-clock is measured by the caller, not summed
  });

  it('coalesces a shard missing the eliminations field (older shard shape) to 0', () => {
    // prettier-ignore
    const base = {
      learnerDecisions: 1, totalTurns: 1, episodesRun: 1, wins: 0,
      overflow: 0, hist: [1], botMs: {}, botCalls: {},
    };
    const a = { ...base }; // no eliminations field
    const b = { ...base, eliminations: 2 };
    expect(mergeShards([a, b]).eliminations).toBe(2); // a.eliminations === undefined → +0, not NaN
  });
});
