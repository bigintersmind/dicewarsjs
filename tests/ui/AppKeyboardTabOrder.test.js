// @vitest-environment jsdom
/**
 * Playing-screen tab order (#201, #211).
 *
 * BoardFocus.test.js proves the territory buttons are what they claim to be and
 * KeyboardController.test.js proves the controller keeps its hands off Tab;
 * neither sees the real playing screen, where the order is whatever App happens
 * to render. What this file pins is that composed order — settings die → QUIT →
 * RULES → own territories ascending → END TURN — as the browser would walk it,
 * with the settings dropdown open as well as closed, because an open dropdown
 * adds a dozen real focusables and all of them sit before QUIT.
 *
 * Before #201 the board swallowed every Tab, so a keyboard-only player could
 * attack but had no key that ended the turn at all; #211 replaced the virtual
 * walk with real DOM, so the assertions here are about document order and
 * `tabindex` rather than about a handler.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { createPreferencesManager } from '../../src/store/PreferencesManager.js';
import { createKeyboardController } from '../../src/controller/KeyboardController.js';

let container;
let keyboard;
let preferences;
let renderer;

/** Own territories are [1, 3] — area 2 belongs to the opponent. */
function makeGameState(overrides = {}) {
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
    ...overrides,
  };
}

function createMockRenderer() {
  return {
    hexGrid: {
      setFocusHighlight: vi.fn(),
      clearFocusHighlight: vi.fn(),
      clearHighlights: vi.fn(),
      clearSelectionHighlights: vi.fn(),
      _cellPos: { x: new Float64Array(40), y: new Float64Array(40) },
    },
  };
}

function renderPlaying(stateOverrides = {}) {
  const store = createGameStore();
  store.setState({
    screen: 'playing',
    animationPhase: 'idle',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    playerNames: ['You', 'Blitz'],
    awaitingInput: 'selectFrom',
    focusedAreaId: null,
    ...stateOverrides,
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
  /* The production scope, and the id the page's own CSS targets. */
  container.id = 'app';
  document.body.appendChild(container);
  /* A real one, so the settings die renders and the dropdown really opens. */
  preferences = createPreferencesManager();
  act(() => {
    render(h(App, { store, controller, preferencesManager: preferences }), container);
  });
  // The real controller, on the real DOM.
  renderer = createMockRenderer();
  keyboard = createKeyboardController(store, controller, renderer);
  return { store, controller };
}

/** Tab as the browser delivers it: from whatever has focus, bubbling to document. */
function press(key, opts = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  act(() => {
    (document.activeElement || document).dispatchEvent(event);
  });
  return event;
}

/**
 * How each tab stop is named in the assertions below: its id when it has one
 * (the territory buttons), otherwise its accessible name, otherwise its text.
 * Naming them rather than counting them is the point — a count passes while the
 * order is wrong.
 */
function tabStopName(el) {
  return el.id || el.getAttribute('aria-label') || el.textContent.trim();
}

/**
 * The page's tab stops inside #app, in document order — the browser's own walk,
 * approximated closely enough for this DOM: nothing here is a hidden input, a
 * <summary>, or contenteditable, and the HUD's centering twins are
 * non-focusable <span>s.
 */
function tabStops() {
  return [...container.querySelectorAll('a[href], button, [tabindex]')]
    .filter(el => el.tabIndex >= 0 && !el.disabled)
    .map(tabStopName);
}

const endTurnBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'END TURN');
const rulesBtn = () => container.querySelector('button[aria-label="Rules: how to play"]');
const settingsBtn = () => container.querySelector('button[aria-label="Settings"]');
const keepPlayingBtn = () =>
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'KEEP PLAYING');
const areaButton = id => container.querySelector(`#dw-area-${id}`);

