// @vitest-environment jsdom
/**
 * KeyboardController tests
 *
 * Tests keyboard navigation for the hex grid: arrow keys, Enter/Space,
 * Escape, Tab cycling, and guard conditions.
 */

import { createKeyboardController } from '../../src/controller/KeyboardController.js';
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
    refreshCoachHighlights: vi.fn(),
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

      const event = fireKey('Escape');

      expect(store.getState().awaitingInput).toBe('selectFrom');
      expect(store.getState().selectedFrom).toBeNull();
      expect(mockRenderer.hexGrid.clearHighlights).toHaveBeenCalled();
      /*
       * clearHighlights() wipes the coaching layer along with the selection, and
       * this lands back on selectFrom — so the controller (which owns that
       * mapping) has to be asked to repaint the attack candidates, or the board
       * silently stops offering them for the rest of the turn.
       */
      expect(mockController.refreshCoachHighlights).toHaveBeenCalled();
      // Claimed: the quit confirm must not also open on this keypress (#181).
      expect(event.defaultPrevented).toBe(true);
    });

    it('tolerates a controller without the coaching hook', () => {
      kbc.destroy();
      const bare = { handleTerritoryClick: vi.fn() };
      kbc = createKeyboardController(store, bare, mockRenderer);
      store.setState({ awaitingInput: 'selectTo', selectedFrom: 1 });

      expect(() => fireKey('Escape')).not.toThrow();
      expect(store.getState().awaitingInput).toBe('selectFrom');
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

    it('Tab wraps around at the end', () => {
      store.setState({ focusedAreaId: 3 });
      fireKey('Tab');
      // After 3 → wraps to 1
      expect(store.getState().focusedAreaId).toBe(1);
    });

    it('Shift+Tab cycles backward', () => {
      store.setState({ focusedAreaId: 1 });
      fireKey('Tab', { shiftKey: true });
      // Own territories are [1, 3]. Before 1 → wraps to 3
      expect(store.getState().focusedAreaId).toBe(3);
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
