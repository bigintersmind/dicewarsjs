// @vitest-environment jsdom
/**
 * App playing-screen quit wiring (#181).
 *
 * GameHUD.test.js proves the QUIT button reports its clicks and
 * QuitConfirm.test.js proves each answer calls the prop it was handed; neither
 * sees which controller method App actually wired to which prop. Swapping
 * onCancel and onConfirm would leave both suites green and quit the game on
 * KEEP PLAYING, so assert the hookup itself against a stub controller.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

function makeGameState() {
  return {
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    players: [
      { id: 0, territoryCount: 5, stock: 1, eliminated: false },
      { id: 1, territoryCount: 4, stock: 0, eliminated: false },
    ],
  };
}

function renderPlaying(overrides = {}) {
  const store = createGameStore();
  store.setState({
    screen: 'playing',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: 'selectFrom',
    ...overrides,
  });
  const controller = {
    openQuitConfirm: vi.fn(),
    closeQuitConfirm: vi.fn(),
    goToTitle: vi.fn(),
    endHumanTurn: vi.fn(),
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller }), container);
  });
  return { store, controller };
}

const quitBtn = () => container.querySelector('button[aria-label="Quit to title"]');
/* Scoped to the dialog: the HUD's own QUIT is still on screen behind it. */
const dialogBtn = text =>
  Array.from(container.querySelectorAll('[role="dialog"] button')).find(
    b => b.textContent.trim() === text
  );

describe('App playing-screen quit wiring', () => {
  it('the HUD QUIT control opens the confirm rather than quitting', () => {
    const { controller } = renderPlaying();

    act(() => quitBtn().click());

    expect(controller.openQuitConfirm).toHaveBeenCalledTimes(1);
    expect(controller.goToTitle).not.toHaveBeenCalled();
  });

  it('QUIT in the dialog goes to the title', () => {
    const { controller } = renderPlaying({ quitConfirmOpen: true });

    act(() => dialogBtn('QUIT').click());

    expect(controller.goToTitle).toHaveBeenCalledTimes(1);
    // goToTitle resets the flag itself; a closeQuitConfirm here would be a
    // second, redundant store write on the way out.
    expect(controller.closeQuitConfirm).not.toHaveBeenCalled();
  });

  it('KEEP PLAYING in the dialog only dismisses it', () => {
    const { controller } = renderPlaying({ quitConfirmOpen: true });

    act(() => dialogBtn('KEEP PLAYING').click());

    expect(controller.closeQuitConfirm).toHaveBeenCalledTimes(1);
    expect(controller.goToTitle).not.toHaveBeenCalled();
  });

  /*
   * #189: the one route to the title where two focus mechanisms meet.
   * QuitConfirm hands focus back to its opener as it unmounts, and TitleScreen
   * claims START as it mounts; the opener — the HUD's QUIT — is torn down with
   * the board, so START is where the keyboard has to end up.
   */
  it('lands focus on START after QUIT in the dialog', () => {
    const { store, controller } = renderPlaying();
    controller.openQuitConfirm.mockImplementation(() => store.setState({ quitConfirmOpen: true }));
    controller.goToTitle.mockImplementation(() =>
      store.setState({ screen: 'title', gameState: null, quitConfirmOpen: false })
    );

    // Opened from the HUD control by keyboard, so the dialog has a real opener to restore to.
    quitBtn().focus();
    act(() => quitBtn().click());
    expect(dialogBtn('QUIT')).toBeTruthy();

    act(() => dialogBtn('QUIT').click());

    const start = [...container.querySelectorAll('button')].find(b => b.textContent === 'START');
    expect(start).toBeTruthy();
    expect(document.activeElement).toBe(start);
  });
});
