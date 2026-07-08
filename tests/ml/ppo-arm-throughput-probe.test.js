/**
 * PPO multi-arm (concurrency) throughput-probe core (ml-bot Phase 3 — PERSONAS §10.7 item 6).
 *
 * Unit-covers the pure, deterministic pieces (seed layout, config validation, contention math,
 * go/no-go classification) plus the timed-shard state machine via an INJECTED clock (phase
 * accounting + the warmup/cooldown exclusion contract, fully deterministic), and one fast live
 * smoke over the real `runSelfPlayEpisode` path. Absolute throughput numbers are never asserted —
 * they're machine- and load-dependent; the probe reports them, the suite pins only invariants.
 */

import { resolveBotsByName } from '../../scripts/lib/selfplay-core.mjs';
import {
  armSeedBase,
  validateArmProbeConfig,
  sumArmShards,
  summarizeContention,
  classifyThroughput,
  runTimedProbeShard,
} from '../../scripts/lib/ppo-arm-probe-core.mjs';

/** A clock stubbed from a fixed list; throws if the shard calls it more often than scripted (so a
 *  miscount is a loud failure, not a silent `undefined`). */
function scriptedClock(times) {
  let i = 0;
  return () => {
    if (i >= times.length) throw new Error(`scriptedClock exhausted after ${times.length} calls`);
    return times[i++];
  };
}

const CHEAP_SEATS = () =>
  resolveBotsByName(['Default', 'Defensive', 'Example', 'Adaptive']).map(b => ({
    name: b.name,
    fn: b.fn,
  }));

describe('armSeedBase', () => {
  it('strides shards apart and is unique per (arm, worker)', () => {
    const workersPerArm = 12;
    const seen = new Set();
    for (let a = 0; a < 3; a++) {
      for (let w = 0; w < workersPerArm; w++) {
        const s = armSeedBase(1, a, w, workersPerArm);
        expect(seen.has(s)).toBe(false); // no two shards share a seed base
        seen.add(s);
      }
    }
    // shard 0 = base; consecutive shards a full stride apart
    expect(armSeedBase(1, 0, 0, 12)).toBe(1);
    expect(armSeedBase(1, 0, 1, 12)).toBe(1_000_001);
    expect(armSeedBase(1, 1, 0, 12)).toBe(12_000_001); // arm 1 worker 0 = shard 12
    expect(armSeedBase(5, 2, 3, 4, 100)).toBe(5 + (2 * 4 + 3) * 100);
  });
});

describe('validateArmProbeConfig', () => {
  const base = () => ({
    arms: 3,
    envsPerArm: 12,
    warmupMs: 2000,
    measureMs: 12000,
    cooldownMs: 2000,
    targetFps: 175,
    margin: 1.3,
    learner: 'random',
  });

  it('accepts a valid config and returns it', () => {
    const c = base();
    expect(validateArmProbeConfig(c)).toBe(c);
  });

  it('rejects a non-positive-integer arms / envsPerArm', () => {
    expect(() => validateArmProbeConfig({ ...base(), arms: 0 })).toThrow(
      /arms must be a positive integer/
    );
    expect(() => validateArmProbeConfig({ ...base(), arms: 2.5 })).toThrow(
      /arms must be a positive integer/
    );
    expect(() => validateArmProbeConfig({ ...base(), envsPerArm: -1 })).toThrow(
      /envsPerArm must be a positive integer/
    );
  });

  it('rejects a non-positive measure window and a negative warmup/cooldown', () => {
    expect(() => validateArmProbeConfig({ ...base(), measureMs: 0 })).toThrow(
      /measureMs must be > 0/
    );
    expect(() => validateArmProbeConfig({ ...base(), warmupMs: -1 })).toThrow(
      /warmupMs must be a non-negative number/
    );
    expect(() => validateArmProbeConfig({ ...base(), cooldownMs: -5 })).toThrow(
      /cooldownMs must be a non-negative number/
    );
  });

  it('rejects a non-positive target-fps and a margin below 1', () => {
    expect(() => validateArmProbeConfig({ ...base(), targetFps: 0 })).toThrow(
      /targetFps must be a positive number/
    );
    expect(() => validateArmProbeConfig({ ...base(), margin: 0.9 })).toThrow(/margin must be ≥ 1/);
    // margin exactly 1 is allowed (no headroom demanded).
    expect(validateArmProbeConfig({ ...base(), margin: 1 }).margin).toBe(1);
  });

  it('rejects an unknown learner mode', () => {
    expect(() => validateArmProbeConfig({ ...base(), learner: 'greedy' })).toThrow(
      /learner must be random\|stop/
    );
  });
});

