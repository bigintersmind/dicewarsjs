/**
 * Unit tests for the [D-29] runGateSweep extraction (scripts/lib/ppo-gate-core.mjs).
 *
 * The sweep loop moved out of ppo-gate.mjs so the strength-curve scorer can
 * drive the identical gate methodology. These tests PIN that methodology —
 * the seed formula, rotation order, rounding, and abort semantics the
 * documented gate baselines were measured under — using a stub matchFn
 * (zero arena games, like the rest of the ppo-gate-core suite).
 */

import {
  ABORT_MIN_ATTEMPTS,
  rotatedField,
  runGateSweep,
  sweepPlan,
} from '../../scripts/lib/ppo-gate-core.mjs';

const mkField = names => names.map(name => ({ name, fn: () => null }));

/** Deterministic stub result: winner = seat 0 of the rotated order; placement = seat order. */
function stubResult(bots) {
  return {
    winnerName: bots[0].name,
    botStats: bots.map((b, i) => ({
      name: b.name,
      placement: i + 1,
      attacksMade: 10,
      attacksWon: 5,
    })),
  };
}

describe('sweepPlan', () => {
  it('reproduces the gate CLI defaults: 150 games on a 9-seat field = 17 seeds x 9', () => {
    expect(sweepPlan(9, 150)).toEqual({
      seedsPerRun: 17,
      gamesPerRunActual: 153,
      stride: 1_000_000,
    });
  });

  it('floors at one seed per run and grows the stride past 1M games-per-run x 1000', () => {
    expect(sweepPlan(9, 1)).toEqual({ seedsPerRun: 1, gamesPerRunActual: 9, stride: 1_000_000 });
    expect(sweepPlan(4, 4000)).toEqual({
      seedsPerRun: 1000,
      gamesPerRunActual: 4000,
      stride: 4_000_000,
    });
  });
});

