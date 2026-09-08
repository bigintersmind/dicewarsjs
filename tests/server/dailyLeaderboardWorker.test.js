/**
 * The leaderboard Worker, end to end.
 *
 * `handleRequest` is driven with real `Request` objects against a real SQLite
 * database bound through the D1 interface, and every submission carries a
 * replay produced by a real headless `GameController` game. So a passing run
 * says the whole path works: HTTP → CORS → limits → name rules → the engine
 * re-simulation → SQL → the ranked board that comes back out.
 */

import {
  handleRequest,
  isOpenBoard,
  MAX_BODY_BYTES,
  MAX_JSON_DEPTH,
  MAX_REQUESTS_PER_IP,
  MAX_SUBMISSIONS_PER_IP,
  SUBMISSION_VERSION,
  sha256,
} from '../../server/daily-leaderboard/src/index.js';
import { normalizeName } from '../../server/daily-leaderboard/src/names.js';
import { SQL, readIpCount, readRequestCount } from '../../server/daily-leaderboard/src/db.js';
import { LEADERBOARD_MESSAGES, NAME_PATTERN } from '../../src/game/dailyLeaderboard.js';
import { createTestDatabase } from './d1Sqlite.js';
import {
  playDailyGame,
  greedyHuman,
  cautiousHuman,
  timidHuman,
  marginHuman,
  turnCapCut,
} from './dailyReplayFixture.js';

/** The board every fixture below was played on; pinned as "today" for the suite. */
const BOARD = '2026-09-16';
const NOW = new Date('2026-09-16T12:00:00.000Z');

const ORIGIN = 'https://ivanlay.com';
const BASE = 'https://daily.example.workers.dev';

let db;
let env;
/** Four real outcomes on BOARD: a fast win, a slow win, and two different losses. */
let fastWin;
let slowWin;
let loss;
let otherLoss;

beforeAll(async () => {
  fastWin = await playDailyGame({ date: BOARD, human: greedyHuman });
  slowWin = await playDailyGame({ date: BOARD, human: cautiousHuman });
  loss = await playDailyGame({ date: BOARD, human: timidHuman });
  // A fourth genuinely different game: the accepted cap needs a submission that
  // both verifies and is not one of the three above.
  otherLoss = await playDailyGame({ date: BOARD, human: marginHuman(0) });
}, 120000);

beforeEach(() => {
  db = createTestDatabase();
  env = {
    DB: db.DB,
    IP_SALT: 'test-salt',
    ALLOWED_ORIGINS: 'https://ivanlay.com,http://localhost:3000',
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

/**
 * POST a submission.
 *
 * `Content-Length` is set here because the Worker requires it and `new Request`
 * in Node does not add one, while a browser's `fetch` always does for the string
 * body the client sends. Pass `contentLength: null` for a body that declares no
 * size, or a string to declare a wrong one.
 */
function post({
  date = BOARD,
  name = 'Ivan',
  replay,
  ip = '203.0.113.7',
  origin = ORIGIN,
  contentType = 'application/json',
  body,
  contentLength,
  headers: extraHeaders,
} = {}) {
  const payload = body ?? JSON.stringify({ version: SUBMISSION_VERSION, name, replay });
  const headers = { ...extraHeaders };
  if (ip !== null) headers['CF-Connecting-IP'] = ip;
  if (origin !== null) headers.Origin = origin;
  if (contentType !== null) headers['Content-Type'] = contentType;
  if (contentLength !== null) {
    headers['Content-Length'] = contentLength ?? String(new TextEncoder().encode(payload).length);
  }
  return handleRequest(
    new Request(`${BASE}/daily/${date}/results`, { method: 'POST', body: payload, headers }),
    env
  );
}

/** GET a board. */
function get({ date = BOARD, origin = ORIGIN } = {}) {
  return handleRequest(
    new Request(`${BASE}/daily/${date}`, { headers: origin ? { Origin: origin } : {} }),
    env
  );
}

const bodyOf = response => response.json();

/**
 * The `ip_hash` the Worker stores for an address, so a test can read its
 * counters. The board date is in the preimage: the digest is a per-day
 * pseudonym, not a handle that follows an address across boards.
 */
function hashFor(ip, date = BOARD) {
  return sha256(`${env.IP_SALT}:${date}:${ip}`);
}

/**
 * The same game carrying different `metadata`. The verifier never reads
 * `metadata`, and neither does the replay hash — which is the point: this is
 * still the SAME submission as far as the duplicate index is concerned.
 */
function variant(replay, tag) {
  return { ...replay, metadata: { ...replay.metadata, tag } };
}

describe('GET /daily/:date', () => {
  it('serves an empty board with zeroed totals', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      date: BOARD,
      entries: [],
      totals: { finished: 0, won: 0 },
    });
  });

  it('rejects a malformed date', async () => {
    const response = await get({ date: 'yesterday' });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
  });

  it('serves closed boards as read-only history', async () => {
    const response = await get({ date: '2020-01-01' });
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).totals).toEqual({ finished: 0, won: 0 });
  });
});

