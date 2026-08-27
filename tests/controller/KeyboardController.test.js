// @vitest-environment jsdom
/**
 * KeyboardController tests
 *
 * Tests keyboard navigation for the hex grid: arrow keys, Enter/Space, Escape,
 * E to end the turn, Tab stepping and the two tab-order seams either side of
 * the board, the focusin rule that keeps the ring honest, and the guards.
 */

import {
  createKeyboardController,
  END_TURN_BUTTON_ID,
} from '../../src/controller/KeyboardController.js';
import { createGameStore } from '../../src/store/GameStore.js';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Own territories are [1, 3, 4] — area 2 is the opponent's. Three of them, so
 * "the next one" and "the last one" are different areas and a stepping bug
 * cannot pass by accident. Area 4 is deliberately neighborless, which keeps it
 * out of the arrow-key geometry entirely.
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

function fireKey(key, opts = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  document.dispatchEvent(event);
  return event;
}

/**
 * The board's neighbors in the page's tab order, as real DOM. The seams are
 * located through the document (getElementById + document order), not through
 * props, so they need actual buttons to aim at.
 */
let mountedControls = [];

function mountButton(id, label) {
  const button = document.createElement('button');
  if (id) button.id = id;
  button.textContent = label;
  document.body.appendChild(button);
  mountedControls.push(button);
  return button;
}

