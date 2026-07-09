import {
  createArenaAccumulator,
  accumulateMatch,
  finalizeArenaStats,
} from '../../src/arena/arenaAccumulator.js';
import { DEFAULT_RATING } from '../../src/arena/elo.js';

/**
 * Build a synthetic MatchResult for the accumulator (no engine needed). `specs` is an
 * array of per-bot partials keyed by position = playerIndex; `winner` is a playerIndex or
 * null. Placements default to seat order (good enough for ELO — a stable permutation).
 */
function makeMatch(specs, winner = 0) {
  const botStats = specs.map((s, i) => ({
    name: s.name,
    playerIndex: i,
    placement: s.placement ?? i + 1,
    finalTerritories: s.finalTerritories ?? 0,
    finalDice: 0,
    attacksMade: s.attacksMade ?? 0,
    attacksWon: s.attacksWon ?? 0,
    turns: s.turns ?? 0,
    errors: s.errors ?? 0,
    invalidMoves: s.invalidMoves ?? 0,
    maxMovesHit: s.maxMovesHit ?? 0,
  }));
  return {
    winner,
    winnerName: winner === null ? null : specs[winner].name,
    turnCount: 10,
    placements: specs.map((_, i) => i),
    botStats,
  };
}

describe('createArenaAccumulator', () => {
  it('seeds ratings from initialRatings and DEFAULT_RATING, and zeroes the accumulators', () => {
    const { ratings, accum } = createArenaAccumulator([{ name: 'a' }, { name: 'b' }], { a: 1500 });

    expect(ratings.a).toBe(1500);
    expect(ratings.b).toBe(DEFAULT_RATING);
    expect(accum.a).toMatchObject({ wins: 0, gamesPlayed: 0, totalAttacks: 0, errors: 0 });
  });
});

describe('accumulateMatch', () => {
  it('folds per-bot stats and credits the winner', () => {
    const acc = createArenaAccumulator([{ name: 'a' }, { name: 'b' }]);

    accumulateMatch(
      acc,
      makeMatch(
        [
          { name: 'a', attacksMade: 8, attacksWon: 5, errors: 1, placement: 1 },
          { name: 'b', attacksMade: 4, attacksWon: 1, placement: 2 },
        ],
        0
      )
    );

    expect(acc.accum.a).toMatchObject({ wins: 1, gamesPlayed: 1, totalAttacks: 8, errors: 1 });
    expect(acc.accum.b).toMatchObject({ wins: 0, gamesPlayed: 1, totalAttacks: 4 });
  });

  it('moves ELO toward the winner', () => {
    const acc = createArenaAccumulator([{ name: 'a' }, { name: 'b' }]);
    accumulateMatch(acc, makeMatch([{ name: 'a' }, { name: 'b' }], 0));

    expect(acc.ratings.a).toBeGreaterThan(DEFAULT_RATING);
    expect(acc.ratings.b).toBeLessThan(DEFAULT_RATING);
  });
});

describe('finalizeArenaStats', () => {
  it('builds averaged stats, sorts by ELO descending, and returns a flagged list', () => {
    const acc = createArenaAccumulator([{ name: 'a' }, { name: 'b' }]);
    accumulateMatch(
      acc,
      makeMatch([{ name: 'a', attacksMade: 10, attacksWon: 6 }, { name: 'b' }], 0)
    );
    accumulateMatch(
      acc,
      makeMatch([{ name: 'a', attacksMade: 6, attacksWon: 3 }, { name: 'b' }], 0)
    );

    const { bots, flagged } = finalizeArenaStats(acc, [{ name: 'a' }, { name: 'b' }], {
      warn: () => {},
    });

    expect(bots.map(b => b.name)).toEqual(['a', 'b']); // 'a' won both → higher ELO first
    expect(bots[0]).toMatchObject({ wins: 2, gamesPlayed: 2, avgAttacks: 8 });
    expect(bots[0].attackWinRate).toBeCloseTo(9 / 16, 3);
    expect(flagged).toEqual([]);
  });

  it('flags a bot that errored on most of its turns and warns via the injected sink', () => {
    const warned = [];
    const acc = createArenaAccumulator([{ name: 'broken' }, { name: 'ok' }]);
    // broken: errored on all 20 turns, never landed an attack → error fraction 1.0
    accumulateMatch(
      acc,
      makeMatch(
        [
          { name: 'broken', turns: 20, errors: 20 },
          { name: 'ok', turns: 20, attacksMade: 10, attacksWon: 6 },
        ],
        1
      )
    );

    const { flagged } = finalizeArenaStats(acc, [{ name: 'broken' }, { name: 'ok' }], {
      label: '[Arena]',
      warn: msg => warned.push(msg),
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe('broken');
    expect(flagged[0].errorFraction).toBe(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('[Arena]');
    expect(warned[0]).toContain('broken');
  });

  it('flags a half-broken bot via the per-turn rate, exercising the turns plumbing (#92 item 4)', () => {
    // Regression guard for the `turns` accumulation. This bot LANDS attacks (attacksMade > 0),
    // so the never-attacked masquerade branch doesn't apply — it can only be flagged through the
    // per-turn rate errors/turns = 25/40 = 0.625, whose denominator is accum.turns. Drop the
    // `a.turns += stat.turns` plumbing and this bot silently stops being flagged (reverting the
    // arena path to the exact #92 blind spot). The other flag test flags via the masquerade
    // branch, which ignores turns, so it can't catch a turns-plumbing regression.
    const warned = [];
    const acc = createArenaAccumulator([{ name: 'half' }, { name: 'ok' }]);
    accumulateMatch(
      acc,
      makeMatch(
        [
          { name: 'half', turns: 40, errors: 25, attacksMade: 100, attacksWon: 40 },
          { name: 'ok', turns: 40, attacksMade: 50, attacksWon: 30 },
        ],
        1
      )
    );

    const { flagged } = finalizeArenaStats(acc, [{ name: 'half' }, { name: 'ok' }], {
      warn: msg => warned.push(msg),
    });

    expect(flagged.map(f => f.name)).toEqual(['half']);
    expect(flagged[0].errorFraction).toBeCloseTo(0.625, 5);
    expect(warned).toHaveLength(1);
  });

  it('reports zero games as zeroed stats rather than NaN', () => {
    const acc = createArenaAccumulator([{ name: 'a' }, { name: 'b' }]);
    const { bots } = finalizeArenaStats(acc, [{ name: 'a' }, { name: 'b' }], { warn: () => {} });

    for (const b of bots) {
      expect(b.gamesPlayed).toBe(0);
      expect(b.avgPlacement).toBe(0);
      expect(b.attackWinRate).toBe(0);
    }
  });
});
