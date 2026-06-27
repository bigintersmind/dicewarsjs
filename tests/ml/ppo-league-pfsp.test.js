/**
 * PFSP opponent sampling — `draw()` weighting on (ml-bot Phase 3, task B step B4 — [D-22]/[D-23]).
 *
 * B3 only *loaded* snapshots into the pool; B4 turns the sampler on. With a non-empty pool,
 * `draw(seed)` seeds a `mulberry32` stream and fills the `count` opponent seats with:
 *   - up to `min(R, count, #reserveBaselines)` DISTINCT aggressive baselines (the [D-15] turtle
 *     defense — never `ai_bc`), sampled without replacement, and
 *   - the remaining seats with snapshots drawn by `w(S) = max(ε, 1 − learnerWinRate(S))^k`
 *     (lower learner win-rate ⇒ higher weight), with replacement,
 * then shuffles opponent→seat so neither group binds to fixed turn-order seats. The empty pool must
 * STILL return the byte-identical task-A field. These tests pin the field shape, the reserve rules,
 * seeded determinism, the win-rate-monotone weighting, and the ε floor (a mastered snapshot is never
 * starved, and the roulette total is never 0).
 *
 * The pool is populated through the real `refresh()` path (temp-dir manifest + minimal weights
 * modules, exactly as ppo-league-snapshots.test.js) — `draw()` only seats the loaded `fn`, never
 * calls it, so tiny stand-in modules suffice.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeLeague } from '../../scripts/lib/ppo-league.mjs';

const DEFAULT_OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';
// Distinct reserve baselines = DEFAULT_OPPONENTS minus ai_bc = these 4 (the turtle-defense set).
const RESERVE_IDS = ['ai_lookahead', 'ai_strategist', 'ai_expectimax', 'ai_defensive'];
const COUNT = 6;

let dir;
let mtimeTick;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ppo-pfsp-'));
  mtimeTick = 1_700_000_000;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSnapshot(step, { encodingVersion = 2, maxAreas = 32 } = {}) {
  const file = `snap-${String(step).padStart(6, '0')}.weights.js`;
  writeFileSync(
    join(dir, file),
    `export const BC_POLICY = ${JSON.stringify({ encodingVersion, config: { maxAreas } })};\n`
  );
  return file;
}

function writeManifest(snapshots) {
  const path = join(dir, 'manifest.json');
  const latestStep = snapshots.reduce((m, s) => Math.max(m, s.step), 0);
  writeFileSync(path, JSON.stringify({ encodingVersion: 2, snapshots, latestStep }));
  const t = ++mtimeTick;
  utimesSync(path, t, t);
  return path;
}

const snap = step => ({ id: `snap-${step}`, step, weights: writeSnapshot(step), createdAt: 'x' });

/** A league whose pool is preloaded with snapshots for `steps`; returns the started league. */
async function leagueWithPool(steps, extra = {}) {
  const lg = makeLeague({
    baselineCsv: DEFAULT_OPPONENTS,
    count: COUNT,
    learnerSeat: 0,
    snapshotManifest: writeManifest(steps.map(snap)),
    ...extra,
  });
  await lg.refresh();
  return lg;
}

describe('ppo-league PFSP — empty-pool parity preserved (B4 must not touch task A)', () => {
  it('returns the byte-identical seed-invariant baseline field with no pool', () => {
    const lg = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    const a = lg.draw(1);
    const b = lg.draw(999_999);
    expect(a.opponents.map(o => o.name)).toEqual(b.opponents.map(o => o.name));
    expect(a.drawn.every(d => d.kind === 'baseline')).toBe(true);
    expect(a.opponents.map(o => o.name)).toEqual([
      'Lookahead@0',
      'Strategist@1',
      'Expectimax@2',
      'BC@3',
      'Defensive@4',
      'Lookahead@5',
    ]);
  });
});

