// @vitest-environment jsdom
/**
 * Daily Conquest — the UI half (v2).
 *
 * The card on the title screen, the panel over the board, the report on the
 * game-over screen and the daily's own map preview. The rules being pinned here
 * are the product decisions, not the pixels:
 *
 * - one scored attempt per UTC date, so the button says PLAY DAILY before it
 *   and PRACTICE after it, and never "TRY AGAIN";
 * - the leaderboard snippet is a nicety, so a failed fetch shows nothing at all
 *   rather than an error on the landing page;
 * - only a real storage failure gets copy of its own;
 * - the supply panel publishes the band the board has to leave it.
 *
 * Agent A's modules (dailyRecords, dailyLeaderboard) are mocked: this file is
 * about what the UI does with their answers, and their own behaviour — the
 * streak arithmetic, the storage failure semantics, the HTTP client — is
 * covered by tests/store and tests/game.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { DailyChallengeCard } from '../../src/ui/DailyChallengeCard.jsx';
import { SupplyStatus } from '../../src/ui/SupplyStatus.jsx';
import { MatchReport } from '../../src/ui/MatchReport.jsx';
import { MapPreview } from '../../src/ui/MapPreview.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { DAILY_STORAGE_KEY, readDailyRecord } from '../../src/store/dailyRecords.js';
import { fetchDailyLeaderboard, isLeaderboardEnabled } from '../../src/game/dailyLeaderboard.js';
import { createMatchJournal, finishMatchJournal } from '../../src/game/matchJournal.js';
import { createGame } from '../../src/engine/index.js';
import { SUPPLY_PANEL_HEIGHT_VAR } from '../../src/renderer/constants.js';

vi.mock('../../src/store/dailyRecords.js', () => ({
  DAILY_STORAGE_KEY: 'dicewars_daily_v1',
  readDailyRecord: vi.fn(),
}));

vi.mock('../../src/game/dailyLeaderboard.js', () => ({
  isLeaderboardEnabled: vi.fn(() => false),
  fetchDailyLeaderboard: vi.fn(),
}));

/** The v2 record shape (see the contract): an official result plus its extras. */
const officialRecord = (official, { streak = 1, available = true } = {}) => ({
  record: { official: { attacks: 20, captures: 15, submission: null, ...official }, practice: 0 },
  available,
  streak,
});

const NO_RECORD = { record: null, available: true, streak: 0 };

let container;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T23:59:00Z'));
  readDailyRecord.mockReturnValue(NO_RECORD);
  isLeaderboardEnabled.mockReturnValue(false);
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
  document.documentElement.style.removeProperty(SUPPLY_PANEL_HEIGHT_VAR);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const mount = (component, props) => act(() => render(h(component, props), container));
const button = () => container.querySelector('button');
/* The fetch chain is a few microtasks deep (a Promise.resolve hop, the mocked
   fetch, the setState); drain them all before asserting. */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