/** The Pixi canvas, made focusable so a test can put DOM focus on it. */
function mountCanvas() {
  const canvas = document.createElement('canvas');
  canvas.id = 'pixi-canvas';
  canvas.tabIndex = 0;
  document.body.appendChild(canvas);
  mountedControls.push(canvas);
  return canvas;
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
      awaitingInput: 'selectFrom',
      focusedAreaId: null,
    });

    kbc = createKeyboardController(store, mockController, mockRenderer);
  });

  afterEach(() => {
    kbc.destroy();
    // Removing the focused element also drops focus back to <body> for the next test.
    mountedControls.forEach(element => element.remove());
    mountedControls = [];
  });

  /*
   * -----------------------------------------------------------------------
   * Guard conditions
   * -----------------------------------------------------------------------
   */

  describe('guard conditions', () => {
    /**
     * Tab is the key that still does something from a focused control, so a
     * guard that only covered the arrows would let it through: every bail-out
     * has to leave Tab to the browser and the ring exactly where it was.
     */
    function expectTabFullyIgnored() {
      store.setState({ focusedAreaId: 1 });
      mockRenderer.hexGrid.clearFocusHighlight.mockClear();

      for (const shiftKey of [false, true]) {
        const event = fireKey('Tab', { shiftKey });
        expect(event.defaultPrevented).toBe(false);
      }

      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.clearFocusHighlight).not.toHaveBeenCalled();
    }

    it('ignores keydown when screen is not playing', () => {
      store.setState({ screen: 'title' });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectTabFullyIgnored();
    });

    it('ignores keydown when animationPhase is not idle', () => {
      store.setState({ animationPhase: 'battle' });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectTabFullyIgnored();
    });

    it('ignores keydown when humanPlayerIndex is null', () => {
      store.setState({ humanPlayerIndex: null });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectTabFullyIgnored();
    });

    it('ignores keydown when it is not the human turn', () => {
      store.setState({
        gameState: makeGameState({ currentPlayerIndex: 1 }),
      });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectTabFullyIgnored();
    });

    it('ignores keydown when gameState is null', () => {
      store.setState({ gameState: null });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expectTabFullyIgnored();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Arrow key navigation
   * -----------------------------------------------------------------------
   */

  describe('arrow key navigation', () => {
    it('focuses first own territory when no focus is set', () => {
      fireKey('ArrowRight');
      // First own territory is area 1 (owner 0)
      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(1);
    });

    it('moves focus right to nearest neighbor', () => {
      // Start focused on area 1 (center), area 2 is to the right
      store.setState({ focusedAreaId: 1 });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBe(2);
    });

    it('moves focus down to nearest neighbor', () => {
      // Start focused on area 1 (center), area 3 is below
      store.setState({ focusedAreaId: 1 });
      fireKey('ArrowDown');
      expect(store.getState().focusedAreaId).toBe(3);
    });

    it('warns and does nothing when renderer has no cellPos', () => {
      kbc.destroy();
      const noRenderer = { hexGrid: { setFocusHighlight: vi.fn(), _cellPos: null } };
      kbc = createKeyboardController(store, mockController, noRenderer);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      store.setState({ focusedAreaId: 1 });
      fireKey('ArrowRight');
      // Should stay on 1 since cellPos is null
      expect(store.getState().focusedAreaId).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cellPos'));
      warnSpy.mockRestore();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Confirm (Enter / Space)
   * -----------------------------------------------------------------------
   */

  describe('confirm action', () => {
    it('Enter calls handleTerritoryClick with focused area', () => {
      store.setState({ focusedAreaId: 1 });
      fireKey('Enter');
      expect(mockController.handleTerritoryClick).toHaveBeenCalledWith(1);
    });

    it('Space calls handleTerritoryClick with focused area', () => {
      store.setState({ focusedAreaId: 3 });
      fireKey(' ');
      expect(mockController.handleTerritoryClick).toHaveBeenCalledWith(3);
    });

    it('does nothing when no area is focused', () => {
      fireKey('Enter');
      expect(mockController.handleTerritoryClick).not.toHaveBeenCalled();
    });
  });

  /*
   * -----------------------------------------------------------------------
   * End turn key (#201)
   * -----------------------------------------------------------------------
   * Tab reaches END TURN one territory at a time, which is 20-odd presses
   * mid-game; E is the shortcut, and it obeys the same focus ownership rule as
   * the rest of the board keys.
   */

  describe('end turn key', () => {
    it('E ends the turn while the board owns focus', () => {
      const event = fireKey('e');
      expect(mockController.endHumanTurn).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('takes the shifted capital too', () => {
      const event = fireKey('E', { shiftKey: true });
      expect(mockController.endHumanTurn).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves E to a focused control', () => {
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.focus();

      const event = fireKey('e');

      expect(mockController.endHumanTurn).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
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
      expect(mockRenderer.hexGrid.clearHighlights).toHaveBeenCalled();
      /*
       * clearHighlights() wipes the board hints along with the selection, and
       * this lands back on selectFrom — so the controller (which owns that
       * mapping) has to be asked to repaint the attack candidates, or the board
       * silently stops offering them for the rest of the turn.
       */
      expect(mockController.refreshCandidateHighlights).toHaveBeenCalled();
      /*
       * ...and in that order. Refreshing first and clearing second wipes the
       * hints it just painted, which no assertion on "was it called" can see.
       */
      expect(mockRenderer.hexGrid.clearHighlights.mock.invocationCallOrder[0]).toBeLessThan(
        mockController.refreshCandidateHighlights.mock.invocationCallOrder[0]
      );
      /*
       * The store has to be back on selectFrom before the refresh runs, too:
       * recomputing against a stale 'selectTo' would repaint the old source's
       * reachable enemies as if they were the attack candidates.
       */
      expect(awaitingAtRefresh).toBe('selectFrom');
      // Claimed: the quit confirm must not also open on this keypress (#181).
      expect(event.defaultPrevented).toBe(true);
    });

    it('repaints the focus ring that clearHighlights took down with the selection', () => {
      store.setState({ awaitingInput: 'selectTo', selectedFrom: 1, focusedAreaId: 3 });

      fireKey('Escape');

      /*
       * The selection was cancelled; the keyboard's focus was not, and it is
       * still on 3. Leaving the ring unpainted would have the next Tab step on
       * from a position nothing on screen shows.
       */
      expect(store.getState().focusedAreaId).toBe(3);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(3);
      // After the wipe, and before the hints go back on top of it.
      expect(mockRenderer.hexGrid.setFocusHighlight.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockRenderer.hexGrid.clearHighlights.mock.invocationCallOrder[0]
      );
      expect(mockRenderer.hexGrid.setFocusHighlight.mock.invocationCallOrder[0]).toBeLessThan(
        mockController.refreshCandidateHighlights.mock.invocationCallOrder[0]
      );
    });

    it('does nothing when already in selectFrom', () => {
      store.setState({ awaitingInput: 'selectFrom' });
      const event = fireKey('Escape');
      // Should still be selectFrom, clearHighlights not called
      expect(store.getState().awaitingInput).toBe('selectFrom');
      expect(mockRenderer.hexGrid.clearHighlights).not.toHaveBeenCalled();
      // Left uncancelled so QuitConfirm's window-level handler can act (#181).
      expect(event.defaultPrevented).toBe(false);
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
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();

      store.setState({ focusedAreaId: 1 });
      fireKey('Enter');
      expect(mockController.handleTerritoryClick).not.toHaveBeenCalled();

      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(1);
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
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();

      store.setState({ focusedAreaId: 1 });
      fireKey('Enter');
      expect(mockController.handleTerritoryClick).not.toHaveBeenCalled();

      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(1);
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
   * Tab stepping
   * -----------------------------------------------------------------------
   */

  describe('tab stepping', () => {
    it('Tab focuses first own territory when none focused', () => {
      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(1);
    });

    it('Tab steps forward one own territory at a time', () => {
      store.setState({ focusedAreaId: 1 });
      // Own territories are [1, 3, 4]: the next one is not the last one.
      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(3);
      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(4);
    });

    it('Shift+Tab steps backward one own territory at a time', () => {
      store.setState({ focusedAreaId: 4 });
      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(3);
      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(1);
    });

    it('Tab does not wrap at the end — the board hands off instead (#201)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      store.setState({ focusedAreaId: 4 });

      const event = fireKey('Tab');

      // After the last own territory the ring comes down rather than cycling
      // back to 1. Nothing to hand focus to here (no END TURN button in this
      // bare DOM), so the key is left for the browser's own Tab.
      expect(store.getState().focusedAreaId).toBeNull();
      expect(event.defaultPrevented).toBe(false);

      // A broken seam is broken for good, so it is reported once, not per press.
      store.setState({ focusedAreaId: 4 });
      fireKey('Tab');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('enters at the first own territory when the ring points at an enemy area', () => {
      // A ring left on an area the player does not own is not a position in the
      // stepping order, so Tab starts the order over rather than doing nothing.
      store.setState({ focusedAreaId: 2, selectedFrom: 1, awaitingInput: 'selectTo' });

      const event = fireKey('Tab');

      expect(store.getState().focusedAreaId).toBe(1);
      expect(event.defaultPrevented).toBe(true);
      // Selection and focus are separate: a half-made attack survives the step.
      expect(store.getState().selectedFrom).toBe(1);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });

    it('enters at the first own territory when the focused area has been lost', () => {
      store.setState({
        focusedAreaId: 3,
        selectedFrom: 1,
        awaitingInput: 'selectTo',
        gameState: makeGameState({
          areas: {
            0: null,
            1: { owner: 0, dice: 3, neighborAreaIds: [2, 3], centerCell: 10 },
            2: { owner: 1, dice: 2, neighborAreaIds: [1, 3], centerCell: 20 },
            3: { owner: 1, dice: 4, neighborAreaIds: [1, 2], centerCell: 30 },
            4: { owner: 0, dice: 2, neighborAreaIds: [], centerCell: 35 },
          },
        }),
      });

      const event = fireKey('Tab');

      expect(store.getState().focusedAreaId).toBe(1);
      expect(event.defaultPrevented).toBe(true);
      expect(store.getState().selectedFrom).toBe(1);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });

    it('still owns the board keys when DOM focus is on the Pixi canvas', () => {
      /*
       * The canvas holds no focus today, but isBoardFocus() accepts it so that
       * a future tabindex — or Pixi's accessibility layer — cannot silently
       * kill every board key.
       */
      const canvas = mountCanvas();
      canvas.focus();
      expect(document.activeElement).toBe(canvas);

      const arrow = fireKey('ArrowRight');
      expect(arrow.defaultPrevented).toBe(true);
      expect(store.getState().focusedAreaId).toBe(1);

      const tab = fireKey('Tab');
      expect(tab.defaultPrevented).toBe(true);
      expect(store.getState().focusedAreaId).toBe(3);
    });
  });

  /*
   * -----------------------------------------------------------------------
   * Tab order seams (#201)
   * -----------------------------------------------------------------------
   * The board is one virtual tab stop sitting immediately before END TURN, and
   * it only owns the keys while DOM focus is still on <body>. Without this a
   * keyboard-only player could attack but never reach END TURN at all.
   */

  describe('tab order seams (#201)', () => {
    it('walks the whole order: board → END TURN, and back to RULES', () => {
      const rules = mountButton(null, 'RULES');
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');

      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(1);
      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(3);
      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(4);
      fireKey('Tab');
      expect(document.activeElement).toBe(endTurn);

      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(4);
      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(3);
      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(1);
      fireKey('Tab', { shiftKey: true });
      expect(document.activeElement).toBe(rules);
    });

    it('Tab past the last own territory moves focus to END TURN', () => {
      mountButton(null, 'RULES');
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({ focusedAreaId: 4 });

      const event = fireKey('Tab');

      expect(document.activeElement).toBe(endTurn);
      // The ring comes down with the hand-off, or two focus indicators show at once.
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it('keeps a half-made attack when the board hands focus on', () => {
      mountButton(null, 'RULES');
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({ focusedAreaId: 4, selectedFrom: 1, awaitingInput: 'selectTo' });

      fireKey('Tab');

      // Leaving the board is a focus move, not a cancel: Escape is what cancels.
      expect(store.getState().selectedFrom).toBe(1);
      expect(store.getState().awaitingInput).toBe('selectTo');
    });

    it('leaves Tab native when there is no END TURN button to reach', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      store.setState({ focusedAreaId: 4 });

      const event = fireKey('Tab');

      // A dead key would be worse than a plain browser Tab out of <body>.
      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();

      // Reported once, however many times the player presses Tab.
      store.setState({ focusedAreaId: 4 });
      fireKey('Tab');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(END_TURN_BUTTON_ID));
      warnSpy.mockRestore();
    });

    it('leaves Tab native when END TURN is present but cannot take focus', () => {
      /*
       * getElementById finds a disabled button; focusablePredecessor's selector
       * would not. Claiming the key on the strength of the lookup alone would
       * leave the player with no focus anywhere and no way forward.
       */
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mountButton(null, 'RULES');
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.disabled = true;
      store.setState({ focusedAreaId: 4 });

      const event = fireKey('Tab');

      expect(document.activeElement).not.toBe(endTurn);
      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("Shift+Tab before the first own territory focuses END TURN's predecessor", () => {
      const rules = mountButton(null, 'RULES');
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({ focusedAreaId: 1 });

      const event = fireKey('Tab', { shiftKey: true });

      expect(document.activeElement).toBe(rules);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves Shift+Tab native when END TURN has no predecessor', () => {
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({ focusedAreaId: 1 });

      const event = fireKey('Tab', { shiftKey: true });

      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      // The ring still comes down: the board is no longer where the keys go.
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
    });

    it('Shift+Tab on END TURN comes back to the last own territory', () => {
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.focus();

      const event = fireKey('Tab', { shiftKey: true });

      // Focus back on <body> is what makes the board the owner of the keys again.
      expect(document.activeElement).toBe(document.body);
      expect(store.getState().focusedAreaId).toBe(4);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(4);
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves Tab on END TURN to the browser — the board is not a focus trap', () => {
      mountButton(null, 'RULES');
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.focus();
      /*
       * Set the ring after focusing, past the focusin rule, so this asserts what
       * the keydown did and nothing else: END TURN is the end of the order, so
       * forward Tab has to leave the page — not re-enter the board.
       */
      store.setState({ focusedAreaId: 4 });
      mockRenderer.hexGrid.clearFocusHighlight.mockClear();

      const event = fireKey('Tab');

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(endTurn);
      expect(store.getState().focusedAreaId).toBe(4);
      expect(mockRenderer.hexGrid.clearFocusHighlight).not.toHaveBeenCalled();
    });

    it("Tab on END TURN's predecessor enters the board at the first own territory", () => {
      const rules = mountButton(null, 'RULES');
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      rules.focus();

      const event = fireKey('Tab');

      expect(document.activeElement).toBe(document.body);
      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it("leaves Shift+Tab on END TURN's predecessor to the browser", () => {
      const rules = mountButton(null, 'RULES');
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      rules.focus();

      const event = fireKey('Tab', { shiftKey: true });

      // Backwards out of RULES is the DOM's business: QUIT is next, not the board.
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(rules);
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('leaves Tab alone on a control that is not one of the two seams', () => {
      const quit = mountButton(null, 'QUIT');
      mountButton(null, 'RULES');
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({ focusedAreaId: 1 });

      // A mouse click on QUIT crosses no seam, so the focusin rule is what takes
      // the ring down — otherwise it would still be painted on area 1 here.
      quit.focus();
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();

      const event = fireKey('Tab');

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(quit);
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('Shift+Tab with nothing highlighted enters at the last own territory', () => {
      // Arriving backwards means arriving at the far end of the group.
      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(4);
    });

    it('hands off in both directions when the human has no territories left', () => {
      const rules = mountButton(null, 'RULES');
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({
        gameState: makeGameState({
          areas: { 0: null, 1: { owner: 1, dice: 3, neighborAreaIds: [], centerCell: 10 } },
        }),
      });

      fireKey('Tab');
      expect(document.activeElement).toBe(endTurn);

      endTurn.blur();
      fireKey('Tab', { shiftKey: true });
      expect(document.activeElement).toBe(rules);
    });

    it('never re-enters the board from a seam when there is nothing to focus', () => {
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.focus();
      store.setState({
        gameState: makeGameState({
          areas: { 0: null, 1: { owner: 1, dice: 3, neighborAreaIds: [], centerCell: 10 } },
        }),
      });

      const event = fireKey('Tab', { shiftKey: true });

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(endTurn);
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('leaves the board keys alone while a control has focus', () => {
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.focus();
      store.setState({ focusedAreaId: 1 });

      // Enter and Space are the button's own activation; the arrows are the
      // browser's (scrolling, a select, a radio group).
      for (const key of ['ArrowRight', 'Enter', ' ']) {
        const event = fireKey(key);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockController.handleTerritoryClick).not.toHaveBeenCalled();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    });

    it('still cancels a half-made attack on Escape from a focused control', () => {
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
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
   * The ring never lies (#201)
   * -----------------------------------------------------------------------
   * DOM focus leaves the board without crossing a seam in three ways: a mouse
   * click on a control, a native Tab taken while the handler was bailing, and a
   * modal restoring focus to its opener on close. A focusin listener catches
   * all three, so the ring can never point at a territory the keys cannot reach.
   */

  describe('focusin', () => {
    it('clears the ring when a real control takes focus', () => {
      const quit = mountButton(null, 'QUIT');
      store.setState({ focusedAreaId: 1 });

      quit.focus();

      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
    });

    it('leaves the ring alone when focus lands on the board itself', () => {
      const canvas = mountCanvas();
      store.setState({ focusedAreaId: 1 });

      canvas.focus();

      expect(store.getState().focusedAreaId).toBe(1);
      expect(mockRenderer.hexGrid.clearFocusHighlight).not.toHaveBeenCalled();
    });

    it('does not write to the store when there is no ring to clear', () => {
      const quit = mountButton(null, 'QUIT');
      const subscriber = vi.fn();
      const unsubscribe = store.subscribe(subscriber);

      quit.focus();

      // Every setState notifies every subscriber; a no-op clear would re-render
      // the whole UI on every click of every button on the screen.
      expect(subscriber).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('stops clearing once the controller is destroyed', () => {
      const quit = mountButton(null, 'QUIT');
      store.setState({ focusedAreaId: 1 });
      kbc.destroy();

      quit.focus();

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
    it('removes event listener so keys have no effect', () => {
      kbc.destroy();
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.setFocusHighlight).not.toHaveBeenCalled();
    });
  });
});
