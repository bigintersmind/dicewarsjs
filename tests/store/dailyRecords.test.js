import {
  DAILY_STORAGE_KEY,
  computeStreak,
  readDailyRecord,
  recordDailyPractice,
  saveDailyOfficial,
  saveDailySubmission,
} from '../../src/store/dailyRecords.js';
import { dailyIdForDate } from '../../src/game/dailyChallenge.js';

const today = '2026-09-07';
const id = dailyIdForDate(today);
const attempt = { won: true, turns: 9, attacks: 20, captures: 14 };
/** What an older build stored on the official result, and no longer does. */
const legacyReplay = { version: 2, actions: [{ type: 'END_TURN' }] };

function memoryStorage(value = '{}') {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_, next) => {
      value = next;
    }),
    stored: () => JSON.parse(value),
  };
}

/** A storage pre-loaded with an official result on each of the given dates. */
function storageWithOfficials(dates) {
  const records = Object.fromEntries(
    dates.map(date => [
      dailyIdForDate(date),
      {
        official: {
          won: false,
          turns: 3,
          attacks: 4,
          captures: 1,
          at: `${date}T12:00:00.000Z`,
          submission: null,
        },
        practice: 0,
      },
    ])
  );
  return memoryStorage(JSON.stringify(records));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${today}T12:00:00Z`));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Personal daily records', () => {
  it('records the one scored attempt and refuses to overwrite it', () => {
    const storage = memoryStorage();
    const saved = saveDailyOfficial(id, attempt, storage);
    expect(saved).toMatchObject({ available: true, streak: 1, wrote: true });
    expect(saved.record).toEqual({
      official: {
        won: true,
        drew: false,
        turns: 9,
        attacks: 20,
        captures: 14,
        at: '2026-09-07T12:00:00.000Z',
        submission: null,
      },
      practice: 0,
    });

    // The rule the whole feature rests on: a better run later changes nothing.
    const second = saveDailyOfficial(id, { won: true, turns: 2, attacks: 2, captures: 2 }, storage);
    expect(second.record).toEqual(saved.record);
    expect(storage.setItem).toHaveBeenCalledTimes(1); // the no-op did not rewrite storage
    expect(readDailyRecord(id, storage).record).toEqual(saved.record);

    /*
     * `wrote` is the difference between "your result was scored" and "someone
     * else's already was". The record alone cannot say which happened — it
     * comes back looking identical — so the flag is what the caller branches on
     * when two tabs finish the same board.
     */
    expect(second.wrote).toBe(false);
  });

  it('reports wrote on every path that changes storage, and only those', () => {
    const storage = memoryStorage();
    expect(saveDailyOfficial(id, attempt, storage).wrote).toBe(true);
    expect(recordDailyPractice(id, storage).wrote).toBe(true);
    expect(saveDailySubmission(id, { name: 'Ada', rank: 1 }, storage).wrote).toBe(true);

    // Nothing to attach a submission to is a no-op, not a write.
    expect(saveDailySubmission(id, { name: 'Ada', rank: 1 }, memoryStorage()).wrote).toBe(false);

    const denied = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Storage that throws never wrote either — but it is `available` that says so.
    expect(saveDailyOfficial(id, attempt, denied)).toMatchObject({
      available: false,
      wrote: false,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('drops a replay left on an older record, and prunes it on the next write', () => {
    const stored = {
      [id]: {
        official: {
          won: true,
          drew: false,
          turns: 9,
          attacks: 20,
          captures: 14,
          replay: legacyReplay,
          at: '2026-09-06T12:00:00.000Z',
          submission: null,
        },
        practice: 0,
      },
    };
    const storage = memoryStorage(JSON.stringify(stored));

    // The old record still validates — the replay is accepted, then dropped.
    const { record } = readDailyRecord(id, storage);
    expect(record.official.turns).toBe(9);
    expect(record.official).not.toHaveProperty('replay');

    // ~22 KB per board of JSON that nothing reads: gone from storage on the
    // next write, without a migration step.
    recordDailyPractice(id, storage);
    expect(storage.stored()[id].official).not.toHaveProperty('replay');
    expect(storage.stored()[id].practice).toBe(1);
  });

  it('never writes a replay for a new result, whatever the caller passes', () => {
    const storage = memoryStorage();
    saveDailyOfficial(id, { ...attempt, replay: legacyReplay }, storage);
    expect(storage.stored()[id].official).not.toHaveProperty('replay');
  });

  it('keeps a turn-cap draw apart from an elimination, and never calls a win a draw', () => {
    const storage = memoryStorage();
    const drawn = saveDailyOfficial(
      id,
      { won: false, drew: true, turns: 40, attacks: 30, captures: 20 },
      storage
    );
    expect(drawn.record.official).toMatchObject({ won: false, drew: true });
    expect(readDailyRecord(id, storage).record.official.drew).toBe(true);

    const other = memoryStorage();
    const won = saveDailyOfficial(id, { ...attempt, drew: true }, other);
    expect(won.record.official).toMatchObject({ won: true, drew: false });

    // A record written before the flag existed still reads back.
    const legacy = memoryStorage();
    const withoutDrew = { ...drawn.record.official };
    delete withoutDrew.drew;
    legacy.setItem(
      DAILY_STORAGE_KEY,
      JSON.stringify({ [id]: { official: withoutDrew, practice: 0 } })
    );
    expect(readDailyRecord(id, legacy).record.official.won).toBe(false);
  });

  it('counts practice runs beside the official result without touching it', () => {
    const storage = memoryStorage();
    saveDailyOfficial(id, attempt, storage);
    expect(recordDailyPractice(id, storage).record.practice).toBe(1);
    expect(recordDailyPractice(id, storage).record).toEqual({
      official: expect.objectContaining({ turns: 9, won: true }),
      practice: 2,
    });
    expect(readDailyRecord(id, storage).record.official.turns).toBe(9);
  });

  it('remembers a submission on the official result, and only there', () => {
    const storage = memoryStorage();
    saveDailyOfficial(id, attempt, storage);
    const posted = saveDailySubmission(id, { name: 'Ada', rank: 3 }, storage);
    expect(posted.record.official.submission).toEqual({ name: 'Ada', rank: 3 });
    expect(
      saveDailySubmission(id, { name: 'Ada', rank: null }, storage).record.official.submission
    ).toEqual({ name: 'Ada', rank: null });
    expect(readDailyRecord(id, storage).record.official.submission.name).toBe('Ada');

    // Nothing to attach it to: a no-op, not an invented record.
    const empty = memoryStorage();
    expect(saveDailySubmission(id, { name: 'Ada', rank: 1 }, empty).record).toBeNull();
    expect(empty.setItem).not.toHaveBeenCalled();
  });

  it('keeps only the newest 30 boards, including an old board finished after midnight', () => {
    const storage = memoryStorage();
    for (let day = 1; day <= 31; day++) {
      saveDailyOfficial(
        dailyIdForDate(`2026-08-${String(day).padStart(2, '0')}`),
        attempt,
        storage
      );
    }
    saveDailyOfficial(dailyIdForDate('2026-07-31'), attempt, storage);
    expect(Object.keys(storage.stored())).toHaveLength(30);
    expect(readDailyRecord(dailyIdForDate('2026-08-31'), storage).record.official.turns).toBe(9);
    expect(readDailyRecord(dailyIdForDate('2026-08-01'), storage).record).toBeNull();
  });

  describe('streaks', () => {
    const streakOf = (dates, at = today) => computeStreak(storageWithOfficials(dates).stored(), at);

    it('counts back from today, or from yesterday before today is played', () => {
      expect(streakOf(['2026-09-07', '2026-09-06', '2026-09-05'])).toBe(3);
      expect(streakOf(['2026-09-06', '2026-09-05'])).toBe(2); // today not played yet
      expect(streakOf(['2026-09-07'])).toBe(1);
    });

    it('stops at a gap and reports nothing for a lapsed or empty history', () => {
      expect(streakOf(['2026-09-07', '2026-09-05', '2026-09-04'])).toBe(1);
      expect(streakOf(['2026-09-05', '2026-09-04'])).toBe(0); // the run ended before yesterday
      expect(streakOf([])).toBe(0);
      expect(computeStreak(null)).toBe(0);
      expect(computeStreak({}, 'not-a-date')).toBe(0);
    });

    it('crosses a month boundary and ignores practice-only dates', () => {
      expect(streakOf(['2026-09-01', '2026-08-31', '2026-08-30'], '2026-09-01')).toBe(3);
      const records = storageWithOfficials(['2026-09-07', '2026-09-05']).stored();
      records[dailyIdForDate('2026-09-06')] = { official: null, practice: 2 };
      expect(computeStreak(records, today)).toBe(1);
    });

    it('is reported by every read and write path', () => {
      const storage = storageWithOfficials(['2026-09-06', '2026-09-05']);
      expect(readDailyRecord(id, storage).streak).toBe(2);
      expect(saveDailyOfficial(id, attempt, storage).streak).toBe(3);
      expect(recordDailyPractice(id, storage).streak).toBe(3);
    });
  });

  describe('failure classes', () => {
    it('reports storage that throws as unavailable', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const denied = {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      };
      expect(readDailyRecord(id, denied)).toEqual({ record: null, available: false, streak: 0 });
      expect(saveDailyOfficial(id, attempt, denied).available).toBe(false);
      expect(recordDailyPractice(id, denied).available).toBe(false);
      expect(saveDailySubmission(id, { name: 'Ada', rank: 1 }, denied).available).toBe(false);

      const quota = memoryStorage();
      quota.setItem.mockImplementation(() => {
        throw new Error('quota');
      });
      expect(saveDailyOfficial(id, attempt, quota).available).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it('treats an unreadable stored value as empty, and the next save overwrites it', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const stored of ['{broken', '[]', '"a string"', 'null', '17']) {
        const storage = memoryStorage(stored);
        // Storage itself works, so results can still be saved: available stays true.
        expect(readDailyRecord(id, storage)).toEqual({ record: null, available: true, streak: 0 });
        expect(saveDailyOfficial(id, attempt, storage).available).toBe(true);
        expect(storage.stored()[id].official.turns).toBe(9);
        expect(Object.keys(storage.stored())).toEqual([id]);
      }
      expect(warn).toHaveBeenCalled();
    });

    it('drops individual entries that could not have been written by this version', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const good = {
        official: {
          won: false,
          turns: 3,
          attacks: 4,
          captures: 1,
          at: '2026-09-06T00:00:00.000Z',
          submission: null,
        },
        practice: 0,
      };
      const storage = memoryStorage(
        JSON.stringify({
          [dailyIdForDate('2026-09-06')]: good,
          'daily-v2-2026-09-07': good, // a future recipe's board
          'nonsense-key': good,
          [id]: { official: { ...good.official, turns: -1 }, practice: 0 },
          [dailyIdForDate('2026-09-04')]: { official: good.official, practice: 1.5 },
          [dailyIdForDate('2026-09-03')]: {
            official: { ...good.official, captures: 99 },
            practice: 0,
          },
          [dailyIdForDate('2026-09-02')]: { official: null, practice: 0 },
          [dailyIdForDate('2026-09-01')]: null,
        })
      );
      expect(readDailyRecord(id, storage).record).toBeNull();
      expect(readDailyRecord(dailyIdForDate('2026-09-06'), storage).record).toEqual(good);
      expect(readDailyRecord(dailyIdForDate('2026-09-03'), storage).record).toBeNull();
      expect(readDailyRecord(dailyIdForDate('2026-09-02'), storage).record).toBeNull();
      // The one valid entry survives the rewrite; the junk does not come back.
      saveDailyOfficial(id, attempt, storage);
      expect(Object.keys(storage.stored()).sort()).toEqual(
        [dailyIdForDate('2026-09-06'), id].sort()
      );
      expect(warn).toHaveBeenCalled();
    });

    it('is namespaced by the recipe version', () => {
      expect(DAILY_STORAGE_KEY).toBe('dicewars_daily_v1');
      const storage = memoryStorage();
      saveDailyOfficial(id, attempt, storage);
      expect(storage.setItem).toHaveBeenLastCalledWith(DAILY_STORAGE_KEY, expect.any(String));
    });
  });
});
