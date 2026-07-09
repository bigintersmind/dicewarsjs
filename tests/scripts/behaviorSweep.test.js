/**
 * The shared behavioral sweep (`scripts/lib/behavior-sweep.mjs`), extracted from
 * `behavior-profile.mjs` so `behavior:preflight`'s A/A negative control runs the identical path.
 *
 * These tests MOCK `runMatch` to pin the sweep's own
 * deterministic control logic: the exact seed SCHEDULE (identical across calls — the A/A pairs over
 * shared maps), the rotation count, and the quarantine tally. The real (noisy) sweep is exercised
 * end-to-end by behaviorPreflight.test.js's A/A cases.
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => ({ seeds: [], seats: [], rotations: [], forcedEndSeeds: new Set() }));

vi.mock('../../src/arena/matchRunner.js', () => ({
  runMatch: ({ seed }) => {
    h.seeds.push(seed);
    const forced = h.forcedEndSeeds.has(seed);
    return { botStats: [{ errors: forced ? 1 : 0, invalidMoves: 0, maxMovesHit: 0 }] };
  },
}));
// Record the rotation index rotatedField is asked for, so a seat-wiring regression is observable.
vi.mock('../../scripts/lib/ppo-gate-core.mjs', () => ({
  rotatedField: (field, rot) => {
    h.rotations.push(rot);
    return field;
  },
}));
vi.mock('../../scripts/lib/behavior-core.mjs', async orig => ({
  ...(await orig()), // keep the real AXES (nullRun depends on it)
  // Record the profiled seat (pi = rot) so the sweep's rotation→seat wiring is asserted, not just
  // the seed schedule — otherwise a `pi = rot` → `pi = 0` regression would pass every sweep test.
  makeCapture: pi => {
    h.seats.push(pi);
    return { capture: {}, onTurn: () => {}, onStep: () => {} };
  },
  profileGameFromCapture: () => ({ marker: true }),
  reduceRun: profiles => ({ winPct: profiles.length }), // marker: how many games survived quarantine
}));

const { sweepBot, nullRun, isForcedEnd } = await import('../../scripts/lib/behavior-sweep.mjs');
const { AXES } = await import('../../scripts/lib/behavior-core.mjs');

const bot = { name: 'Base', fn: () => null };
const opponents = [
  { name: 'O1', fn: () => null },
  { name: 'O2', fn: () => null },
];
const COMMON = { opponents, runCount: 2, gamesPerRun: 2, stride: 1000 };
const fieldSize = opponents.length + 1; // 3

beforeEach(() => {
  h.seeds.length = 0;
  h.seats.length = 0;
  h.rotations.length = 0;
  h.forcedEndSeeds.clear();
});

describe('sweepBot — seed schedule', () => {
  it('baseSeed = run*stride + 1, each seed played once per rotation', () => {
    sweepBot(bot, { ...COMMON });
    // run 0 → seeds 1,2 ; run 1 → seeds 1001,1002 ; each ×3 rotations.
    expect(h.seeds).toEqual([1, 1, 1, 2, 2, 2, 1001, 1001, 1001, 1002, 1002, 1002]);
  });

  it('profiles seat pi = rot for each rotation (rotation→seat wiring)', () => {
    sweepBot(bot, { ...COMMON });
    // Under rotation `rot`, the profiled bot sits at seat `rot`; each seed cycles rot 0..fieldSize-1.
    const perSeed = Array.from({ length: fieldSize }, (_, r) => r); // [0,1,2]
    const expected = Array(COMMON.runCount * COMMON.gamesPerRun)
      .fill(perSeed)
      .flat();
    expect(h.seats).toEqual(expected); // [0,1,2, 0,1,2, 0,1,2, 0,1,2]
    expect(h.rotations).toEqual(expected); // rotatedField asked for the same rot sequence
  });

  it('is identical across calls (the A/A relies on both arms drawing the SAME map seeds)', () => {
    sweepBot(bot, { ...COMMON });
    const first = [...h.seeds];
    h.seeds.length = 0;
    sweepBot(bot, { ...COMMON });
    // Same seed schedule both passes: map variance cancels in the A/A pairing (and since #151
    // seeded the built-in bots, the realized games are identical too — see behaviorPreflight).
    expect(h.seeds).toEqual(first);
  });

  it('plays every scheduled match: played === runCount × games × fieldSize', () => {
    const { played } = sweepBot(bot, { ...COMMON });
    expect(played).toBe(COMMON.runCount * COMMON.gamesPerRun * fieldSize);
    expect(h.seeds.length).toBe(played);
  });
});

describe('sweepBot — quarantine', () => {
  it('drops forced-end games and tallies them (kept games flow to reduceRun)', () => {
    h.forcedEndSeeds.add(1); // all 3 rotations of seed 1 are forced-end
    const { perRun, played, quarantined } = sweepBot(bot, { ...COMMON });
    expect(played).toBe(12);
    expect(quarantined).toBe(3); // seed 1 × 3 rotations
    // run 0 kept only seed 2 (3 games) → reduceRun marker winPct = 3.
    expect(perRun[0].winPct).toBe(3);
  });

  it('a fully-quarantined run reduces to nullRun (winPct === null, not a measured 0)', () => {
    h.forcedEndSeeds.add(1).add(2); // both seeds of run 0 forced-end
    const { perRun } = sweepBot(bot, { ...COMMON });
    expect(perRun[0].winPct).toBeNull();
    expect(perRun[1].winPct).toBe(6); // run 1 (seeds 1001,1002 × 3) untouched
  });

  it('quarantine:false keeps every game (quarantined stays 0)', () => {
    h.forcedEndSeeds.add(1).add(2);
    const { quarantined, perRun } = sweepBot(bot, { ...COMMON, quarantine: false });
    expect(quarantined).toBe(0);
    expect(perRun[0].winPct).toBe(6); // all 6 games kept despite the forced-end flag
  });
});

describe('sweep helpers', () => {
  it('nullRun() has every AXES key set to null', () => {
    const nr = nullRun();
    expect(Object.keys(nr).sort()).toEqual([...AXES].sort());
    expect(Object.values(nr).every(v => v === null)).toBe(true);
  });

  it('isForcedEnd is true iff any forced-end signal is positive', () => {
    expect(isForcedEnd({ errors: 0, invalidMoves: 0, maxMovesHit: 0 })).toBe(false);
    expect(isForcedEnd({ errors: 1, invalidMoves: 0, maxMovesHit: 0 })).toBe(true);
    expect(isForcedEnd({ errors: 0, invalidMoves: 2, maxMovesHit: 0 })).toBe(true);
    expect(isForcedEnd({ errors: 0, invalidMoves: 0, maxMovesHit: 5 })).toBe(true);
  });
});