describe('DailyChallengeCard — the one scored attempt', () => {
  it('offers PLAY DAILY, and says the board and dice are the same for everyone', () => {
    const onStart = vi.fn();
    mount(DailyChallengeCard, { onStart });

    expect(button().textContent).toContain('PLAY DAILY');
    expect(button().textContent).not.toContain('TRY AGAIN');
    expect(container.textContent).toContain('same board and the same dice');

    act(() => button().click());
    expect(onStart).toHaveBeenCalledWith('2026-09-07');
  });

  /*
   * The one rule the whole card is built around. It used to live only in the
   * button's `title` tooltip — which a touch screen never shows, and a mouse
   * only shows to someone who already hovered and waited. The label says where
   * the button goes, not that it leaves the page, so the ↗ is gone too: that
   * glyph is the convention for a link OUT of the site.
   */
  it('says the scoring rule in visible copy rather than a tooltip', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });

    expect(container.textContent).toContain('Your first finished run is the scored one');
    expect(button().getAttribute('title')).toBeNull();
    expect(button().textContent).not.toContain('↗');
  });

  /*
   * The heart of v2: a finished run is spent. The card reports it, and the
   * button stops promising another scored attempt.
   */
  it('reports a win and turns the button into PRACTICE', () => {
    readDailyRecord.mockReturnValue(officialRecord({ won: true, turns: 9 }, { streak: 3 }));
    mount(DailyChallengeCard, { onStart: vi.fn() });

    expect(container.textContent).toContain('Today: won in 9 turns');
    expect(container.textContent).toContain('Streak: 3 days');
    expect(container.textContent).toContain('Practice runs don’t count.');
    expect(button().textContent).toContain('PRACTICE');
    expect(button().textContent).not.toContain('PLAY DAILY');
  });

  it('reports an elimination, and leaves the streak line out below two days', () => {
    readDailyRecord.mockReturnValue(officialRecord({ won: false, turns: 15 }, { streak: 1 }));
    mount(DailyChallengeCard, { onStart: vi.fn() });

    expect(container.textContent).toContain('Today: eliminated after 15 turns');
    expect(container.textContent).not.toContain('Streak:');
  });

  it('names the posting when the result went to the leaderboard', () => {
    readDailyRecord.mockReturnValue(
      officialRecord({ won: true, turns: 9, submission: { name: 'ACE', rank: 4 } })
    );
    mount(DailyChallengeCard, { onStart: vi.fn() });

    expect(container.textContent).toContain('Posted as ACE · #4');
  });

  /*
   * Storage failing is the one thing that changes what the card can promise, so
   * it is the one thing that gets copy. Playing still works.
   */
  it('says so when the browser refuses storage, and still starts the game', () => {
    readDailyRecord.mockReturnValue({ record: null, available: false, streak: 0 });
    const onStart = vi.fn();
    mount(DailyChallengeCard, { onStart });

    expect(container.textContent).toContain('Personal results can’t be saved in this browser.');
    act(() => button().click());
    expect(onStart).toHaveBeenCalledOnce();
  });
});