describe('sumArmShards', () => {
  it('sums concurrent shard rates + decisions and counts workers', () => {
    const shards = [
      { stepsPerSec: 100, learnerDecisions: 1000 },
      { stepsPerSec: 150, learnerDecisions: 1500 },
      { stepsPerSec: 90, learnerDecisions: 900 },
    ];
    expect(sumArmShards(shards)).toEqual({ stepsPerSec: 340, learnerDecisions: 3400, workers: 3 });
  });
});

describe('summarizeContention', () => {
  it('computes penalty, aggregate speedup, and parallel efficiency', () => {
    // baseline 1000/arm; under load the 3 arms average 600/arm (40% penalty).
    const s = summarizeContention(1000, [600, 600, 600]);
    expect(s.arms).toBe(3);
    expect(s.aggregateStepsPerSec).toBe(1800);
    expect(s.meanArmStepsPerSec).toBe(600);
    expect(s.contentionPenalty).toBeCloseTo(0.4, 10);
    expect(s.aggregateSpeedup).toBeCloseTo(1.8, 10); // ideal 3.0
    expect(s.parallelEfficiency).toBeCloseTo(0.6, 10); // ideal 1.0
  });

  it('reports perfect scaling as zero penalty, speedup = arms', () => {
    const s = summarizeContention(500, [500, 500]);
    expect(s.contentionPenalty).toBeCloseTo(0, 10);
    expect(s.aggregateSpeedup).toBeCloseTo(2, 10);
    expect(s.parallelEfficiency).toBeCloseTo(1, 10);
  });

  it('reports super-linear noise honestly (negative penalty, efficiency > 1)', () => {
    // at tiny/under-subscribed scale a contended arm can measure faster than the single-worker
    // baseline (measurement noise); the math stays honest rather than clamping.
    const s = summarizeContention(400, [500, 450]);
    expect(s.contentionPenalty).toBeLessThan(0);
    expect(s.parallelEfficiency).toBeGreaterThan(1);
  });

  it('throws on a non-positive baseline or an empty contended array', () => {
    expect(() => summarizeContention(0, [1])).toThrow(/baselineArmStepsPerSec must be > 0/);
    expect(() => summarizeContention(100, [])).toThrow(/non-empty array/);
  });
});

describe('classifyThroughput', () => {
  const opts = { targetFps: 175, margin: 1.3 }; // floor 175, ceiling 227.5

  it('GREEN when the contended per-arm ceiling clears target × margin', () => {
    const v = classifyThroughput(228, opts);
    expect(v.verdict).toBe('GREEN');
    expect(v.floor).toBe(175);
    expect(v.ceiling).toBeCloseTo(227.5, 10);
    expect(v.headroom).toBeCloseTo(228 / 175, 10);
  });

  it('GREEN exactly at the ceiling (≥, not >)', () => {
    expect(classifyThroughput(227.5, opts).verdict).toBe('GREEN');
  });

  it('YELLOW between the target floor and the margin ceiling', () => {
    expect(classifyThroughput(200, opts).verdict).toBe('YELLOW');
    expect(classifyThroughput(175, opts).verdict).toBe('YELLOW'); // exactly at floor → clears it
  });

  it('RED below the target floor even with zero GPU cost', () => {
    const v = classifyThroughput(174.9, opts);
    expect(v.verdict).toBe('RED');
    expect(v.note).toMatch(/BELOW the target/);
  });

  it('margin = 1 collapses YELLOW (floor === ceiling): at target is GREEN', () => {
    expect(classifyThroughput(175, { targetFps: 175, margin: 1 }).verdict).toBe('GREEN');
    expect(classifyThroughput(174, { targetFps: 175, margin: 1 }).verdict).toBe('RED');
  });
});

