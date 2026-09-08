/** A versioned, UTC daily board. Keep v1's recipe fixed so retries remain comparable. */
export const DAILY_VERSION = 1;

/**
 * Identity of a daily board: the version and the UTC date it belongs to.
 * Derived once from DAILY_VERSION so a recipe bump renames every id — and, with
 * it, the storage namespace (`src/store/dailyRecords.js`) — in a single edit.
 */
const DAILY_ID_PREFIX = `daily-v${DAILY_VERSION}-`;
const DAILY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_ID_PATTERN = new RegExp(`^${DAILY_ID_PREFIX}\\d{4}-\\d{2}-\\d{2}$`);

export function dailyDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * The id a board gets for a UTC date — the one place the id is spelled.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {string}
 */
export function dailyIdForDate(date) {
  return `${DAILY_ID_PREFIX}${date}`;
}

/**
 * Does this string name a board of the CURRENT daily version? Stored results
 * are read back through this, so entries left by an older (or hand-edited)
 * version are ignored rather than mixed into today's results.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isDailyId(id) {
  return typeof id === 'string' && DAILY_ID_PATTERN.test(id);
}

/**
 * The UTC date a daily id belongs to, or null when the id isn't one of ours.
 * The inverse of dailyIdForDate: streaks are counted over these dates, and the
 * record store keys by id, so the mapping has to live with the id format.
 *
 * @param {unknown} id
 * @returns {string | null}
 */
export function dailyDateFromId(id) {
  return isDailyId(id) ? id.slice(DAILY_ID_PREFIX.length) : null;
}

export function createDailyChallenge(date = dailyDate()) {
  /*
   * Date.parse rather than `new Date(...)` straight into dailyDate: an
   * out-of-range but well-shaped date ('2026-13-01') parses to NaN, and
   * `new Date(NaN).toISOString()` throws a RangeError — the wrong error, from
   * the middle of the guard that exists to produce the documented one.
   */
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  if (
    !DAILY_DATE_PATTERN.test(date) ||
    !Number.isFinite(utcMidnight) ||
    dailyDate(new Date(utcMidnight)) !== date
  ) {
    throw new Error('Daily Conquest requires a valid YYYY-MM-DD date.');
  }
  const id = dailyIdForDate(date);
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

/**
 * The board's own UTC date, in the reader's locale ("Sep 7"). Pinned to UTC
 * rather than the reader's zone: everyone is playing the same board, so the
 * label has to name that board's day even for a player whose local clock has
 * not reached it (or has already left it).
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {string}
 */
export function formatDailyDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
