/**
 * Pure logic of the Phase-3 PPO gate (`scripts/lib/ppo-gate-core.mjs`) — the
 * paired-delta math, the BEAT/TIE/BEHIND boundary, field construction, and the
 * "no weights yet" help. No arena, no torch.
 */
import {
  LOOKAHEAD_PIN,
  buildGateField,
  classifyGate,
  missingWeightsHelp,
  pairedDelta,
  rotatedField,
  verdictLine,
} from '../../scripts/lib/ppo-gate-core.mjs';

describe('pairedDelta', () => {
  it('is the per-run difference, not the difference of means', () => {
    // Pairing matters: same means, but run-correlated so the paired CI is tight.
    const cand = [20, 22, 24];
    const bar = [18, 20, 22]; // cand − bar = +2 every run
    const d = pairedDelta(cand, bar);
    expect(d.mean).toBeCloseTo(2, 6);
    expect(d.ci).toBeCloseTo(0, 6); // zero variance in the diffs
    expect(d.lo).toBeCloseTo(2, 6);
    expect(d.hi).toBeCloseTo(2, 6);
  });

  it('rejects mismatched lengths', () => {
    expect(() => pairedDelta([1, 2], [1])).toThrow(/length mismatch/);
  });

  it('rejects fewer than 2 runs (no CI)', () => {
    expect(() => pairedDelta([1], [0])).toThrow(/>= 2 runs/);
  });
});

describe('classifyGate', () => {
  it('BEAT when the whole CI is above 0', () => {
    expect(classifyGate({ lo: 0.5, hi: 3 })).toBe('BEAT');
  });
  it('BEHIND when the whole CI is below 0', () => {
    expect(classifyGate({ lo: -3, hi: -0.5 })).toBe('BEHIND');
  });
  it('TIE when the CI straddles 0', () => {
    expect(classifyGate({ lo: -1, hi: 2 })).toBe('TIE');
  });
  it('TIE at an exact 0 boundary (not strictly above/below)', () => {
    expect(classifyGate({ lo: 0, hi: 2 })).toBe('TIE');
    expect(classifyGate({ lo: -2, hi: 0 })).toBe('TIE');
  });
});

describe('verdictLine', () => {
  it('labels each verdict and shows the signed delta', () => {
    const d = { mean: 1.2, ci: 0.4 };
    expect(verdictLine('BEAT', d)).toMatch(/BEAT.*\+1\.2 ± 0\.4/);
    expect(verdictLine('TIE', { mean: -0.1, ci: 1.0 })).toMatch(/TIE/);
    expect(verdictLine('BEHIND', { mean: -2.0, ci: 0.5 })).toMatch(/BEHIND.*-2\.0/);
  });
});

describe('buildGateField', () => {
  const builtIns = [
    { id: 'ai_lookahead', name: 'Lookahead', fn: () => null },
    { id: 'ai_strategist', name: 'Strategist', fn: () => null },
    { id: 'ai_bc', name: 'BC', fn: () => null },
  ];
  const cand = () => null;

  it('drops the existing BC clone and appends the candidate', () => {
    const field = buildGateField(builtIns, cand, 'PPO');
    const names = field.map(b => b.name);
    expect(names).not.toContain('BC');
    expect(names).toContain('PPO');
    expect(names).toContain('Lookahead');
    expect(field[field.length - 1]).toEqual({ name: 'PPO', fn: cand });
  });

  it('throws if the bar is absent from the field', () => {
    const noBar = builtIns.filter(b => b.name !== 'Lookahead');
    expect(() => buildGateField(noBar, cand, 'PPO')).toThrow(/bar "Lookahead" missing/);
  });

  it('throws on a candidate name colliding with a built-in', () => {
    expect(() => buildGateField(builtIns, cand, 'Strategist')).toThrow(/collides/);
  });
});

describe('rotatedField', () => {
  const field = ['A', 'B', 'C', 'D'];

  it('is identity at rotation 0', () => {
    expect(rotatedField(field, 0)).toEqual(field);
  });

  it('counterbalances: over all N rotations each bot occupies every seat exactly once', () => {
    const N = field.length;
    // seatsByBot[bot] = the set of seat indices it sits in across rotations 0..N-1
    const seatsByBot = Object.fromEntries(field.map(b => [b, new Set()]));
    for (let r = 0; r < N; r++) {
      const seating = rotatedField(field, r);
      seating.forEach((bot, seat) => seatsByBot[bot].add(seat));
    }
    for (const bot of field) {
      expect([...seatsByBot[bot]].sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it('keeps the field a permutation (no bot dropped or duplicated)', () => {
    for (let r = 0; r < field.length; r++) {
      expect([...rotatedField(field, r)].sort()).toEqual([...field].sort());
    }
  });
});

describe('missingWeightsHelp', () => {
  it('names the path and the three reproduce steps', () => {
    const help = missingWeightsHelp('src/ai/ppoPolicyWeights.js');
    expect(help).toContain('src/ai/ppoPolicyWeights.js');
    expect(help).toContain('train_tracer');
    expect(help).toContain('npm run ppo:export');
    expect(help).toContain('npm run ppo:gate');
  });
});

describe('LOOKAHEAD_PIN', () => {
  it('is the pinned bar SHA', () => {
    expect(LOOKAHEAD_PIN).toBe('596f781');
  });
});
