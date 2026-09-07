import {
  DAILY_LEADERBOARD_URL,
  fetchDailyLeaderboard,
  isLeaderboardEnabled,
  normalizeName,
  submitDailyResult,
} from '../../src/game/dailyLeaderboard.js';

const url = 'https://leaderboard.example/api';
const replay = { version: 2, actions: [] };

/** A fetch stub answering with one canned response. */
function respondWith({ status = 200, body = {}, malformed = false } = {}) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (malformed) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  }));
}

const page = {
  date: '2026-09-07',
  entries: [{ rank: 1, name: 'Ada', turns: 7, at: '2026-09-07T01:00:00.000Z' }],
  totals: { finished: 12, won: 4 },
};
const accepted = { accepted: true, won: true, turns: 9, rank: 3, totals: { finished: 12, won: 4 } };

describe('Daily leaderboard client', () => {
  describe('names', () => {
    it('trims, collapses whitespace, and accepts a short printable name', () => {
      expect(normalizeName('  Ada   Lovelace  ')).toBe('Ada Lovelace');
      expect(normalizeName('dice_wars-99')).toBe('dice_wars-99');
      expect(normalizeName('さいころ')).toBe('さいころ');
      // A pasted line break is whitespace like any other, not a rejection.
      expect(normalizeName('new\nline')).toBe('new line');
    });

    it('rejects anything unusable rather than sending it', () => {
      for (const raw of [
        '',
        '   ',
        'x'.repeat(17),
        'drop <b>tags</b>',
        'semi;colon',
        'nul\u0000byte',
        'rtl\u202Eoverride',
        null,
        undefined,
        42,
        {},
      ]) {
        expect(normalizeName(raw)).toBeNull();
      }
    });
  });

  describe('when no leaderboard is configured', () => {
    it('is off, and neither call fires a request', async () => {
      // The build under test has no VITE_DAILY_LEADERBOARD_URL.
      expect(DAILY_LEADERBOARD_URL).toBeNull();
      expect(isLeaderboardEnabled()).toBe(false);
      expect(isLeaderboardEnabled(null)).toBe(false);
      expect(isLeaderboardEnabled('')).toBe(false);
      expect(isLeaderboardEnabled(url)).toBe(true);

      const fetch = respondWith({ body: page });
      await expect(fetchDailyLeaderboard('2026-09-07', { url: null, fetch })).rejects.toMatchObject(
        {
          code: 'disabled',
          message: expect.stringContaining('not available'),
        }
      );
      await expect(
        submitDailyResult({ date: '2026-09-07', name: 'Ada', replay }, { url: null, fetch })
      ).rejects.toMatchObject({ code: 'disabled' });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('fetchDailyLeaderboard', () => {
    it('asks for the date and returns the page', async () => {
      const fetch = respondWith({ body: page });
      await expect(fetchDailyLeaderboard('2026-09-07', { url, fetch })).resolves.toEqual(page);
      expect(fetch).toHaveBeenCalledWith(
        'https://leaderboard.example/api/daily/2026-09-07',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('rejects a page of the wrong shape and a body that will not parse', async () => {
      for (const body of [null, [], { entries: [] }, { entries: {}, totals: {} }]) {
        await expect(
          fetchDailyLeaderboard('2026-09-07', { url, fetch: respondWith({ body }) })
        ).rejects.toMatchObject({ code: 'bad_response' });
      }
      await expect(
        fetchDailyLeaderboard('2026-09-07', { url, fetch: respondWith({ malformed: true }) })
      ).rejects.toMatchObject({ code: 'bad_response' });
    });

    it('reports an unreachable leaderboard in words a player can act on', async () => {
      const fetch = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      await expect(fetchDailyLeaderboard('2026-09-07', { url, fetch })).rejects.toMatchObject({
        code: 'network',
        message: expect.stringContaining("Couldn't reach the leaderboard"),
      });
    });
  });

  describe('submitDailyResult', () => {
    it('posts the replay — never a claimed score — and returns the server’s numbers', async () => {
      const fetch = respondWith({ status: 201, body: accepted });
      await expect(
        submitDailyResult({ date: '2026-09-07', name: '  Ada  ', replay }, { url, fetch })
      ).resolves.toEqual(accepted);

      const [requestUrl, init] = fetch.mock.calls[0];
      expect(requestUrl).toBe('https://leaderboard.example/api/daily/2026-09-07/results');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(init.body);
      expect(sent).toEqual({ version: 1, name: 'Ada', replay });
      expect(sent).not.toHaveProperty('turns');
      expect(sent).not.toHaveProperty('won');
    });

    it('refuses an unusable name or a missing replay before touching the network', async () => {
      const fetch = respondWith({ status: 201, body: accepted });
      await expect(
        submitDailyResult({ date: '2026-09-07', name: '  ', replay }, { url, fetch })
      ).rejects.toMatchObject({ code: 'name_rejected' });
      await expect(
        submitDailyResult({ date: '2026-09-07', name: 'Ada', replay: null }, { url, fetch })
      ).rejects.toMatchObject({ code: 'not_submittable' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('turns every documented rejection into a coded, readable error', async () => {
      const cases = [
        [400, 'invalid_body'],
        [400, 'name_rejected'],
        [400, 'wrong_board'],
        [400, 'unverifiable'],
        [400, 'not_finished'],
        [400, 'date_closed'],
        [429, 'rate_limited'],
      ];
      for (const [status, code] of cases) {
        const fetch = respondWith({ status, body: { error: code, message: 'server copy' } });
        const err = await submitDailyResult(
          { date: '2026-09-07', name: 'Ada', replay },
          { url, fetch }
        ).catch(e => e);
        expect(err.code).toBe(code);
        // Our own copy, not the server's string rendered verbatim.
        expect(err.message).not.toBe('server copy');
        expect(err.message.length).toBeGreaterThan(10);
      }
      const rateLimited = await submitDailyResult(
        { date: '2026-09-07', name: 'Ada', replay },
        { url, fetch: respondWith({ status: 429, body: { error: 'rate_limited' } }) }
      ).catch(e => e);
      expect(rateLimited.message).toBe('Too many submissions from your network today.');
    });

    it('handles a 500, an unparseable body and an unacknowledged acceptance', async () => {
      await expect(
        submitDailyResult(
          { date: '2026-09-07', name: 'Ada', replay },
          { url, fetch: respondWith({ status: 500, malformed: true }) }
        )
      ).rejects.toMatchObject({ code: 'server_error' });

      await expect(
        submitDailyResult(
          { date: '2026-09-07', name: 'Ada', replay },
          { url, fetch: respondWith({ status: 201, malformed: true }) }
        )
      ).rejects.toMatchObject({ code: 'bad_response' });

      await expect(
        submitDailyResult(
          { date: '2026-09-07', name: 'Ada', replay },
          { url, fetch: respondWith({ status: 201, body: { accepted: false } }) }
        )
      ).rejects.toMatchObject({ code: 'bad_response' });
    });

    it('gives up on a silent server instead of hanging, and says so', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn(
          (_, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
            })
        );
        const pending = submitDailyResult(
          { date: '2026-09-07', name: 'Ada', replay },
          { url, fetch }
        ).catch(e => e);
        await vi.advanceTimersByTimeAsync(8000);
        const err = await pending;
        expect(err.code).toBe('timeout');
        expect(err.message).toMatch(/too long/i);
      } finally {
        vi.useRealTimers();
      }
    });

    it('strips a trailing slash so the path is never doubled', async () => {
      const fetch = respondWith({ status: 201, body: accepted });
      await submitDailyResult(
        { date: '2026-09-07', name: 'Ada', replay },
        { url: 'https://leaderboard.example/api/', fetch }
      );
      expect(fetch.mock.calls[0][0]).toBe(
        'https://leaderboard.example/api/daily/2026-09-07/results'
      );
    });
  });
});
