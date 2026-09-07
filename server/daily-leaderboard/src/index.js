/**
 * Daily Conquest shared leaderboard — Cloudflare Worker.
 *
 * Three routes, backed by D1:
 *
 * - `GET  /daily/{YYYY-MM-DD}`         → the board (top wins + totals)
 * - `POST /daily/{YYYY-MM-DD}/results` → submit a finished attempt
 * - `OPTIONS *`                        → CORS preflight
 *
 * The submission route is the whole point, and its rule is simple: **the score
 * is not in the request.** The client sends a name and the replay of the game it
 * played; the Worker rebuilds that board from the date's own seed, re-runs the
 * opponents itself, and derives the score from the re-simulation
 * (`verifyDailyReplay`). `replay.metadata`, and anything else the client claims,
 * is ignored. A replay from a different board, an illegal move, an edited
 * opponent turn or an unfinished game each get their own 400 code.
 *
 * What is deliberately NOT stored: the replay, the submitter's address, and any
 * other identifier. Only the verified numbers, a salted hash of the address (to
 * cap submissions), and a hash of the replay (to reject a double-submit) are
 * kept — see README.md.
 *
 * "One attempt per person" is not enforceable here and is not claimed to be:
 * the client's localStorage decides which attempt is official, and this Worker
 * only caps how many results one address can push onto a single board.
 *
 * @module server/daily-leaderboard/index
 */

import { verifyDailyReplay } from '../../../src/game/verifyDailyReplay.js';
import { normalizeName } from './names.js';
import {
  LEADERBOARD_LIMIT,
  insertResult,
  rankOf,
  readIpCount,
  readTopWins,
  readTotals,
  replayAlreadySubmitted,
} from './db.js';

/** Submission envelope version this Worker speaks (`{ version, name, replay }`). */
export const SUBMISSION_VERSION = 1;

/** Origins allowed to call the API when `env.ALLOWED_ORIGINS` is unset. */
export const DEFAULT_ALLOWED_ORIGINS =
  'https://ivanlay.com,http://localhost:3000,http://localhost:4173';

/**
 * Largest submission body accepted, in bytes. A full daily replay is a few
 * hundred two-key objects — well under 20 KB serialized — so this leaves plenty
 * of headroom while keeping a hostile body from being parsed at all.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Accepted submissions one address may add to one board. */
export const MAX_SUBMISSIONS_PER_IP = 3;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

export default {
  /**
   * @param {Request} request
   * @param {{DB: D1Database, ALLOWED_ORIGINS?: string, IP_SALT?: string}} env
   * @returns {Promise<Response>}
   */
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

/**
 * Route and answer one request. Exported so tests can drive it directly with a
 * plain `Request` and a stub `env`, without a Worker runtime.
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env) {
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  let route;
  try {
    route = matchRoute(new URL(request.url).pathname);
  } catch {
    return fail(cors, 400, 'invalid_body', 'Malformed request URL.');
  }
  if (!route) return fail(cors, 404, 'not_found', 'No such endpoint.');
  if (!DATE_PATTERN.test(route.date)) {
    return fail(cors, 400, 'invalid_body', 'Board date must be formatted YYYY-MM-DD.');
  }

  try {
    if (route.kind === 'board' && request.method === 'GET') {
      return await getBoard(env, route.date, cors);
    }
    if (route.kind === 'results' && request.method === 'POST') {
      return await postResult(request, env, route.date, cors);
    }
  } catch (err) {
    /*
     * A throw here is ours (a D1 outage, a missing binding), not the caller's —
     * every client-controlled failure above returns a coded 400. Log it so it is
     * findable in `wrangler tail` and answer with a 503 rather than leaking the
     * internals to the page.
     */
    console.error('[daily-leaderboard] request failed:', err && err.stack ? err.stack : err);
    return fail(cors, 503, 'unavailable', 'The leaderboard is temporarily unavailable.');
  }

  return fail(cors, 405, 'method_not_allowed', `${request.method} is not allowed here.`);
}

/**
 * Split a pathname into `{ kind, date }`.
 *
 * Matched from the `daily` segment rather than from the root, so the Worker
 * still routes correctly when it is mounted under a path prefix
 * (`example.com/api/*`) instead of on its own subdomain.
 *
 * @param {string} pathname
 * @returns {{kind: 'board'|'results', date: string}|null}
 */
function matchRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const start = parts.lastIndexOf('daily');
  if (start === -1) return null;
  const rest = parts.slice(start + 1);
  if (rest.length === 1) return { kind: 'board', date: rest[0] };
  if (rest.length === 2 && rest[1] === 'results') return { kind: 'results', date: rest[0] };
  return null;
}

/**
 * `GET /daily/{date}` — the public board. Open for any well-formed date: past
 * boards are read-only history, and hiding them would only make the archive
 * harder to link to.
 */
