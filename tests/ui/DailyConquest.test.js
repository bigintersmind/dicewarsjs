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
import { readDailyRecord } from '../../src/store/dailyRecords.js';
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

  /*
   * A landing page must not put a network problem in front of someone who came
   * to press a button — no spinner, no error, no empty frame.
   */
  it('shows nothing at all when the fetch fails', async () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockRejectedValue(new Error('offline'));
    mount(DailyChallengeCard, { onStart: vi.fn() });
    await flush();

    expect(container.querySelector('.dw-daily-board')).toBeNull();
    expect(container.textContent).not.toContain('offline');
    expect(container.textContent).not.toContain('finished today');
    // ...and the card still does its actual job.
    expect(button().textContent).toContain('PLAY DAILY');
  });

  it('shows nothing while the fetch is still in flight', () => {
    isLeaderboardEnabled.mockReturnValue(true);
    fetchDailyLeaderboard.mockReturnValue(new Promise(() => {}));
    mount(DailyChallengeCard, { onStart: vi.fn() });

    expect(container.querySelector('.dw-daily-board')).toBeNull();
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

  /* Another tab finishing today's run has to reach this one. */
  it('re-reads the record on a storage event', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    expect(button().textContent).toContain('PLAY DAILY');

    readDailyRecord.mockReturnValue(officialRecord({ won: false, turns: 12 }));
    act(() => window.dispatchEvent(new Event('storage')));

    expect(container.textContent).toContain('Today: eliminated after 12 turns');
    expect(button().textContent).toContain('PRACTICE');
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
   * The title screen has no h1 of its own: its name is the wordmark SVG, an
   * image with a label rather than a heading. This card's headline used to be
   * an h2, which opened the page's outline at level 2 — and the section
   * repeated the same words as an aria-label, so the card announced its name
   * twice.
   */
  it('is a top-level heading, and labels the card rather than repeating itself', () => {
    mount(DailyChallengeCard, { onStart: vi.fn() });
    const section = container.querySelector('section');
    const heading = container.querySelector('h1');

    expect(heading.textContent).toBe('DAILY CONQUEST');
    expect(container.querySelector('h2')).toBeNull();
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
    expect([...container.querySelectorAll('dd')].map(e => e.textContent)).toEqual(['7', '+3', '2']);
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

      expect(document.documentElement.style.getPropertyValue(SUPPLY_PANEL_HEIGHT_VAR)).toBe('92px');
      // The renderer only re-reads on a resize; publishing without one would
      // leave the board scaled to the whole window until something else moved.
      expect(resized).toHaveBeenCalled();
      window.removeEventListener('resize', resized);
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
});
