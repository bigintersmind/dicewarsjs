/** Personal daily results only; no account or remote leaderboard. */
export const DAILY_STORAGE_KEY = 'dicewars_daily_v1';

function readRecords(storage) {
  const value = JSON.parse(storage.getItem(DAILY_STORAGE_KEY) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid daily records');
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([id, r]) =>
        /^daily-v1-\d{4}-\d{2}-\d{2}$/.test(id) &&
        r &&
        Number.isSafeInteger(r.completed) &&
        r.completed > 0 &&
        Number.isSafeInteger(r.wins) &&
        r.wins >= 0 &&
        r.wins <= r.completed &&
        (r.wins === 0 ? r.bestTurns === null : Number.isSafeInteger(r.bestTurns) && r.bestTurns > 0)
    )
  );
}

export function readDailyRecord(id, storage) {
  try {
    return { record: readRecords(storage ?? localStorage)[id] ?? null, available: true };
  } catch (err) {
    console.warn('[Daily Conquest] Could not read personal results:', err);
    return { record: null, available: false };
  }
}

export function saveDailyResult(id, { won, turns }, storage) {
  try {
    const target = storage ?? localStorage;
    const records = readRecords(target);
    const previous = records[id] ?? { completed: 0, wins: 0, bestTurns: null };
    const record = {
      completed: previous.completed + 1,
      wins: previous.wins + Number(won),
      bestTurns: won ? Math.min(previous.bestTurns ?? Infinity, turns) : previous.bestTurns,
    };
    records[id] = record;
    // Bound local history; sorting by the ISO date keeps the newest 30 boards.
    const recent = Object.entries(records)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 30);
    target.setItem(DAILY_STORAGE_KEY, JSON.stringify(Object.fromEntries(recent)));
    return { record, available: true };
  } catch (err) {
    console.warn('[Daily Conquest] Could not save personal result:', err);
    return { record: null, available: false };
  }
}