describe('DailyChallengeCard — the leaderboard snippet', () => {
  const page = {
    date: '2026-09-07',
    entries: [
      { rank: 1, name: 'ACE', turns: 7 },
      { rank: 2, name: 'BEE', turns: 8 },
      { rank: 3, name: 'CEE', turns: 9 },
      { rank: 4, name: 'DEE', turns: 10 },
    ],
    totals: { finished: 12, won: 5 },
  };

  it('shows the top three and the day’s totals when a leaderboard is configured', async () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockResolvedValue(page);
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(fetchDailyLeaderboard).toHaveBeenCalledWith('2026-09-07');
    expect(container.textContent).toContain('ACE');
    expect(container.textContent).toContain('7 turns');
    // Three, not four: it is a snippet beside a button, not the leaderboard.
    expect(container.textContent).not.toContain('DEE');
    expect(container.textContent).toContain('12 finished today · 5 won');
  });

  /* A list of three names read out as a list needs to say what list it is. */
  it('names the snippet for a screen reader', async () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockResolvedValue(page);
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(container.querySelector('ol').getAttribute('aria-label')).toBe('Today\u2019s top three');
  });

  /*
   * A landing page must not put a network problem in front of someone who came
   * to press a button — no spinner, no error text. What it must not do EITHER
   * is jump: the slot is reserved from the first paint, so the snippet arrives
   * into space that was already there instead of shoving the footer down.
   */
  it('shows nothing at all when the fetch fails, and says why in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    isLeaderboardEnabled.mockReturnValue(true);
    const failure = Object.assign(new Error('offline'), { code: 'network' });
    fetchDailyLeaderboard.mockRejectedValue(failure);
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(container.querySelector('.dw-daily-board').textContent).toBe('');
    expect(container.textContent).not.toContain('offline');
    expect(container.textContent).not.toContain('finished today');
    // ...and the card still does its actual job.
    expect(button().textContent).toContain('PLAY DAILY');
    /*
     * Silent to the player, not to us: a misconfigured origin or an unmigrated
     * database otherwise looks exactly like "nobody has finished today".
     */
    expect(warn).toHaveBeenCalledWith('[Daily Conquest] leaderboard unavailable:', failure);
  });

  /* `disabled` is not a fault — it is a build with no leaderboard configured. */
  it('stays quiet when the client reports the feature is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockRejectedValue(Object.assign(new Error('off'), { code: 'disabled' }));
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });

  /* Once per mount: the card lives on the landing page for as long as the tab
     is open, and a re-fetch a day later must not start a console log. */
  it('warns once, not on every re-fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockRejectedValue(Object.assign(new Error('down'), { code: 'network' }));
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-08T00:01:00Z'));
    act(() => vi.advanceTimersByTime(60000));
    await flush();

    expect(fetchDailyLeaderboard).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /*
   * The list is the top three WINS, so a board that plenty of people have
   * finished and nobody has won yet has no entries at all. Hanging the totals
   * off the list made that render identically to the failed fetch above — the
   * one thing this slot must not do, since a fetch that never landed is exactly
   * what the silence is reserved for. A page that arrived always says something.
   */
  it('still gives the day’s totals when nobody has won yet', async () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockResolvedValue({
      date: '2026-09-07',
      entries: [],
      totals: { finished: 4, won: 0 },
    });
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(container.textContent).toContain('4 finished today · 0 won');
    expect(container.querySelector('ol')).toBeNull();
  });

  /* ...and an untouched board says so in words, rather than "0 finished today". */
  it('says nobody has finished yet on an empty board', async () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockResolvedValue({
      date: '2026-09-07',
      entries: [],
      totals: { finished: 0, won: 0 },
    });
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(container.querySelector('.dw-daily-board').textContent).toBe(
      'Nobody has finished today yet.'
    );
    expect(container.textContent).not.toContain('0 finished today');
  });

  it('shows nothing while the fetch is still in flight', () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockReturnValue(new Promise(() => {}));
    mount(DailyChallengeCard, { onStart: vi.fn() });

    expect(container.querySelector('.dw-daily-board').textContent).toBe('');
  });

  it('asks for nothing when no leaderboard is configured', async () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();
    expect(fetchDailyLeaderboard).not.toHaveBeenCalled();
  });
});

