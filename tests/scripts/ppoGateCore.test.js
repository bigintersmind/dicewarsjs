/**
 * Pure logic of the Phase-3 PPO gate (`scripts/lib/ppo-gate-core.mjs`) — the
 * paired-delta math, the BEAT/TIE/BEHIND boundary, field construction, and the
 * "no weights yet" help. No arena, no torch.
 */
import {
  ABORT_MIN_ATTEMPTS,
  DEFAULT_CANDIDATE_NAME,
  LOOKAHEAD_PIN,
  buildGateField,
  classifyGate,
  missingWeightsHelp,
  pairedDelta,
  rotatedField,
  runGateSweep,
  shouldAbort,
  verdictLine,
} from '../../scripts/lib/ppo-gate-core.mjs';
import { reportBotErrors } from '../../src/arena/botErrorReport.js';

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

  it('DEFAULT_CANDIDATE_NAME never collides with the real registry (bare `npm run ppo:gate` must not throw)', async () => {
    /*
     * Regression: the old default 'PPO' started colliding when PR #74 seated `ai_ppo`
     * in the gate field, so the documented bare `npm run ppo:gate` crashed at field
     * construction. Locks the CLI default against the REAL bot registry.
     */
    const { BUILT_IN_BOTS } = await import('../../src/arena/builtInBots.js');
    expect(() => buildGateField(BUILT_IN_BOTS, cand, DEFAULT_CANDIDATE_NAME)).not.toThrow();
  });

  it('seats a loaded bar (Name=weights.js port) as an extra seat, before the candidate', () => {
    const barFn = () => null;
    const field = buildGateField(builtIns, cand, 'Cand', 'ScratchLong', barFn);
    expect(field.map(b => b.name)).toEqual(['Lookahead', 'Strategist', 'ScratchLong', 'Cand']);
    expect(field[field.length - 2]).toEqual({ name: 'ScratchLong', fn: barFn });
  });

  it('throws if a loaded bar name collides with a built-in', () => {
    expect(() => buildGateField(builtIns, cand, 'Cand', 'Strategist', () => null)).toThrow(
      /collides with a built-in/
    );
  });

  it('throws if the candidate name collides with a loaded bar', () => {
    expect(() => buildGateField(builtIns, cand, 'Same', 'Same', () => null)).toThrow(/collides/);
  });

  it('pins the canonical 8-seat baseline against the REAL registry (drops BC + personas, keeps PPO)', async () => {
    /*
     * The mocks above have no `persona`-tagged entry, so they never exercise the
     * `!b.persona` filter that keeps personas out of the gate. Drive the real
     * BUILT_IN_BOTS: the documented gate table is 8 baseline seats + the candidate,
     * and every RESULTS.md verdict was measured on exactly that field. A new persona
     * without its flag (or a 4th persona) would silently re-inflate it — this locks it.
     */
    const { BUILT_IN_BOTS } = await import('../../src/arena/builtInBots.js');
    const field = buildGateField(BUILT_IN_BOTS, cand, DEFAULT_CANDIDATE_NAME);
    expect(field).toHaveLength(9); // 8 baseline + candidate

    const base = field.map(b => b.name).filter(n => n !== DEFAULT_CANDIDATE_NAME);
    expect(base).toHaveLength(8);
    expect(base).not.toContain('BC'); // the near-identical clone is dropped
    for (const persona of ['Conqueror', 'Blitz', 'Survivor']) {
      expect(base).not.toContain(persona); // challengers, not baselines
    }
    expect(base).toContain('PPO'); // hidden from players, but kept as the strength baseline
    expect(base).toContain('Lookahead'); // the default bar survives
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

describe('runGateSweep errorTotals (#92 item 5)', () => {
  // A field of two tallied bots; the candidate throws every turn (errors, no attacks), the bar
  // is healthy. matchFn is a stub — runGateSweep only reads winnerName + botStats by name.
  const field = [
    { name: 'Cand', fn: () => null },
    { name: 'Bar', fn: () => null },
  ];
  const matchFn = () => ({
    winnerName: 'Bar',
    botStats: [
      {
        name: 'Cand',
        playerIndex: 0,
        placement: 2,
        attacksMade: 0,
        attacksWon: 0,
        turns: 5,
        errors: 5,
        invalidMoves: 2,
        maxMovesHit: 0,
      },
      {
        name: 'Bar',
        playerIndex: 1,
        placement: 1,
        attacksMade: 10,
        attacksWon: 6,
        turns: 5,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      },
    ],
  });

  it('accumulates per-tally-name forced-end totals across the whole sweep', async () => {
    // N=2, gamesPerRun=2 → 1 seed × 2 rotations = 2 games/run; 2 runs = 4 games total.
    const sweep = await runGateSweep({
      field,
      matchFn,
      runs: 2,
      gamesPerRun: 2,
      tallyNames: ['Cand', 'Bar'],
    });

    expect(sweep.games).toBe(4);
    expect(sweep.errorTotals.Cand).toEqual({ errors: 20, invalidMoves: 8, turns: 20, attacks: 0 });
    expect(sweep.errorTotals.Bar).toEqual({ errors: 0, invalidMoves: 0, turns: 20, attacks: 40 });
  });

  it('feeds a broken candidate to reportBotErrors as a 100%-error flag (the gate wiring)', async () => {
    const sweep = await runGateSweep({
      field,
      matchFn,
      runs: 2,
      gamesPerRun: 2,
      tallyNames: ['Cand', 'Bar'],
    });

    const flagged = reportBotErrors(
      ['Cand', 'Bar'].map(name => ({ name, ...sweep.errorTotals[name] })),
      { label: '[gate]', warn: () => {} }
    );

    expect(flagged.map(f => f.name)).toEqual(['Cand']);
    expect(flagged[0].errorFraction).toBe(1);
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

describe('shouldAbort', () => {
  it('does not abort before the minimum-attempts floor, even at 100% failure', () => {
    /*
     * The whole point of the fix: a run where every early match fails must NOT pin the
     * guard. Below the floor it stays quiet regardless of the failure ratio.
     */
    for (let a = 1; a < ABORT_MIN_ATTEMPTS; a++) {
      expect(shouldAbort(a, a)).toBe(false); // all `a` attempts failed
    }
  });

  it('aborts at/after the floor once more than half of attempts failed', () => {
    expect(shouldAbort(ABORT_MIN_ATTEMPTS, ABORT_MIN_ATTEMPTS)).toBe(true); // 5/5
    expect(shouldAbort(4, 5)).toBe(true); // 4/5 = 80% > 50%
    expect(shouldAbort(6, 10)).toBe(true); // 6/10 = 60% > 50%
  });

  it('does not abort at exactly half or below (strictly > 50%)', () => {
    expect(shouldAbort(5, 10)).toBe(false); // exactly 50%
    expect(shouldAbort(3, 10)).toBe(false); // 30%
    expect(shouldAbort(0, 20)).toBe(false); // clean run
  });
});

describe('LOOKAHEAD_PIN', () => {
  it('is the pinned bar SHA', () => {
    expect(LOOKAHEAD_PIN).toBe('596f781');
  });
});
