// @vitest-environment jsdom
/**
 * OnlineLeaderboardScreen mount/wiring tests
 *
 * The leaderboard is the one menu screen the suite never mounted elsewhere: it
 * is eagerly imported by App.jsx (no lazy-chunk test covers it) and it fetches
 * at mount. These tests render all three branches (loading → data, error →
 * retry) against a mocked fetch, and pin the WATCH wiring: fetch the replay
 * file, show the '...' busy label while in flight, hand the parsed JSON to
 * onViewReplay.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { OnlineLeaderboardScreen } from '../../src/ui/OnlineLeaderboardScreen.jsx';

const FIXTURE = {
  updatedAt: '2026-07-01T00:00:00Z',
  tournamentCount: 3,
  totalGamesPlayed: 420,
  bots: [
    {
      name: 'Conqueror',
      elo: 1210,
      wins: 30,
      gamesPlayed: 40,
      avgPlacement: 1.4,
      attackWinRate: 0.7,
    },
    {
      name: 'Lookahead',
      elo: 1050,
      wins: 10,
      gamesPlayed: 40,
      avgPlacement: 2.9,
      attackWinRate: 0.6,
    },
  ],
  replays: [
    { file: 'match-1.json', bots: ['Conqueror', 'Lookahead'], turns: 42, winner: 'Conqueror' },
  ],
};

let container;

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
  vi.unstubAllGlobals();
});

function mount(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(OnlineLeaderboardScreen, { onViewReplay: vi.fn(), ...props }), container);
  });
  return container;
}

const okJson = payload => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });

const button = label =>
  [...container.querySelectorAll('button')].find(b => b.textContent.trim() === label);

describe('OnlineLeaderboardScreen', () => {
  it('shows the loading state, then renders rankings and notable matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => okJson(FIXTURE))
    );
    mount();
    // Synchronously after mount the fetch is still pending → loading branch.
    expect(container.textContent).toContain('Loading');

    await vi.waitFor(() => expect(container.textContent).toContain('3 tournaments'));
    expect(fetch).toHaveBeenCalledWith('data/leaderboard.json');
    // Stats line, ranking table, and the replay list all made it to the DOM.
    expect(container.textContent).toContain('420 games');
    expect(container.textContent).toContain('Conqueror');
    expect(container.textContent).toContain('42 turns');
    expect(button('WATCH')).toBeTruthy();
    // FIXTURE deliberately has no `flagged` field (the pre-#137 published shape): the
    // screen must treat that as "no exclusions", not crash or render a stray note.
    expect(container.textContent).not.toContain('Excluded this run');
  });

  it('renders no note when the new-format flagged field is present but empty', async () => {
    // The shape every clean run publishes from now on. Guards the `flagged.length > 0`
    // gate: a truthy-check "simplification" would render a dangling "Excluded this run
    // as broken:" lead-in on every clean day, since [] is truthy.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => okJson({ ...FIXTURE, flagged: [] }))
    );
    mount();

    await vi.waitFor(() => expect(container.textContent).toContain('Conqueror'));
    expect(container.textContent).not.toContain('Excluded this run');
  });

  it('surfaces flagged (excluded) bots from leaderboard.json in a note (#137)', async () => {
    // The flagged bot is NOT in `bots` — buildLeaderboard excludes it — so only this
    // note distinguishes "excluded because broken" from "didn't compete".
    const withFlagged = {
      ...FIXTURE,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, maxMovesHit: 0, errorFraction: 1 }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => okJson(withFlagged))
    );
    mount();

    await vi.waitFor(() => expect(container.textContent).toContain('Excluded this run'));
    // Visible text, not just a threaded prop: name + the same failure-mode wording the
    // in-app badge uses (flagBadgeText).
    expect(container.textContent).toContain('Broken');
    expect(container.textContent).toContain('30 error turns');
  });

  it('still shows the exclusion note when every bot was flagged (empty rankings)', async () => {
    const allFlagged = {
      ...FIXTURE,
      bots: [],
      replays: [],
      flagged: [{ name: 'Broken', errors: 0, invalidMoves: 12, maxMovesHit: 0, errorFraction: 1 }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => okJson(allFlagged))
    );
    mount();

    await vi.waitFor(() => expect(container.textContent).toContain('Excluded this run'));
    expect(container.textContent).toContain('Broken');
    expect(container.textContent).toContain('12 invalid moves');
    // The empty-rankings message and the note coexist: no one ranked *and* the run
    // excluded someone are both true, and both should be said. But tournaments HAVE
    // run (tournamentCount > 0), so the copy must not claim "first run" (#175).
    expect(container.textContent).toContain('No ranked bots this run');
    expect(container.textContent).not.toContain('first run');
  });

  it('keeps the first-run copy when no tournament has ever run', async () => {
    // The pre-first-run placeholder shape (run-online-tournament.mjs seeds
    // tournamentCount: 0) — the one case where "check back after the first run" is true.
    const neverRan = {
      updatedAt: null,
      tournamentCount: 0,
      totalGamesPlayed: 0,
      bots: [],
      replays: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => okJson(neverRan))
    );
    mount();

    await vi.waitFor(() => expect(container.textContent).toContain('No tournament results yet'));
    expect(container.textContent).toContain('first run');
    expect(container.textContent).not.toContain('No ranked bots');
  });

  it('WATCH fetches the replay, shows a busy label in flight, and hands the JSON to onViewReplay', async () => {
    const replay = { meta: { seed: 7 } };
    let resolveReplay;
    const replayResponse = new Promise(res => {
      resolveReplay = res;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(url => (url === 'data/leaderboard.json' ? okJson(FIXTURE) : replayResponse))
    );
    const onViewReplay = vi.fn();
    mount({ onViewReplay });
    await vi.waitFor(() => expect(button('WATCH')).toBeTruthy());

    act(() => button('WATCH').click());
    // Replay fetch still pending: the button goes busy and disabled.
    await vi.waitFor(() => expect(button('...')).toBeTruthy());
    expect(button('...').disabled).toBe(true);
    expect(fetch).toHaveBeenCalledWith('data/replays/match-1.json');
    expect(onViewReplay).not.toHaveBeenCalled();

    resolveReplay({ ok: true, json: () => Promise.resolve(replay) });
    await vi.waitFor(() => expect(onViewReplay).toHaveBeenCalledWith(replay));
    await vi.waitFor(() => expect(button('WATCH')).toBeTruthy()); // busy label cleared
  });

  it('renders the error branch on a failed fetch, and RETRY refetches into the data branch', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 503 }))
      .mockImplementation(() => okJson(FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    mount();

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Could not load leaderboard: HTTP 503')
    );

    act(() => button('RETRY').click());
    await vi.waitFor(() => expect(container.textContent).toContain('Conqueror'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
