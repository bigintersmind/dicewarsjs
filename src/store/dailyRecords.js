/**
 * Personal daily results for this browser: one SCORED attempt per UTC date,
 * plus a tally of the practice runs played afterwards.
 *
 * The first completed attempt on a board — win, elimination or turn-cap draw —
 * is the official one, and nothing later replaces it (`saveDailyOfficial` is a
 * no-op once one exists). That is what makes a shared leaderboard meaningful:
 * a player cannot grind the same seeded board and post their best run. Quitting
 * completes nothing, so it is not recorded at all.
 *
 * Storage is best-effort. Two failure classes, deliberately distinguished:
 *   - the storage API itself throws (private mode, quota, a blocked origin) —
 *     `available: false`, so the UI can say results are not being saved;
 *   - the stored VALUE is unreadable or of the wrong shape — a warn, treated as
 *     empty, and the next save overwrites it. Storage works; its contents were
 *     junk, and the player should not be told their browser is broken.
 *
 * @module store/dailyRecords
 */

import { DAILY_VERSION, dailyDate, dailyDateFromId, isDailyId } from '../game/dailyChallenge.js';

/** Namespaced by recipe version: a v2 board must never read v1's results. */
export const DAILY_STORAGE_KEY = `dicewars_daily_v${DAILY_VERSION}`;

/** Local history bound: the newest N daily dates are kept, the rest dropped. */
const MAX_RECORDS = 30;

/**
 * @typedef {Object} DailyOfficial
 * @property {boolean} won
 * @property {number} turns - Human turns taken.
 * @property {number} attacks
 * @property {number} captures
 * @property {Object | null} replay - The game's replay, kept so the result can
 *   be submitted (and re-verified server-side) later in the session.
 * @property {string} at - ISO timestamp of the completed attempt.
 * @property {{ name: string, rank: number | null } | null} submission - Set once
 *   the result has been posted to the shared leaderboard.
 */

/**
 * @typedef {Object} DailyRecord
 * @property {DailyOfficial | null} official - The one scored attempt. Null only
 *   in the odd case where a practice run was recorded for a board whose official
 *   result is not in storage (it was cleared between the two games); the next
 *   completed attempt then becomes the official one.
 * @property {number} practice - Completed practice attempts after the official.
 */

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Coerce a caller-supplied tally into something a read-back will accept. */
function toCount(value) {
  return isCount(value) ? value : Math.max(0, Math.trunc(Number(value)) || 0);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidSubmission(value) {
  return (
    value === null ||
    (isPlainObject(value) &&
      typeof value.name === 'string' &&
      value.name.length > 0 &&
      (value.rank === null || isCount(value.rank)))
  );
}

function isValidOfficial(value) {
  return (
    value === null ||
    (isPlainObject(value) &&
      typeof value.won === 'boolean' &&
      isCount(value.turns) &&
      isCount(value.attacks) &&
      isCount(value.captures) &&
      value.captures <= value.attacks &&
      (value.replay === null || isPlainObject(value.replay)) &&
      typeof value.at === 'string' &&
      value.at.length > 0 &&
      isValidSubmission(value.submission))
  );
}

function isValidRecord(value) {
  return (
    isPlainObject(value) &&
    isCount(value.practice) &&
    isValidOfficial(value.official ?? null) &&
    // A record with neither an official result nor a practice run is noise.
    (value.official != null || value.practice > 0)
  );
}

/**
 * Read every valid record out of storage.
 *
 * Throws only when the storage API throws — the caller turns that into
 * `available: false`. An unreadable or malformed VALUE is warned about and read
 * as empty, which is what lets the next save overwrite it.
 *
 * @param {Storage} storage
 * @returns {Record<string, DailyRecord>}
 */
function loadRecords(storage) {
  const raw = storage.getItem(DAILY_STORAGE_KEY);
  if (!raw) return {};

  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    console.warn('[Daily Conquest] Discarding unreadable personal results:', err);
    return {};
  }
  if (!isPlainObject(value)) {
    console.warn('[Daily Conquest] Discarding personal results stored in an unexpected shape.');
    return {};
  }

  const entries = Object.entries(value).filter(([id, r]) => isDailyId(id) && isValidRecord(r));
  if (entries.length !== Object.keys(value).length) {
    console.warn('[Daily Conquest] Dropped personal result entries that failed validation.');
  }
  return Object.fromEntries(entries);
}

/**
 * Persist the newest MAX_RECORDS boards, sorted by their ISO date (which the id
 * ends with, so a plain string sort is a date sort).
 *
 * @returns {Record<string, DailyRecord>} What was actually written.
 */
function commit(records, storage) {
  const kept = Object.fromEntries(
    Object.entries(records)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, MAX_RECORDS)
  );
  storage.setItem(DAILY_STORAGE_KEY, JSON.stringify(kept));
  return kept;
}

