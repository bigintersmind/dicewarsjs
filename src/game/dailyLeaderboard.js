/**
 * Client for the shared daily leaderboard.
 *
 * The board is the same for everybody, so a result is only worth posting if it
 * can be checked: the server re-simulates the submitted replay against the
 * day's seed and derives the score itself. Nothing this module sends is trusted
 * — it carries the replay, not a claim — which is why there is no "score" field
 * in the request body.
 *
 * Every rejection surfaces as an Error with a machine-readable `.code` and a
 * `.message` a player can act on. The message table lives here rather than
 * being echoed from the server: it is stable copy under our control, and a
 * response body is not something to render verbatim.
 *
 * Entirely optional. With no `VITE_DAILY_LEADERBOARD_URL` configured the
 * feature is off — `isLeaderboardEnabled()` is false and both calls reject with
 * code `disabled` rather than firing a request at a nonexistent host.
 *
 * @module game/dailyLeaderboard
 */

/** Configured base URL, trailing slash stripped; null when the build has none. */
export const DAILY_LEADERBOARD_URL =
  (import.meta.env?.VITE_DAILY_LEADERBOARD_URL || '').replace(/\/$/, '') || null;

/** Give up on a silent network rather than leaving a spinner up forever. */
const REQUEST_TIMEOUT_MS = 8000;

/** Wire version of the submission body; the server rejects anything else. */
const SUBMISSION_VERSION = 1;

/** 1–16 characters: letters, digits, spaces, hyphen, underscore. */
const NAME_PATTERN = /^[\p{L}\p{N} _-]{1,16}$/u;

/** Player-facing sentence per failure code. */
export const LEADERBOARD_MESSAGES = {
  disabled: 'The daily leaderboard is not available in this build.',
  not_submittable: 'There is no scored daily result to submit.',
  invalid_body: "The leaderboard couldn't read that result.",
  name_rejected: 'Pick a name of 1-16 letters, numbers, spaces, hyphens or underscores.',
  wrong_board: "That result isn't from this daily board.",
  unverifiable: "That result couldn't be verified against today's board.",
  not_finished: 'That game has not finished yet.',
  date_closed: 'That board is closed to new results.',
  rate_limited: 'Too many submissions from your network today.',
  network: "Couldn't reach the leaderboard. Check your connection and try again.",
  timeout: 'The leaderboard took too long to answer. Try again.',
  bad_response: 'The leaderboard sent an unexpected response.',
  server_error: 'The leaderboard is having trouble. Try again later.',
};

/**
 * Build a rejection the UI can both branch on (`.code`) and show (`.message`).
 *
 * @param {string} code
 * @param {string} [message] - Defaults to the table entry for `code`.
 * @param {unknown} [cause]
 * @returns {Error}
 */
export function leaderboardError(code, message, cause) {
  const err = new Error(
    message || LEADERBOARD_MESSAGES[code] || LEADERBOARD_MESSAGES.bad_response,
    {
      cause,
    }
  );
  err.code = code;
  return err;
}

/**
 * Is the leaderboard configured for this build?
 *
 * @param {string | null} [url]
 * @returns {boolean}
 */
export function isLeaderboardEnabled(url = DAILY_LEADERBOARD_URL) {
  return typeof url === 'string' && url.length > 0;
}

/**
 * Trim, collapse runs of whitespace, and accept only a short, printable name.
 *
 * @param {unknown} raw
 * @returns {string | null} The name to send, or null when it can't be used.
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return NAME_PATTERN.test(name) ? name : null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The base with any trailing slash removed. Applied to whatever a caller passes
 * as well as to the configured constant, so `…/api/` and `…/api` build the same
 * request rather than one of them asking for `…/api//daily/…`.
 */