beforeEach(() => {
  localStorage.clear();
  /*
   * This jsdom has no matchMedia, and PreferencesManager logs (harmlessly) when
   * it cannot read the system motion preference. Stub it so a real manager can
   * be used here without a stack trace per test.
   */
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

afterEach(() => {
  if (keyboard) {
    keyboard.destroy();
    keyboard = null;
  }
  document.activeElement?.blur?.();
  if (container) {
    act(() => render(null, container));
    container.remove();
    container = null;
  }
  if (preferences) {
    preferences.destroy();
    preferences = null;
  }
  renderer = null;
});

describe('App playing-screen tab order (#211)', () => {
  it('places no focus on mount — the board owns the keys (#189 exception)', () => {
    renderPlaying();
    expect(document.activeElement).toBe(document.body);
  });

  it('walks settings die → QUIT → RULES → own territories → END TURN', () => {
    renderPlaying();
    expect(tabStops()).toEqual([
      'Settings',
      'Quit to title',
      'Rules: how to play',
      'dw-area-1',
      'dw-area-3',
      'END TURN',
    ]);
  });

  // Reachable by the arrows, never by Tab: an enemy territory is a target, not
  // a place the player steps through on the way to ending the turn.
  it("leaves the opponent's territory out of the walk", () => {
    renderPlaying();
    expect(areaButton(2).getAttribute('tabindex')).toBe('-1');
    expect(tabStops()).not.toContain('dw-area-2');
  });

  it('still enters the board from RULES with the settings dropdown open', () => {
    renderPlaying();

    act(() => settingsBtn().click());
    // The dropdown really is contributing extra focusables to the walk.
    expect(container.querySelectorAll('a[href]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('button').length).toBeGreaterThan(6);

    // All of them sit before QUIT, so RULES is still what precedes the board.
    const stops = tabStops();
    expect(stops[stops.indexOf('dw-area-1') - 1]).toBe('Rules: how to play');
  });

  it('writes the ring when the browser tabs onto a territory', () => {
    const { store } = renderPlaying();

    // What Tab does: DOM focus moves, and nothing else is involved.
    act(() => areaButton(3).focus());

    expect(store.getState().focusedAreaId).toBe(3);
    expect(renderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(3);
  });

  it('takes the ring down when a control is clicked into focus', () => {
    const { store } = renderPlaying();

    act(() => areaButton(1).focus());
    expect(store.getState().focusedAreaId).toBe(1);

    // What a mouse click on RULES does.
    act(() => rulesBtn().focus());

    expect(store.getState().focusedAreaId).toBeNull();
    expect(renderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
  });

  it('leaves Tab off the last own territory to the browser — END TURN is next in document order', () => {
    renderPlaying();

    act(() => areaButton(3).focus());
    const event = press('Tab');

    /*
     * jsdom does not move focus on Tab, so what is asserted is that nothing
     * claimed the key: the browser's own walk from dw-area-3 lands on END TURN
     * because that is the next tab stop in the list above.
     */
    expect(event.defaultPrevented).toBe(false);
    const stops = tabStops();
    expect(stops[stops.indexOf('dw-area-3') + 1]).toBe('END TURN');
  });

  it('leaves Enter on END TURN to the button itself', () => {
    const { controller } = renderPlaying();

    endTurnBtn().focus();

    /*
     * The point of the whole fix: the board no longer claims the key, so the
     * browser's own activation can run. Claiming it for the board is what left a
     * keyboard player unable to end a turn — and it would have fired an attack
     * instead, which is why handleTerritoryClick is asserted silent.
     */
    const enter = press('Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(controller.handleTerritoryClick).not.toHaveBeenCalled();

    /*
     * jsdom does not synthesize a click from a keydown, so the activation the
     * browser would run is spelled out here: it is this button's onClick that
     * ends the turn.
     */
    act(() => endTurnBtn().click());
    expect(controller.endHumanTurn).toHaveBeenCalledTimes(1);
  });

  it('activates a focused territory the same way a board click does', () => {
    const { controller } = renderPlaying();

    act(() => areaButton(1).focus());
    const enter = press('Enter');

    expect(enter.defaultPrevented).toBe(false);
    act(() => areaButton(1).click());
    expect(controller.handleTerritoryClick).toHaveBeenCalledWith(1);
  });

  it('E ends the turn straight from the board', () => {
    const { controller } = renderPlaying();

    act(() => areaButton(1).focus());
    const event = press('e');

    expect(controller.endHumanTurn).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('E ends the turn from END TURN itself — the key its aria-keyshortcuts announces', () => {
    const { controller } = renderPlaying();

    endTurnBtn().focus();
    expect(document.activeElement).toBe(endTurnBtn());

    const event = press('e');

    expect(controller.endHumanTurn).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  // Nothing on the board to do and nothing to end, so Tab skips it entirely —
  // the buttons stay mounted at tabindex -1 rather than vanishing under focus.
  it('offers no board tab stop and no END TURN on an AI turn', () => {
    renderPlaying({ gameState: makeGameState({ currentPlayerIndex: 1 }) });

    expect(tabStops()).toEqual(['Settings', 'Quit to title', 'Rules: how to play']);
    expect(endTurnBtn()).toBeUndefined();
    expect(areaButton(1)).toBeTruthy();
  });

  /*
   * The dialog restores focus to whatever opened it. Opened from the keyboard
   * with focus on a territory, that is the territory button — which is the
   * whole point of the board being real DOM: before #211 focus came back to
   * `<body>` with the ring gone.
   */
  it('gives the board its focus and its ring back when the quit dialog closes', () => {
    const { store } = renderPlaying();

    act(() => areaButton(1).focus());
    expect(store.getState().focusedAreaId).toBe(1);

    act(() => store.setState({ quitConfirmOpen: true }));
    expect(document.activeElement).toBe(keepPlayingBtn());
    expect(store.getState().focusedAreaId).toBeNull();

    act(() => store.setState({ quitConfirmOpen: false }));
    expect(document.activeElement).toBe(areaButton(1));
    expect(store.getState().focusedAreaId).toBe(1);
  });

  /*
   * The same round trip through the other modal, and the one App really mounts:
   * RulesModal restores focus to whatever opened the card, falling back to the
   * first control still on screen when that element is gone — a path the quit
   * dialog above never takes.
   */
  it('gives the board its focus and its ring back when the rules card closes', () => {
    const { store } = renderPlaying();

    act(() => areaButton(1).focus());
    expect(store.getState().focusedAreaId).toBe(1);

    act(() => store.setState({ rulesOpen: true }));
    expect(document.activeElement).not.toBe(areaButton(1));
    expect(store.getState().focusedAreaId).toBeNull();

    act(() => store.setState({ rulesOpen: false }));
    expect(document.activeElement).toBe(areaButton(1));
    expect(store.getState().focusedAreaId).toBe(1);
  });

  /*
   * Game over unmounts the playing screen and the board buttons with it. That
   * removal fires no focusout in jsdom (nor in Firefox), so the id is nulled by
   * the controller's own setState rather than by a listener — and the focus
   * GameOverScreen then puts on BATTLE must not write it back.
   */
  it('drops the board buttons when the game ends', () => {
    const { store } = renderPlaying();

    act(() => areaButton(1).focus());
    expect(store.getState().focusedAreaId).toBe(1);

    // What triggerGameOver's setState does at that seam.
    act(() => store.setState({ screen: 'gameOver', focusedAreaId: null }));

    expect(areaButton(1)).toBeNull();
    // GameOverScreen has claimed focus for BATTLE by now (#189), and that
    // focusin went past the controller without resurrecting the dead id.
    expect(document.activeElement.textContent.trim()).toBe('BATTLE');
    expect(store.getState().focusedAreaId).toBeNull();
  });
});
