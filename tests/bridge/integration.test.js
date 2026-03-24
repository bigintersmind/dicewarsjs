/**
 * Integration Tests for Bridge Modules
 *
 * These tests verify that the bridge modules correctly expose ES6 functionality
 * to the global scope for backward compatibility with legacy code.
 */

// Import utility functions from ES6 modules to compare with global scope
import { AI_REGISTRY } from '../../src/mechanics/aiHandler.js';
import { Game } from '../../src/Game.js';
import { getAIImplementation } from '../../src/ai/index.js';

describe('Bridge Module Integration', () => {
  describe('Game Bridge', () => {
    // Skip: Bridge is deprecated. require() identity differs from import in Vitest.
    test.skip('exposes Game class to global scope', () => {
      // Import the bridge module to trigger the code
      require('../../src/bridge/Game.js');

      // Verify that Game is available in the global scope
      expect(window.Game).toBeDefined();
      expect(typeof window.Game).toBe('function');

      // Verify it's the same as the ES6 module
      expect(window.Game).toBe(Game);
    });

    test('Game constructor can be used from global scope', () => {
      // Require the bridge module
      require('../../src/bridge/Game.js');

      // Create a new game instance using the global constructor
      const gameInstance = new window.Game();

      // Check that it has expected properties
      expect(gameInstance.XMAX).toBe(28);
      expect(gameInstance.YMAX).toBe(32);
      expect(gameInstance.cel_max).toBe(gameInstance.XMAX * gameInstance.YMAX);
    });
  });

  describe('AI Bridge', () => {
    test('exposes AI functions to global scope', async () => {
      // Import the bridge module to trigger the code
      await import('../../src/bridge/ai.js');
      await Promise.resolve();

      // Load ES6 implementations for comparison
      const ai_default = await getAIImplementation('ai_default');
      const ai_defensive = await getAIImplementation('ai_defensive');
      const ai_example = await getAIImplementation('ai_example');
      const ai_adaptive = await getAIImplementation('ai_adaptive');

      // Verify that AI functions are available in the global scope
      expect(window.ai_default).toBeDefined();
      expect(window.ai_defensive).toBeDefined();
      expect(window.ai_example).toBeDefined();
      expect(window.ai_adaptive).toBeDefined();

      // Verify they're the same as the ES6 modules
      expect(window.ai_default).toBe(ai_default);
      expect(window.ai_defensive).toBe(ai_defensive);
      expect(window.ai_example).toBe(ai_example);
      expect(window.ai_adaptive).toBe(ai_adaptive);
    });
  });

  describe('Bridge Index Module', () => {
    // Skip: Bridge is deprecated. Async initialization doesn't complete via require() in Vitest.
    test.skip('checkBridgeStatus returns status of core bridge modules', () => {
      // Import the bridge index to trigger initialization
      require('../../src/bridge/index.js');

      expect(window.checkBridgeStatus).toBeDefined();
      expect(typeof window.checkBridgeStatus).toBe('function');

      const status = window.checkBridgeStatus();

      expect(status).toHaveProperty('ai');
      expect(status).toHaveProperty('game');
      expect(status.ai).toEqual({ initialized: true, error: null });
      expect(status.game).toEqual({ initialized: true, error: null });
    });
  });
});
