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
});
