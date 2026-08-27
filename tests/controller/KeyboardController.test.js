// @vitest-environment jsdom
/**
 * KeyboardController tests
 *
 * Tests keyboard navigation for the hex grid: arrow keys, Enter/Space,
 * Escape, Tab cycling, and guard conditions.
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
    },
    players: [
      { id: 0, alive: true, territoryCount: 2 },
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
    mountedControls.forEach(button => button.remove());
    mountedControls = [];
  });

  /*
   * -----------------------------------------------------------------------
   * Guard conditions
   * -----------------------------------------------------------------------
   */

  describe('guard conditions', () => {
    it('ignores keydown when screen is not playing', () => {
      store.setState({ screen: 'title' });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('ignores keydown when animationPhase is not idle', () => {
      store.setState({ animationPhase: 'battle' });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('ignores keydown when humanPlayerIndex is null', () => {
      store.setState({ humanPlayerIndex: null });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('ignores keydown when it is not the human turn', () => {
      store.setState({
        gameState: makeGameState({ currentPlayerIndex: 1 }),
      });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('ignores keydown when gameState is null', () => {
      store.setState({ gameState: null });
      fireKey('ArrowRight');
      expect(store.getState().focusedAreaId).toBeNull();
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
   * Tab cycling
   * -----------------------------------------------------------------------
   */

  describe('tab cycling', () => {
    it('Tab focuses first own territory when none focused', () => {
      fireKey('Tab');
      expect(store.getState().focusedAreaId).toBe(1);
    });

    it('Tab cycles forward through own territories', () => {
      store.setState({ focusedAreaId: 1 });
      fireKey('Tab');
      // Own territories are [1, 3]. After 1 → next is 3
      expect(store.getState().focusedAreaId).toBe(3);
    });

    it('Tab does not wrap at the end — the board hands off instead (#201)', () => {
      store.setState({ focusedAreaId: 3 });
      const event = fireKey('Tab');
      // After the last own territory the ring comes down rather than cycling
      // back to 1. Nothing to hand focus to here (no END TURN button in this
      // bare DOM), so the key is left for the browser's own Tab.
      expect(store.getState().focusedAreaId).toBeNull();
      expect(event.defaultPrevented).toBe(false);
    });

    it('Shift+Tab cycles backward', () => {
      store.setState({ focusedAreaId: 3 });
      fireKey('Tab', { shiftKey: true });
      // Own territories are [1, 3]. Before 3 → 1
      expect(store.getState().focusedAreaId).toBe(1);
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
    it('Tab past the last own territory moves focus to END TURN', () => {
      mountButton(null, 'RULES');
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      store.setState({ focusedAreaId: 3 });

      const event = fireKey('Tab');

      expect(document.activeElement).toBe(endTurn);
      // The ring comes down with the hand-off, or two focus indicators show at once.
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it('leaves Tab native when there is no END TURN button to reach', () => {
      store.setState({ focusedAreaId: 3 });

      const event = fireKey('Tab');

      // A dead key would be worse than a plain browser Tab out of <body>.
      expect(event.defaultPrevented).toBe(false);
      expect(store.getState().focusedAreaId).toBeNull();
      expect(mockRenderer.hexGrid.clearFocusHighlight).toHaveBeenCalled();
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
    });

    it('Shift+Tab on END TURN comes back to the last own territory', () => {
      const endTurn = mountButton(END_TURN_BUTTON_ID, 'END TURN');
      endTurn.focus();

      const event = fireKey('Tab', { shiftKey: true });

      // Focus back on <body> is what makes the board the owner of the keys again.
      expect(document.activeElement).toBe(document.body);
      expect(store.getState().focusedAreaId).toBe(3);
      expect(mockRenderer.hexGrid.setFocusHighlight).toHaveBeenCalledWith(3);
      expect(event.defaultPrevented).toBe(true);
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

    it('leaves Tab alone on a control that is not one of the two seams', () => {
      const quit = mountButton(null, 'QUIT');
      mountButton(null, 'RULES');
      mountButton(END_TURN_BUTTON_ID, 'END TURN');
      quit.focus();

      const event = fireKey('Tab');

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(quit);
      expect(store.getState().focusedAreaId).toBeNull();
    });

    it('Shift+Tab with nothing highlighted enters at the last own territory', () => {
      // Arriving backwards means arriving at the far end of the group.
      fireKey('Tab', { shiftKey: true });
      expect(store.getState().focusedAreaId).toBe(3);
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