function baseUrl(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

/**
 * One request, with a timeout, mapping every failure onto a coded Error.
 *
 * @param {Function} doFetch
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function request(doFetch, url, init) {
  if (typeof doFetch !== 'function') {
    throw leaderboardError('network', LEADERBOARD_MESSAGES.network);
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  let response;
  try {
    response = await doFetch(url, { ...init, ...(controller && { signal: controller.signal }) });
  } catch (err) {
    // An abort is our own timeout; anything else is the network refusing.
    const timedOut = err?.name === 'AbortError';
    throw leaderboardError(timedOut ? 'timeout' : 'network', undefined, err);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    // A body-less error status is still an error status; only a broken success
    // body is a protocol failure.
    if (response.ok) throw leaderboardError('bad_response', undefined, err);
  }
  return { status: response.status, body };
}

/** Turn a non-2xx response into the coded Error the UI shows. */
function responseError(status, body) {
  const code = isPlainObject(body) && typeof body.error === 'string' ? body.error : null;
  if (code && LEADERBOARD_MESSAGES[code]) return leaderboardError(code);
  if (status === 429) return leaderboardError('rate_limited');
  if (status >= 500) return leaderboardError('server_error');
  /*
   * An unknown code from a newer server: keep the code so the UI can log it,
   * and prefer the server's own sentence over a generic one — it is the only
   * description of a failure this client has never heard of.
   */
  const message = isPlainObject(body) && typeof body.message === 'string' ? body.message : null;
  return leaderboardError(code ?? 'bad_response', message ?? undefined);
}

/**
 * Today's (or any date's) top wins.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @param {{ url?: string|null, fetch?: Function }} [options]
 * @returns {Promise<{ date: string, entries: Array, totals: { finished: number, won: number } }>}
 */
export async function fetchDailyLeaderboard(
  date,
  { url = DAILY_LEADERBOARD_URL, fetch = globalThis.fetch } = {}
) {
  if (!isLeaderboardEnabled(url)) throw leaderboardError('disabled');

  const { status, body } = await request(
    fetch,
    `${baseUrl(url)}/daily/${encodeURIComponent(date)}`,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }
  );
  if (status < 200 || status >= 300) throw responseError(status, body);
  if (!isPlainObject(body) || !Array.isArray(body.entries) || !isPlainObject(body.totals)) {
    throw leaderboardError('bad_response');
  }
  return {
    date: typeof body.date === 'string' ? body.date : date,
    entries: body.entries,
    totals: {
      finished: Number(body.totals.finished) || 0,
      won: Number(body.totals.won) || 0,
    },
  };
}

/**
 * Post a finished daily attempt. The server verifies the replay and answers
 * with the score IT derived — that, not the client's own tally, is what the
 * card should show.
 *
 * @param {{ date: string, name: string, replay: Object }} result
 * @param {{ url?: string|null, fetch?: Function }} [options]
 * @returns {Promise<{ accepted: true, won: boolean, turns: number, rank: number|null,
 *   totals: { finished: number, won: number } }>}
 */
export async function submitDailyResult(
  { date, name, replay },
  { url = DAILY_LEADERBOARD_URL, fetch = globalThis.fetch } = {}
) {
  if (!isLeaderboardEnabled(url)) throw leaderboardError('disabled');
  const normalized = normalizeName(name);
  if (!normalized) throw leaderboardError('name_rejected');
  if (!isPlainObject(replay)) throw leaderboardError('not_submittable');

  const { status, body } = await request(
    fetch,
    `${baseUrl(url)}/daily/${encodeURIComponent(date)}/results`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ version: SUBMISSION_VERSION, name: normalized, replay }),
    }
  );
  if (status < 200 || status >= 300) throw responseError(status, body);
  if (!isPlainObject(body) || body.accepted !== true) throw leaderboardError('bad_response');

  return {
    accepted: true,
    won: !!body.won,
    turns: Number(body.turns) || 0,
    rank: Number.isSafeInteger(body.rank) ? body.rank : null,
    totals: {
      finished: Number(body.totals?.finished) || 0,
      won: Number(body.totals?.won) || 0,
    },
  };
}