describe('DailyChallengeCard — staying current', () => {
  it('rolls over to the new board at UTC midnight while the tab sleeps', () => {
    readDailyRecord.mockReturnValue(officialRecord({ won: true, turns: 9 }));
    const onStart = vi.fn();
    mount(DailyChallengeCard, { onStart });
    expect(container.textContent).toContain('Today: won in 9 turns');

    readDailyRecord.mockReturnValue(NO_RECORD);
    vi.setSystemTime(new Date('2026-09-08T00:01:00Z'));
    act(() => vi.advanceTimersByTime(60000));

    expect(container.textContent).not.toContain('Today: won');
    expect(button().textContent).toContain('PLAY DAILY');
    act(() => button().click());
    expect(onStart).toHaveBeenCalledWith('2026-09-08');
  });

  /*
   * The timer runs every minute for as long as the title screen is up, so all
   * but one tick a day has to cost a string comparison — no storage read, no
   * setState, no re-render of a card nobody is looking at.
   */
  it('costs nothing on a tick that is still the same day', () => {
    // Mid-day, so five minutes of ticks stay on the same board (the fake clock
    // advances with the timers, and the fixture's default is 23:59 UTC).
    vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
    mount(DailyChallengeCard, { onStart: vi.fn() });
    readDailyRecord.mockClear();

    act(() => vi.advanceTimersByTime(60000 * 5));

    expect(readDailyRecord).not.toHaveBeenCalled();
  });

  /*
   * The label and the record only refresh on the 60s tick, but the click reads
   * the clock live — so between 00:00 UTC and the next tick a stale card could
   * say PRACTICE while starting a fresh, SCORED board. The click has to notice.
   */
  it('starts today’s board, not yesterday’s, when the clock rolled over mid-visit', () => {
    readDailyRecord.mockReturnValue(officialRecord({ won: true, turns: 9 }));
    const onStart = vi.fn();
    mount(DailyChallengeCard, { onStart });
    expect(button().textContent).toContain('PRACTICE');

    // Midnight passes with no tick: the timer fires once a minute.
    readDailyRecord.mockReturnValue(NO_RECORD);
    vi.setSystemTime(new Date('2026-09-08T00:00:20Z'));

    act(() => button().click());

    expect(onStart).toHaveBeenCalledWith('2026-09-08');
    // ...and the card caught up in the same gesture, rather than going on
    // describing yesterday's spent result over today's fresh board.
    expect(button().textContent).toContain('PLAY DAILY');
    expect(container.textContent).not.toContain('Today: won');
  });

  /* Another tab finishing today's run has to reach this one. */
  it('re-reads the record on a storage event for its own key', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    expect(button().textContent).toContain('PLAY DAILY');

    readDailyRecord.mockReturnValue(officialRecord({ won: false, turns: 12 }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: DAILY_STORAGE_KEY })));

    expect(container.textContent).toContain('Today: eliminated after 12 turns');
    expect(button().textContent).toContain('PRACTICE');
  });

  /*
   * ...but 'storage' fires for every key another tab writes on this origin, and
   * the card only cares about one of them. A write to the remembered
   * leaderboard name or the preferences would otherwise cost a storage read and
   * a re-render of a record that cannot have changed.
   */
  it('ignores a cross-tab write to somebody else’s key', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    const reads = readDailyRecord.mock.calls.length;

    readDailyRecord.mockReturnValue(officialRecord({ won: false, turns: 12 }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'dicewars_daily_name' })));

    expect(readDailyRecord).toHaveBeenCalledTimes(reads);
    expect(button().textContent).toContain('PLAY DAILY');
  });

  /* A `key` of null is a clear() of the whole origin — that one does concern us. */
  it('re-reads when another tab clears the origin', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });

    readDailyRecord.mockReturnValue(officialRecord({ won: false, turns: 12 }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));

    expect(container.textContent).toContain('Today: eliminated after 12 turns');
  });

  it('re-reads the record when the tab is focused again', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    readDailyRecord.mockReturnValue(officialRecord({ won: true, turns: 4 }));

    act(() => window.dispatchEvent(new Event('focus')));

    expect(container.textContent).toContain('Today: won in 4 turns');
  });
});

describe('DailyChallengeCard — heading hierarchy', () => {
  /*
   * The title screen's name is the wordmark SVG — an image with a label rather
   * than a heading — so it now carries a visually hidden h1 of its own, and
   * this card is a SECTION inside that page: an h2. It was briefly an h1, which
   * made the landing page's outline open on a sub-offer. The section is
   * labelled BY the heading rather than repeating the words as an aria-label.
   */
  it('is a second-level heading under the screen’s own h1, and labels the card', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    const section = container.querySelector('section');
    const heading = container.querySelector('h2');

    expect(heading.textContent).toBe('DAILY CONQUEST');
    expect(container.querySelector('h1')).toBeNull();
    expect(section.getAttribute('aria-label')).toBeNull();
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
  });
});

describe('MapPreview — the daily board', () => {
  const preview = daily => {
    const store = createGameStore({
      dailyChallenge: daily,
      config: { playerCount: 8, mapSize: 'large', difficulty: 'hard' },
    });
    mount(MapPreview, { store, onAccept: vi.fn(), onBack: vi.fn(), onReject: vi.fn() });
  };

  it('describes its own board and offers no reroll', () => {
    preview(createDailyChallenge('2026-09-07'));
    expect(container.textContent).toContain('4 players · small map · standard');
    expect(container.textContent).not.toContain('NEW MAP');
    expect(container.textContent).not.toContain('hard');
    expect(container.textContent).not.toContain('Practice run');
  });

  /* The board looks identical either way, so this is the last chance to say it. */
  it('says a practice run is not scored', () => {
    preview({ ...createDailyChallenge('2026-09-07'), practice: true });
    expect(container.textContent).toContain('Practice run · not scored');
  });
});