describe('ppo-league PFSP — field shape with a non-empty pool', () => {
  it('fills count seats with R distinct reserve baselines + (count−R) snapshots', async () => {
    const lg = await leagueWithPool([100, 200, 300, 400]); // R defaults to 3
    const { opponents, drawn } = lg.draw(7);
    expect(opponents).toHaveLength(COUNT);
    expect(drawn).toHaveLength(COUNT);

    const baselines = drawn.filter(d => d.kind === 'baseline');
    const snapshots = drawn.filter(d => d.kind === 'snapshot');
    expect(baselines).toHaveLength(3); // R = 3
    expect(snapshots).toHaveLength(3); // count − R = 3

    // Reserve baselines are DISTINCT and never ai_bc (the turtle-defense set).
    const baseIds = baselines.map(d => d.id);
    expect(new Set(baseIds).size).toBe(baseIds.length);
    baseIds.forEach(id => expect(RESERVE_IDS).toContain(id));
    expect(baseIds).not.toContain('ai_bc');
  });

  it('drawn seats are a permutation of the non-learner seats (player_count held constant)', async () => {
    const lg = await leagueWithPool([100, 200], { learnerSeat: 3 });
    const seats = lg.draw(7).drawn.map(d => d.seat).sort((a, b) => a - b);
    expect(seats).toEqual([0, 1, 2, 4, 5, 6]); // learnerSeat 3 skipped, every other seat once
  });

  it('opponents/drawn stay index-parallel, names carry the @i slot suffix', async () => {
    const lg = await leagueWithPool([100, 200]);
    const { opponents, drawn } = lg.draw(7);
    opponents.forEach((o, i) => {
      expect(o.name).toBe(`${o.name.replace(/@\d+$/, '')}@${i}`);
      expect(o.id).toBe(drawn[i].id);
      expect(typeof o.fn).toBe('function');
    });
  });
});

describe('ppo-league PFSP — seeded determinism', () => {
  it('same seed → identical field; pool state held', async () => {
    const lg = await leagueWithPool([100, 200, 300]);
    const a = lg.draw(42);
    const b = lg.draw(42);
    expect(a.opponents.map(o => o.name)).toEqual(b.opponents.map(o => o.name));
    expect(a.drawn).toEqual(b.drawn);
  });

  it('different seeds vary the field (sampling actually depends on the seed)', async () => {
    const lg = await leagueWithPool([100, 200, 300, 400, 500]);
    const fields = [0, 1, 2, 3, 4].map(s =>
      lg
        .draw(s)
        .drawn.map(d => `${d.kind}:${d.id}@${d.seat}`)
        .join('|')
    );
    expect(new Set(fields).size).toBeGreaterThan(1);
  });

  it('shuffles opponent→seat so neither kind binds to fixed turn-order seats (D-23 guarantee)', async () => {
    /*
     * Without the Fisher-Yates shuffle, reserve baselines would always occupy the low field indices
     * (→ the early, first-to-move board seats) and snapshots the high ones — a systematic turn-order
     * pattern D-23 forbids and the learner could overfit. learnerSeat=0 → seats are 1..6; without the
     * shuffle baselines (R=3) would be locked to seats {1,2,3} and snapshots to {4,5,6}. Assert the
     * coupling is broken: across seeds, a snapshot reaches the earliest seat (1) AND a baseline reaches
     * the latest seat (6). (Disabling the shuffle in draw() makes both of these impossible → fails.)
     */
    const lg = await leagueWithPool([100, 200, 300]); // R=3 baselines + 3 snapshots
    let snapshotAtEarliest = false;
    let baselineAtLatest = false;
    for (let s = 0; s < 100 && !(snapshotAtEarliest && baselineAtLatest); s++) {
      for (const d of lg.draw(s).drawn) {
        if (d.kind === 'snapshot' && d.seat === 1) snapshotAtEarliest = true;
        if (d.kind === 'baseline' && d.seat === 6) baselineAtLatest = true;
      }
    }
    expect(snapshotAtEarliest).toBe(true);
    expect(baselineAtLatest).toBe(true);
  });
});

describe('ppo-league PFSP — reserve-baseline rules', () => {
  it('reserveBaselines=0 → every seat is a PFSP snapshot', async () => {
    const lg = await leagueWithPool([100, 200], { reserveBaselines: 0 });
    const drawn = lg.draw(7).drawn;
    expect(drawn.every(d => d.kind === 'snapshot')).toBe(true);
  });

  it('caps reserved seats at the number of DISTINCT reserve baselines (R > pool size)', async () => {
    // R=10 but only 4 distinct aggressive baselines exist → 4 reserved, 2 PFSP.
    const lg = await leagueWithPool([100, 200, 300], { reserveBaselines: 10 });
    const drawn = lg.draw(7).drawn;
    expect(drawn.filter(d => d.kind === 'baseline')).toHaveLength(4);
    expect(drawn.filter(d => d.kind === 'snapshot')).toHaveLength(2);
  });

  it('empty reserve set (baselineCsv=ai_bc only) → all seats PFSP, never seats ai_bc', async () => {
    const lg = makeLeague({
      baselineCsv: 'ai_bc',
      count: COUNT,
      learnerSeat: 0,
      snapshotManifest: writeManifest([100, 200].map(snap)),
    });
    await lg.refresh();
    const drawn = lg.draw(7).drawn;
    expect(drawn.every(d => d.kind === 'snapshot')).toBe(true);
    expect(drawn.some(d => d.id === 'ai_bc')).toBe(false);
  });
});