async function getBoard(env, date, cors) {
  const [entries, totals] = await Promise.all([
    readTopWins(env.DB, date, LEADERBOARD_LIMIT),
    readTotals(env.DB, date),
  ]);
  return json(cors, 200, { date, entries, totals });
}

/**
 * `POST /daily/{date}/results` — verify and record one finished attempt.
 *
 * Order matters and is chosen so the cheap refusals happen first: the date
 * window, then the body size, then the name, then the per-address cap, and only
 * then the re-simulation, which is the one step that costs real CPU. The
 * allowance is charged after the insert, so a rejected submission never burns
 * an attempt.
 */
async function postResult(request, env, date, cors) {
  if (!isOpenBoard(date)) {
    return fail(
      cors,
      400,
      'date_closed',
      "That board is closed — only today's and yesterday's results can be posted."
    );
  }

  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(cors, 400, 'invalid_body', 'Submission is too large.');
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return fail(cors, 400, 'invalid_body', 'Submission body could not be read.');
  }
  if (raw.length > MAX_BODY_BYTES) {
    return fail(cors, 400, 'invalid_body', 'Submission is too large.');
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(cors, 400, 'invalid_body', 'Submission body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(cors, 400, 'invalid_body', 'Submission body must be an object.');
  }
  if (body.version !== SUBMISSION_VERSION) {
    return fail(
      cors,
      400,
      'invalid_body',
      `Unsupported submission version ${JSON.stringify(body.version)}; this server speaks ${SUBMISSION_VERSION}.`
    );
  }

  const name = normalizeName(body.name);
  if (name === null) {
    return fail(
      cors,
      400,
      'name_rejected',
      'Pick a name of 1-16 letters, numbers, spaces, hyphens or underscores.'
    );
  }

  /*
   * Refuse rather than fall back to an unsalted hash: without the secret the
   * stored digest is a reversible record of who played, which is exactly the
   * thing this column exists to avoid.
   */
  if (!env.IP_SALT) {
    console.error('[daily-leaderboard] IP_SALT is not set; refusing to store submissions.');
    return fail(cors, 503, 'unavailable', 'The leaderboard is temporarily unavailable.');
  }
  const ipHash = await sha256(`${env.IP_SALT}:${clientAddress(request)}`);

  if ((await readIpCount(env.DB, date, ipHash)) >= MAX_SUBMISSIONS_PER_IP) {
    return fail(
      cors,
      429,
      'rate_limited',
      `Only ${MAX_SUBMISSIONS_PER_IP} results per day can be posted from one connection.`
    );
  }

  const replayHash = await sha256(JSON.stringify(body.replay ?? null));
  if (await replayAlreadySubmitted(env.DB, date, ipHash, replayHash)) {
    return fail(cors, 400, 'duplicate', 'You have already posted that game to this board.');
  }

  const verdict = verifyDailyReplay(date, body.replay);
  if (!verdict.ok) return fail(cors, 400, verdict.code, verdict.message);

  const { id, createdAt } = await insertResult(env.DB, {
    date,
    name,
    won: verdict.won,
    drew: verdict.drew,
    turns: verdict.turns,
    attacks: verdict.attacks,
    captures: verdict.captures,
    ipHash,
    replayHash,
  });

  const rank = verdict.won
    ? await rankOf(env.DB, date, { id, turns: verdict.turns, createdAt })
    : null;
  const totals = await readTotals(env.DB, date);

  return json(cors, 201, {
    accepted: true,
    won: verdict.won,
    turns: verdict.turns,
    rank,
    totals,
  });
}

/**
 * Is this board still accepting results?
 *
 * Today or yesterday, UTC. Yesterday stays open because the board rolls at
 * midnight UTC and a game in progress across it should still be postable; two
 * days is the whole grace period, so a stockpile of old replays can't be
 * dumped onto a quiet board later.
 *
 * @param {string} date - `YYYY-MM-DD`
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isOpenBoard(date, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10);
  return date === today || date === yesterday;
}

/**
 * The submitter's address, as Cloudflare reports it. `X-Forwarded-For` is only
 * a fallback for local `wrangler dev`; in production `CF-Connecting-IP` is set
 * by the edge and cannot be spoofed by the client.
 *
 * @param {Request} request
 * @returns {string}
 */
function clientAddress(request) {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct) return direct;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

/**
 * Hex SHA-256 via WebCrypto — present in both Workers and Node.
 *
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function sha256(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * CORS headers for this request. An origin that isn't configured gets NO
 * `Access-Control-Allow-Origin` at all, so the browser refuses the response —
 * rather than a wildcard, which would put the board's write endpoint on every
 * page on the web.
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Record<string, string>}
 */
export function corsHeaders(request, env) {
  const allowed = (env?.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin');
  // Vary regardless: the response body is origin-independent but the headers
  // are not, so a shared cache must not serve one origin's answer to another.
  const headers = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** JSON response with CORS + no-store (the board changes on every submission). */
function json(cors, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Coded error response — the shape every client failure takes. */
function fail(cors, status, error, message) {
  return json(cors, status, { error, message });
}
