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

  it('announces AI thinking on non-human turn', () => {
    store.setState({
      screen: 'playing',
      awaitingInput: null,
      humanPlayerIndex: 0,
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Player 2');
    expect(getText()).toContain('thinking');
  });

  it('announces game over with winner', () => {
    store.setState({
      screen: 'gameOver',
      awaitingInput: null,
      humanPlayerIndex: 0,
      gameState: makeGameState({ winner: 0 }),
    });

    const { getText } = renderAnnouncer(store);
    expect(getText()).toContain('Game over');
    expect(getText()).toContain('Player 1 wins');
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
