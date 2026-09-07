import {
  DAILY_STORAGE_KEY,
  readDailyRecord,
  saveDailyResult,
} from '../../src/store/dailyRecords.js';

const id = 'daily-v1-2026-09-07';
function memoryStorage(value = '{}') {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_, next) => {
      value = next;
    }),
  };
}

describe('Personal daily records', () => {
  it('counts completed attempts and retains the fastest victory across retries', () => {
    const storage = memoryStorage();
    saveDailyResult(id, { won: false, turns: 3 }, storage);
    saveDailyResult(id, { won: true, turns: 12 }, storage);
    saveDailyResult(id, { won: true, turns: 8 }, storage);
    saveDailyResult(id, { won: true, turns: 14 }, storage);
    saveDailyResult(id, { won: false, turns: 0 }, storage);
    expect(readDailyRecord(id, storage)).toEqual({
      available: true,
      record: { completed: 5, wins: 3, bestTurns: 8 },
    });
    expect(storage.setItem).toHaveBeenLastCalledWith(DAILY_STORAGE_KEY, expect.any(String));
    expect(readDailyRecord('daily-v1-2026-09-08', storage).record).toBeNull();
  });

  it('keeps only the newest 30 boards, including an old board finished after midnight', () => {
    const storage = memoryStorage();
    for (let day = 1; day <= 31; day++) {
      saveDailyResult(
        `daily-v1-2026-08-${String(day).padStart(2, '0')}`,
        { won: false, turns: 3 },
        storage
      );
    }
    saveDailyResult('daily-v1-2026-07-31', { won: false, turns: 3 }, storage);
    expect(Object.keys(JSON.parse(storage.getItem(DAILY_STORAGE_KEY)))).toHaveLength(30);
    expect(readDailyRecord('daily-v1-2026-08-31', storage).record.completed).toBe(1);
    expect(readDailyRecord('daily-v1-2026-08-01', storage).record).toBeNull();
  });

  it('reports blocked or corrupt storage without breaking play', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const denied = {
      getItem() {
        throw new Error('denied');
      },
    };
    expect(readDailyRecord(id, denied).available).toBe(false);
    expect(saveDailyResult(id, { won: true, turns: 2 }, denied).available).toBe(false);
    expect(readDailyRecord(id, memoryStorage('{broken')).available).toBe(false);
    const quota = memoryStorage();
    quota.setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    expect(saveDailyResult(id, { won: false, turns: 2 }, quota).available).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('discards invalid stored scores instead of displaying impossible personal bests', () => {
    for (const record of [
      null,
      { completed: -1, wins: 2, bestTurns: 0 },
      { completed: 1, wins: 1, bestTurns: -3 },
      { completed: 1, wins: 0, bestTurns: 3 },
    ]) {
      expect(
        readDailyRecord(id, memoryStorage(JSON.stringify({ [id]: record }))).record
      ).toBeNull();
    }
  });
});