describe('SupplyStatus', () => {
  const seatedStore = (players, overrides = {}) => {
    const game = createGame({ seed: 17, playerCount: 4 });
    return createGameStore({ gameState: { ...game, players }, ...overrides });
  };

  it('speaks the rules’ vocabulary and follows the engine', () => {
    const store = seatedStore([{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }]);
    mount(SupplyStatus, { store });

    expect([...container.querySelectorAll('dt')].map(e => e.textContent)).toEqual([
      'Land',
      'Reinforcements',
      'Stockpile',
    ]);
    /* No `+` on Reinforcements: `+N` is the HUD chip's stockpile, and one sign
       meaning two things across two panels is worse than no sign at all. */
    expect([...container.querySelectorAll('dd')].map(e => e.textContent)).toEqual(['7', '3', '2']);
    // The same words the rules card uses, so the panel teaches the game's own language.
    expect(container.textContent).toContain(
      'Your largest connected group earns 3 reinforcement dice'
    );
    // No invented third term for the same number.
    expect(container.textContent).not.toContain('Income');
    expect(container.textContent).not.toContain('In reserve');

    act(() =>
      store.setState({
        gameState: { ...store.getState().gameState, turnNumber: 6 },
      })
    );
    expect(container.textContent).toContain('Round 7');
  });

  /*
   * PRACTICE AGAIN restarts straight into the game — it skips the map preview,
   * the only other place a practice run is labelled — so on a second run of the
   * day this heading is the one thing on screen that can say so.
   */
  it('labels a practice run in its heading', () => {
    const players = [{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }];
    const daily = { ...createDailyChallenge('2026-09-07'), practice: true };
    mount(SupplyStatus, { store: seatedStore(players, { dailyChallenge: daily }) });
    expect(container.querySelector('.dw-supply-heading').textContent).toContain(
      'Daily · Sep 7 · Practice'
    );

    act(() => render(null, container));
    mount(SupplyStatus, {
      store: seatedStore(players, { dailyChallenge: { ...daily, practice: false } }),
    });
    expect(container.querySelector('.dw-supply-heading').textContent).not.toContain('Practice');
  });

  it('disappears for a spectator', () => {
    const store = seatedStore([{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }]);
    mount(SupplyStatus, { store });
    act(() => store.setState({ humanPlayerIndex: null }));
    expect(container.querySelector('aside')).toBeNull();
  });

  /*
   * The reservation contract with GameRenderer. jsdom lays nothing out, so a
   * real measurement is not available here — what is testable, and what the
   * renderer depends on, is that a measured panel publishes the property and
   * that unmounting withdraws it (otherwise the board would go on reserving a
   * band for a panel that is no longer there).
   */
  describe('the board reservation (--dw-supply-panel-height)', () => {
    const withMeasuredPanel = bottom => {
      const proto = Element.prototype;
      vi.spyOn(proto, 'getBoundingClientRect').mockReturnValue({
        bottom,
        height: bottom,
        top: 0,
        left: 0,
        right: 0,
        width: 400,
        x: 0,
        y: 0,
      });
    };

    it('publishes the band the panel occupies, gap included', () => {
      withMeasuredPanel(92);
      const store = seatedStore([{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }]);
      const resized = vi.fn();
      window.addEventListener('resize', resized);

      mount(SupplyStatus, { store });

      // Rounded UP to the step: 92px of panel reserves 96px of board.
      expect(document.documentElement.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR)).toBe('96px');
      // The renderer only re-reads on a resize; publishing without one would
      // leave the board scaled to the whole window until something else moved.
      expect(resized).toHaveBeenCalled();
      window.removeEventListener('resize', resized);
    });

    /*
     * Why the rounding: every republish dispatches a resize, which rescales the
     * whole board. A measured panel moves for reasons that have nothing to do
     * with the game — the explanatory sentence gaining a wrap line, a font
     * swapping in — and the map visibly shifting mid-turn because a sentence
     * grew is not an acceptable cost for a pixel of accuracy. A whole step's
     * worth of reflow therefore resolves to one reservation, and the
     * `getPropertyValue` guard in `publish` then makes the republish a no-op.
     */
    it('resolves a step’s worth of reflow to one reservation', () => {
      const players = [{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }];
      const published = [];
      for (const measured of [89, 92, 95, 96]) {
        withMeasuredPanel(measured);
        mount(SupplyStatus, { store: seatedStore(players) });
        published.push(document.documentElement.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR));
        act(() => render(null, container));
      }
      expect(published).toEqual(['96px', '96px', '96px', '96px']);
    });

    /* ...and a real change still crosses a step and is published. */
    it('publishes a new band once the panel crosses a step', () => {
      const players = [{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }];
      withMeasuredPanel(97);
      mount(SupplyStatus, { store: seatedStore(players) });
      expect(document.documentElement.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR)).toBe(
        '104px'
      );
    });

    it('withdraws it when the panel goes away', () => {
      withMeasuredPanel(92);
      const store = seatedStore([{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }]);
      mount(SupplyStatus, { store });

      act(() => render(null, container));

      expect(document.documentElement.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR)).toBe('');
    });

    /* An unlaid-out panel measures 0; reserving nothing is what no property
       already means, so it must not publish a bogus 0px. */
    it('publishes nothing for a panel that has not been laid out', () => {
      const store = seatedStore([{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }]);
      mount(SupplyStatus, { store });
      expect(document.documentElement.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR)).toBe('');
    });
  });
});

