// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { DailyChallengeCard } from '../../src/ui/DailyChallengeCard.jsx';
import { SupplyStatus } from '../../src/ui/SupplyStatus.jsx';
import { MatchReport } from '../../src/ui/MatchReport.jsx';
import { MapPreview } from '../../src/ui/MapPreview.jsx';
import { GameOverlay } from '../../src/ui/GameOverlay.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { saveDailyResult } from '../../src/store/dailyRecords.js';
import { createMatchJournal, finishMatchJournal } from '../../src/game/matchJournal.js';
import { createGame } from '../../src/engine/index.js';

let container;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T23:59:00Z'));
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const mount = (component, props) => act(() => render(h(component, props), container));

it('launches the daily board and refreshes a sleeping title at UTC midnight', () => {
  const onStart = vi.fn();
  saveDailyResult(createDailyChallenge('2026-09-07').id, { won: true, turns: 9 });
  mount(DailyChallengeCard, { onStart });
  expect(container.textContent).toContain('Best win: 9 turns');
  vi.setSystemTime(new Date('2026-09-08T00:01:00Z'));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).not.toContain('Best win:');
  expect(container.querySelector('button').textContent).toContain('PLAY DAILY');
  act(() => container.querySelector('button').click());
  expect(onStart).toHaveBeenCalledWith('2026-09-08');
});

it('keeps daily play available when personal records are blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const onStart = vi.fn();
  mount(DailyChallengeCard, { onStart });
  expect(container.textContent).toContain('Personal bests are unavailable');
  act(() => container.querySelector('button').click());
  expect(onStart).toHaveBeenCalledOnce();
});

it('the daily preview describes its own board and offers no reroll', () => {
  const store = createGameStore({
    dailyChallenge: createDailyChallenge('2026-09-07'),
    config: { playerCount: 8, mapSize: 'large', difficulty: 'hard' },
  });
  const onAccept = vi.fn();
  mount(MapPreview, { store, onAccept, onBack: vi.fn(), onReject: vi.fn() });
  expect(container.textContent).toContain('4 players · small map · standard');
  expect(container.textContent).not.toContain('NEW MAP');
  expect(container.textContent).not.toContain('hard');
  act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'PLAY').click());
  expect(onAccept).toHaveBeenCalledOnce();
});

it('shows connected income rather than total land, responds to the engine, and disappears for spectators', () => {
  const game = createGame({ seed: 17, playerCount: 4 });
  const store = createGameStore({
    gameState: { ...game, players: [{ id: 0, territoryCount: 7, largestGroup: 3, stock: 2 }] },
  });
  mount(SupplyStatus, { store });
  expect([...container.querySelectorAll('dd')].map(e => e.textContent)).toEqual(['7', '+3', '2']);
  expect(container.textContent).toContain('earns 3 dice');
  act(() => store.setState({ gameState: { ...game, turnNumber: 6 } }));
  expect(container.textContent).toContain('Round 7');
  expect(container.querySelectorAll('dd')[1].textContent).toBe(`+${game.players[0].largestGroup}`);
  act(() => store.setState({ humanPlayerIndex: null }));
  expect(container.querySelector('aside')).toBeNull();
});

it('gives the chart a spoken equivalent and handles a match lost before any turns', () => {
  const state = createGame({ seed: 17, playerCount: 4 });
  const journal = finishMatchJournal(createMatchJournal(state, 0), {
    ...state,
    players: [{ ...state.players[0], territoryCount: 0 }],
    winner: 1,
  });
  mount(MatchReport, {
    journal,
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

it('explains a turn with no legal attacks even with board hints off, and disables end turn during a roll', () => {
  const game = createGame({ seed: 17, playerCount: 2 });
  const state = {
    ...game,
    currentPlayerIndex: game.turnOrder.indexOf(0),
    areas: game.areas.map(a => ({ ...a, dice: 1 })),
  };
  const store = createGameStore({
    gameState: state,
    awaitingInput: 'selectFrom',
    preferences: { boardHints: 'off' },
  });
  const onEndTurn = vi.fn();
  mount(GameOverlay, { store, onEndTurn });
  expect(container.textContent).toContain('No attacks available. End your turn to reinforce.');
  act(() => store.setState({ awaitingInput: null }));
  expect(container.querySelector('button').disabled).toBe(true);
  act(() => container.querySelector('button').click());
  expect(onEndTurn).not.toHaveBeenCalled();
});
