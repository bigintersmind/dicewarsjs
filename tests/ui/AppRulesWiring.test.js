// @vitest-environment jsdom
/**
 * App "How to play" wiring.
 *
 * RulesModal.test.js proves the card answers its own props and the screen
 * suites prove each entry point reports its clicks; neither sees that App
 * mounted the card outside the screen switch, nor which controller method the
 * entry points reach. This asserts the hookup: the card is reachable from the
 * title, the board and the game-over screen, and — the reason the flag lives
 * in the store — Escape over the playing screen closes the card instead of
 * raising "Abandon this game?" behind it.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    container.remove();
    container = null;
  }
});

function makeGameState(extra = {}) {
  return {
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    players: [
      { id: 0, territoryCount: 5, stock: 1, eliminated: false },
      { id: 1, territoryCount: 4, stock: 0, eliminated: false },
    ],
    ...extra,
  };
}

function renderApp(overrides = {}) {
  const store = createGameStore();
  store.setState({
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: 'selectFrom',
    ...overrides,
  });
  const controller = {
    openRules: vi.fn(() => store.setState({ rulesOpen: true })),
    closeRules: vi.fn(() => store.setState({ rulesOpen: false })),
    openQuitConfirm: vi.fn(),
    closeQuitConfirm: vi.fn(),
    goToTitle: vi.fn(),
    startNewGame: vi.fn(),
    startSpectate: vi.fn(),
    endHumanTurn: vi.fn(),
    goToArena: vi.fn(),
    goToTournament: vi.fn(),
    goToOnlineLeaderboard: vi.fn(),
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller }), container);
  });
  return { store, controller };
}

const dialog = () => container.querySelector('[role="dialog"]');
const byLabel = label => container.querySelector(`button[aria-label="${label}"]`);
const rulesEntry = () => byLabel('How to play: the rules in one card');

function pressEscape() {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

describe('App "How to play" wiring', () => {
  it('opens the card from the title screen', () => {
    const { controller } = renderApp({ screen: 'title' });

    act(() => rulesEntry().click());

    expect(controller.openRules).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();
    expect(controller.startNewGame).not.toHaveBeenCalled();
  });

  it('opens the card from the in-game HUD', () => {
    const { controller } = renderApp({ screen: 'playing' });

    act(() => byLabel('Rules: how to play').click());

    expect(controller.openRules).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();
    // The bar's other control must not have been reached by mistake.
    expect(controller.openQuitConfirm).not.toHaveBeenCalled();
  });

  it('opens the card from the game-over screen', () => {
    const { controller } = renderApp({
      screen: 'gameOver',
      gameState: makeGameState({ winner: 1 }),
    });

    act(() => rulesEntry().click());

    expect(controller.openRules).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();
    expect(controller.goToTitle).not.toHaveBeenCalled();
  });

  it('survives the screen changing underneath it', () => {
    const { store } = renderApp({ screen: 'playing', rulesOpen: true });
    const opened = dialog();
    expect(opened).toBeTruthy();

    // An AI finishes the game while the player is reading. The card is mounted
    // outside the screen switch precisely so that does not yank it away.
    act(() =>
      store.setState({
        screen: 'gameOver',
        gameState: makeGameState({ winner: 1 }),
        quitConfirmOpen: false,
      })
    );

    expect(dialog()).toBe(opened);
    expect(opened.isConnected).toBe(true);
  });

  it('closes the card through the controller', () => {
    const { controller } = renderApp({ screen: 'playing', rulesOpen: true });

    act(() => container.querySelector('button[aria-label="Close how to play"]').click());

    expect(controller.closeRules).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('Escape over the board closes the card instead of raising the quit confirm', () => {
    const { store, controller } = renderApp({ screen: 'playing', rulesOpen: true });

    pressEscape();

    expect(controller.closeRules).toHaveBeenCalledTimes(1);
    expect(controller.openQuitConfirm).not.toHaveBeenCalled();
    expect(store.getState().quitConfirmOpen).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('still raises the quit confirm on Escape once the card is closed', () => {
    const { controller } = renderApp({ screen: 'playing' });

    pressEscape();

    expect(controller.openQuitConfirm).toHaveBeenCalledTimes(1);
    expect(controller.closeRules).not.toHaveBeenCalled();
  });
});
