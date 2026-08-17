// @vitest-environment jsdom
/**
 * GameOverlay tests
 *
 * Covers the "is thinking..." line shown over the board on an AI turn: it names
 * the opponent by its bot ("Conqueror is thinking...") in the seat's color, so
 * each rival has an identity rather than a seat number — the color is what tells
 * two seats running the same bot apart.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameOverlay } from '../../src/ui/GameOverlay.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { PLAYER_COLORS_CSS } from '../../src/renderer/constants.js';

let container;

function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    turnOrder: [0, 1, 2],
    currentPlayerIndex: 1,
    winner: null,
    players: [
      { id: 0, territoryCount: 5, eliminated: false },
      { id: 1, territoryCount: 3, eliminated: false },
      { id: 2, territoryCount: 4, eliminated: false },
    ],
    ...overrides,
  };
}

function renderOverlay(stateOverrides = {}) {
  const store = createGameStore({
    screen: 'playing',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: null,
    playerNames: ['You', 'Conqueror', 'Conqueror'],
    ...stateOverrides,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(GameOverlay, { store, onEndTurn: vi.fn() }), container);
  });
  return { store };
}

/** The colored name span inside the thinking line. */
const nameSpan = () => container.querySelector('p span');

/** jsdom normalizes hex colors to rgb(); compare against the same normalization. */
function cssColor(hex) {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
}

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('GameOverlay — AI thinking line', () => {
  it('names the current bot rather than its seat number', () => {
    renderOverlay();
    expect(container.textContent).toContain('Conqueror is thinking...');
    expect(container.textContent).not.toContain('Player 2');
  });

  it('colors the name with the seat color (what tells two identical bots apart)', () => {
    renderOverlay({ gameState: makeGameState({ currentPlayerIndex: 2 }) });
    // Seats 1 and 2 both run Conqueror; only the color says which one is up.
    expect(nameSpan().textContent).toBe('Conqueror');
    expect(nameSpan().style.color).toBe(cssColor(PLAYER_COLORS_CSS[2]));
  });

  it('falls back to the seat number when no player names are recorded', () => {
    renderOverlay({ playerNames: [] });
    expect(container.textContent).toContain('Player 2 is thinking...');
  });

  it('shows no thinking line on the human turn', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(container.textContent).not.toContain('is thinking');
  });

  it('shows no thinking line in spectator mode', () => {
    renderOverlay({ humanPlayerIndex: null });
    expect(container.textContent).not.toContain('is thinking');
  });
});
