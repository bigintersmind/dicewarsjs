/**
 * PFSP opponent league — empty-pool parity (ml-bot Phase 3, task B step B1 — [D-22]).
 *
 * The league replaces the env-server's static opponent const with a per-episode
 * `league.draw(seed)`. The load-bearing B1 guarantee is that **the empty-pool field
 * is byte-identical to the fixed field task A trained on** (`resolveBaselineField`,
 * the verbatim-moved `resolveOpponents`) — so turning the league on changes nothing
 * until snapshots (B3) actually enter the pool. These tests pin that equivalence, the
 * player-count-constant contract, seed-invariance, and the decisive/truncated tally.
 */

import { makeLeague, resolveBaselineField } from '../../scripts/lib/ppo-league.mjs';

const DEFAULT_OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';
const COUNT = 6; // playerCount 7 − 1 (the env-server default)

/** Compare two opponent fields by name + fn reference (fns come from the same BUILT_IN_BOTS). */
function expectSameField(a, b) {
  expect(a.map(o => o.name)).toEqual(b.map(o => o.name));
  expect(a.length).toBe(b.length);
  a.forEach((o, i) => expect(o.fn).toBe(b[i].fn));
}

describe('ppo-league — empty-pool field == task A (B1)', () => {
  it('draw() reproduces resolveBaselineField for the DEFAULT_OPPONENTS field', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    const ref = resolveBaselineField(DEFAULT_OPPONENTS, COUNT);
    expectSameField(league.draw(1).opponents, ref);
  });

  it('draw() reproduces the env-server bare default (single bot `ai_bc`, cycled)', () => {
    const league = makeLeague({ baselineCsv: 'ai_bc', count: COUNT, learnerSeat: 0 });
    const ref = resolveBaselineField('ai_bc', COUNT);
    expectSameField(league.draw(1).opponents, ref);
    // Cycled single bot ⇒ every seat is the same fn, named ai_bc@0..@5.
    expect(league.draw(1).opponents.map(o => o.name)).toEqual([
      'BC@0',
      'BC@1',
      'BC@2',
      'BC@3',
      'BC@4',
      'BC@5',
    ]);
  });

  it('always returns exactly `count` opponents (holds player_count constant)', () => {
    for (const count of [3, 6, 7]) {
      const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count, learnerSeat: 0 });
      expect(league.draw(42).opponents).toHaveLength(count);
      expect(league.draw(42).drawn).toHaveLength(count);
    }
  });

  it('empty-pool field is seed-invariant (no sampling until B4)', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    expectSameField(league.draw(1).opponents, league.draw(999_999).opponents);
  });

  it('names use the seat-cycle index `@i`, not the seat', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    const names = league.draw(0).opponents.map(o => o.name);
    // 5 ids cycled over 6 slots ⇒ ai_lookahead reappears at slot 5.
    expect(names[0]).toMatch(/@0$/);
    expect(names[5]).toMatch(/@5$/);
    expect(names[5].replace(/@\d+$/, '')).toBe(names[0].replace(/@\d+$/, ''));
  });
});

describe('ppo-league — drawn seat attribution metadata (B2-ready)', () => {
  it('maps opponent array index → seat around learnerSeat=0', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    expect(league.draw(0).drawn.map(d => d.seat)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('skips the learner seat when learnerSeat is interior', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 3 });
    expect(league.draw(0).drawn.map(d => d.seat)).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('tags every drawn entry as a baseline with its stable bot id', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    const drawn = league.draw(0).drawn;
    expect(drawn.every(d => d.kind === 'baseline')).toBe(true);
    expect(drawn.map(d => d.id)).toEqual([
      'ai_lookahead',
      'ai_strategist',
      'ai_expectimax',
      'ai_bc',
      'ai_defensive',
      'ai_lookahead', // cycled
    ]);
  });

  it('sources drawn[i].id from the opponent field itself (single source of truth)', () => {
    /*
     * resolveBaselineField surfaces `id` on each entry; draw() keys `drawn[i].id` off that same
     * field rather than re-deriving the cycle — so the id↔fn correspondence can never drift.
     */
    const ref = resolveBaselineField(DEFAULT_OPPONENTS, COUNT);
    expect(ref.map(o => o.id)).toEqual([
      'ai_lookahead',
      'ai_strategist',
      'ai_expectimax',
      'ai_bc',
      'ai_defensive',
      'ai_lookahead',
    ]);
    const { opponents, drawn } = makeLeague({
      baselineCsv: DEFAULT_OPPONENTS,
      count: COUNT,
      learnerSeat: 0,
    }).draw(0);
    drawn.forEach((d, i) => expect(d.id).toBe(opponents[i].id));
  });
});

describe('ppo-league — telemetry tally (B1)', () => {
  it('counts decisive vs maxTurns-truncated games and reports decisive-rate', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    const { drawn } = league.draw(0);
    league.recordResult(drawn, { truncated: false });
    league.recordResult(drawn, { truncated: false });
    league.recordResult(drawn, { truncated: false });
    league.recordResult(drawn, { truncated: true });
    const s = league.stats();
    expect(s.decisiveGames).toBe(3);
    expect(s.truncatedGames).toBe(1);
    expect(s.decisiveRate).toBeCloseTo(0.75, 10);
    expect(s.poolSize).toBe(0);
  });

  it('decisiveRate is 0 before any game is recorded', () => {
    const league = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0 });
    expect(league.stats().decisiveRate).toBe(0);
  });
});

describe('ppo-league — error handling', () => {
  it('throws on an empty opponents CSV', () => {
    expect(() => makeLeague({ baselineCsv: '  ,  ', count: COUNT, learnerSeat: 0 })).toThrow(
      /empty list/
    );
  });

  it('throws on an unknown bot id', () => {
    expect(() => resolveBaselineField('ai_not_a_bot', COUNT)).toThrow(/Unknown opponent bot id/);
  });
});

describe('ppo-league — construction validation', () => {
  it('rejects a learnerSeat outside [0, count]', () => {
    for (const learnerSeat of [-1, COUNT + 1, 99]) {
      expect(() =>
        makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat })
      ).toThrow(/learnerSeat .* out of range/);
    }
  });

  it('accepts the boundary learner seats 0 and count (learner first / last)', () => {
    for (const learnerSeat of [0, COUNT]) {
      expect(() =>
        makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat })
      ).not.toThrow();
    }
  });

  it('rejects a non-positive or fractional count', () => {
    for (const count of [0, -1, 6.5]) {
      expect(() => makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count, learnerSeat: 0 })).toThrow(
        /count must be a positive integer/
      );
    }
  });
});
