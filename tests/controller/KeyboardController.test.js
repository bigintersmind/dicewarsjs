// @vitest-environment jsdom
/**
 * KeyboardController tests
 *
 * What the controller still owns now that the board is real DOM (#211): the
 * arrow keys, E, Escape, and the two focus listeners that mirror DOM focus into
 * `store.focusedAreaId` and the renderer's ring. Tab and Enter/Space are the
 * browser's and are asserted here only to prove the controller keeps its hands
 * off them.
 *
 * The real `BoardFocus` is mounted for every test rather than a hand-built
 * stand-in, because the contract between the two files — the `dw-area-N` ids,
 * which territories exist as buttons, the click that reaches
 * handleTerritoryClick — is the thing under test.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { createKeyboardController } from '../../src/controller/KeyboardController.js';
import { BoardFocus } from '../../src/ui/BoardFocus.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Own territories are [1, 3, 4] — area 2 is the opponent's, which is what makes
 * an arrow step onto a territory the player cannot Tab to. Area 4 has no
 * neighbors at all: it is the one arrow branch nothing else reaches, where the
 * key is claimed and there is nowhere to go.
 */
function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    grid: { width: 28, height: 32, cellCount: 896 },
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    history: [],
    areas: {
      0: null,
      1: { owner: 0, dice: 3, neighborAreaIds: [2, 3], centerCell: 10 },
      2: { owner: 1, dice: 2, neighborAreaIds: [1, 3], centerCell: 20 },
      3: { owner: 0, dice: 1, neighborAreaIds: [1, 2], centerCell: 30 },
      4: { owner: 0, dice: 2, neighborAreaIds: [], centerCell: 35 },
    },
    players: [
      { id: 0, alive: true, territoryCount: 3 },
      { id: 1, alive: true, territoryCount: 1 },
    ],
    ...overrides,
  };
}

function createMockRenderer() {
  /*
   * cellPos places areas at distinct positions for directional testing:
   *  area 1 (cell 10) at (50, 50)  — center
   *  area 2 (cell 20) at (150, 50) — to the right
   *  area 3 (cell 30) at (50, 150) — below
   */
  const x = new Float64Array(40);
  const y = new Float64Array(40);
  x[10] = 37;
  y[10] = 41; // center = (37+13, 41+9) = (50, 50)
  x[20] = 137;
  y[20] = 41; // center = (137+13, 41+9) = (150, 50)
  x[30] = 37;
  y[30] = 141; // center = (37+13, 141+9) = (50, 150)

  return {
    hexGrid: {
      setFocusHighlight: vi.fn(),
      clearFocusHighlight: vi.fn(),
      clearHighlights: vi.fn(),
      clearSelectionHighlights: vi.fn(),
      _cellPos: { x, y },
      _getPlayerColor: vi.fn(() => 0xffffff),
    },
  };
}

function createMockController() {
  return {
    handleTerritoryClick: vi.fn(),
    refreshCandidateHighlights: vi.fn(),
    endHumanTurn: vi.fn(),
  };
}

/** A key as the browser delivers it: from whatever has focus, bubbling to document. */
function fireKey(key, opts = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  (document.activeElement || document).dispatchEvent(event);
  return event;
}

/** The board's territory buttons, by area id. */
const areaButton = id => document.getElementById(`dw-area-${id}`);

let boardContainer;
let mountedControls = [];

