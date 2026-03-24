/**
 * Tests for AI Handler Module
 *
 * @vitest-environment jsdom
 */

import { vi } from 'vitest';

// Now import modules
import {
  AI_REGISTRY,
  generatePossibleMoves,
  executeAIMove,
  configureAI,
} from '../../src/mechanics/aiHandler.js';
import { AI_STRATEGIES, createAIFunctionMapping } from '../../src/ai/index.js';

// Mock createAIFunctionMapping before importing the module
vi.mock('../../src/ai/index.js', async () => {
  const actualModule = await vi.importActual('../../src/ai/index.js');
  return {
    ...actualModule,
    createAIFunctionMapping: vi.fn(),
  };
});

describe('AI Handler Module', () => {
  describe('AI_REGISTRY', () => {
    it('should create a registry from AI_STRATEGIES', () => {
      expect(AI_REGISTRY).toBeDefined();
      expect(typeof AI_REGISTRY).toBe('object');

      // Check that all strategies from AI_STRATEGIES are in the registry
      Object.keys(AI_STRATEGIES).forEach(key => {
        expect(AI_REGISTRY).toHaveProperty(key);
        expect(AI_REGISTRY[key]).toBe(AI_STRATEGIES[key].loader);
      });
    });
  });

  describe('generatePossibleMoves', () => {
    let gameState;

    beforeEach(() => {
      gameState = {
        AREA_MAX: 4,
        adat: {
          1: { size: 6, arm: 1, dice: 3, join: { 2: 1, 3: 0 } },
          2: { size: 4, arm: 2, dice: 2, join: { 1: 1, 3: 1 } },
          3: { size: 5, arm: 1, dice: 1, join: { 1: 0, 2: 1 } },
        },
      };
    });

    it('should generate valid attack moves for a player', () => {
      const moves = generatePossibleMoves(gameState, 1);

      expect(moves).toHaveLength(1);
      expect(moves[0]).toEqual({
        from: 1,
        to: 2,
        attackerDice: 3,
        defenderDice: 2,
        ratio: 1.5,
      });
    });

    it('should not generate moves for territories with 1 die', () => {
      const moves = generatePossibleMoves(gameState, 1);

      // Territory 3 has only 1 die, shouldn't be in the moves
      const movesFromTerritory3 = moves.filter(m => m.from === 3);
      expect(movesFromTerritory3).toHaveLength(0);
    });

    it('should not attack own territories', () => {
      const moves = generatePossibleMoves(gameState, 1);

      // Should not attack territory 3 (also owned by player 1)
      const movesToOwnTerritory = moves.filter(m => m.to === 3);
      expect(movesToOwnTerritory).toHaveLength(0);
    });

    it('should only attack adjacent territories', () => {
      const moves = generatePossibleMoves(gameState, 1);

      // Territory 1 is not adjacent to territory 3
      const movesFromTerritory1 = moves.filter(m => m.from === 1);
      expect(movesFromTerritory1.some(m => m.to === 3)).toBe(false);
    });

    it('should return empty array when no valid moves exist', () => {
      // Make territory 2 have only 1 die so it can't attack
      gameState.adat[2].dice = 1;
      const moves = generatePossibleMoves(gameState, 2);
      expect(moves).toHaveLength(0);
    });

    it('should skip non-existent territories', () => {
      gameState.adat[1].size = 0; // Non-existent territory
      const moves = generatePossibleMoves(gameState, 1);
      expect(moves).toHaveLength(0);
    });
  });

  describe('executeAIMove', () => {
    let gameState;
    let mockAIFunction;
    let consoleErrorSpy;
    let consoleLogSpy;

    beforeEach(() => {
      mockAIFunction = vi.fn().mockReturnValue(1);
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      gameState = {
        ai: [null, mockAIFunction],
        jun: [1, 2],
        ban: 0,
      };
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('should call the correct AI function for the current player', () => {
      const result = executeAIMove(gameState);

      expect(mockAIFunction).toHaveBeenCalledWith(gameState);
      expect(result).toBe(1);
    });

    it('should handle missing AI function with fallback', () => {
      gameState.ai[1] = null;

      // Mock the default AI
      const originalDefault = AI_STRATEGIES.ai_default?.implementation;
      const mockDefaultAI = vi.fn().mockReturnValue(0);
      AI_STRATEGIES.ai_default = {
        ...AI_STRATEGIES.ai_default,
        implementation: mockDefaultAI,
      };

      const result = executeAIMove(gameState);

      expect(consoleErrorSpy).toHaveBeenCalledWith('AI function not found for player 1');
      expect(consoleLogSpy).toHaveBeenCalledWith('Using default AI as fallback');
      expect(mockDefaultAI).toHaveBeenCalledWith(gameState);
      expect(result).toBe(0);

      // Restore original
      if (originalDefault) {
        AI_STRATEGIES.ai_default.implementation = originalDefault;
      }
    });

    it('should handle missing AI function without fallback', () => {
      gameState.ai[1] = null;

      // Temporarily remove ai_default so there's no fallback
      const originalDefault = AI_STRATEGIES.ai_default;
      delete AI_STRATEGIES.ai_default;

      try {
        const result = executeAIMove(gameState);

        // Should call console.error for the missing AI function
        expect(consoleErrorSpy).toHaveBeenCalledWith('AI function not found for player 1');
        expect(result).toBe(0);
      } finally {
        // Restore ai_default
        AI_STRATEGIES.ai_default = originalDefault;
      }
    });

    it('should handle AI function that is not actually a function', () => {
      gameState.ai[1] = 'not a function';

      // Ensure ai_default exists for fallback
      const originalDefault = AI_STRATEGIES.ai_default?.implementation;
      const mockDefaultAI = vi.fn().mockReturnValue(0);
      AI_STRATEGIES.ai_default = {
        ...AI_STRATEGIES.ai_default,
        implementation: mockDefaultAI,
      };

      const result = executeAIMove(gameState);

      expect(consoleErrorSpy).toHaveBeenCalledWith('AI function not found for player 1');
      expect(mockDefaultAI).toHaveBeenCalledWith(gameState);
      expect(result).toBe(0);

      // Restore original
      if (originalDefault) {
        AI_STRATEGIES.ai_default.implementation = originalDefault;
      }
    });
  });

  describe('configureAI', () => {
    let gameState;

    beforeEach(() => {
      gameState = {
        ai: [null, null, null, null],
      };

      // Clear the mock
      createAIFunctionMapping.mockClear();
    });

    it('should configure AI strategies from assignments', async () => {
      const mockAI1 = vi.fn();
      const mockAI2 = vi.fn();
      const mockAIs = [mockAI1, mockAI2];

      // Mock the createAIFunctionMapping to return our mock functions
      createAIFunctionMapping.mockResolvedValue(mockAIs);

      const result = await configureAI(gameState, ['ai_default', 'ai_defensive']);

      expect(createAIFunctionMapping).toHaveBeenCalledWith(['ai_default', 'ai_defensive']);
      expect(result.ai[0]).toBe(mockAI1);
      expect(result.ai[1]).toBe(mockAI2);
      expect(result.ai[2]).toBe(null); // Unchanged
      expect(result.ai[3]).toBe(null); // Unchanged
    });

    it('should handle invalid assignments', async () => {
      const result = await configureAI(gameState, null);
      expect(result).toBe(gameState);

      const result2 = await configureAI(gameState, undefined);
      expect(result2).toBe(gameState);

      const result3 = await configureAI(gameState, 'not an array');
      expect(result3).toBe(gameState);
    });

    it('should not mutate original game state', async () => {
      const originalAI = [...gameState.ai];
      const mockAIs = [vi.fn(), vi.fn()];

      // Mock the createAIFunctionMapping to return our mock functions
      createAIFunctionMapping.mockResolvedValue(mockAIs);

      const result = await configureAI(gameState, ['ai_default', 'ai_defensive']);

      expect(gameState.ai).toEqual(originalAI); // Original unchanged
      expect(result).not.toBe(gameState); // New object
      expect(result.ai).not.toBe(gameState.ai); // Different array instance
    });

    it('should handle empty assignments array', async () => {
      const mockAIs = [];

      // Mock the createAIFunctionMapping to return empty array
      createAIFunctionMapping.mockResolvedValue(mockAIs);

      const result = await configureAI(gameState, []);

      expect(createAIFunctionMapping).toHaveBeenCalledWith([]);
      expect(result.ai).toEqual([null, null, null, null]); // Unchanged
    });
  });
});
