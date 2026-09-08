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
 * only caps how much one address can push onto a single board. Two caps, not
 * one: submission ATTEMPTS are charged before the replay is verified (that is
 * the CPU bound), accepted RESULTS are charged by the insert itself (that is
 * the board bound), and both are conditional single-statement writes so a burst
 * of simultaneous requests can't slip past a stale read.
 *
 * Writes additionally require a listed `Origin` and a JSON content type. CORS
 * headers alone were never that check — they decide whether a browser will let
 * a page READ the answer, not whether the handler runs.
 *
 * @module server/daily-leaderboard/index
 */

import { BOARD_FIELDS, verifyDailyReplay } from '../../../src/game/verifyDailyReplay.js';
import { SUBMISSION_VERSION } from '../../../src/game/dailySubmission.js';
import { isBlockedName, normalizeName } from './names.js';
import {
  LEADERBOARD_LIMIT,
  MAX_REQUESTS_PER_IP,
  MAX_SUBMISSIONS_PER_IP,
  chargeRequest,
  findSubmittedResult,
  insertResult,
  rankOf,
  readTopWins,
  readTotals,
} from './db.js';

// Re-exported so a test can drive the Worker and read its constants from one
// module; `SUBMISSION_VERSION` itself is shared with the client, not declared here.
export { MAX_REQUESTS_PER_IP, MAX_SUBMISSIONS_PER_IP, SUBMISSION_VERSION };

/** Origins allowed to call the API when `env.ALLOWED_ORIGINS` is unset. */
export const DEFAULT_ALLOWED_ORIGINS =
  'https://ivanlay.com,http://localhost:3000,http://localhost:4173';

/**
 * Largest submission body accepted, in BYTES — `raw.length` counts UTF-16
 * units, which a multi-byte body undercounts by up to 3x.
 *
 * Sized off the real thing rather than a round number. Measured on the actual
 * serialization: an ATTACK entry is 35 bytes, an END_TURN 19, and the envelope
 * around them (version, name, replay config and metadata) 318 — so the longest
 * documented honest result, the 215-turn / 840-action spectate-to-the-cap draw,
 * is about 27 KB. A 32 KB ceiling left that barely 5 KB of headroom and would
 * have refused a legitimate ~260-turn game outright; 64 KB clears roughly 480
 * turns, which is past anything the 300-turn cap can produce.
 *
 * It is still a CPU bound as much as a memory one: the cost of a submission is
 * one re-simulated action each, and 64 KB is about 1,800 actions — under
 * `MAX_REPLAY_ACTIONS` (3,000) in `src/game/verifyDailyReplay.js`, which stays
 * the ceiling stated in actions, and well inside the `cpu_ms` budget the README
 * measures.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Deepest JSON nesting a submission may carry.
 *
 * A replay is `{version, config, actions:[{type, from, to}]}` — four levels at
 * the very most, the way this guard counts them. The guard is not about shape,
 * though: `JSON.stringify` is recursive and blows the C++ stack on a body
 * nested a few thousand deep, which would come back as a 503 for what is
 * plainly a malformed request. Checked iteratively so the CHECK cannot overflow
 * the stack it is protecting.
 */
export const MAX_JSON_DEPTH = 32;

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
 * Order matters and is chosen so the cheap refusals happen first: who is
 * calling, what they sent it as, the date window, the body size and shape, the
 * name — and only then the per-address ATTEMPT charge and the re-simulation,
 * which is the one step that costs real CPU. The attempt is charged BEFORE the
 * verification it pays for, so an address cannot buy unbounded CPU with
 * submissions that were always going to be rejected; the separate accepted-post
 * allowance is charged by the insert itself.
 */