describe('runTimedProbeShard (injected clock + fake episode — phase machine)', () => {
  // A deterministic episode that fires `perEpisode` learner observations and returns; lets the
  // phase-accounting/exclusion contract be pinned exactly (the real episode isn't bit-deterministic).
  const fakeEpisodeFn =
    perEpisode =>
    ({ onObservation }) => {
      for (let i = 0; i < perEpisode; i++) onObservation({ moves: [] });
      return { won: 0, eliminated: true, turnCount: 1 };
    };
  const STUB_SEATS = [{ name: 'x', fn: () => null }]; // unused by the fake episode

  const shardWith = (perEpisode, times, phases) =>
    runTimedProbeShard({
      seats: STUB_SEATS,
      learner: 'stop',
      learnerSeat: 0,
      maxAreas: 32,
      maxTurns: 500,
      seedBase: 1,
      prngSeed: 1,
      ...phases,
      nowFn: scriptedClock(times),
      episodeFn: fakeEpisodeFn(perEpisode),
    });

  it('accounts warmup / measured / cooldown episodes and times only the measured window', () => {
    // 12 scripted nowFn calls ⇒ warmup 2 eps, measure 3 eps (elapsed 305−200=105ms), cooldown 1 ep.
    const times = [0, 10, 20, 100, 200, 210, 220, 300, 305, 400, 410, 500];
    const r = shardWith(5, times, { warmupMs: 100, measureMs: 100, cooldownMs: 100 });
    expect(r.warmupEpisodes).toBe(2);
    expect(r.measuredEpisodes).toBe(3);
    expect(r.cooldownEpisodes).toBe(1);
    expect(r.elapsedMs).toBe(105); // true wall of the counted episodes, not nominal measureMs
    expect(r.learnerDecisions).toBe(15); // ONLY the 3 measured eps × 5 decisions — warmup/cooldown excluded
    expect(r.stepsPerSec).toBeCloseTo((15 * 1000) / 105, 9);
  });

  it('excludes warmup/cooldown decisions entirely (measured-only counter)', () => {
    // Same 2/3/1 phase split, 4 decisions/episode. If warmup(2)+cooldown(1) leaked in, the count
    // would be 6×4=24; the contract is measured-only ⇒ exactly 3×4=12.
    const times = [0, 10, 20, 100, 200, 210, 220, 300, 305, 400, 410, 500];
    const r = shardWith(4, times, { warmupMs: 100, measureMs: 100, cooldownMs: 100 });
    expect(r.warmupEpisodes).toBe(2);
    expect(r.cooldownEpisodes).toBe(1);
    expect(r.learnerDecisions).toBe(12);
  });

  it('runs at least one measured episode (do-while) even with a zero-length measure window', () => {
    // warmup 0, measure "0ms" (first post-episode check already ≥ 0 ⇒ exits after 1), cooldown 0.
    const r = shardWith(3, [0, 0, 5, 5, 6, 10, 10], { warmupMs: 0, measureMs: 0, cooldownMs: 0 });
    expect(r.warmupEpisodes).toBe(0);
    expect(r.measuredEpisodes).toBe(1);
    expect(r.cooldownEpisodes).toBe(0);
    expect(r.learnerDecisions).toBe(3);
  });
});

describe('runTimedProbeShard (live smoke)', () => {
  it('produces positive throughput over a real short window', () => {
    const r = runTimedProbeShard({
      seats: CHEAP_SEATS(),
      learner: 'random',
      learnerSeat: 0,
      maxAreas: 32,
      maxTurns: 500,
      seedBase: 7,
      prngSeed: 7,
      warmupMs: 0,
      measureMs: 60,
      cooldownMs: 0,
    });
    expect(r.measuredEpisodes).toBeGreaterThanOrEqual(1);
    expect(r.learnerDecisions).toBeGreaterThan(0);
    expect(r.elapsedMs).toBeGreaterThan(0);
    expect(r.stepsPerSec).toBeGreaterThan(0);
  });
});
