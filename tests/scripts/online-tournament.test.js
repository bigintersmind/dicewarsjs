import { buildLeaderboard, buildHistoryEntry } from '../../scripts/lib/online-tournament.mjs';
import { DEFAULT_RATING } from '../../src/arena/elo.js';

/** A minimal arena-style bot stat row (ELO-sorted order is the caller's responsibility). */
function bot(name, over = {}) {
  return {
    name,
    wins: 10,
    gamesPlayed: 40,
    avgPlacement: 2.5,
    attackWinRate: 0.55,
    elo: 1300,
    errors: 0,
    invalidMoves: 0,
    maxMovesHit: 0,
    ...over,
  };
}

const authorByName = new Map([['community/thing', 'community']]);
const previousLeaderboard = {
  tournamentCount: 4,
  totalGamesPlayed: 400,
  bots: [{ name: 'Healthy', elo: 1280 }],
};

describe('buildLeaderboard', () => {
  it('persists forced-end counts on surviving bots and computes previousElo', () => {
    const result = {
      totalGames: 100,
      flagged: [],
      bots: [bot('Healthy', { elo: 1350, errors: 2, invalidMoves: 1, maxMovesHit: 3 })],
    };

    const lb = buildLeaderboard({
      result,
      previousLeaderboard,
      authorByName,
      replayFiles: [],
      updatedAt: '2026-07-08T00:00:00.000Z',
    });

    expect(lb.tournamentCount).toBe(5);
    expect(lb.totalGamesPlayed).toBe(500);
    expect(lb.bots).toHaveLength(1);
    const row = lb.bots[0];
    expect(row).toMatchObject({ name: 'Healthy', errors: 2, invalidMoves: 1, maxMovesHit: 3 });
    expect(row.previousElo).toBe(1280); // from previousLeaderboard
    expect(row.elo).toBe(1350);
  });

  it('falls back to DEFAULT_RATING for a bot missing from the previous leaderboard', () => {
    const result = { totalGames: 10, flagged: [], bots: [bot('Newcomer', { elo: 1210 })] };
    const lb = buildLeaderboard({
      result,
      previousLeaderboard,
      authorByName,
      replayFiles: [],
      updatedAt: 'x',
    });
    expect(lb.bots[0].previousElo).toBe(DEFAULT_RATING);
  });

  it('excludes flagged (broken) bots from the published leaderboard', () => {
    const result = {
      totalGames: 100,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, maxMovesHit: 0, errorFraction: 1 }],
      bots: [bot('Healthy', { elo: 1350 }), bot('Broken', { elo: 900, errors: 30, wins: 0 })],
    };

    const lb = buildLeaderboard({
      result,
      previousLeaderboard,
      authorByName,
      replayFiles: [],
      updatedAt: 'x',
    });

    expect(lb.bots.map(b => b.name)).toEqual(['Healthy']);
    expect(lb.bots.map(b => b.name)).not.toContain('Broken');
  });

  it('keeps excluded bots visible under a durable flagged[] field (#137)', () => {
    // Same shape as tournament-history.json's flagged[], so a consumer of leaderboard.json
    // alone can tell "excluded because broken" from "didn't compete".
    const result = {
      totalGames: 100,
      flagged: [{ name: 'Broken', errors: 25, invalidMoves: 5, errorFraction: 0.66667 }],
      bots: [bot('Healthy', { elo: 1350 }), bot('Broken', { elo: 900, errors: 25, wins: 0 })],
    };

    const lb = buildLeaderboard({
      result,
      previousLeaderboard,
      authorByName,
      replayFiles: [],
      updatedAt: 'x',
    });

    expect(lb.flagged).toEqual([
      // maxMovesHit defaults to 0 when absent; errorFraction rounds to 3 places.
      { name: 'Broken', errors: 25, invalidMoves: 5, maxMovesHit: 0, errorFraction: 0.667 },
    ]);
  });

  it('records an empty flagged[] on a clean run', () => {
    const result = { totalGames: 10, flagged: [], bots: [bot('Healthy')] };
    const lb = buildLeaderboard({
      result,
      previousLeaderboard,
      authorByName,
      replayFiles: [],
      updatedAt: 'x',
    });
    expect(lb.flagged).toEqual([]);
  });

  it('namespaces authorByName and defaults to built-in', () => {
    const result = {
      totalGames: 10,
      flagged: [],
      bots: [bot('community/thing'), bot('Strategist')],
    };
    const lb = buildLeaderboard({
      result,
      previousLeaderboard,
      authorByName,
      replayFiles: [],
      updatedAt: 'x',
    });
    expect(lb.bots.find(b => b.name === 'community/thing').author).toBe('community');
    expect(lb.bots.find(b => b.name === 'Strategist').author).toBe('built-in');
  });
});