async function postResult(request, env, date, cors) {
  /*
   * The write endpoint is for this game's pages, not for the web. CORS alone
   * never was that check: it only decides whether the browser SHOWS a response,
   * so a `text/plain` form-style post from any page still ran the whole
   * handler, spent the visitor's allowance and landed a row. Both halves are
   * required — a listed Origin, and a content type that makes the request
   * preflighted rather than "simple".
   */
  if (!isAllowedOrigin(request, env)) {
    return fail(cors, 403, 'forbidden', 'This leaderboard does not accept results from that page.');
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(contentType.trim())) {
    return fail(cors, 415, 'invalid_body', 'Submissions must be sent as application/json.');
  }

  if (!isOpenBoard(date)) {
    return fail(
      cors,
      400,
      'date_closed',
      "That board is closed — only today's and yesterday's results can be posted."
    );
  }

  /*
   * The declared size is the only bound available BEFORE the body is buffered,
   * so a submission that does not declare one is refused rather than read: with
   * the header absent `Number(null)` is 0, which slipped past a `> cap` test
   * and let a chunked body stream into memory in full before the byte count
   * below could object. Junk (`NaN`) is refused for the same reason. A real
   * client always has the header — `fetch` sets it for the string body the
   * client sends.
   */
  const declared = Number(request.headers.get('Content-Length'));
  if (!Number.isFinite(declared) || declared <= 0) {
    return fail(cors, 400, 'invalid_body', 'Submissions must declare their Content-Length.');
  }
  if (declared > MAX_BODY_BYTES) {
    return fail(cors, 400, 'invalid_body', 'Submission is too large.');
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return fail(cors, 400, 'invalid_body', 'Submission body could not be read.');
  }
  if (byteLength(raw) > MAX_BODY_BYTES) {
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
  if (exceedsDepth(body, MAX_JSON_DEPTH)) {
    return fail(cors, 400, 'invalid_body', 'Submission body is nested too deeply.');
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
   * Separate from the charset rule, and a separate code, because they fail for
   * different reasons: `admin` is a perfectly well-formed name, and answering
   * it with "pick a name of 1-16 letters, numbers, spaces, hyphens or
   * underscores" tells the player to fix something that is not wrong.
   */
  if (isBlockedName(name)) {
    return fail(cors, 400, 'name_blocked', 'That name is not available. Pick another.');
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
  // The date is in the preimage, so the digest is a per-day pseudonym rather
  // than a stable one: both counters and the duplicate index are date-scoped
  // already, so nothing here needs to recognize an address across boards.
  const ipHash = await sha256(`${env.IP_SALT}:${date}:${clientAddress(request, env)}`);

  if (!(await chargeRequest(env.DB, date, ipHash))) {
    return fail(
      cors,
      429,
      'rate_limited',
      `Only ${MAX_REQUESTS_PER_IP} submissions a day can be tried from one connection.`
    );
  }

  const replayHash = await sha256(safeStringify(replayIdentity(date, body.replay)));
  const existing = await findSubmittedResult(env.DB, date, ipHash, replayHash);
  if (existing) return alreadyPosted(cors, env, date, name, existing);

  const verdict = verifyDailyReplay(date, body.replay);
  if (!verdict.ok) return fail(cors, 400, verdict.code, verdict.message);

  let accepted;
  let id;
  let createdAt;
  try {
    ({ accepted, id, createdAt } = await insertResult(env.DB, {
      date,
      name,
      won: verdict.won,
      drew: verdict.drew,
      turns: verdict.turns,
      attacks: verdict.attacks,
      captures: verdict.captures,
      ipHash,
      replayHash,
    }));
  } catch (err) {
    /*
     * The duplicate-replay index firing means another request for this same
     * game won the race between the check above and this insert. That is the
     * caller's answer, not our outage — the row the winner stored is looked up
     * and answered from, exactly as the pre-check would have. Everything else
     * still throws through to the 503.
     */
    if (!isUniqueViolation(err)) throw err;
    const raced = await findSubmittedResult(env.DB, date, ipHash, replayHash);
    if (raced) return alreadyPosted(cors, env, date, name, raced);
    return fail(cors, 400, 'duplicate', 'You have already posted that game to this board.');
  }

  if (!accepted) {
    return fail(
      cors,
      429,
      'rate_limited',
      `Only ${MAX_SUBMISSIONS_PER_IP} results per day can be posted from one connection.`
    );
  }

  const { rank, totals } = await boardPosition(env, date, {
    id,
    won: verdict.won,
    turns: verdict.turns,
    createdAt,
  });

  return json(cors, 201, {
    accepted: true,
    won: verdict.won,
    turns: verdict.turns,
    rank,
    totals,
  });
}

/**
 * The answer to a game this submitter has already landed on this board.
 *
 * A retry after a lost response is the ordinary case — the row is in, the
 * player never saw the 201 — and a flat `duplicate` made that unrecoverable:
 * the client throws on any non-2xx, so the form kept offering to post and every
 * retry burned another attempt. The same name gets the same success answer the
 * insert would have given, computed from the stored row, and nothing is
 * inserted. A DIFFERENT name on the same replay is a real conflict (two players
 * behind one address who played identically, or a rename attempt) and still
 * gets the 400.
 */
async function alreadyPosted(cors, env, date, name, existing) {
  if (existing.name !== name) {
    return fail(cors, 400, 'duplicate', 'You have already posted that game to this board.');
  }
  const { rank, totals } = await boardPosition(env, date, existing);
  return json(cors, 200, {
    accepted: true,
    won: existing.won,
    turns: existing.turns,
    rank,
    totals,
  });
}

/**
 * Where a stored row sits on the board, plus the board's totals — the two reads
 * that decorate an accepted answer.
 *
 * Deliberately not fatal. The row is committed and on the board by the time
 * these run, so letting a read failure fall through to the catch-all 503 told
 * the player their accepted result had failed; they would then retry, spend
 * another attempt, and be told `duplicate`. Log it and answer with what is
 * known for certain instead.
 */
async function boardPosition(env, date, entry) {
  try {
    const rank = entry.won ? await rankOf(env.DB, date, entry) : null;
    return { rank, totals: await readTotals(env.DB, date) };
  } catch (err) {
    console.error(
      '[daily-leaderboard] result stored, but reading the board back failed:',
      err && err.stack ? err.stack : err
    );
    return { rank: null, totals: { finished: 0, won: 0 } };
  }
}

/** UTF-8 size of a string — what a body limit actually has to measure. */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Is this value nested deeper than `limit`?
 *
 * Iterative by necessity: the whole point is to refuse input that would
 * overflow the stack in `JSON.stringify`, so the check may not recurse either.
 *
 * @param {unknown} value
 * @param {number} limit
 * @returns {boolean}
 */
function exceedsDepth(value, limit) {
  const stack = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * `JSON.stringify` that answers with a sentinel instead of throwing. Only
 * reachable for input the depth guard let through (a cycle can't come out of
 * `JSON.parse`), and it hashes to a value like any other, so a body that
 * somehow defeats both still gets a coded rejection rather than a 503.
 *
 * The sentinel opens with a NUL, which is what makes it unforgeable: a raw NUL
 * never appears in `JSON.stringify` output (it is always escaped as `\u0000`),
 * so no real body can serialize to a string that collides with it. It is
 * written here as the ESCAPE `\u0000` rather than the byte itself — a raw NUL
 * in the source makes this file binary to `grep` and `file`.
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '\u0000unserializable';
  }
}

/**
 * What a duplicate is measured against: the board's date, the config fields the
 * verifier actually compares, and the action list.
 *
 * NOT the raw body. The submitted envelope carries `replay.metadata`, which the
 * verifier ignores and which holds a wall-clock timestamp — so hashing the body
 * keyed the duplicate index on the clock, and a re-post of the very same game
 * (or the same game with its top-level keys in a different order) hashed as a
 * new one. Projecting first means the hash is the identity the Worker verified.
 *
 * `BOARD_FIELDS` is the verifier's own list — the one that decides
 * `wrong_board` — imported rather than mirrored so the two cannot drift.
 */

function replayIdentity(date, replay) {
  const config = replay && typeof replay === 'object' ? replay.config : null;
  const board =
    config && typeof config === 'object'
      ? Object.fromEntries(BOARD_FIELDS.map(field => [field, config[field] ?? null]))
      : null;
  return {
    date,
    config: board,
    actions: replay && typeof replay === 'object' ? (replay.actions ?? null) : null,
  };
}

/** A duplicate-key rejection from D1/SQLite, whichever layer wrapped it. */
function isUniqueViolation(err) {
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  return /UNIQUE constraint failed/i.test(text);
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
 * The submitter's address, as Cloudflare reports it. In production
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client.
 *
 * `X-Forwarded-For` is a caller-supplied header — a fresh value on every
 * request would hand an attacker a fresh rate-limit bucket each time — so it is
 * read ONLY when the deployment opts in with `TRUST_FORWARDED_FOR = "1"`, which
 * is for `wrangler dev` (no `CF-Connecting-IP`) and for a deployment behind a
 * proxy that sets the header itself. Off, everything without a
 * `CF-Connecting-IP` shares the single `unknown` bucket, which is the safe way
 * to be wrong.
 *
 * @param {Request} request
 * @param {Object} [env]
 * @returns {string}
 */
function clientAddress(request, env) {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct) return direct;
  if (env?.TRUST_FORWARDED_FOR === '1') {
    const forwarded = request.headers.get('X-Forwarded-For');
    if (forwarded) return forwarded.split(',')[0].trim();
  }
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
  const origin = request.headers.get('Origin');
  // Vary regardless: the response body is origin-independent but the headers
  // are not, so a shared cache must not serve one origin's answer to another.
  const headers = { Vary: 'Origin' };
  if (isAllowedOrigin(request, env)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/**
 * The configured origin allow-list, as a list. Trailing slashes are stripped:
 * a browser's `Origin` never has one, so a configured `https://ivanlay.com/`
 * would silently 403 every write with nothing in the logs to explain it.
 */
function allowedOrigins(env) {
  return (env?.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Did this request come from a page we serve?
 *
 * A missing `Origin` is NOT allowed here, which is the whole difference between
 * this and {@link corsHeaders}: reads are open to anyone (curl included), but a
 * write has to name the page it came from, and browsers set that header on
 * every cross-origin request whether or not the response will be readable.
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {boolean}
 */
export function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return !!origin && allowedOrigins(env).includes(origin);
}

/** JSON response with CORS + no-store (the board changes on every submission). */
function json(cors, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // Every response here is JSON; say so and stop a browser guessing otherwise.
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Coded error response — the shape every client failure takes. */
function fail(cors, status, error, message) {
  return json(cors, status, { error, message });
}
