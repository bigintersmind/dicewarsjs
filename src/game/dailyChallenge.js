/** A versioned, UTC daily board. Keep v1's recipe fixed so retries remain comparable. */
export const DAILY_VERSION = 1;

export function dailyDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function createDailyChallenge(date = dailyDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dailyDate(new Date(`${date}T00:00:00Z`)) !== date) {
    throw new Error('Daily Conquest requires a valid YYYY-MM-DD date.');
  }
  const id = `daily-v${DAILY_VERSION}-${date}`;
  // FNV-1a: a stable unsigned seed, independent of the browser's time zone.
  let seed = 2166136261;
  for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  return {
    id,
    date,
    seed,
    playerCount: 4,
    mapSize: 'small',
    difficulty: 'standard',
    luck: 0,
    spectator: false,
    aiAssignments: [null, 'ai_default', 'ai_default', 'ai_default'],
  };
}

export function formatDailyDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
