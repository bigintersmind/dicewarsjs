/**
 * Tests for Game.js - Core Game Logic
 */

/*
 * Mock the dependencies
 * Import after mocks
 */
import { Game } from '../../src/Game.js';
import { AreaData, PlayerData } from '../../src/models/index.js';

vi.mock('../../src/models/index.js', () => ({
  AreaData: vi.fn().mockImplementation(function () {
    this.size = 0;
    this.arm = 0;
    this.dice = 0;
    this.join = Array(32).fill(0);
    this.line_cel = Array(100).fill(0);
    this.line_dir = Array(100).fill(0);
  }),
  PlayerData: vi.fn().mockImplementation(function () {
    this.area_c = 0;
    this.area_tc = 0;
    this.dice_c = 0;
  }),
  JoinData: vi.fn().mockImplementation(function () {
    this.dir = [0, 0, 0, 0, 0, 0];
  }),
  HistoryData: vi.fn(),
  Battle: vi.fn(),
}));

vi.mock('../../src/ai/index.js', () => ({
  ai_default: vi.fn(),
  ai_defensive: vi.fn(),
  ai_example: vi.fn(),
  ai_adaptive: vi.fn(),
  AI_STRATEGIES: {
    ai_default: { loader: async () => vi.fn(), implementation: vi.fn() },
    ai_defensive: { loader: async () => vi.fn(), implementation: vi.fn() },
    ai_example: { loader: async () => vi.fn(), implementation: vi.fn() },
    ai_adaptive: { loader: async () => vi.fn(), implementation: vi.fn() },
  },
  createAIFunctionMapping: vi.fn(),
  getAIImplementation: vi.fn(),
  getAIById: vi.fn(),
}));