/** A real control on the page, for "focus is not on the board" cases. */
function mountButton(label) {
  const button = document.createElement('button');
  button.textContent = label;
  document.body.appendChild(button);
  mountedControls.push(button);
  return button;
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('KeyboardController', () => {
  let store, mockRenderer, mockController, kbc;

  beforeEach(() => {
    store = createGameStore();
    mockRenderer = createMockRenderer();
    mockController = createMockController();

    store.setState({
      screen: 'playing',
      animationPhase: 'idle',
      humanPlayerIndex: 0,
      gameState: makeGameState(),
      playerNames: ['You', 'Blitz'],
      awaitingInput: 'selectFrom',
      focusedAreaId: null,
    });

    boardContainer = document.createElement('div');
    document.body.appendChild(boardContainer);
    act(() => {
      render(
        h(BoardFocus, { store, onSelect: id => mockController.handleTerritoryClick(id) }),
        boardContainer
      );
    });

    kbc = createKeyboardController(store, mockController, mockRenderer);
  });

  afterEach(() => {
    kbc.destroy();
    // Blur first: removing a focused element drops focus with no event at all,
    // which would leak this test's focus into the next one.
    document.activeElement?.blur?.();
    act(() => render(null, boardContainer));
    boardContainer.remove();
    mountedControls.forEach(element => element.remove());
    mountedControls = [];
  });

  /*
   * -----------------------------------------------------------------------
   * Guard conditions
   * -----------------------------------------------------------------------
   */

  describe('guard conditions', () => {
    /** Every bail-out leaves the key uncancelled and the ring where it was. */
    function expectBoardKeysIgnored() {
      store.setState({ focusedAreaId: 1 });
      mockRenderer.hexGrid.setFocusHighlight.mockClear();

      for (const key of ['ArrowRight', 'ArrowDown', 'Escape']) {
        expect(fireKey(key).defaultPrevented).toBe(false);
      }

      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    }

    it('ignores keydown when screen is not playing', () => {
      store.setState({ screen: 'title' });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectBoardKeysIgnored();
    });

    it('ignores keydown when animationPhase is not idle', () => {
      store.setState({ animationPhase: 'battle' });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectBoardKeysIgnored();
    });

    it('ignores keydown when humanPlayerIndex is null', () => {
      store.setState({ humanPlayerIndex: null });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectBoardKeysIgnored();
    });

    it('ignores keydown when it is not the human turn', () => {
      store.setState({
        gameState: makeGameState({ currentPlayerIndex: 1 }),
      });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectBoardKeysIgnored();
    });

    it('ignores keydown when gameState is null', () => {
      store.setState({ gameState: null });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectBoardKeysIgnored();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Arrow key navigation
   * -----------------------------------------------------------------------
   * The arrows move DOM focus; the focusin listener is what writes the store
   * and paints the ring, so every assertion here is on all three at once.
   */

  describe('arrow key navigation', () => {
    it('enters the board at the first own territory when focus is nowhere', () => {
      expect(document.activeElement).toBe(document.body);

      const event = fireKey('ArrowRight');

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(areaButton(1));
      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(1);
    });

    /*
     * The default fixture's area 1 is both the first live area and the human's,
     * so "the first area with an owner" would pass it. Here the board opens
     * with the opponent's.
     */
    it('enters at the first territory the human owns, not the first on the board', () => {
      act(() =>
        store.setState({
          gameState: makeGameState({
            areas: {
              0: null,
              1: { owner: 1, dice: 2, neighborAreaIds: [3], centerCell: 20 },
              3: { owner: 0, dice: 1, neighborAreaIds: [1], centerCell: 30 },
            },
          }),
        })
      );

      fireKey('ArrowRight');

      expect(document.activeElement).toBe(areaButton(3));
      expect(store.getState().focusedAreaId).toBe(3);
    });

    /*
     * ...and "live" has to mean what BoardFocus means by it. A dense `Area[]`
     * carries truthy `size: 0` sentinels in its unused slots; one of those with
     * an owner on it would be entered at, and there is no button to focus.
     */
    it('enters at the first territory that actually has a button', () => {
      act(() =>
        store.setState({
          gameState: makeGameState({
            areas: [
              { id: 0, size: 0, owner: -1, dice: 0, neighborAreaIds: [] },
              { id: 1, size: 0, owner: 0, dice: 0, neighborAreaIds: [] },
              { id: 2, size: 4, owner: 0, dice: 3, neighborAreaIds: [], centerCell: 10 },
            ],
          }),
        })
      );

      fireKey('ArrowRight');

      expect(areaButton(1)).toBeNull();
      expect(document.activeElement).toBe(areaButton(2));
      expect(store.getState().focusedAreaId).toBe(2);
    });

    it('moves focus right to the nearest neighbor', () => {
      // Area 1 is the center of the fixture geometry; area 2 is the opponent's,
      // to its right — tabindex -1, so arrow-reachable but not a Tab stop.
      areaButton(1).focus();

      fireKey('ArrowRight');

      expect(document.activeElement).toBe(areaButton(2));
      expect(store.getState().focusedAreaId).toBe(2);
    });

    it('moves focus down to the nearest neighbor', () => {
      areaButton(1).focus();

      fireKey('ArrowDown');

      expect(document.activeElement).toBe(areaButton(3));
      expect(store.getState().focusedAreaId).toBe(3);
    });

    /*
     * On a real control the arrows are the browser's — scrolling, a select, a
     * radio group. Claiming them from a `document` listener would break every
     * one of those.
     */
    it('leaves the arrows to a focused control', () => {
      const quit = mountButton('QUIT');
      quit.focus();

      const event = fireKey('ArrowRight');

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(quit);
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('warns once and does not move when the renderer has no cellPos', () => {
      kbc.destroy();
      const noCellPos = {
        hexGrid: {
          setFocusHighlight: vi.fn(),
          clearFocusHighlight: vi.fn(),
          clearSelectionHighlights: vi.fn(),
          _cellPos: null,
        },
      };
      kbc = createKeyboardController(store, mockController, noCellPos);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      areaButton(1).focus();
      fireKey('ArrowRight');
      fireKey('ArrowDown');

      expect(document.activeElement).toBe(areaButton(1));
      expect(store.getState().focusedAreaId).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cellPos'));
      warnSpy.mockRestore();
    });

    /*
     * The id contract with BoardFocus, broken: a missing button means the
     * component is not mounted (or an ErrorBoundary is showing its fallback),
     * which is never transient — so it is reported once, not per keypress, and
     * focus is left exactly where it was rather than dropped.
     */
    it('warns once and stays put when a neighbor has no button', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      areaButton(1).focus();
      areaButton(2).remove();

      fireKey('ArrowRight');
      fireKey('ArrowRight');

      expect(document.activeElement).toBe(areaButton(1));
      expect(store.getState().focusedAreaId).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('territory 2'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BoardFocus'));
      warnSpy.mockRestore();
    });

    /*
     * A territory with nothing next to it. The key is claimed the moment focus
     * is on the board, so it is swallowed rather than left to scroll the page —
     * and focus stays where it was instead of being dropped somewhere else.
     */
    it('swallows the arrow on a territory with no neighbors', () => {
      areaButton(4).focus();

      const event = fireKey('ArrowRight');

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(areaButton(4));
      expect(store.getState().focusedAreaId).toBe(4);
    });

    /*
     * What a click on the canvas does to the keyboard: mousedown's focus fixup
     * blurs the focused button to `<body>`, so the next arrow re-enters the
     * board from the start rather than resuming at area 3. This is the
     * documented behaviour, not the desired one — resuming at the clicked
     * territory is a #211 follow-up.
     */
    it('re-enters at the first own territory after a click blurs the board', () => {
      areaButton(3).focus();
      areaButton(3).blur();

      fireKey('ArrowRight');

      expect(document.activeElement).toBe(areaButton(1));
      expect(store.getState().focusedAreaId).toBe(1);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Activation is the button's own (#211)
   * -----------------------------------------------------------------------
   */

  describe('Enter and Space', () => {
    it.each([
      ['Enter', 1],
      [' ', 3],
    ])('leaves %s to the focused territory button', (key, areaId) => {
      areaButton(areaId).focus();

      const event = fireKey(key);

      // Claiming it here would swallow the browser's activation and fire the
      // attack twice over.
      expect(event.defaultPrevented).toBe(false);
      expect(mockController.handleTerritoryClick).not.toHaveBeenCalled();

      /*
       * jsdom does not synthesize a click from a keydown, so the activation the
       * browser would run is spelled out here: it is the button's own onClick
       * that reaches the controller, the same entry point as a board click —
       * reporting the territory that was actually activated, which is why the
       * two rows use different ones.
       */
      act(() => areaButton(areaId).click());
      expect(mockController.handleTerritoryClick).toHaveBeenCalledWith(areaId);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Tab belongs to the browser (#211)
   * -----------------------------------------------------------------------
   * The territory buttons are real tab stops in document order, so there is
   * nothing left to intercept. Pinned in both directions from all three places
   * focus can be, because a `document` keydown listener that claimed Tab would
   * strand a keyboard player exactly as #201 did.
   */

  describe('Tab', () => {
    function expectTabUntouched() {
      const before = store.getState().focusedAreaId;
      for (const shiftKey of [false, true]) {
        expect(fireKey('Tab', { shiftKey }).defaultPrevented).toBe(false);
      }
      expect(store.getState().focusedAreaId).toBe(before);
    }

    it('is untouched from an unfocused page', () => {
      expectTabUntouched();
    });

    it('is untouched from a territory button', () => {
      areaButton(1).focus();
      expectTabUntouched();
      expect(document.activeElement).toBe(areaButton(1));
    });

    it('is untouched from a control', () => {
      const endTurn = mountButton('END TURN');
      endTurn.focus();
      expectTabUntouched();
      expect(document.activeElement).toBe(endTurn);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * End turn key (#201)
   * -----------------------------------------------------------------------
   * Tab reaches END TURN one territory at a time — one press per territory;
   * E is the shortcut. Unlike the rest of the board keys it also
   * fires from a focused button or link — END TURN advertises it through
   * aria-keyshortcuts — and only a text-entry control keeps the letter.
   */

  describe('end turn key', () => {
    it('E ends the turn from the board', () => {
      const event = fireKey('e');
      expect(mockController.endHumanTurn).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('takes the shifted capital too', () => {
      const event = fireKey('E', { shiftKey: true });
      expect(mockController.endHumanTurn).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('E ends the turn from a focused control too — END TURN announces the key itself', () => {
      const endTurn = mountButton('END TURN');
      endTurn.focus();

      const event = fireKey('e');

      expect(mockController.endHumanTurn).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('E ends the turn from a focused territory button', () => {
      areaButton(1).focus();

      const event = fireKey('e');

      expect(mockController.endHumanTurn).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves E to a text-entry control', () => {
      for (const tag of ['input', 'select', 'textarea']) {
        const field = document.createElement(tag);
        document.body.appendChild(field);
        mountedControls.push(field);
        field.focus();
        expect(document.activeElement).toBe(field);

        const event = fireKey('e');
        expect(event.defaultPrevented).toBe(false);
      }
      expect(mockController.endHumanTurn).not.toHaveBeenCalled();
    });

    it('leaves the browser its own modifier combinations', () => {
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
        const event = fireKey('e', { [modifier]: true });
        expect(event.defaultPrevented).toBe(false);
      }
      expect(mockController.endHumanTurn).not.toHaveBeenCalled();
    });

    it('does nothing behind the quit confirm or the how to play card', () => {
      store.setState({ quitConfirmOpen: true });
      fireKey('e');
      store.setState({ quitConfirmOpen: false, rulesOpen: true });
      fireKey('e');
      expect(mockController.endHumanTurn).not.toHaveBeenCalled();
    });

    it('does nothing on an AI turn', () => {
      store.setState({ gameState: makeGameState({ currentPlayerIndex: 1 }) });
      fireKey('e');
      expect(mockController.endHumanTurn).not.toHaveBeenCalled();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Escape (cancel selection)
   * -----------------------------------------------------------------------
   */

  describe('cancel selection', () => {
    it('transitions from selectTo back to selectFrom', () => {
      store.setState({
        awaitingInput: 'selectTo',
        selectedFrom: 1,
      });

      // What the controller would see if it recomputed the hints right now.
      let awaitingAtRefresh;
      mockController.refreshCandidateHighlights.mockImplementation(() => {
        awaitingAtRefresh = store.getState().awaitingInput;
      });

      const event = fireKey('Escape');

      expect(store.getState().awaitingInput).toBe('selectFrom');
      expect(store.getState().selectedFrom).toBeNull();
      expect(mockRenderer.hexGrid.clearSelectionHighlights).toHaveBeenCalled();
      /*
       * clearSelectionHighlights() wipes the board hints along with the
       * selection, and this lands back on selectFrom — so the controller (which
       * owns that mapping) has to be asked to repaint the attack candidates, or
       * the board silently stops offering them for the rest of the turn.
       */
      expect(mockController.refreshCandidateHighlights).toHaveBeenCalled();
      /*
       * ...and in that order. Refreshing first and clearing second wipes the
       * hints it just painted, which no assertion on "was it called" can see.
       */
      expect(
        mockRenderer.hexGrid.clearSelectionHighlights.mock.invocationCallOrder[0]
      ).toBeLessThan(mockController.refreshCandidateHighlights.mock.invocationCallOrder[0]);
      /*
       * The store has to be back on selectFrom before the refresh runs, too:
       * recomputing against a stale 'selectTo' would repaint the old source's
       * reachable enemies as if they were the attack candidates.
       */
      expect(awaitingAtRefresh).toBe('selectFrom');
      // Claimed: the quit confirm must not also open on this keypress (#181).
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves the focus layer alone — cancelling a selection never took the ring down', () => {
      areaButton(3).focus();
      store.setState({ awaitingInput: 'selectTo', selectedFrom: 1 });
      // Past the focusin paint, so this asserts only what the Escape did.
      mockRenderer.hexGrid.setFocusHighlight.mockClear();

      fireKey('Escape');

      /*
       * The selection was cancelled; DOM focus was not, and it is still on the
       * button for area 3. Before #211 item 3 this ran clearHighlights() and
       * then repainted the ring from the store id; now the clear never reaches
       * that layer, so there is nothing to put back — and "nothing happened to
       * the ring" is the assertion, not "it was painted again".
       */
      expect(document.activeElement).toBe(areaButton(3));
      expect(store.getState().focusedAreaId).toBe(3);
      expect(mockRenderer.hexGrid.clearSelectionHighlights).toHaveBeenCalled();
      expect(mockRenderer.hexGrid.clearHighlights).not.toHaveBeenCalled();
      expect(mockRenderer.hexGrid.clearFocusHighlight).not.toHaveBeenCalled();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    });

    it('does nothing when already in selectFrom', () => {
      store.setState({ awaitingInput: 'selectFrom' });
      const event = fireKey('Escape');
      // Should still be selectFrom, and nothing on the board was cleared
      expect(store.getState().awaitingInput).toBe('selectFrom');
      expect(mockRenderer.hexGrid.clearSelectionHighlights).not.toHaveBeenCalled();
      expect(mockRenderer.hexGrid.clearHighlights).not.toHaveBeenCalled();
      // Left uncancelled so QuitConfirm's window-level handler can act (#181).
      expect(event.defaultPrevented).toBe(false);
    });

    it('still cancels a half-made attack from a focused control', () => {
      const endTurn = mountButton('END TURN');
      endTurn.focus();
      store.setState({ awaitingInput: 'selectTo', selectedFrom: 1 });

      const event = fireKey('Escape');

      expect(store.getState().awaitingInput).toBe('selectFrom');
      expect(store.getState().selectedFrom).toBeNull();
      expect(event.defaultPrevented).toBe(true);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Quit confirm (#181)
   * -----------------------------------------------------------------------
   */

  describe('quit confirm', () => {
    beforeEach(() => {
      store.setState({ quitConfirmOpen: true });
    });

    it('suspends board navigation while the dialog is open', () => {
      const event = fireKey('ArrowRight');
      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(document.activeElement).toBe(document.body);
    });

    it('leaves Escape alone so the dialog can close itself', () => {
      store.setState({ awaitingInput: 'selectTo', selectedFrom: 1 });

      const event = fireKey('Escape');

      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Rules card
   * -----------------------------------------------------------------------
   * Same contract as the quit confirm: a modal over the board takes every key,
   * and Escape passes through untouched for the card's own handler to close it.
   */

  describe('how to play card', () => {
    beforeEach(() => {
      store.setState({ rulesOpen: true });
    });

    it('suspends board navigation while the card is open', () => {
      const event = fireKey('ArrowRight');
      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(document.activeElement).toBe(document.body);
    });

    it('leaves Escape alone so the card can close itself', () => {
      store.setState({ awaitingInput: 'selectTo', selectedFrom: 1 });

      const event = fireKey('Escape');

      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });
  });

  /*
   * -----------------------------------------------------------------------
   * The ring mirrors DOM focus (#211)
   * -----------------------------------------------------------------------
   * Everything that can move focus ends in one of these two listeners: the
   * browser's Tab walk, a click, the arrow handler's own focus() call, a dialog
   * restoring focus on close, a blur. So the ring cannot point at a territory
   * the keys are not on.
   */

  describe('focus listeners', () => {
    it('writes the id and paints the ring when a territory button takes focus', () => {
      areaButton(3).focus();

      expect(store.getState().focusedAreaId).toBe(3);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(3);
    });

    it('clears the ring when a real control takes focus', () => {
      const quit = mountButton('QUIT');
      areaButton(1).focus();

      quit.focus();

      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
    });

    /*
     * Button → button must not blink through "no ring": the focusout fires
     * before the focusin, so clearing on it would take the ring down and put it
     * straight back up.
     */
    it('never clears the ring on a step from one territory to the next', () => {
      areaButton(1).focus();
      mockRenderer.hexGrid.clearFocusHighlight.mockClear();

      areaButton(3).focus();

      expect(mockRenderer.hexGrid.clearFocusHighlight).not.toHaveBeenCalled();
      expect(store.getState().focusedAreaId).toBe(3);
    });

    /*
     * The focusout half's own job: a blur, a click on the canvas, or the window
     * losing focus moves focus to nothing at all, and there is no focusin to
     * catch. It comes back on focusin when the window returns.
     */
    it('clears the ring when a territory button is blurred to nothing', () => {
      areaButton(1).focus();

      areaButton(1).blur();

      expect(document.activeElement).toBe(document.body);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
    });

    it('does not write to the store when there is no ring to clear', () => {
      const quit = mountButton('QUIT');
      const subscriber = vi.fn();
      const unsubscribe = store.subscribe(subscriber);

      quit.focus();

      // Every setState notifies every subscriber; a no-op clear would re-render
      // the whole UI on every click of every button on the screen.
      expect(subscriber).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('ignores focus on a territory button off the playing screen', () => {
      store.setState({ screen: 'gameOver' });

      areaButton(1).focus();

      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    });

    /*
     * The prefix is not the contract, the suffix is: an id that merely starts
     * with `dw-area-` is some other element. Read as a territory it would write
     * NaN (or area 0) into the store, paint the ring on nothing, and hand that
     * decoy the arrow keys.
     */
    it.each(['dw-area-hint', 'dw-area-0', 'dw-area-01'])('does not read #%s as a territory', id => {
      const decoy = mountButton('decoy');
      decoy.id = id;

      decoy.focus();

      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
      // And the arrows stay the browser's on it, as on any other control.
      expect(fireKey('ArrowRight').defaultPrevented).toBe(false);
    });

    /*
     * The window losing focus takes the ring down through focusout; getting it
     * back has to put the same ring up again, so nothing may latch on the way
     * out.
     */
    it('paints the ring again when focus comes back to the territory it left', () => {
      areaButton(1).focus();
      areaButton(1).blur();
      mockRenderer.hexGrid.setFocusHighlight.mockClear();

      areaButton(1).focus();

      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(1);
    });

    it('stops mirroring once the controller is destroyed', () => {
      kbc.destroy();

      areaButton(1).focus();

      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    });

    // The other half of the same teardown: a controller that let go of focusin
    // but kept focusout would go on wiping a ring it no longer paints.
    it('stops taking the ring down once the controller is destroyed', () => {
      areaButton(1).focus();
      kbc.destroy();
      mockRenderer.hexGrid.clearFocusHighlight.mockClear();

      areaButton(1).blur();

      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.clearFocusHighlight).not.toHaveBeenCalled();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Cleanup
   * -----------------------------------------------------------------------
   */

  describe('destroy', () => {
    it('removes the key listener so the board keys have no effect', () => {
      kbc.destroy();

      const event = fireKey('ArrowRight');

      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    });
  });
});
