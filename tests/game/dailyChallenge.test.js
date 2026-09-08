import {
  createDailyChallenge,
  dailyDate,
  dailyDateFromId,
  dailyIdForDate,
  formatDailyDate,
  isDailyId,
} from '../../src/game/dailyChallenge.js';
import { createGame, simulateGame } from '../../src/engine/index.js';
import { ai_default } from '../../src/ai/ai_default.js';
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

  it('recreates the exact initial board, and the exact game that follows', () => {
    const recipe = createDailyChallenge('2026-09-07');
    const config = { ...recipe, ...resolveMapSize(recipe.mapSize) };
    const first = createGame(config);
    const second = createGame(config);
    expect(second).toEqual(first);
    expect(first.config.handicap).toBeNull();

    /*
     * Two pins, because the leaderboard's Worker verifies submissions by
     * re-simulating them: if the game drifts under a deployed Worker, every
     * honest post starts failing `unverifiable` and nothing else notices.
     *
     * The first pin is the initial state — the map, the turn order and the
     * starting dice. The second is the whole tape of a full self-play game on
     * that board, which is the part the initial state cannot see: it moves if
     * BattleResolver, END_TURN's reinforcement, `ai_default`'s policy or
     * anything else the journal reads changes.
     *
     * Either literal moving is a deliberate act: bump DAILY_VERSION (new boards,
     * old results retired) and redeploy the Worker — never just re-pin.
     */
    expect(createHash('sha256').update(JSON.stringify(first)).digest('hex')).toBe(
      'a1c2eccd124fe9b17a2f6b11f09a343021e6629a708d7e39dc76c73e0166184c'
    );

    const played = simulateGame({ config, aiAssignments: Array(4).fill(ai_default) });
    expect(played.completed).toBe(true);
    const tape = played.finalState.history
      .map(e => (e.type === 'ATTACK' ? `A${e.from}-${e.to}:${e.result.success ? 1 : 0}` : 'E'))
      .join(',');
    expect(createHash('sha256').update(tape).digest('hex')).toBe(
      '3bc62497f23f34b3cfcc45569e0ed08c5e79accb31b3ba10d951ff5380d05829'
    );

    expect(recipe.aiAssignments).toEqual([null, 'ai_default', 'ai_default', 'ai_default']);
    expect(createDailyChallenge('2026-09-08').seed).not.toBe(recipe.seed);
  });

  it('returns independent lineups and rejects impossible dates', () => {
    const recipe = createDailyChallenge('2026-09-07');
    recipe.aiAssignments[1] = 'ai_conqueror';
    expect(createDailyChallenge('2026-09-07').aiAssignments[1]).toBe('ai_default');
    // The message is asserted, not just the throw: an out-of-range but
    // well-shaped date ('2026-13-01') used to blow up as a RangeError from
    // inside the guard rather than as the documented refusal.
    for (const date of [
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '9999-99-99',
      'tomorrow',
      '2026-9-7',
    ]) {
      expect(() => createDailyChallenge(date)).toThrow(/valid YYYY-MM-DD date/);
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
