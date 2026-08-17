// @vitest-environment jsdom
/**
 * Escape layering: KeyboardController vs QuitConfirm (#181).
 *
 * One key, two owners. KeyboardController listens on `document` and claims
 * Escape — preventDefault() — only when it actually cancelled a half-made
 * attack; QuitConfirm listens on `window`, therefore later in the bubble path,
 * and skips an Escape someone else already claimed. Each side is unit-tested
 * against a synthetic event, which proves the halves but not the join: the
 * contract is a single real keypress doing exactly one thing. So mount both
 * against one store and press Escape for real.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { QuitConfirm } from '../../src/ui/QuitConfirm.jsx';
import { createKeyboardController } from '../../src/controller/KeyboardController.js';
import { createGameStore } from '../../src/store/GameStore.js';

let container;
let kbc;

function makeGameState() {
  return {
    phase: 'playing',
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    areas: {
      0: null,
      1: { owner: 0, dice: 3, neighborAreaIds: [2], centerCell: 10 },
      2: { owner: 1, dice: 2, neighborAreaIds: [1], centerCell: 20 },
    },
    players: [
      { id: 0, territoryCount: 1 },
      { id: 1, territoryCount: 1 },
    ],
  };
}

/** Both Escape owners on one store, exactly as App and main.jsx wire them. */
function mountBoth(overrides = {}) {
  const store = createGameStore();
  store.setState({
    screen: 'playing',
    animationPhase: 'idle',
    humanPlayerIndex: 0,
    gameState: makeGameState(),
    awaitingInput: 'selectFrom',
    selectedFrom: null,
    ...overrides,
  });

  const renderer = { hexGrid: { clearHighlights: vi.fn(), setFocusHighlight: vi.fn() } };
  const controller = { handleTerritoryClick: vi.fn() };
  kbc = createKeyboardController(store, controller, renderer);

  const onOpen = vi.fn(() => store.setState({ quitConfirmOpen: true }));
  const onCancel = vi.fn(() => store.setState({ quitConfirmOpen: false }));
  const onConfirm = vi.fn();

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(QuitConfirm, { store, onOpen, onCancel, onConfirm }), container);
  });

  return { store, renderer, onOpen, onCancel, onConfirm };
}

/** Escape as the browser delivers it: on document, bubbling and cancelable. */
function pressEscape() {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  if (kbc) {
    kbc.destroy();
    kbc = null;
  }
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('Escape layering between the board and the quit confirm', () => {
  it('cancels a half-made attack and leaves the dialog closed', () => {
    const { store, renderer, onOpen } = mountBoth({
      awaitingInput: 'selectTo',
      selectedFrom: 1,
    });

    const event = pressEscape();

    // KeyboardController took the key...
    expect(store.getState().awaitingInput).toBe('selectFrom');
    expect(store.getState().selectedFrom).toBeNull();
    expect(renderer.hexGrid.clearHighlights).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    // ...so the same press must not also raise "Abandon this game?".
    expect(onOpen).not.toHaveBeenCalled();
    expect(store.getState().quitConfirmOpen).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('raises the dialog when there is no selection to cancel', () => {
    const { store, onOpen } = mountBoth({ awaitingInput: 'selectFrom' });

    const event = pressEscape();

    expect(event.defaultPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(store.getState().quitConfirmOpen).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });
});