describe('ppo-league PFSP — win-rate-monotone weighting (the [D-19]/[D-22] signal)', () => {
  it('samples a low-win-rate snapshot far more than a high-win-rate one (monotone in 1−winRate)', async () => {
    /*
     * Pool of two: snap-100 unrecorded (winRate 0 → weight max(ε,1)^k = 1); snap-200 recorded as a
     * learner win (winRate 1 → weight max(ε,0)^k = ε^k ≈ 0.0025). reserveBaselines=0 ⇒ all 6 seats
     * are snapshots, so every seat is one of the two and the counts isolate the weighting.
     */
    const lg = await leagueWithPool([100, 200], { reserveBaselines: 0 });
    // Drive snap-200's win-rate to 1 (learner beat it) via a synthetic per-seat outcome.
    lg.recordResult([{ id: 'snap-200', kind: 'snapshot', seat: 1 }], {
      truncated: false,
      seatBeat: [null, 1, null, null, null, null, null],
    });
    expect(lg.winRate('snap-200')).toBe(1);
    expect(lg.winRate('snap-100')).toBe(0);

    let lose = 0; // snap-100 (learner loses → up-weighted)
    let won = 0; // snap-200 (learner wins → down-weighted)
    const DRAWS = 400;
    for (let s = 0; s < DRAWS; s++) {
      for (const d of lg.draw(s).drawn) {
        if (d.id === 'snap-100') lose++;
        else if (d.id === 'snap-200') won++;
      }
    }
    expect(lose + won).toBe(DRAWS * COUNT); // sanity: all seats accounted for
    // ~400:1 expected weight ratio — assert a strong, unambiguous bias toward the loser.
    expect(lose).toBeGreaterThan(won * 20);
    // ε floor: the mastered snapshot is NOT starved — it still surfaces sometimes.
    expect(won).toBeGreaterThan(0);
  });

  it('higher k sharpens the bias (k=4 starves the mastered snapshot harder than k=1)', async () => {
    const countWonAtK = async k => {
      const lg = await leagueWithPool([100, 200], { reserveBaselines: 0, pfspK: k });
      lg.recordResult([{ id: 'snap-200', kind: 'snapshot', seat: 1 }], {
        truncated: false,
        seatBeat: [null, 1, null, null, null, null, null],
      });
      let won = 0;
      for (let s = 0; s < 300; s++) for (const d of lg.draw(s).drawn) if (d.id === 'snap-200') won++;
      return won;
    };
    expect(await countWonAtK(4)).toBeLessThan(await countWonAtK(1));
  });

  it('pins the makeLeague defaults at ε=0.05, k=2 (field sequence == explicit knobs, ≠ other ε)', async () => {
    /*
     * R=3/ε=0.05/k=2 are D-23-fixed defaults. R is pinned behaviorally above; ε and k are pinned here.
     * With one mastered snapshot (snap-200) and one fresh (snap-100), the per-seat pick threshold is
     * 1/(1+ε^k), which depends on BOTH ε and k — so the field SEQUENCE over a seed sweep is a
     * fingerprint of the defaults. A default league must reproduce the explicit-{ε:0.05,k:2} sequence
     * exactly, and a different ε must change it (proof the check has teeth, not a tautology).
     */
    const masteredPool = async extra => {
      const lg = await leagueWithPool([100, 200], { reserveBaselines: 0, ...extra });
      lg.recordResult([{ id: 'snap-200', kind: 'snapshot', seat: 1 }], {
        truncated: false,
        seatBeat: [null, 1, null, null, null, null, null],
      });
      return lg;
    };
    const seq = lg => Array.from({ length: 200 }, (_, s) => JSON.stringify(lg.draw(s).drawn)).join('|');

    const dflt = await masteredPool({});
    const explicit = await masteredPool({ pfspEpsilon: 0.05, pfspK: 2 });
    const otherEps = await masteredPool({ pfspEpsilon: 0.5 });
    expect(seq(dflt)).toBe(seq(explicit)); // defaults are exactly ε=0.05, k=2
    expect(seq(dflt)).not.toBe(seq(otherEps)); // and the sequence genuinely depends on ε
  });
});