/**
 * The one write path: read, apply `update` to the current record (null when
 * there is none), write back if it produced something new.
 *
 * `update` returning the existing record — or null — means "nothing to do", so
 * a no-op never rewrites storage and never invents an entry.
 *
 * @param {string} id
 * @param {Storage | undefined} storage
 * @param {(existing: DailyRecord | null) => DailyRecord | null} update
 * @returns {{ record: DailyRecord | null, available: boolean, streak: number }}
 */
function mutate(id, storage, update) {
  try {
    const target = storage ?? localStorage;
    const records = loadRecords(target);
    const existing = records[id] ?? null;
    const next = update(existing);
    if (!next || next === existing) {
      return { record: existing, available: true, streak: computeStreak(records) };
    }
    records[id] = next;
    const kept = commit(records, target);
    // `next` even when the board fell outside the newest 30: it is this
    // attempt's result, and the caller is about to show it.
    return { record: next, available: true, streak: computeStreak(kept) };
  } catch (err) {
    console.warn('[Daily Conquest] Could not save personal result:', err);
    return { record: null, available: false, streak: 0 };
  }
}

/**
 * This board's record, whether storage worked, and the current streak.
 *
 * @param {string} id - Daily id (`dailyIdForDate`).
 * @param {Storage} [storage] - Defaults to localStorage.
 * @returns {{ record: DailyRecord | null, available: boolean, streak: number }}
 */
export function readDailyRecord(id, storage) {
  try {
    const records = loadRecords(storage ?? localStorage);
    return { record: records[id] ?? null, available: true, streak: computeStreak(records) };
  } catch (err) {
    console.warn('[Daily Conquest] Could not read personal results:', err);
    return { record: null, available: false, streak: 0 };
  }
}

/**
 * Record the ONE scored attempt for a board. A second call is a no-op that
 * returns the standing result — the rule the whole feature rests on, enforced
 * here rather than at the call site so no path can score a board twice.
 *
 * @param {string} id
 * @param {{ won: boolean, turns: number, attacks: number, captures: number, replay?: Object|null }} result
 * @param {Storage} [storage]
 */
export function saveDailyOfficial(id, { won, turns, attacks, captures, replay = null }, storage) {
  return mutate(id, storage, existing => {
    if (existing?.official) return existing;
    const attackCount = toCount(attacks);
    return {
      official: {
        won: !!won,
        turns: toCount(turns),
        attacks: attackCount,
        captures: Math.min(toCount(captures), attackCount),
        replay: isPlainObject(replay) ? replay : null,
        at: new Date().toISOString(),
        submission: null,
      },
      practice: existing?.practice ?? 0,
    };
  });
}

/**
 * Count one completed practice run — a replay of a board that already has its
 * official result. Never touches the official result.
 *
 * @param {string} id
 * @param {Storage} [storage]
 */
export function recordDailyPractice(id, storage) {
  return mutate(id, storage, existing => ({
    official: existing?.official ?? null,
    practice: (existing?.practice ?? 0) + 1,
  }));
}

/**
 * Remember that the official result was posted to the shared leaderboard, so
 * the card can show the name and rank on a later visit instead of offering the
 * post again. A no-op when there is no official result to attach it to.
 *
 * @param {string} id
 * @param {{ name: string, rank: number | null }} submission
 * @param {Storage} [storage]
 */
export function saveDailySubmission(id, { name, rank }, storage) {
  return mutate(id, storage, existing => {
    if (!existing?.official) return existing;
    return {
      ...existing,
      official: {
        ...existing.official,
        submission: { name: String(name), rank: isCount(rank) ? rank : null },
      },
    };
  });
}

/** One UTC day earlier, as 'YYYY-MM-DD'. */
function previousDate(date) {
  return dailyDate(new Date(new Date(`${date}T00:00:00Z`).getTime() - 86400000));
}

/**
 * Consecutive UTC dates with an official result, ending today — or, when today
 * has not been played yet, ending yesterday, so a streak is not reported broken
 * for every hour between midnight UTC and the day's first game. 0 when neither
 * today nor yesterday was played.
 *
 * Pure: it reads a records map, not storage.
 *
 * @param {Record<string, DailyRecord>} records
 * @param {string} [today] - UTC date to count back from.
 * @returns {number}
 */
export function computeStreak(records, today = dailyDate()) {
  if (!isDailyId(`daily-v${DAILY_VERSION}-${today}`)) return 0;

  const played = new Set(
    Object.entries(records ?? {})
      .filter(([id, record]) => record?.official && dailyDateFromId(id))
      .map(([id]) => dailyDateFromId(id))
  );

  let cursor = today;
  if (!played.has(cursor)) {
    cursor = previousDate(cursor);
    if (!played.has(cursor)) return 0;
  }

  let streak = 0;
  while (played.has(cursor)) {
    streak++;
    cursor = previousDate(cursor);
  }
  return streak;
}
