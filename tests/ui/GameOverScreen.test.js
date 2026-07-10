// @vitest-environment jsdom
/**
 * GameOverScreen tests
 *
 * Covers the subtitle the screen shows for each terminal outcome, in particular the
 * turn-cap draw (winner null + gameOverReason 'turnLimit') introduced with the browser
 * stalemate guard — a game that reached the turn cap with no conqueror.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameOverScreen } from '../../src/ui/GameOverScreen.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

/** Render GameOverScreen against a store seeded with the given terminal state. */
function renderGameOver(overrides = {}) {
  const store = createGameStore();
  store.setState({
    gameState: { winner: null, ...overrides.gameState },
    humanPlayerIndex: overrides.humanPlayerIndex ?? null,
    humanEliminated: overrides.humanEliminated ?? false,
    gameOverReason: overrides.gameOverReason ?? null,
  });

  const onTitle = overrides.onTitle ?? vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(GameOverScreen, { store, onTitle }), container);
  });
  return { store, container };
}

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

describe('GameOverScreen', () => {
  it('shows a draw subtitle when the game ended on the turn cap', () => {
    renderGameOver({ gameState: { winner: null }, gameOverReason: 'turnLimit' });
    expect(container.textContent).toContain('turn limit reached');
  });

  it('names the winning player when there is a winner', () => {
    renderGameOver({ gameState: { winner: 2 }, humanPlayerIndex: 0 });
    expect(container.textContent).toContain('Player 3 wins');
    expect(container.textContent).not.toContain('turn limit reached');
  });

  it('shows the elimination subtitle (not a draw) when the human was eliminated', () => {
    renderGameOver({ gameState: { winner: null }, humanEliminated: true });
    expect(container.textContent).toContain('You were eliminated');
    expect(container.textContent).not.toContain('turn limit reached');
  });

  it('shows no draw subtitle for a normal game-over with no draw reason', () => {
    renderGameOver({ gameState: { winner: null }, gameOverReason: null });
    expect(container.textContent).not.toContain('turn limit reached');
  });

  // The exit button says BATTLE (the mode rail's name for the landing screen,
  // since the top-rail redesign) and routes through onTitle.
  it('labels the exit button BATTLE and routes it through onTitle', () => {
    const onTitle = vi.fn();
    renderGameOver({ gameState: { winner: 2 }, onTitle });
    const battle = [...container.querySelectorAll('button')].find(b => b.textContent === 'BATTLE');
    expect(battle).toBeTruthy();
    act(() => battle.click());
    expect(onTitle).toHaveBeenCalledTimes(1);
  });

  // Locks the subtitle branch precedence: a real winner must win over a lingering
  // 'turnLimit' reason. gameOverReason is a sticky store field (see GameStore
  // DEFAULT_STATE); if a future reorder let it shadow `winner !== null`, a decisive
  // game could wrongly read "Draw" — this guards against that.
  it('prefers the winner subtitle over a stale turnLimit reason', () => {
    renderGameOver({ gameState: { winner: 2 }, gameOverReason: 'turnLimit' });
    expect(container.textContent).toContain('Player 3 wins');
    expect(container.textContent).not.toContain('turn limit reached');
  });
});
