// @vitest-environment jsdom
/**
 * useAnnouncer / ScreenReaderAnnouncer tests
 *
 * Verifies that game state changes produce correct screen reader
 * announcements via the ARIA live region.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ScreenReaderAnnouncer } from '../../../src/ui/ScreenReaderAnnouncer.jsx';
import { createGameStore } from '../../../src/store/GameStore.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    grid: { width: 28, height: 32, cellCount: 896 },
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    history: [],
    winner: null,
    areas: {
      0: null,
      1: { owner: 0, dice: 3, neighborAreaIds: [2, 3] },
      2: { owner: 1, dice: 2, neighborAreaIds: [1, 3] },
      3: { owner: 0, dice: 1, neighborAreaIds: [1, 2] },
    },
    players: [
      { id: 0, alive: true, territoryCount: 2 },
      { id: 1, alive: true, territoryCount: 1 },
    ],
    ...overrides,
  };
}

let container;

function renderAnnouncer(store) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(ScreenReaderAnnouncer, { store }), container);
  });
  return {
    getText: () => container.querySelector('[aria-live]')?.textContent || '',
    getEl: () => container.querySelector('[aria-live]'),
  };
}

afterEach(() => {
  if (container) {
    act(() => {
      render(null, container);
    });
    if (container.parentNode) {
      document.body.removeChild(container);
    }
    container = null;
  }
});

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('ScreenReaderAnnouncer', () => {
  let store;

  beforeEach(() => {
    store = createGameStore();
  });

  it('renders with correct ARIA attributes', () => {
    const { getEl } = renderAnnouncer(store);
    const el = getEl();
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(el.getAttribute('role')).toBe('log');
  });

  it('shows no announcement when game state is null', () => {
    store.setState({
      screen: 'playing',
      gameState: null,
      humanPlayerIndex: 0,
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toBe('');
  });

  it('announces "Your turn" with territory count on human turn', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Your turn');
    expect(getText()).toContain('2 territories');
  });

  it('announces "Select a neighboring territory" on selectTo', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectTo',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Select a neighboring territory');
  });

  it('announces the AI by its bot name on a non-human turn', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');
    expect(getText()).not.toContain('Player 2');
  });

  it('falls back to the seat number when no player names are recorded', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: [],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Player 2 is thinking');
  });

  // Names are indexed by seat (turnOrder[currentPlayerIndex]), not by turn slot — real games
  // shuffle turnOrder, and the identity-order fixture above cannot tell the two apart.
  it('names the seat whose turn it is under a shuffled turn order', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ turnOrder: [1, 0], currentPlayerIndex: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');
  });

  // A live region has no color to tell two seats running the same bot apart (the visual
  // label's disambiguator), so a repeated name is spoken with its seat number — the whole
  // Standard lineup is Balanced AI. A unique name is spoken bare (see the Blitz cases).
  it('speaks the seat number too when the lineup repeats the bot name', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Balanced AI', 'Balanced AI'],
      gameState: makeGameState({
        turnOrder: [0, 1, 2],
        currentPlayerIndex: 2,
        players: [
          { id: 0, alive: true, territoryCount: 2 },
          { id: 1, alive: true, territoryCount: 1 },
          { id: 2, alive: true, territoryCount: 1 },
        ],
      }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Balanced AI, player 3, is thinking.');
  });

  // The effect must re-run on a lineup change alone: two back-to-back games can agree on
  // every other dependency (screen, turn index, human seat, winner, phase) and differ only in
  // who sits where — without `playerNames` in the deps the old game's bot would be announced.
  it('re-announces when the lineup changes under the same turn state', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Blitz is thinking');

    act(() => store.setState({ playerNames: ['You', 'Conqueror'] }));
    expect(getText()).toContain('Conqueror is thinking');
  });

  it('announces a human win as "You win!"', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ winner: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over. You win!');
  });

  it('announces a bot win by its bot name', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Blitz'],
      gameState: makeGameState({ winner: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over. Blitz wins!');
  });

  it('announces a bot win with its seat number when the lineup repeats the name', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      playerNames: ['You', 'Balanced AI', 'Balanced AI'],
      gameState: makeGameState({ winner: 2 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over. Balanced AI, player 3, wins!');
  });

  it('announces battle result', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
      battleResult: {
        success: true,
        attackerRoll: { values: [3, 4], total: 7 },
        defenderRoll: { values: [2, 1], total: 3 },
      },
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('7');
    expect(getText()).toContain('3');
    expect(getText()).toContain('Success');
  });

  it('updates announcement reactively when store changes', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: 'selectFrom',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Your turn');

    // Transition to game over
    act(() => {
      store.setState({
        screen: 'gameOver',
        gameState: makeGameState({ winner: 0 }),
      });
    });

    expect(getText()).toContain('Game over');
  });
});
