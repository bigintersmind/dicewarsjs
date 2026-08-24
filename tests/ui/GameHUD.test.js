// @vitest-environment jsdom
/**
 * GameHUD tests
 *
 * Covers the player-status bar and the QUIT control it carries during play
 * (#181) — present only when App supplies a handler, and never dressed as a
 * primary action.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameHUD } from '../../src/ui/GameHUD.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

function makeGameState() {
  return {
    turnOrder: [0, 1, 2],
    currentPlayerIndex: 0,
    players: [
      { id: 0, territoryCount: 5, stock: 2, eliminated: false },
      { id: 1, territoryCount: 3, stock: 0, eliminated: false },
      { id: 2, territoryCount: 0, stock: 0, eliminated: true },
    ],
  };
}

function renderHUD({ onQuit, onRules, gameState = makeGameState() } = {}) {
  const store = createGameStore({ screen: 'playing', gameState });

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(GameHUD, { store, onQuit, onRules }), container);
  });

  return { store };
}

const quitBtn = () => container.querySelector('button[aria-label="Quit to title"]');
const rulesBtn = () => container.querySelector('button[aria-label="Rules: how to play"]');
/** The hidden width-matched twins that keep the chips optically centered. */
const twins = () => [...container.querySelectorAll('span[aria-hidden="true"]')];
const quitTwin = () => twins().find(el => el.textContent.trim() === 'QUIT');
/** The chips row — the only <div> child of the HUD bar. */
const playersRow = () => Array.from(container.firstChild.children).find(el => el.tagName === 'DIV');

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('GameHUD', () => {
  it('shows one chip per surviving player', () => {
    renderHUD();
    expect(container.textContent).toContain('5');
    expect(container.textContent).toContain('+2');
    // The eliminated player is dropped from the bar.
    expect(playersRow().children.length).toBe(2);
  });

  it('renders no QUIT control without a handler (game over keeps its own way out)', () => {
    renderHUD();
    expect(quitBtn()).toBeNull();
    // No button, no twin — nothing to balance, and the chips stay centered.
    expect(quitTwin()).toBeUndefined();
    expect(twins()).toHaveLength(0);
  });

  it('renders QUIT as a muted text control and reports clicks', () => {
    const onQuit = vi.fn();
    renderHUD({ onQuit });

    const button = quitBtn();
    expect(button).toBeTruthy();
    expect(button.textContent.trim()).toBe('QUIT');
    // .dw-opt is the bare-text idiom; .dw-btn would make it a primary action.
    expect(button.className).toBe('dw-opt');

    // Same text in the same class on the other side, so the two ends of the
    // bar measure the same and the chips sit centered rather than pushed right.
    const twin = quitTwin();
    expect(twin).toBeTruthy();
    expect(twin.textContent.trim()).toBe('QUIT');
    expect(twin.className).toBe('dw-opt');

    act(() => button.click());
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('renders RULES as a muted text control and reports clicks', () => {
    const onRules = vi.fn();
    renderHUD({ onRules });

    const button = rulesBtn();
    expect(button).toBeTruthy();
    expect(button.textContent.trim()).toBe('RULES');
    // Bare text like QUIT: the way through the game (END TURN) stays the button.
    expect(button.className).toBe('dw-opt');

    act(() => button.click());
    expect(onRules).toHaveBeenCalledTimes(1);
  });

  it('renders no RULES control without a handler', () => {
    renderHUD({ onQuit: vi.fn() });
    expect(rulesBtn()).toBeNull();
  });

  /*
   * The bar is a hard 50px that must not wrap, so both ends have to measure the
   * same or the chips drift off centre: every left-hand control gets a hidden
   * twin on the right, mirrored (the twins run in reverse order).
   */
  it('mirrors both controls with hidden twins so the chips stay centered', () => {
    renderHUD({ onQuit: vi.fn(), onRules: vi.fn() });

    expect(twins().map(s => s.textContent.trim())).toEqual(['RULES', 'QUIT']);
    for (const twin of twins()) {
      expect(twin.className).toBe('dw-opt');
      expect(twin.style.visibility).toBe('hidden');
    }
  });

  it('renders nothing without a game state', () => {
    renderHUD({ gameState: null });
    expect(container.innerHTML).toBe('');
  });
});
