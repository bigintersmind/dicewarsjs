// @vitest-environment jsdom
/**
 * App Daily Conquest wiring.
 *
 * DailyConquest.test.js proves each daily component reports its clicks, and the
 * controller tests prove each method does what it says; neither sees which
 * controller method App actually wired to which prop. Wiring PLAY DAILY to
 * `startNewGame`, or PRACTICE AGAIN to `startDailyGame`, would leave both
 * suites green and quietly hand out a second scored attempt — so assert the
 * hookup itself against a stub controller (the AppQuitWiring pattern).
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { readDailyRecord } from '../../src/store/dailyRecords.js';
import { isLeaderboardEnabled } from '../../src/game/dailyLeaderboard.js';
import { createMatchJournal, finishMatchJournal } from '../../src/game/matchJournal.js';
import { createGame } from '../../src/engine/index.js';

vi.mock('../../src/store/dailyRecords.js', () => ({
  DAILY_STORAGE_KEY: 'dicewars_daily_v1',
  readDailyRecord: vi.fn(() => ({ record: null, available: true, streak: 0 })),
}));

vi.mock('../../src/game/dailyLeaderboard.js', () => ({
  isLeaderboardEnabled: vi.fn(() => false),
  fetchDailyLeaderboard: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../src/game/dailyShare.js', () => ({
  GAME_URL: 'https://ivanlay.com/dicewarsjs/',
  formatDailyShare: vi.fn(() => 'SHARE TEXT'),
}));

let container;

beforeEach(() => {
  localStorage.clear();
  // Fixed, mid-day UTC: the daily card reads the clock at mount and again on a
  // one-minute timer, and a real clock would make the date it starts a moving target.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  readDailyRecord.mockReturnValue({ record: null, available: true, streak: 0 });
  isLeaderboardEnabled.mockReturnValue(false);
});

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A finished daily, as the store looks at the end of the scored attempt. */
function dailyGameOverState(overrides = {}) {
  const state = createGame({ seed: 17, playerCount: 4 });
  return {
    screen: 'gameOver',
    gameState: { ...state, winner: 0 },
    humanPlayerIndex: 0,
    matchJournal: finishMatchJournal(createMatchJournal(state, 0), { ...state, winner: 0 }),
    dailyChallenge: createDailyChallenge('2026-09-07'),
    dailyResult: {
      available: true,
      official: true,
      streak: 3,
      record: {
        official: { won: true, turns: 9, attacks: 20, captures: 15, submission: null },
        practice: 0,
      },
    },
    ...overrides,
  };
}

function renderApp(state) {
  const store = createGameStore();
  store.setState(state);
  const controller = {
    startNewGame: vi.fn(),
    startDailyGame: vi.fn(),
    retryGame: vi.fn(),
    submitDailyScore: vi.fn(() => Promise.resolve({ accepted: true, rank: 4 })),
    goToTitle: vi.fn(),
    goToArena: vi.fn(),
    goToTournament: vi.fn(),
    goToOnlineLeaderboard: vi.fn(),
    openRules: vi.fn(),
    closeRules: vi.fn(),
    openQuitConfirm: vi.fn(),
    closeQuitConfirm: vi.fn(),
    endHumanTurn: vi.fn(),
    handleTerritoryClick: vi.fn(),
    startSpectate: vi.fn(),
    viewGameReplay: vi.fn(),
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller }), container);
  });
  return { store, controller };
}

const byText = label =>
  [...container.querySelectorAll('button')].find(b => b.textContent.startsWith(label));

describe('App — the daily card on the title screen', () => {
  it('starts today’s daily board rather than an ordinary game', () => {
    const { controller } = renderApp({ screen: 'title' });

    act(() => byText('PLAY DAILY').click());

    expect(controller.startDailyGame).toHaveBeenCalledWith('2026-09-07');
    expect(controller.startNewGame).not.toHaveBeenCalled();
  });
});

describe('App — the game-over screen', () => {
  it('routes PRACTICE AGAIN on a daily through retryGame', () => {
    const { controller } = renderApp(dailyGameOverState());

    act(() => byText('PRACTICE AGAIN').click());

    expect(controller.retryGame).toHaveBeenCalledTimes(1);
    // The scored attempt is spent; nothing here may start a new daily.
    expect(controller.startDailyGame).not.toHaveBeenCalled();
  });

  it('routes TRY AGAIN on an ordinary game through the same method', () => {
    const state = dailyGameOverState({ dailyChallenge: null, dailyResult: null });
    const { controller } = renderApp(state);

    act(() => byText('TRY AGAIN').click());

    expect(controller.retryGame).toHaveBeenCalledTimes(1);
  });

  it('posts the typed name through submitDailyScore', async () => {
    isLeaderboardEnabled.mockReturnValue(true);
    const { controller } = renderApp(dailyGameOverState());

    const input = container.querySelector('#dw-daily-name');
    input.value = 'ACE';
    act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => {
      byText('POST').click();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    expect(controller.submitDailyScore).toHaveBeenCalledWith('ACE');
  });
});

describe('App — the playing screen', () => {
  it('mounts the supply panel over the board', () => {
    const state = createGame({ seed: 17, playerCount: 4 });
    renderApp({
      screen: 'playing',
      gameState: state,
      humanPlayerIndex: 0,
      awaitingInput: 'selectFrom',
    });

    expect(container.querySelector('aside[aria-label="Your supply"]')).toBeTruthy();
  });

  it('leaves it off every other screen', () => {
    renderApp({ screen: 'title' });
    expect(container.querySelector('aside[aria-label="Your supply"]')).toBeNull();
  });
});
