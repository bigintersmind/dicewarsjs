import {
  createDailyChallenge,
  dailyDate,
  dailyDateFromId,
  dailyIdForDate,
  formatDailyDate,
  isDailyId,
} from '../../src/game/dailyChallenge.js';
import { createGame } from '../../src/engine/index.js';
import { resolveMapSize } from '../../src/utils/config.js';
import { createHash } from 'node:crypto';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Daily Conquest recipe', () => {
  it('uses the UTC day, including across time-zone and year boundaries', () => {
    expect(dailyDate(new Date('2026-09-07T23:59:59-05:00'))).toBe('2026-09-08');
    expect(dailyDate(new Date('2027-01-01T00:30:00+09:00'))).toBe('2026-12-31');
  });

  it('recreates the exact initial board, dice, turn order and RNG state', () => {
    const recipe = createDailyChallenge('2026-09-07');
    const config = { ...recipe, ...resolveMapSize(recipe.mapSize) };
    const first = createGame(config);
    const second = createGame(config);
    expect(second).toEqual(first);
    expect(first.config.handicap).toBeNull();
    // A map/engine change that alters the shared board needs an intentional recipe version bump.
    expect(createHash('sha256').update(JSON.stringify(first)).digest('hex')).toBe(
      'a1c2eccd124fe9b17a2f6b11f09a343021e6629a708d7e39dc76c73e0166184c'
    );
    expect(recipe.aiAssignments).toEqual([null, 'ai_default', 'ai_default', 'ai_default']);
    expect(createDailyChallenge('2026-09-08').seed).not.toBe(recipe.seed);
  });

  it('returns independent lineups and rejects impossible dates', () => {
    const recipe = createDailyChallenge('2026-09-07');
    recipe.aiAssignments[1] = 'ai_conqueror';
    expect(createDailyChallenge('2026-09-07').aiAssignments[1]).toBe('ai_default');
    for (const date of ['2026-02-30', '2026-13-01', 'tomorrow', '2026-9-7']) {
      expect(() => createDailyChallenge(date)).toThrow();
    }
    expect(createDailyChallenge('2028-02-29').date).toBe('2028-02-29');
  });

  it('recognises only ids of the current recipe version', () => {
    const recipe = createDailyChallenge('2026-09-07');
    expect(dailyIdForDate('2026-09-07')).toBe(recipe.id);
    expect(isDailyId(recipe.id)).toBe(true);
    expect(dailyDateFromId(recipe.id)).toBe('2026-09-07');

    for (const id of [
      'daily-v2-2026-09-07', // a future recipe's results must not be counted as ours
      'daily-v1-2026-9-7',
      'daily-v1-2026-09-07-extra',
      'dicewars_daily_v1',
      '',
      null,
      undefined,
      42,
      { id: 'daily-v1-2026-09-07' },
    ]) {
      expect(isDailyId(id)).toBe(false);
      expect(dailyDateFromId(id)).toBeNull();
    }
  });

  it('names the board’s UTC date, not the reader’s local day', () => {
    // Los Angeles is 7 hours behind: midnight UTC on the 7th is the evening of
    // the 6th there, and a player in that window is still on the 7th's board.
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const boardMidnight = new Date('2026-09-07T00:00:00Z');
    // Guard the guard: prove the runtime honoured the stub before leaning on it.
    expect(boardMidnight.getUTCDate() - boardMidnight.getDate()).toBe(1);

    // Locale-independent: the same fields, the difference being the zone.
    expect(formatDailyDate('2026-09-07')).toBe(
      boardMidnight.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    );
    expect(formatDailyDate('2026-09-07')).not.toBe(
      boardMidnight.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    );
  });
});