describe('POST /daily/:date/results', () => {
  it('accepts a verified win and ranks it first', async () => {
    const response = await post({ replay: fastWin.replay });
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toEqual({
      accepted: true,
      won: true,
      turns: fastWin.journal.turns,
      rank: 1,
      totals: { finished: 1, won: 1 },
    });
  });

  it('re-ranks the board when a faster win arrives', async () => {
    const first = await post({ name: 'Slowpoke', replay: slowWin.replay, ip: '198.51.100.1' });
    expect((await bodyOf(first)).rank).toBe(1);

    const second = await post({ name: 'Speedy', replay: fastWin.replay, ip: '198.51.100.2' });
    expect(await bodyOf(second)).toMatchObject({ rank: 1, turns: fastWin.journal.turns });

    const board = await bodyOf(await get());
    expect(board.entries.map(e => ({ rank: e.rank, name: e.name, turns: e.turns }))).toEqual([
      { rank: 1, name: 'Speedy', turns: fastWin.journal.turns },
      { rank: 2, name: 'Slowpoke', turns: slowWin.journal.turns },
    ]);
    expect(board.totals).toEqual({ finished: 2, won: 2 });
    expect(board.entries[0].at).toBe(NOW.toISOString());
  });

  it('accepts a loss without ranking it, but counts it', async () => {
    await post({ name: 'Speedy', replay: fastWin.replay, ip: '198.51.100.2' });
    const response = await post({ name: 'Unlucky', replay: loss.replay, ip: '198.51.100.3' });

    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toEqual({
      accepted: true,
      won: false,
      turns: loss.journal.turns,
      rank: null,
      totals: { finished: 2, won: 1 },
    });

    const board = await bodyOf(await get());
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0].name).toBe('Speedy');
  });

  it('breaks a tie on submission order', async () => {
    // The clock is frozen, so both rows share a created_at and the tiebreak
    // falls through to insertion order — exactly the case a live server hits
    // when two submissions land in the same millisecond.
    await post({ name: 'First', replay: fastWin.replay, ip: '198.51.100.4' });
    const second = await post({ name: 'Second', replay: fastWin.replay, ip: '198.51.100.5' });
    expect(await bodyOf(second)).toMatchObject({ rank: 2 });
    const board = await bodyOf(await get());
    expect(board.entries.map(e => e.name)).toEqual(['First', 'Second']);
  });

  it('closes boards older than yesterday', async () => {
    const response = await post({ date: '2026-09-13', replay: fastWin.replay });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('date_closed');
  });

  it('closes boards from the future', async () => {
    const response = await post({ date: '2026-09-17', replay: fastWin.replay });
    expect((await bodyOf(response)).error).toBe('date_closed');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'abcdefghijklmnopq'],
    ['markup', '<b>hi</b>'],
    ['emoji', '🔥🔥'],
    ['not a string', 42],
  ])('refuses a %s name', async (_label, name) => {
    const response = await post({ name, replay: fastWin.replay });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('name_rejected');
  });

  /*
   * A blocked name is WELL FORMED — it passes every charset rule the client can
   * check — so answering it with `name_rejected`, whose message is "pick a name
   * of 1-16 letters, numbers, spaces, hyphens or underscores", told the player
   * to fix something that was not wrong. Its own code, and its own sentence.
   */
  it.each([
    ['reserved', 'admin'],
    ['reserved, spaced out', 'M O D'],
    ['the game itself', 'Dicewars'],
    ['profane, leet-spelled', 'sh1t'],
    // Math-bold and fullwidth letters are `\p{L}`, survive NFC and render as the
    // word — they used to squash to the empty string and skip the lists.
    ['reserved in math-bold letters', '\u{1D41A}dmin'],
    ['reserved in fullwidth letters', '\uFF41\uFF44\uFF4D\uFF49\uFF4E'],
  ])('refuses a %s name with its own code', async (_label, name) => {
    const response = await post({ name, replay: fastWin.replay });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('name_blocked');
    expect((await bodyOf(await post({ name, replay: fastWin.replay }))).message).toMatch(
      /not available/i
    );
  });

  it('accepts every name the client accepts, normalized the same way', async () => {
    // Same charset as dailyLeaderboard.js's NAME_PATTERN — a name the client
    // let through must never come back 400 from here.
    const response = await post({ name: '  Éva   Ó-Neil_2 ', replay: fastWin.replay });
    expect(response.status).toBe(201);
    const board = await bodyOf(await get());
    expect(board.entries[0].name).toBe('Éva Ó-Neil_2');
  });

  it('refuses a tampered opponent turn', async () => {
    const actions = fastWin.replay.actions.map((action, i) =>
      i === fastWin.replay.actions.length - 2 ? { type: 'END_TURN' } : action
    );
    const response = await post({ replay: { ...fastWin.replay, actions } });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('unverifiable');
  });

  it('refuses a replay from another board', async () => {
    const response = await post({
      replay: { ...fastWin.replay, config: { ...fastWin.replay.config, seed: 12345 } },
    });
    expect((await bodyOf(response)).error).toBe('wrong_board');
  });

  it('refuses an unfinished game', async () => {
    const response = await post({
      replay: { ...fastWin.replay, actions: fastWin.replay.actions.slice(0, 12) },
    });
    expect((await bodyOf(response)).error).toBe('not_finished');
  });

  it('ignores a lie in the metadata', async () => {
    const response = await post({
      replay: { ...fastWin.replay, metadata: { ...fastWin.replay.metadata, turnCount: 1 } },
    });
    expect(await bodyOf(response)).toMatchObject({ turns: fastWin.journal.turns });
  });

  it('answers a retry of the same game with the result it already stored', async () => {
    /*
     * The retry after a lost response is the ordinary case, and a flat 400 made
     * it unrecoverable: the client throws on any non-2xx, so the form kept
     * offering to post and each retry burned another attempt. The second post
     * gets the same answer as the first, and stores nothing new.
     */
    const ip = '203.0.113.9';
    const first = await post({ replay: fastWin.replay, ip });
    expect(first.status).toBe(201);

    const retry = await post({ replay: fastWin.replay, ip });
    expect(retry.status).toBe(200);
    expect(await bodyOf(retry)).toEqual(await bodyOf(first));
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(1);
    expect(await readIpCount(env.DB, BOARD, await hashFor(ip))).toBe(1);
  });

  it('recognizes a retry that carries different metadata', async () => {
    // The hash is over the replay's identity — date, board fields, actions —
    // not the raw body, so `metadata`'s wall clock cannot make one game two.
    const ip = '203.0.113.11';
    await post({ replay: fastWin.replay, ip });
    const retry = await post({ replay: variant(fastWin.replay, 'retry'), ip });
    expect(retry.status).toBe(200);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(1);
  });

  it('recognizes a retry whose replay keys arrive in a different order', async () => {
    const ip = '203.0.113.12';
    await post({ replay: fastWin.replay, ip });
    const reordered = {
      metadata: fastWin.replay.metadata,
      actions: fastWin.replay.actions,
      config: fastWin.replay.config,
      version: fastWin.replay.version,
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(fastWin.replay));
    expect((await post({ replay: reordered, ip })).status).toBe(200);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(1);
  });

  it('still refuses the same game posted under a different name', async () => {
    // Two players behind one address CAN produce identical replays on a fixed
    // seed — but then it is not a retry, and the board must not take it twice.
    const ip = '203.0.113.13';
    expect((await post({ name: 'Ivan', replay: fastWin.replay, ip })).status).toBe(201);
    const other = await post({ name: 'Someone', replay: fastWin.replay, ip });
    expect(other.status).toBe(400);
    expect((await bodyOf(other)).error).toBe('duplicate');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(1);
  });

  it('lets a different submitter post an identical game', async () => {
    await post({ name: 'A', replay: fastWin.replay, ip: '203.0.113.9' });
    const response = await post({ name: 'B', replay: fastWin.replay, ip: '203.0.113.10' });
    expect(response.status).toBe(201);
  });

  it('caps one address at three accepted results per board', async () => {
    const ip = '192.0.2.55';
    expect(MAX_SUBMISSIONS_PER_IP).toBe(3);
    for (const replay of [fastWin.replay, slowWin.replay, loss.replay]) {
      expect((await post({ replay, ip })).status).toBe(201);
    }

    // The fourth is a different game that verifies just as well — so it is the
    // ACCEPTED cap that turns it away, not the duplicate index.
    const fourth = await post({ replay: otherLoss.replay, ip, name: 'Again' });
    expect(fourth.status).toBe(429);
    expect((await bodyOf(fourth)).error).toBe('rate_limited');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(3);

    // Another address still has its own allowance.
    expect((await post({ replay: fastWin.replay, ip: '192.0.2.56' })).status).toBe(201);
  });

  it('does not charge an accepted result for a rejected submission', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < 5; i++) {
      expect((await post({ name: 'admin', replay: fastWin.replay, ip })).status).toBe(400);
    }
    expect((await post({ replay: fastWin.replay, ip })).status).toBe(201);
    // A refused name never reaches the verifier, so it costs neither counter.
    expect(await readIpCount(env.DB, BOARD, await hashFor(ip))).toBe(1);
    expect(await readRequestCount(env.DB, BOARD, await hashFor(ip))).toBe(1);
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a JSON array', '[]'],
    ['a bare string', '"hello"'],
    ['an unknown envelope version', JSON.stringify({ version: 2, name: 'Ivan', replay: {} })],
  ])('refuses %s', async (_label, body) => {
    const response = await post({ body });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
  });

  it('refuses an oversized body without parsing it', async () => {
    const response = await post({ body: 'x'.repeat(MAX_BODY_BYTES + 1) });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
  });

  it('refuses a body that declares no size at all, before reading it', async () => {
    /*
     * The cap used to be `Number(header) > MAX_BODY_BYTES`, and `Number(null)`
     * is 0 — so a request with no `Content-Length` (a chunked, streamed body)
     * sailed past it and `request.text()` buffered the whole thing before
     * anything measured it. A real client always sends the header.
     */
    const response = await post({ replay: fastWin.replay, contentLength: null });
    expect(response.status).toBe(400);
    const failure = await bodyOf(response);
    expect(failure.error).toBe('invalid_body');
    expect(failure.message).toMatch(/Content-Length/i);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
  });

  it.each([
    ['junk', 'lots'],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-1'],
  ])('refuses a %s Content-Length', async (_label, contentLength) => {
    const response = await post({ replay: fastWin.replay, contentLength });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
  });

  it('charges nothing for a body it refuses on its declared size', async () => {
    const ip = '198.51.100.66';
    await post({ replay: fastWin.replay, ip, contentLength: null });
    await post({ body: 'x'.repeat(MAX_BODY_BYTES + 1), ip });
    expect(await readRequestCount(env.DB, BOARD, await hashFor(ip))).toBe(0);
  });

  it('still measures the body it read, not the size the caller claimed', async () => {
    // The declared size is only a pre-read bound; a lying header is caught by
    // the byte count taken after the body is in hand.
    const response = await post({ body: 'x'.repeat(MAX_BODY_BYTES + 1), contentLength: '20' });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
  });

  it('measures the body cap in bytes, not UTF-16 units', async () => {
    /*
     * `raw.length` counts UTF-16 units, so a body of 3-byte characters is three
     * times the size it reports. Just under the cap in code units, well over it
     * in bytes — the shape a hostile submission takes when the limit is read
     * off `.length`.
     */
    const wide = 'あ'.repeat(MAX_BODY_BYTES / 2); // 1 UTF-16 unit, 3 bytes
    const payload = `{"pad":"${wide}"}`;
    expect(payload.length).toBeLessThan(MAX_BODY_BYTES);
    expect(new TextEncoder().encode(payload).length).toBeGreaterThan(MAX_BODY_BYTES);

    const response = await post({ body: payload });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
  });

  it('refuses JSON nested deep enough to overflow the stack, as a 400 and not a 503', async () => {
    // Deep enough that `JSON.stringify` throws RangeError, which used to escape
    // the handler and surface as "the leaderboard is unavailable".
    const depth = 15000; // 30 KB of brackets: deep enough to overflow, small enough to accept
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const payload = `{"version":1,"name":"Ivan","replay":${nested}}`;
    expect(new TextEncoder().encode(payload).length).toBeLessThan(MAX_BODY_BYTES);
    expect(() => JSON.stringify(JSON.parse(nested))).toThrow(RangeError);

    const response = await post({ body: payload });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
    expect((await bodyOf(await post({ body: payload }))).message).toMatch(/nested too deeply/);
  });

  it('accepts nesting up to the documented depth', async () => {
    const under = MAX_JSON_DEPTH - 2; // body(1) + replay(2) + this
    const payload = `{"version":1,"name":"Ivan","replay":${'['.repeat(under)}${']'.repeat(under)}}`;
    // Past the depth guard, so it fails on the replay's shape instead.
    const response = await post({ body: payload });
    expect((await bodyOf(response)).error).toBe('unverifiable');
  });

  it('refuses to store anything while IP_SALT is unset', async () => {
    env = { ...env, IP_SALT: undefined };
    const response = await post({ replay: fastWin.replay });
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe('unavailable');
  });

  it('stores only the verified numbers, never the replay', async () => {
    await post({ replay: fastWin.replay });
    const row = db.sqlite.prepare('SELECT * FROM results').get();
    expect(Object.keys(row).sort()).toEqual(
      [
        'attacks',
        'captures',
        'created_at',
        'date',
        'drew',
        'id',
        'ip_hash',
        'name',
        'replay_hash',
        'turns',
        'won',
      ].sort()
    );
    expect(row.turns).toBe(fastWin.journal.turns);
    expect(row.attacks).toBe(fastWin.journal.attacks);
    expect(row.captures).toBe(fastWin.journal.captures);
    // The address is only ever present as an unrecoverable digest.
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip_hash).not.toContain('203.0.113');
  });
});