describe('buildHistoryEntry', () => {
  it('excludes flagged bots from standings but keeps them in a durable flagged[] record', () => {
    const result = {
      totalGames: 100,
      failedGames: 0,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 5, maxMovesHit: 0, errorFraction: 1 }],
      bots: [
        bot('Healthy', { elo: 1350, wins: 40, errors: 1 }),
        bot('Broken', { elo: 900, wins: 0, errors: 30 }),
      ],
    };

    const entry = buildHistoryEntry({ result, date: '2026-07-08', botCount: 2 });

    expect(entry.standings.map(s => s.name)).toEqual(['Healthy']);
    expect(entry.standings[0]).toMatchObject({ name: 'Healthy', wins: 40, errors: 1 });
    expect(entry.champion).toBe('Healthy'); // top surviving bot, never the flagged one
    expect(entry.flagged).toHaveLength(1);
    expect(entry.flagged[0]).toMatchObject({ name: 'Broken', errors: 30, invalidMoves: 5 });
    expect(entry.botCount).toBe(2);
  });

  it('records an empty flagged[] and a real champion for a clean run', () => {
    const result = {
      totalGames: 50,
      failedGames: 0,
      flagged: [],
      bots: [bot('Top', { elo: 1400 }), bot('Second', { elo: 1200 })],
    };
    const entry = buildHistoryEntry({ result, date: '2026-07-08', botCount: 2 });
    expect(entry.flagged).toEqual([]);
    expect(entry.champion).toBe('Top');
    expect(entry.standings).toHaveLength(2);
  });

  it('crowns the top SURVIVING bot when the flagged bot is the ELO leader', () => {
    /*
     * The distinguishing case: the flagged bot sits at result.bots[0] (highest ELO). The old
     * script logic (`champion: result.bots[0]?.name`) would have crowned it; the fix filters
     * flagged bots first and takes standings[0]. Only this arrangement fails under the old code.
     */
    const result = {
      totalGames: 100,
      failedGames: 0,
      flagged: [{ name: 'Broken', errors: 40, invalidMoves: 0, maxMovesHit: 0, errorFraction: 1 }],
      bots: [
        bot('Broken', { elo: 1500, wins: 0, errors: 40 }), // top ELO but broken → index 0
        bot('Healthy', { elo: 1200, wins: 30, errors: 0 }),
      ],
    };

    const entry = buildHistoryEntry({ result, date: '2026-07-08', botCount: 2 });

    expect(entry.champion).toBe('Healthy');
    expect(entry.standings.map(s => s.name)).toEqual(['Healthy']);
  });

  it('records a null champion (and empty standings) when every bot is flagged', () => {
    const result = {
      totalGames: 20,
      failedGames: 0,
      flagged: [
        { name: 'A', errors: 20, invalidMoves: 0, maxMovesHit: 0, errorFraction: 1 },
        { name: 'B', errors: 20, invalidMoves: 0, maxMovesHit: 0, errorFraction: 1 },
      ],
      bots: [bot('A', { elo: 1000, wins: 0 }), bot('B', { elo: 990, wins: 0 })],
    };

    const entry = buildHistoryEntry({ result, date: '2026-07-08', botCount: 2 });

    expect(entry.champion).toBeNull();
    expect(entry.standings).toEqual([]);
    expect(entry.flagged.map(f => f.name)).toEqual(['A', 'B']);
  });
});

describe('missing-flagged contract (#53)', () => {
  // A result without a `flagged` field is a contract violation, not "zero broken bots" —
  // both builders must refuse rather than silently republish. See flaggedNameSet.
  const resultWithoutFlagged = { totalGames: 10, failedGames: 0, bots: [bot('Healthy')] };

  it('buildLeaderboard throws instead of defaulting a missing flagged to []', () => {
    expect(() =>
      buildLeaderboard({
        result: resultWithoutFlagged,
        previousLeaderboard,
        authorByName,
        replayFiles: [],
        updatedAt: 'x',
      })
    ).toThrow(/flagged/);
  });

  it('buildHistoryEntry throws instead of defaulting a missing flagged to []', () => {
    expect(() =>
      buildHistoryEntry({ result: resultWithoutFlagged, date: '2026-07-08', botCount: 1 })
    ).toThrow(/flagged/);
  });
});
