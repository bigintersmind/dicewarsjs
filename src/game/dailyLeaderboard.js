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

import { SUBMISSION_VERSION } from './dailySubmission.js';

/** Configured base URL, trailing slash stripped; null when the build has none. */
export const DAILY_LEADERBOARD_URL =
  (import.meta.env?.VITE_DAILY_LEADERBOARD_URL || '').replace(/\/$/, '') || null;

/** Give up on a silent network rather than leaving a spinner up forever. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * 1–16 characters: letters, digits, spaces, hyphen, underscore.
 *
 * Exported so the Worker's own suite can assert the two rules agree rather than
 * re-typing the literal beside its server twin (`server/daily-leaderboard/src/names.js`).
 */
export const NAME_PATTERN = /^[\p{L}\p{N} _-]{1,16}$/u;

/**
 * Code points that are never part of a name, mirroring the server's rule. The
 * Hangul fillers are the reason it exists: U+115F, U+1160, U+3164 and U+FFA0
 * are `\p{L}`, survive NFC and render as nothing, so `ㅤ` would otherwise pass
 * {@link NAME_PATTERN} as a blank board entry.
 */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0]/gu;

/** A name has to show something: at least one letter or digit that renders. */
const VISIBLE = /[\p{L}\p{N}]/u;

/** Player-facing sentence per failure code. */
export const LEADERBOARD_MESSAGES = {
  disabled: 'The daily leaderboard is not available in this build.',
  not_submittable: 'There is no scored daily result to submit.',
  invalid_body: "The leaderboard couldn't read that result.",
  name_rejected: 'Pick a name of 1-16 letters, numbers, spaces, hyphens or underscores.',
  name_blocked: 'That name is not available. Pick another.',
  wrong_board: "That result isn't from this daily board.",
  unverifiable: "That result couldn't be verified against today's board.",
  not_finished: 'That game has not finished yet.',
  date_closed: 'That board is closed to new results.',
  duplicate: 'You already posted this result today.',
  forbidden: 'This build is not allowed to post to the leaderboard.',
  rate_limited: 'Too many submissions from your network today.',
  not_found: "The leaderboard isn't where this build expects it to be.",
  method_not_allowed: "The leaderboard didn't understand that request.",
  unavailable: 'The leaderboard is temporarily unavailable. Try again later.',
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
  const err = new Error(message || knownMessage(code) || LEADERBOARD_MESSAGES.bad_response, {
    cause,
  });
  err.code = code;
  return err;
}

/**
 * The sentence for a code we actually publish.
 *
 * `Object.hasOwn`, not a truthiness test: a server answering `{"error":
 * "toString"}` would otherwise "match" a function off Object.prototype and get
 * rendered as source code.
 *
 * @param {unknown} code
 * @returns {string | null}
 */
function knownMessage(code) {
  return typeof code === 'string' && Object.hasOwn(LEADERBOARD_MESSAGES, code)
    ? LEADERBOARD_MESSAGES[code]
    : null;
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
 * Normalize, collapse runs of whitespace, and accept only a short, printable
 * name — the same steps in the same order as the server's `normalizeName`.
 *
 * NFC first, because that is what the server measures: a `é` pasted from macOS
 * arrives decomposed (`e` + U+0301), which is two code points and fails
 * {@link NAME_PATTERN}. Without this the client refuses a name the board would
 * happily have taken.
 *
 * @param {unknown} raw
 * @returns {string | null} The name to send, or null when it can't be used.
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!NAME_PATTERN.test(name)) return null;
  // Refuse invisibles rather than strip them, then insist on something visible
  // — which is also what turns away a name of nothing but `-` and `_`.
  const visible = name.replace(IGNORABLE, '');
  if (visible !== name || !VISIBLE.test(visible)) return null;
  return name;
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
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
  };

  let response;
  try {
    response = await doFetch(url, { ...init, ...(controller && { signal: controller.signal }) });
  } catch (err) {
    disarm();
    // An abort is our own timeout; anything else is the network refusing.
    const timedOut = err?.name === 'AbortError';
    throw leaderboardError(timedOut ? 'timeout' : 'network', undefined, err);
  }

  /*
   * The timer stays armed through the body read. `fetch` resolves on the
   * HEADERS, so a server that answers and then stalls mid-body leaves this
   * awaiting forever if the abort has already been cancelled — the exact hang
   * the timeout exists to prevent.
   */
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw leaderboardError('timeout', undefined, err);
    // A body-less error status is still an error status; only a broken success
    // body is a protocol failure.
    if (response.ok) throw leaderboardError('bad_response', undefined, err);
  } finally {
    disarm();
  }
  return { status: response.status, body };
}

/** Turn a non-2xx response into the coded Error the UI shows. */
function responseError(status, body) {
  const code = isPlainObject(body) && typeof body.error === 'string' ? body.error : null;
  if (code && knownMessage(code)) return leaderboardError(code);
  if (status === 429) return leaderboardError('rate_limited');
  if (status >= 500) return leaderboardError('server_error');
  /*
   * An unknown code from a newer server: keep the code so the UI can log it,
   * and prefer the server's own sentence over a generic one — it is the only
   * description of a failure this client has never heard of. Clamped first: it
   * is rendered to a player, and an unbounded, newline-riddled string from a
   * host we do not control is not copy.
   */
  const message = isPlainObject(body) && typeof body.message === 'string' ? body.message : null;
  return leaderboardError(code ?? 'bad_response', message ? clampMessage(message) : undefined);
}

/** One line of a stranger's prose, trimmed to something that fits a dialog. */
function clampMessage(message) {
  return String(message).slice(0, 200).replace(/\s+/g, ' ');
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
