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
} from '../../server/daily-leaderboard/src/index.js';
import { normalizeName } from '../../server/daily-leaderboard/src/names.js';
import { createTestDatabase } from './d1Sqlite.js';
import { playDailyGame, greedyHuman, cautiousHuman, timidHuman } from './dailyReplayFixture.js';

/** The board every fixture below was played on; pinned as "today" for the suite. */
const BOARD = '2026-09-16';
const NOW = new Date('2026-09-16T12:00:00.000Z');

const ORIGIN = 'https://ivanlay.com';
const BASE = 'https://daily.example.workers.dev';

let db;
let env;
/** Three real outcomes on BOARD: a fast win, a slow win, and a loss. */
let fastWin;
let slowWin;
let loss;

beforeAll(async () => {
  fastWin = await playDailyGame({ date: BOARD, human: greedyHuman });
  slowWin = await playDailyGame({ date: BOARD, human: cautiousHuman });
  loss = await playDailyGame({ date: BOARD, human: timidHuman });
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

/** POST a submission. */
function post({ date = BOARD, name = 'Ivan', replay, ip = '203.0.113.7', origin = ORIGIN, body }) {
  const payload = body ?? JSON.stringify({ version: 1, name, replay });
  return handleRequest(
    new Request(`${BASE}/daily/${date}/results`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'CF-Connecting-IP': ip,
      },
    }),
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
    ['reserved', 'admin'],
    ['profane', 'sh1t'],
    ['markup', '<b>hi</b>'],
    ['emoji', '🔥🔥'],
    ['not a string', 42],
  ])('refuses a %s name', async (_label, name) => {
    const response = await post({ name, replay: fastWin.replay });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('name_rejected');
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

  it('rejects a second copy of the same game from the same submitter', async () => {
    await post({ replay: fastWin.replay, ip: '203.0.113.9' });
    const response = await post({ replay: fastWin.replay, ip: '203.0.113.9' });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('duplicate');
  });

  it('lets a different submitter post an identical game', async () => {
    await post({ name: 'A', replay: fastWin.replay, ip: '203.0.113.9' });
    const response = await post({ name: 'B', replay: fastWin.replay, ip: '203.0.113.10' });
    expect(response.status).toBe(201);
  });

  it('caps one address at three accepted results per board', async () => {
    const ip = '192.0.2.55';
    for (const replay of [fastWin.replay, slowWin.replay, loss.replay]) {
      expect((await post({ replay, ip })).status).toBe(201);
    }

    const fourth = await post({ replay: fastWin.replay, ip });
    expect(fourth.status).toBe(429);
    expect((await bodyOf(fourth)).error).toBe('rate_limited');

    // Another address still has its own allowance.
    expect((await post({ replay: fastWin.replay, ip: '192.0.2.56' })).status).toBe(201);
  });

  it('does not charge an attempt for a rejected submission', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < 5; i++) {
      expect((await post({ name: 'admin', replay: fastWin.replay, ip })).status).toBe(400);
    }
    expect((await post({ replay: fastWin.replay, ip })).status).toBe(201);
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
    const response = await handleRequest(
      new Request(`${BASE}/daily/${BOARD}/results`, {
        method: 'POST',
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
        headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' },
      }),
      env
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_body');
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
  /**
   * The client (`src/game/dailyLeaderboard.js`) gates on
   * `/^[\p{L}\p{N} _-]{1,16}$/u` after trimming and collapsing whitespace. The
   * server must accept everything that pattern does, or a player is told their
   * name is fine and then refused by the board.
   */
  const CLIENT_PATTERN = /^[\p{L}\p{N} _-]{1,16}$/u;

  it.each(['Ivan', 'a', 'Éva Ó-Neil_2', '日本語の名前', '0123456789', 'x'.repeat(16)])(
    'accepts %s, which the client also accepts',
    name => {
      expect(CLIENT_PATTERN.test(name)).toBe(true);
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
