// @vitest-environment jsdom
/**
 * Escape layering: KeyboardController vs QuitConfirm (#181).
 *
 * One key, three owners. KeyboardController listens on `document` and claims
 * Escape — preventDefault() — only when it actually cancelled a half-made
 * attack; QuitConfirm listens on `window`, therefore later in the bubble path,
 * and skips an Escape someone else already claimed. RulesModal outranks both by
 * listening in the CAPTURE phase, which runs before every bubble listener in
 * the document however the components mounted — and QuitConfirm additionally
 * stands down whenever `rulesOpen` is set. Each side is unit-tested against a
 * synthetic event, which proves the halves but not the join: the contract is a
 * single real keypress doing exactly one thing. So mount them against one store
 * and press Escape for real.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { QuitConfirm } from '../../src/ui/QuitConfirm.jsx';
import { RulesModal } from '../../src/ui/RulesModal.jsx';
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

  const renderer = {
    hexGrid: {
      clearHighlights: vi.fn(),
      clearSelectionHighlights: vi.fn(),
      setFocusHighlight: vi.fn(),
    },
  };
  /*
   * The controller methods KeyboardController calls. Cancelling a half-made
   * attack is the controller's since #211 follow-up 16 — a click on water asks
   * for the same three steps — so this stand-in does what
   * GameController.cancelSelection does: these tests are about which owner
   * claims the key, and for that the store has to move for real. What the real
   * one does to the board is GameController.test.js's to pin.
   */
  const controller = {
    handleTerritoryClick: vi.fn(),
    cancelSelection: vi.fn(() => {
      if (store.getState().awaitingInput !== 'selectTo') return false;
      store.setState({ selectedFrom: null, awaitingInput: 'selectFrom' });
      renderer.hexGrid.clearSelectionHighlights();
      return true;
    }),
  };
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
    expect(renderer.hexGrid.clearSelectionHighlights).toHaveBeenCalled();
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

/*
 * The third owner. The card wins by listening in the capture phase, so mount
 * order genuinely cannot change the outcome — mount them both ways and assert
 * the same thing: the reference card closes, and the game is never asked to
 * quit or to stay.
 */
describe('Escape layering between the quit confirm and the rules card', () => {
  let rulesContainer;
  /** Extra listeners a case installed on `document`, removed after it. */
  let documentListeners = [];

  afterEach(() => {
    for (const handler of documentListeners) {
      document.removeEventListener('keydown', handler);
    }
    documentListeners = [];
    if (rulesContainer) {
      act(() => render(null, rulesContainer));
      if (rulesContainer.parentNode) document.body.removeChild(rulesContainer);
      rulesContainer = null;
    }
  });

  /** Both Escape owners on one store, mounted in the given order. */
  function mountPair(rulesFirst, overrides = {}) {
    const store = createGameStore();
    store.setState({ screen: 'playing', rulesOpen: true, ...overrides });

    const onOpen = vi.fn(() => store.setState({ quitConfirmOpen: true }));
    const onCancel = vi.fn(() => store.setState({ quitConfirmOpen: false }));
    const onClose = vi.fn(() => store.setState({ rulesOpen: false }));

    container = document.createElement('div');
    rulesContainer = document.createElement('div');
    document.body.append(container, rulesContainer);

    const mountRules = () => act(() => render(h(RulesModal, { store, onClose }), rulesContainer));
    const mountQuit = () =>
      act(() => render(h(QuitConfirm, { store, onOpen, onCancel, onConfirm: vi.fn() }), container));

    if (rulesFirst) {
      mountRules();
      mountQuit();
    } else {
      mountQuit();
      mountRules();
    }

    return { store, onOpen, onCancel, onClose };
  }

  for (const rulesFirst of [true, false]) {
    it(`closes the card and never opens the quit confirm (rules ${
      rulesFirst ? 'first' : 'second'
    })`, () => {
      const { store, onOpen, onCancel, onClose } = mountPair(rulesFirst);

      pressEscape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(store.getState().rulesOpen).toBe(false);
      expect(store.getState().quitConfirmOpen).toBe(false);
    });
  }

  it('closes the card without also dismissing the dialog already behind it', () => {
    // QUIT was pressed, then RULES from behind the confirm: both are up, and
    // one Escape must peel off exactly the top one.
    const { store, onOpen, onCancel, onClose } = mountPair(true, { quitConfirmOpen: true });

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(store.getState().rulesOpen).toBe(false);
    expect(store.getState().quitConfirmOpen).toBe(true);
  });

  it('gets the key ahead of a document handler that stops propagation', () => {
    /*
     * The settings dropdown's shape: a `document` listener that swallows Escape
     * so nothing further up the bubble path sees it. Registered first, and on
     * an ancestor of nothing the card contains, it would beat any bubble-phase
     * listener — the card's capture-phase registration is what still wins.
     */
    const swallow = event => {
      if (event.key === 'Escape') event.stopPropagation();
    };
    document.addEventListener('keydown', swallow);
    documentListeners.push(swallow);

    const { store, onClose, onOpen } = mountPair(true);

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(store.getState().rulesOpen).toBe(false);
  });
});
