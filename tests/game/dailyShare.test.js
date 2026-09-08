import { GAME_URL, formatDailyShare } from '../../src/game/dailyShare.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Daily Conquest share text', () => {
  it('reports a win in four lines with the streak and the link', () => {
    expect(
      formatDailyShare({
        date: '2026-09-07',
        won: true,
        turns: 9,
        attacks: 37,
        captures: 36,
        streak: 3,
      })
    ).toBe(
      [
        'Dice Wars Daily · Sep 7, 2026',
        'Won in 9 turns · 36/37 attacks won',
        'Streak: 3 days',
        GAME_URL,
      ].join('\n')
    );
  });

  it('names a loss and a draw differently, and never leaks the board', () => {
    const loss = formatDailyShare({
      date: '2026-09-07',
      won: false,
      turns: 15,
      attacks: 20,
      captures: 12,
      streak: 5,
    });
    expect(loss.split('\n')[1]).toBe('Eliminated after 15 turns · 12/20 attacks won');

    const draw = formatDailyShare({
      date: '2026-09-07',
      won: false,
      drew: true,
      turns: 40,
      attacks: 61,
      captures: 30,
      streak: 5,
    });
    expect(draw.split('\n')[1]).toBe('Draw after 40 turns · 30/61 attacks won');

    // Nothing about the map, the seats, or the territories anyone held.
    for (const text of [loss, draw]) {
      expect(text).not.toMatch(/territor|land|player|seat|map/i);
    }
  });

  it('drops the streak line below two days and keeps three lines', () => {
    for (const streak of [undefined, 0, 1]) {
      const lines = formatDailyShare({
        date: '2026-09-07',
        won: true,
        turns: 1,
        attacks: 1,
        captures: 1,
        streak,
      }).split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('Won in 1 turn · 1/1 attacks won'); // singular, not "1 turns"
      expect(lines.at(-1)).toBe(GAME_URL);
    }
  });

  it('names the board’s UTC date with its year, wherever the sharer is', () => {
    vi.stubEnv('TZ', 'Pacific/Auckland'); // UTC+12: already the 8th when the board opens
    const line = formatDailyShare({
      date: '2026-09-07',
      won: true,
      turns: 2,
      attacks: 3,
      captures: 3,
    }).split('\n')[0];
    expect(line).toBe('Dice Wars Daily · Sep 7, 2026');
  });
});
