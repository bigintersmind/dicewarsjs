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
import { END_TURN_BUTTON_ID } from '../../src/controller/KeyboardController.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../../src/renderer/constants.js';

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

function renderOverlay(stateOverrides = {}, { onEndTurn = vi.fn() } = {}) {
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
    render(h(GameOverlay, { store, onEndTurn }), container);
  });
  return { store, onEndTurn };
}

/** The thinking line, located by its text so another <p> can't be mistaken for it. */
const thinkingLine = () =>
  [...container.querySelectorAll('p')].find(p => p.textContent.includes('is thinking'));
/** The colored name span inside the thinking line. */
const nameSpan = () => thinkingLine().querySelector('span');
const endTurnButton = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'END TURN');

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

  // Real games shuffle turnOrder, so the seat whose turn it is (turnOrder[currentPlayerIndex])
  // is not the turn slot. Names are indexed by seat: an identity-order fixture could not tell
  // the two apart, and the wrong index would show one bot's name in another seat's color.
  it('names the seat whose turn it is, not the turn slot', () => {
    renderOverlay({
      gameState: makeGameState({ turnOrder: [2, 0, 1], currentPlayerIndex: 0 }),
      playerNames: ['You', 'Blitz', 'Conqueror'],
    });
    expect(container.textContent).toContain('Conqueror is thinking...');
    expect(container.textContent).not.toContain('Blitz');
    // Name and color agree on the seat.
    expect(nameSpan().style.color).toBe(cssColor(PLAYER_COLORS_CSS[2]));
  });

  it('uses the color-blind palette for the name when that preference is on', () => {
    renderOverlay({
      preferences: { colorBlindMode: true },
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });
    expect(nameSpan().style.color).toBe(cssColor(COLORBLIND_PLAYER_COLORS_CSS[1]));
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

describe('GameOverlay — human turn', () => {
  it('shows the attack-from prompt and an END TURN button that reports clicks', () => {
    const { onEndTurn } = renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(container.textContent).toContain('Click your territory to attack from');
    expect(endTurnButton()).toBeTruthy();
    act(() => endTurnButton().click());
    expect(onEndTurn).toHaveBeenCalledTimes(1);
  });

  it('shows the attack-target prompt once a territory is selected', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectTo',
    });
    expect(container.textContent).toContain('Click a neighbor to attack');
    expect(container.textContent).not.toContain('attack from');
  });

  /*
   * KeyboardController makes the board one virtual tab stop sitting immediately
   * before this button and finds it by id (#201). Renaming the id here without
   * the controller would silently strand a keyboard player on the board.
   */
  it('gives END TURN the id the keyboard tab-order seam aims at', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(endTurnButton().id).toBe(END_TURN_BUTTON_ID);
  });

  /*
   * The seam's destination, so it has to show a focus ring — and it cannot use
   * the shared .dw-btn one, whose accent color is this button's own background.
   * E is the shortcut past the seam; the title advertises it the way QUIT
   * advertises Esc, and aria-keyshortcuts says the same thing to a screen reader.
   */
  it('advertises the E shortcut and carries its own focus-ring class', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(endTurnButton().getAttribute('title')).toContain('(E)');
    expect(endTurnButton().getAttribute('aria-keyshortcuts')).toBe('E');
    expect(endTurnButton().className).toContain('dw-end-turn');
  });

  it('offers no END TURN button on an AI turn', () => {
    renderOverlay();
    expect(endTurnButton()).toBeUndefined();
  });
});