describe('MatchReport', () => {
  const finished = () => {
    const state = createGame({ seed: 17, playerCount: 4 });
    return finishMatchJournal(createMatchJournal(state, 0), {
      ...state,
      players: [{ ...state.players[0], territoryCount: 0 }],
      winner: 1,
    });
  };

  it('gives the chart a spoken equivalent and handles a match lost before any turns', () => {
    mount(MatchReport, {
      journal: finished(),
      daily: createDailyChallenge('2026-09-07'),
      dailyResult: { available: false },
    });

    const chart = container.querySelector('svg[role="img"]');
    expect(chart.getAttribute('aria-label')).toContain('finished with 0');
    expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container.textContent).toContain('No attacks made');
    expect(container.textContent).toContain('could not be saved');
    expect(container.querySelector('dd').textContent).toBe('0');
  });

  /*
   * The samples are one per human turn now (the journal records them on your
   * own END TURN), so the chart may not be captioned as if it ran on the
   * game's clock.
   */
  it('says whose turns the chart counts, in the caption and the alternative', () => {
    mount(MatchReport, { journal: finished() });
    expect(container.querySelector('svg[role="img"]').getAttribute('aria-label')).toContain(
      'after each of your turns'
    );
    expect(container.querySelector('figcaption').textContent).toContain(
      'Land after each of your turns'
    );
  });

  it('uses the rules’ word for the reinforcement stat', () => {
    mount(MatchReport, { journal: finished() });
    expect([...container.querySelectorAll('dt')].map(e => e.textContent)).toEqual([
      'Your turns',
      'Most land held',
      'Most reinforcements',
    ]);
    expect(container.textContent).not.toContain('income');
    expect(container.textContent).not.toContain('Income');
  });

  /* `+N` is the HUD chip's stockpile. Three plain counts here, no sign. */
  it('prints the reinforcement peak as a count, not a signed number', () => {
    mount(MatchReport, { journal: finished() });
    const numbers = [...container.querySelectorAll('dd')].map(e => e.textContent);
    expect(numbers).toHaveLength(3);
    expect(numbers.some(text => text.startsWith('+'))).toBe(false);
  });
});