describe('who may POST', () => {
  /*
   * CORS headers only decide whether a browser hands the response to the page.
   * They never stopped the handler running, so before this guard a "simple"
   * cross-origin post — no preflight, `text/plain` — landed a real row and
   * spent the visitor's allowance from any page on the web.
   */
  it('refuses a submission with no Origin header at all', async () => {
    const response = await post({ replay: fastWin.replay, origin: null });
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error).toBe('forbidden');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
  });

  it('refuses a submission from an unlisted origin', async () => {
    const response = await post({ replay: fastWin.replay, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error).toBe('forbidden');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
  });

  it.each([
    ['text/plain', 'text/plain;charset=UTF-8'],
    ['a form post', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['nothing', null],
  ])('refuses a %s content type, which needs no preflight', async (_label, contentType) => {
    const response = await post({ replay: fastWin.replay, contentType });
    expect(response.status).toBe(415);
    expect((await bodyOf(response)).error).toBe('invalid_body');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
  });

  it('accepts application/json with a charset parameter', async () => {
    const response = await post({
      replay: fastWin.replay,
      contentType: 'application/json; charset=utf-8',
    });
    expect(response.status).toBe(201);
  });

  it('leaves the read endpoint open to callers with no Origin', async () => {
    const response = await handleRequest(new Request(`${BASE}/daily/${BOARD}`), env);
    expect(response.status).toBe(200);
  });

  it('charges neither counter for a request it refuses at the door', async () => {
    const ip = '198.51.100.99';
    await post({ replay: fastWin.replay, ip, origin: 'https://evil.example' });
    await post({ replay: fastWin.replay, ip, contentType: 'text/plain' });
    expect(await readRequestCount(env.DB, BOARD, await hashFor(ip))).toBe(0);
  });
});

describe('rate limiting', () => {
  /** A well-formed submission that always fails verification, so it never inserts. */
  const wrongBoard = replay => ({ ...replay, config: { ...replay.config, seed: 424242 } });

  it('charges attempts, not just accepted results', async () => {
    const ip = '203.0.113.44';
    const replay = wrongBoard(fastWin.replay);
    for (let i = 0; i < MAX_REQUESTS_PER_IP; i++) {
      expect((await bodyOf(await post({ replay, ip }))).error).toBe('wrong_board');
    }
    const overLimit = await post({ replay, ip });
    expect(overLimit.status).toBe(429);
    expect((await bodyOf(overLimit)).error).toBe('rate_limited');

    // The expensive path is what the cap protects: a valid game from the same
    // address is refused too, because the budget is spent.
    expect((await post({ replay: fastWin.replay, ip })).status).toBe(429);
    expect((await post({ replay: fastWin.replay, ip: '203.0.113.45' })).status).toBe(201);
  });

  it('lets exactly the cap through when the requests arrive together', async () => {
    /*
     * The counter used to be read, compared, and written three round trips
     * apart, so N simultaneous posts all read the same under-cap value and all
     * went through. One conditional write is what makes this a real limit.
     *
     * The SQLite shim is synchronous, so this is not a genuine race: what it
     * pins is that the cap lives in the statement's own predicate, which is the
     * property that makes a real race safe.
     */
    const ip = '203.0.113.77';
    const replay = wrongBoard(fastWin.replay);
    const responses = await Promise.all(
      Array.from({ length: MAX_REQUESTS_PER_IP * 2 }, () => post({ replay, ip }))
    );
    const codes = await Promise.all(responses.map(r => bodyOf(r).then(b => b.error)));

    expect(codes.filter(code => code === 'wrong_board')).toHaveLength(MAX_REQUESTS_PER_IP);
    expect(codes.filter(code => code === 'rate_limited')).toHaveLength(MAX_REQUESTS_PER_IP);
    expect(await readRequestCount(env.DB, BOARD, await hashFor(ip))).toBe(MAX_REQUESTS_PER_IP);
  });

  it('accepts exactly the cap when winning submissions arrive together', async () => {
    const ip = '203.0.113.88';
    const replays = [fastWin.replay, slowWin.replay, loss.replay, otherLoss.replay];
    const responses = await Promise.all(
      replays.map((replay, i) => post({ replay, ip, name: `Racer${i}` }))
    );
    const accepted = responses.filter(r => r.status === 201);
    expect(accepted).toHaveLength(MAX_SUBMISSIONS_PER_IP);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(
      MAX_SUBMISSIONS_PER_IP
    );
    expect(await readIpCount(env.DB, BOARD, await hashFor(ip))).toBe(MAX_SUBMISSIONS_PER_IP);
  });

  it('does not leave a free slot behind when the counter bump fails', async () => {
    /*
     * The insert and the bump used to be two separate writes with the insert
     * first: a bump that threw left a scored row that nothing had been charged
     * for. They are one batch now, so the failure takes the row with it.
     */
    const ip = '203.0.113.66';
    const realDb = env.DB;
    env = {
      ...env,
      DB: {
        ...realDb,
        prepare: sql => realDb.prepare(sql),
        batch: () => Promise.reject(new Error('D1_ERROR: disk I/O error')),
      },
    };
    const response = await post({ replay: fastWin.replay, ip });
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe('unavailable');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
    expect(await readIpCount(realDb, BOARD, await hashFor(ip))).toBe(0);
    // The attempt is still charged: it cost the CPU whether or not it stored.
    expect(await readRequestCount(realDb, BOARD, await hashFor(ip))).toBe(1);
  });

  it('rolls the whole batch back when the bump statement itself throws', async () => {
    const realDb = env.DB;
    env = {
      ...env,
      DB: {
        ...realDb,
        prepare(sql) {
          if (sql !== SQL.bumpIpCount) return realDb.prepare(sql);
          return { bind: () => ({ run: () => Promise.reject(new Error('bump exploded')) }) };
        },
        batch: statements => realDb.batch(statements),
      },
    };
    expect((await post({ replay: fastWin.replay })).status).toBe(503);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
  });

  it('keeps an accepted result accepted when the board read afterwards fails', async () => {
    /*
     * `rankOf` and `readTotals` run AFTER the insert has committed. Letting them
     * fall through to the catch-all told the player their stored result had
     * failed — and the retry they would then make costs an attempt and comes
     * back `duplicate`. The row is on the board either way; answer with what is
     * known.
     */
    const realDb = env.DB;
    env = {
      ...env,
      DB: {
        ...realDb,
        prepare(sql) {
          if (sql !== SQL.betterThan) return realDb.prepare(sql);
          throw new Error('D1_ERROR: read failed');
        },
        batch: statements => realDb.batch(statements),
      },
    };
    const response = await post({ replay: fastWin.replay });
    expect(response.status).toBe(201);
    expect(await bodyOf(response)).toEqual({
      accepted: true,
      won: true,
      turns: fastWin.journal.turns,
      rank: null,
      totals: { finished: 0, won: 0 },
    });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(1);
  });

  it.each([
    [
      'a flat D1 message',
      () => new Error('D1_ERROR: UNIQUE constraint failed: results.replay_hash'),
    ],
    [
      'a wrapped D1 message',
      () =>
        Object.assign(new Error('D1_ERROR: Error in performing DB operation'), {
          cause: new Error('UNIQUE constraint failed: results.date, results.ip_hash'),
        }),
    ],
  ])('reads %s as a duplicate rather than an outage', async (_label, makeError) => {
    /*
     * The shim reports SQLite's own wording; real D1 wraps it, sometimes only on
     * `.cause`. Both shapes are pinned here so `isUniqueViolation` cannot be
     * narrowed to the one the tests happen to produce.
     */
    const realDb = env.DB;
    env = {
      ...env,
      DB: {
        ...realDb,
        prepare: sql => realDb.prepare(sql),
        batch: () => Promise.reject(makeError()),
      },
    };
    const response = await post({ replay: fastWin.replay });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('duplicate');
  });

  it('reports a raced duplicate as 400, not as an outage', async () => {
    /*
     * The handler's own duplicate check is a read, so two simultaneous posts of
     * one replay can both pass it; the unique index is what actually decides.
     * Blinding the check is how a test reaches that branch deterministically —
     * and it blinds the recovery lookup too, so this lands on the plain 400
     * rather than on the idempotent answer a real retry would get.
     */
    const ip = '203.0.113.55';
    expect((await post({ replay: fastWin.replay, ip })).status).toBe(201);

    const realDb = env.DB;
    env = {
      ...env,
      DB: {
        ...realDb,
        prepare(sql) {
          if (sql !== SQL.findReplay) return realDb.prepare(sql);
          return { bind: () => ({ first: async () => null }) };
        },
        batch: statements => realDb.batch(statements),
      },
    };
    const raced = await post({ replay: fastWin.replay, ip });
    expect(raced.status).toBe(400);
    expect((await bodyOf(raced)).error).toBe('duplicate');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(1);
  });
});

describe('the verifier the Worker calls', () => {
  it('scores against the real turn cap, never the test-only override', async () => {
    /*
     * `verifyDailyReplay`'s `maxTurns` option exists so a test can reach the
     * draw branch without playing 300 turns. A Worker that passed it would be
     * scoring a different game from the one the player played, and no response
     * would look wrong.
     *
     * So: a real game cut at exactly 12 completed turns. Under `maxTurns: 12`
     * that is a turn-cap DRAW and would be accepted; under the 300 the browser
     * uses it is simply an abandoned game. The Worker must say `not_finished`.
     */
    const cap = 12;
    const cut = turnCapCut(fastWin.replay, cap);
    expect(cut).toBeGreaterThan(0);
    const stalled = { ...fastWin.replay, actions: fastWin.replay.actions.slice(0, cut) };

    const response = await post({ replay: stalled });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('not_finished');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM results').get().n).toBe(0);
  });
});

describe('the address the caps are charged to', () => {
  it('ignores X-Forwarded-For unless the deployment opts in', async () => {
    /*
     * The header is caller-supplied: honouring it unconditionally handed anyone
     * a fresh rate-limit bucket per request, which is the cap defeating itself.
     */
    const ip = null; // no CF-Connecting-IP, as `wrangler dev` sees it
    await post({ replay: fastWin.replay, ip, headers: { 'X-Forwarded-For': '198.51.100.200' } });
    expect(await readRequestCount(env.DB, BOARD, await hashFor('198.51.100.200'))).toBe(0);
    expect(await readRequestCount(env.DB, BOARD, await hashFor('unknown'))).toBe(1);
  });

  it('reads X-Forwarded-For when TRUST_FORWARDED_FOR is set', async () => {
    env = { ...env, TRUST_FORWARDED_FOR: '1' };
    await post({
      replay: fastWin.replay,
      ip: null,
      headers: { 'X-Forwarded-For': '198.51.100.200, 10.0.0.1' },
    });
    expect(await readRequestCount(env.DB, BOARD, await hashFor('198.51.100.200'))).toBe(1);
    expect(await readRequestCount(env.DB, BOARD, await hashFor('unknown'))).toBe(0);
  });

  it('scopes the address digest to the board it was charged on', async () => {
    const ip = '203.0.113.200';
    await post({ replay: fastWin.replay, ip });
    expect(await readRequestCount(env.DB, BOARD, await hashFor(ip))).toBe(1);
    // Yesterday's board is open too, and hashes the same address differently.
    expect(await readRequestCount(env.DB, '2026-09-15', await hashFor(ip, '2026-09-15'))).toBe(0);
  });
});

describe('the codes this Worker emits', () => {
  /**
   * Every code the handler can answer with. The client renders its OWN sentence
   * per code (`LEADERBOARD_MESSAGES`) and only falls back to the server's string
   * for a code it has never heard of — so a code missing from that table shows
   * the player server copy instead of ours.
   */
  const CODES = [
    'invalid_body',
    'name_rejected',
    'name_blocked',
    'wrong_board',
    'unverifiable',
    'not_finished',
    'duplicate',
    'date_closed',
    'forbidden',
    'rate_limited',
    'not_found',
    'method_not_allowed',
    'unavailable',
  ];

  it.each(CODES)('publishes a player-facing sentence for %s', code => {
    expect(Object.hasOwn(LEADERBOARD_MESSAGES, code)).toBe(true);
    expect(LEADERBOARD_MESSAGES[code].length).toBeGreaterThan(10);
  });

  it('answers every response as JSON a browser may not re-sniff', async () => {
    for (const response of [await get(), await post({ replay: fastWin.replay })]) {
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
});

describe('CORS', () => {
  it('answers a preflight with 204 and the allowed methods', async () => {
    const response = await handleRequest(
      new Request(`${BASE}/daily/${BOARD}/results`, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
      env
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });

  it('allows a configured origin', async () => {
    const response = await get({ origin: 'http://localhost:3000' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('gives an unlisted origin no allow-origin header at all', async () => {
    const response = await get({ origin: 'https://evil.example' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('falls back to the default origin list when none is configured', async () => {
    env = { DB: db.DB, IP_SALT: 'test-salt' };
    const response = await get({ origin: 'http://localhost:4173' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4173');
  });
});

describe('routing', () => {
  it('404s an unknown path', async () => {
    const response = await handleRequest(new Request(`${BASE}/nope`), env);
    expect(response.status).toBe(404);
  });

  it('405s the wrong verb', async () => {
    const response = await handleRequest(
      new Request(`${BASE}/daily/${BOARD}`, { method: 'DELETE' }),
      env
    );
    expect(response.status).toBe(405);
  });

  it('routes correctly under a path prefix', async () => {
    const response = await handleRequest(new Request(`${BASE}/api/v1/daily/${BOARD}`), env);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).date).toBe(BOARD);
  });

  it('turns a database failure into a 503, not a crash', async () => {
    env = {
      ...env,
      DB: {
        prepare() {
          throw new Error('D1_ERROR: no such table');
        },
      },
    };
    const response = await get();
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe('unavailable');
  });
});

describe('normalizeName', () => {
  /*
   * The client's gate is imported, not retyped: the two rules are separate on
   * purpose (instant feedback vs. the only one that decides anything), but a
   * name the client accepted must never come back 400 from the board, and a
   * copied literal is exactly how that drifts.
   */
  it.each(['Ivan', 'a', 'Éva Ó-Neil_2', '日本語の名前', '0123456789', 'x'.repeat(16)])(
    'accepts %s, which the client also accepts',
    name => {
      expect(NAME_PATTERN.test(name)).toBe(true);
      expect(normalizeName(name)).toBe(name);
    }
  );

  it('collapses whitespace exactly as the client does', () => {
    expect(normalizeName('  a \t\n b  ')).toBe('a b');
  });

  it.each([['x'.repeat(17)], [''], ['   '], ['a.b'], ["O'Neil"], ['<b>'], ['🔥'], [null], [7]])(
    'rejects %s',
    value => {
      expect(normalizeName(value)).toBeNull();
    }
  );

  /*
   * The fillers are the case that needed a rule of their own — written as
   * escapes, because every one of them is invisible in a source file and a test
   * whose input you cannot see is not one anyone can maintain.
   */
  const FILLERS = ['\u3164', '\u115F', '\u1160', '\uFFA0'];

  it('shows why the fillers needed a rule of their own', () => {
    for (const filler of FILLERS) {
      // A letter, unchanged by NFC, and accepted by the charset gate on BOTH
      // sides — so nothing but the ignorable rule turns it away.
      expect(/\p{L}/u.test(filler)).toBe(true);
      expect(filler.normalize('NFC')).toBe(filler);
      expect(NAME_PATTERN.test(filler)).toBe(true);
    }
  });

  it.each([
    ['U+3164 hangul filler', '\u3164'],
    ['U+115F choseong filler', '\u115F'],
    ['U+1160 jungseong filler', '\u1160'],
    ['U+FFA0 halfwidth filler', '\uFFA0'],
    ['a run of fillers', '\u3164\u3164\u3164'],
    ['a filler hidden inside a name', 'Iv\u3164an'],
    ['a slur padded past the squasher', 'f\u3164u\u3164c\u3164k'],
    ['a zero-width joiner', 'a\u200Db'],
    ['a soft hyphen', 'a\u00ADb'],
  ])('rejects %s', (_label, name) => {
    expect(normalizeName(name)).toBeNull();
  });

  it('rejects a name with nothing visible in it', () => {
    expect(normalizeName('-')).toBeNull();
    expect(normalizeName('___')).toBeNull();
    expect(normalizeName('- _ -')).toBeNull();
    expect(normalizeName('a-')).toBe('a-');
  });

  it('accepts a decomposed name, which the client now normalizes the same way', () => {
    // macOS pastes NFD, so a pasted `Éva` is really `E` + U+0301 + `va`: four
    // code points, which used to fail the CLIENT's pattern for a name this
    // server was always happy to take.
    const decomposed = 'E\u0301va';
    expect(NAME_PATTERN.test(decomposed)).toBe(false);
    expect(normalizeName(decomposed)).toBe('\u00C9va');
  });
});

describe('isOpenBoard', () => {
  it('accepts today and yesterday, UTC, and nothing else', () => {
    const now = new Date('2026-09-16T00:05:00.000Z');
    expect(isOpenBoard('2026-09-16', now)).toBe(true);
    expect(isOpenBoard('2026-09-15', now)).toBe(true);
    expect(isOpenBoard('2026-09-14', now)).toBe(false);
    expect(isOpenBoard('2026-09-17', now)).toBe(false);
  });

  it('rolls the window at UTC midnight, not local midnight', () => {
    const justBefore = new Date('2026-09-16T23:59:59.000Z');
    const justAfter = new Date('2026-09-17T00:00:01.000Z');
    expect(isOpenBoard('2026-09-15', justBefore)).toBe(true);
    expect(isOpenBoard('2026-09-15', justAfter)).toBe(false);
    expect(isOpenBoard('2026-09-17', justAfter)).toBe(true);
  });
});