describe('ppo-league PFSP — ε floor / no degenerate total', () => {
  it('seats snapshots even when EVERY snapshot is fully mastered (weights all ε^k > 0)', async () => {
    const lg = await leagueWithPool([100, 200], { reserveBaselines: 0 });
    // Drive both snapshots to winRate 1 → both weights collapse to ε^k; total must stay > 0.
    for (const id of ['snap-100', 'snap-200']) {
      lg.recordResult([{ id, kind: 'snapshot', seat: 1 }], {
        truncated: false,
        seatBeat: [null, 1, null, null, null, null, null],
      });
    }
    const seenIds = new Set();
    for (let s = 0; s < 50; s++) {
      const drawn = lg.draw(s).drawn;
      expect(drawn).toHaveLength(COUNT);
      expect(drawn.every(d => d.kind === 'snapshot')).toBe(true); // never empty / NaN seat
      drawn.forEach(d => seenIds.add(d.id));
    }
    // Equal weights ⇒ both mastered snapshots still get drawn.
    expect(seenIds).toEqual(new Set(['snap-100', 'snap-200']));
  });

  it('falls back to uniform when a pathological k underflows every weight to 0 (total===0 guard)', async () => {
    /*
     * At k high enough that ε^k underflows to exactly 0.0 in IEEE-754 (0.05^400 === 0) AND every
     * snapshot mastered (base floored to ε), all weights are 0 and the roulette total is 0. Without
     * the uniform fallback, sampleByWeight would degenerate to always returning the last pool entry;
     * the guard keeps sampling meaningful (both snapshots surface) and crash-free.
     */
    const lg = await leagueWithPool([100, 200], { reserveBaselines: 0, pfspK: 400 });
    for (const id of ['snap-100', 'snap-200']) {
      lg.recordResult([{ id, kind: 'snapshot', seat: 1 }], {
        truncated: false,
        seatBeat: [null, 1, null, null, null, null, null],
      });
    }
    const seenIds = new Set();
    for (let s = 0; s < 50; s++) {
      const drawn = lg.draw(s).drawn;
      expect(drawn).toHaveLength(COUNT);
      expect(drawn.every(d => d.kind === 'snapshot')).toBe(true);
      drawn.forEach(d => seenIds.add(d.id));
    }
    expect(seenIds).toEqual(new Set(['snap-100', 'snap-200'])); // uniform fallback drew both
  });
});

describe('ppo-league PFSP — draw → record → winRate loop credits sampled snapshots', () => {
  it('records a snapshot drawn from the pool back into the win-rate book', async () => {
    const lg = await leagueWithPool([100], { reserveBaselines: 0 });
    const { drawn } = lg.draw(7); // every seat is snap-100
    // Synthesize: the learner beat the snapshot at every seat.
    const seatBeat = [null, null, null, null, null, null, null];
    drawn.forEach(d => {
      seatBeat[d.seat] = 1;
    });
    lg.recordResult(drawn, { truncated: false, seatBeat });
    expect(lg.winRate('snap-100')).toBe(1); // beat at all (count) seats → 1.0
    expect(lg.stats().bookSize).toBe(1);
  });
});

describe('ppo-league PFSP — construction validation (B4 knobs)', () => {
  const base = { baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 };

  it('rejects pfspEpsilon outside (0, 1]', () => {
    for (const pfspEpsilon of [0, -0.1, 1.5, NaN, Infinity]) {
      expect(() => makeLeague({ ...base, pfspEpsilon })).toThrow(/pfspEpsilon must be in \(0, 1]/);
    }
  });

  it('rejects a negative or non-finite pfspK', () => {
    for (const pfspK of [-1, NaN, Infinity]) {
      expect(() => makeLeague({ ...base, pfspK })).toThrow(/pfspK must be a finite number/);
    }
  });

  it('rejects a negative or fractional reserveBaselines', () => {
    for (const reserveBaselines of [-1, 2.5]) {
      expect(() => makeLeague({ ...base, reserveBaselines })).toThrow(
        /reserveBaselines must be a non-negative integer/
      );
    }
  });

  it('accepts the B4 defaults (R=3, ε=0.05, k=2) implicitly', () => {
    expect(() => makeLeague(base)).not.toThrow();
  });

  it('rejects a typo\'d opponent id PAST position count with the clear "Unknown opponent bot id" error', () => {
    /*
     * The reserve pool is built from ALL distinct CSV ids, but resolveBaselineField only validates the
     * first `count` cycled positions — so a bad id beyond position count−1 would slip past it and used
     * to crash the reserve build with a cryptic `undefined.name` TypeError. The reserve lookup now
     * guards it with the same clear message resolveBaselineField emits. (count=2, ai_not_a_bot at idx 2.)
     */
    expect(() =>
      makeLeague({ baselineCsv: 'ai_lookahead,ai_bc,ai_not_a_bot', count: 2, learnerSeat: 0 })
    ).toThrow(/Unknown opponent bot id "ai_not_a_bot"/);
  });
});