describe('runGateSweep', () => {
  it('pins the seed formula and rotation order the gate baselines were measured under', async () => {
    const field = mkField(['A', 'B', 'C']);
    const calls = [];
    await runGateSweep({
      field,
      matchFn: ({ bots, seed }) => {
        calls.push({ bots: bots.map(b => b.name), seed });
        return stubResult(bots);
      },
      runs: 2,
      gamesPerRun: 3, // seedsPerRun = 1 on a 3-seat field
      seedBase: 0,
      tallyNames: ['A'],
    });
    // seed = (seedBase + run) * stride + s + 1, stride = max(1e6, 3 * 1000)
    expect(calls.map(c => c.seed)).toEqual([1, 1, 1, 1_000_001, 1_000_001, 1_000_001]);
    // each seed replayed through every rotation, in rotation order
    for (let r = 0; r < 3; r++) {
      expect(calls[r].bots).toEqual(rotatedField(field, r).map(b => b.name));
    }
  });

  it('offsets seed blocks by seedBase (the fresh-seed confirmation lever)', async () => {
    const seeds = [];
    await runGateSweep({
      field: mkField(['A', 'B', 'C']),
      matchFn: ({ bots, seed }) => {
        seeds.push(seed);
        return stubResult(bots);
      },
      runs: 1,
      gamesPerRun: 3,
      seedBase: 5,
      tallyNames: ['A'],
    });
    expect(seeds).toEqual([5_000_001, 5_000_001, 5_000_001]);
  });

  it('tallies per-run win% / placement / attack-rate for every tallied name from the same games', async () => {
    const field = mkField(['A', 'B', 'C']);
    const result = await runGateSweep({
      field,
      matchFn: ({ bots }) => stubResult(bots),
      runs: 2,
      gamesPerRun: 3,
      tallyNames: ['A', 'B', 'C'],
    });
    // Winner = rotated seat 0: over a full rotation set every bot wins exactly once,
    // and every bot occupies every placement exactly once (mean 2.0 on 3 seats).
    for (const name of ['A', 'B', 'C']) {
      expect(result.perRun[name].winPct).toHaveLength(2);
      result.perRun[name].winPct.forEach(w => expect(w).toBeCloseTo(100 / 3, 6));
      result.perRun[name].avgPlacement.forEach(p => expect(p).toBeCloseTo(2, 6));
      result.perRun[name].attackWinRate.forEach(a => expect(a).toBeCloseTo(0.5, 6));
    }
    expect(result.games).toBe(6);
    expect(result.failedGames).toBe(0);
    expect(result.attempts).toBe(6);
  });

  it('rejects a non-finite seedBase (NaN would silently collapse every run onto seed 0)', async () => {
    await expect(
      runGateSweep({
        field: mkField(['A', 'B']),
        matchFn: ({ bots }) => stubResult(bots),
        runs: 2,
        gamesPerRun: 2,
        seedBase: NaN,
        tallyNames: ['A'],
      })
    ).rejects.toThrow(/seedBase must be a finite number/);
  });

  it('rejects a tally name that is not in the field (references are never seated)', async () => {
    await expect(
      runGateSweep({
        field: mkField(['A', 'B']),
        matchFn: () => {},
        runs: 1,
        gamesPerRun: 2,
        tallyNames: ['Nope'],
      })
    ).rejects.toThrow(/not in the field/);
  });

  it('throws (instead of exiting) once >50% of attempted matches failed past the floor', async () => {
    let attempts = 0;
    await expect(
      runGateSweep({
        field: mkField(['A', 'B', 'C']),
        matchFn: () => {
          attempts++;
          throw new Error('boom');
        },
        runs: 2,
        gamesPerRun: 6, // seedsPerRun = 2 -> 6 attempts available in run 1
        tallyNames: ['A'],
      })
    ).rejects.toThrow(/matches failed \(>50%\)/);
    expect(attempts).toBe(ABORT_MIN_ATTEMPTS);
  });

  it('throws on a zero-game run under the abort floor (NaN win% must not reach a verdict)', async () => {
    await expect(
      runGateSweep({
        field: mkField(['A', 'B', 'C']),
        matchFn: () => {
          throw new Error('boom');
        },
        runs: 1,
        gamesPerRun: 3, // 3 attempts, all fail — under the 5-attempt abort floor
        tallyNames: ['A'],
      })
    ).rejects.toThrow(/completed 0 of 3 attempted games/);
  });

  it('skips (and reports) individual match failures under the thresholds', async () => {
    const errors = [];
    let call = 0;
    const result = await runGateSweep({
      field: mkField(['A', 'B', 'C']),
      matchFn: ({ bots }) => {
        call++;
        if (call === 2) throw new Error('flaky');
        return stubResult(bots);
      },
      runs: 1,
      gamesPerRun: 6,
      tallyNames: ['A'],
      onMatchError: info => errors.push(info),
    });
    expect(result.failedGames).toBe(1);
    expect(result.games).toBe(5);
    expect(errors).toHaveLength(1);
    expect(errors[0].seed).toBe(1);
    expect(errors[0].rotation).toBe(1);
    // win% divides by COMPLETED games, not attempts
    expect(result.perRun.A.winPct[0]).toBeCloseTo((2 / 5) * 100, 6);
  });

  it('reports run progress via onRunComplete', async () => {
    const seen = [];
    await runGateSweep({
      field: mkField(['A', 'B']),
      matchFn: ({ bots }) => stubResult(bots),
      runs: 3,
      gamesPerRun: 2,
      tallyNames: ['A'],
      onRunComplete: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('fails loud when a tallied bot is missing from botStats (invariant break)', async () => {
    await expect(
      runGateSweep({
        field: mkField(['A', 'B']),
        matchFn: ({ bots }) => ({
          winnerName: 'A',
          botStats: bots
            .filter(b => b.name !== 'B')
            .map(b => ({ name: b.name, placement: 1, attacksMade: 0, attacksWon: 0 })),
        }),
        runs: 1,
        gamesPerRun: 2,
        tallyNames: ['A', 'B'],
      })
    ).rejects.toThrow(/missing from match botStats/);
  });
});