describe('Game', () => {
  let game;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a fresh Game instance for each test
    game = new Game();
  });

  describe('Construction', () => {
    test('initializes with default grid dimensions', () => {
      expect(game.XMAX).toBe(28);
      expect(game.YMAX).toBe(32);
      expect(game.cel_max).toBe(game.XMAX * game.YMAX);
    });

    test('initializes with default player settings', () => {
      expect(game.pmax).toBe(7);
      expect(game.user).toBe(0);
      expect(game.put_dice).toBe(3);
    });

    test('initializes the AI registry', () => {
      expect(game.aiRegistry).toBeDefined();
      expect(game.aiRegistry.ai_default).toBeDefined();
      expect(game.aiRegistry.ai_defensive).toBeDefined();
      expect(game.aiRegistry.ai_example).toBeDefined();
      expect(game.aiRegistry.ai_adaptive).toBeDefined();
    });

    test('creates cell-to-area mapping array', () => {
      expect(Array.isArray(game.cel)).toBe(true);
      expect(game.cel.length).toBe(game.cel_max);
    });

    test('creates adjacency mapping for all cells', () => {
      expect(Array.isArray(game.join)).toBe(true);
      expect(game.join.length).toBe(game.cel_max);
    });

    test('creates area data array with 32 elements', () => {
      expect(Array.isArray(game.adat)).toBe(true);
      expect(game.adat.length).toBeGreaterThanOrEqual(32);

      // Check that AreaData constructor was called
      expect(AreaData).toHaveBeenCalled();
    });

    test('creates player data array with 8 elements', () => {
      expect(Array.isArray(game.player)).toBe(true);
      expect(game.player.length).toBe(8);

      // Check that PlayerData constructor was called
      expect(PlayerData).toHaveBeenCalled();
    });
  });

  describe('next_cel', () => {
    test('calculates correct index for right direction', () => {
      // Middle of the grid
      const x = 10;
      const y = 10;
      const cell = y * game.XMAX + x;

      // Direction 1 is right
      const rightCell = game.next_cel(cell, 1);
      expect(rightCell).toBe(cell + 1);
    });

    test('calculates correct index for left direction', () => {
      // Middle of the grid
      const x = 10;
      const y = 10;
      const cell = y * game.XMAX + x;

      // Direction 4 is left
      const leftCell = game.next_cel(cell, 4);
      expect(leftCell).toBe(cell - 1);
    });

    test('handles edge case on the left border', () => {
      // Left edge
      const x = 0;
      const y = 10;
      const cell = y * game.XMAX + x;

      // Direction 4 is left - should be out of bounds
      const outOfBoundsCell = game.next_cel(cell, 4);
      expect(outOfBoundsCell).toBe(-1);
    });

    test('handles edge case on the right border', () => {
      // Right edge
      const x = game.XMAX - 1;
      const y = 10;
      const cell = y * game.XMAX + x;

      // Direction 1 is right - should be out of bounds
      const outOfBoundsCell = game.next_cel(cell, 1);
      expect(outOfBoundsCell).toBe(-1);
    });

    test('handles edge case on the top border', () => {
      // Top edge
      const x = 10;
      const y = 0;
      const cell = y * game.XMAX + x;

      // Direction 5 is upper left - should be out of bounds
      const outOfBoundsCell = game.next_cel(cell, 5);
      expect(outOfBoundsCell).toBe(-1);
    });

    test('handles edge case on the bottom border', () => {
      // Bottom edge
      const x = 10;
      const y = game.YMAX - 1;
      const cell = y * game.XMAX + x;

      // Direction 2 is bottom right - should be out of bounds
      const outOfBoundsCell = game.next_cel(cell, 2);
      expect(outOfBoundsCell).toBe(-1);
    });
  });

  describe('get_pn', () => {
    test('returns the current player index from the jun array', () => {
      // Default ban is 0, jun[0] should be 0
      expect(game.get_pn()).toBe(0);

      // Change ban and check if it returns the correct player
      game.ban = 2;
      game.jun[2] = 5;
      expect(game.get_pn()).toBe(5);
    });
  });

  describe('start_game', () => {
    test('initializes turn order and sets ban to 0', () => {
      // Set ban to something other than 0
      game.ban = 3;

      // Mock Math.random to make the test deterministic
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      game.start_game();

      // Ban should be reset to 0
      expect(game.ban).toBe(0);

      // Players should be in the jun array
      for (let i = 0; i < game.pmax; i++) {
        expect(game.jun[i]).toBeGreaterThanOrEqual(0);
        expect(game.jun[i]).toBeLessThan(8);
      }

      // Restore Math.random
      Math.random = originalRandom;
    });

    test('records initial state in history arrays', () => {
      // Set up some test data
      game.adat[1].arm = 2;
      game.adat[1].dice = 3;

      game.start_game();

      // Check that history was initialized
      expect(game.his_c).toBe(0);
      expect(game.his_arm[1]).toBe(2);
      expect(game.his_dice[1]).toBe(3);
    });
  });

  describe('set_area_tc', () => {
    test('calculates largest connected territory for a player', () => {
      const playerIndex = 2;

      // Prepare mock territories

      // First territory
      game.adat[1].size = 10;
      game.adat[1].arm = playerIndex;
      game.adat[1].join[2] = 1; // Connected to territory 2

      // Second territory, connected to first
      game.adat[2].size = 10;
      game.adat[2].arm = playerIndex;
      game.adat[2].join[1] = 1; // Connected to territory 1

      // Third territory, isolated
      game.adat[3].size = 10;
      game.adat[3].arm = playerIndex;

      // Calculate territory grouping
      game.set_area_tc(playerIndex);

      // The player should have 2 territories in largest group
      expect(game.player[playerIndex].area_tc).toBe(2);
    });

    test('handles player with no territories', () => {
      const playerIndex = 3;

      // No territories for this player

      // Calculate territory grouping
      game.set_area_tc(playerIndex);

      // The player should have 0 territories in largest group
      expect(game.player[playerIndex].area_tc).toBe(0);
    });
  });
});
