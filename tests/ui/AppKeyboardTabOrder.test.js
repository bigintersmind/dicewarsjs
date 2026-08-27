// @vitest-environment jsdom
/**
 * Playing-screen tab order (#201).
 *
 * KeyboardController.test.js proves the seams against hand-built buttons and
 * GameOverlay.test.js proves END TURN carries the id they aim at; neither sees
 * the real playing screen, where the seam's target is whatever App happens to
 * render before END TURN. Before this fix the board swallowed every Tab, so a
 * keyboard-only player could attack but had no key that ended the turn at all.
 *
 * The route asserted here is the whole one: QUIT → RULES → [own territories] →
 * END TURN, and back again.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { createKeyboardController } from '../../src/controller/KeyboardController.js';

let container;
let keyboard;

/** Own territories are [1, 3] — area 2 belongs to the opponent. */
function makeGameState() {
  return {
    phase: 'playing',
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    areas: {
      0: null,
      1: { owner: 0, dice: 3, neighborAreaIds: [2, 3], centerCell: 10 },
      2: { owner: 1, dice: 2, neighborAreaIds: [1, 3], centerCell: 20 },
      3: { owner: 0, dice: 1, neighborAreaIds: [1, 2], centerCell: 30 },
    },
    players: [
      { id: 0, territoryCount: 2, stock: 0, eliminated: false },
      { id: 1, territoryCount: 1, stock: 0, eliminated: false },
    ],
  };
}

function createMockRenderer() {
  return {
    hexGrid: {
      setFocusHighlight: vi.fn(),
      clearFocusHighlight: vi.fn(),
      clearHighlights: vi.fn(),
      _cellPos: { x: new Float64Array(40), y: new Float64Array(40) },
    },
  };
}

function renderPlaying() {
  const store = createGameStore();
  store.setState({
    screen: 'playing',
    animationPhase: 'idle',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: 'selectFrom',
    focusedAreaId: null,
  });
  const controller = {
    openQuitConfirm: vi.fn(),
    closeQuitConfirm: vi.fn(),
    goToTitle: vi.fn(),
    endHumanTurn: vi.fn(),
    openRules: vi.fn(),
    closeRules: vi.fn(),
    handleTerritoryClick: vi.fn(),
    refreshCandidateHighlights: vi.fn(),
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller }), container);
  });
  // The real controller, on the real DOM: the seams are located by document order.
  keyboard = createKeyboardController(store, controller, createMockRenderer());
  return { store, controller };
}

/** Tab as the browser delivers it: from whatever has focus, bubbling to document. */
function tab(shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    (document.activeElement || document).dispatchEvent(event);
  });
  return event;
}

const endTurnBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'END TURN');
const rulesBtn = () => container.querySelector('button[aria-label="Rules: how to play"]');

afterEach(() => {
  if (keyboard) {
    keyboard.destroy();
    keyboard = null;
  }
  if (container) {
    act(() => render(null, container));
    container.remove();
    container = null;
  }
});

describe('App playing-screen tab order (#201)', () => {
  it('places no focus on mount — the board owns the keys (#189 exception)', () => {
    renderPlaying();
    expect(document.activeElement).toBe(document.body);
  });

  it('tabs off the end of the board onto END TURN, which then answers Enter itself', () => {
    const { store } = renderPlaying();

    tab();
    expect(store.getState().focusedAreaId).toBe(1);
    tab();
    expect(store.getState().focusedAreaId).toBe(3);

    // Past the last own territory the board hands DOM focus on.
    tab();
    expect(document.activeElement).toBe(endTurnBtn());
    expect(store.getState().focusedAreaId).toBeNull();

    /*
     * The point of the whole fix: the button gets its own Enter. Claiming it
     * for the board here is what left a keyboard player unable to end a turn.
     */
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.activeElement.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(false);
  });

  it('Shift+Tab walks back from END TURN through the board to RULES', () => {
    const { store } = renderPlaying();

    endTurnBtn().focus();

    // Back onto the board at the far end, DOM focus returned to <body>.
    tab(true);
    expect(document.activeElement).toBe(document.body);
    expect(store.getState().focusedAreaId).toBe(3);

    tab(true);
    expect(store.getState().focusedAreaId).toBe(1);

    // Off the front of the board onto END TURN's neighbor in document order.
    tab(true);
    expect(document.activeElement).toBe(rulesBtn());
    expect(store.getState().focusedAreaId).toBeNull();
  });

  it('Tab from RULES re-enters the board at the first own territory', () => {
    const { store } = renderPlaying();

    rulesBtn().focus();

    const event = tab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect(store.getState().focusedAreaId).toBe(1);
  });
});
