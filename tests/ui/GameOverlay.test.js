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
  /*
   * With coaching on (the default) the CoachHint strip *replaces* the bare
   * prompts — same job, but it explains the rule behind the click. The terse
   * lines stay as the fallback for a player who turned coaching off, so both
   * forms are covered here.
   */
  it('shows the coaching prompt and an END TURN button that reports clicks', () => {
    const { onEndTurn } = renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(container.textContent).toContain('Pick one of your territories with 2 or more dice.');
    expect(endTurnButton()).toBeTruthy();
    act(() => endTurnButton().click());
    expect(onEndTurn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bare prompts when coaching is off', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
      preferences: { coachHints: 'off' },
    });
    expect(container.textContent).toContain('Click your territory to attack from');
    expect(container.querySelector('.dw-coach')).toBeNull();
  });

  it('shows the attack-target prompt once a territory is selected', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectTo',
      selectedFrom: 1,
      preferences: { coachHints: 'off' },
    });
    expect(container.textContent).toContain('Click a neighbor to attack');
    expect(container.textContent).not.toContain('attack from');
  });

  it('mounts no coaching strip in spectator mode', () => {
    renderOverlay({ humanPlayerIndex: null });
    expect(container.querySelector('.dw-coach')).toBeNull();
  });

  it('offers no END TURN button on an AI turn', () => {
    renderOverlay();
    expect(endTurnButton()).toBeUndefined();
  });
});
