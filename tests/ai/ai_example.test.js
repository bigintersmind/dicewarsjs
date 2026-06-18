/**
 * Tests for Example AI implementation
 */
import { ai_example } from '../../src/ai/ai_example.js';
import { AreaData } from '../mocks/areaData.js';

describe('Example AI', () => {
  // Create a mock game object
  let mockGame;

  beforeEach(() => {
    // Set up a fresh mock game for each test
    mockGame = {
      AREA_MAX: 32,
      adat: [],
      area_from: 0,
      area_to: 0,
      get_pn: vi.fn().mockReturnValue(1), // Current player is 1
    };

    // Initialize territory data
    for (let i = 0; i < mockGame.AREA_MAX; i++) {
      mockGame.adat[i] = new AreaData();
    }
  });

  test('ends turn when no valid moves are available', () => {
    // Configure territories - no valid attacks possible
    mockGame.adat[1].size = 10; // Territory exists
    mockGame.adat[1].arm = 1; // Owned by current player
    mockGame.adat[1].dice = 1; // Only has 1 die, can't attack

    const result = ai_example(mockGame);

    expect(result).toBe(0); // Should return 0 to end turn
    expect(mockGame.area_from).toBe(0); // Should not set area_from
    expect(mockGame.area_to).toBe(0); // Should not set area_to
  });

  test('selects a valid attack when only one option is available', () => {
    // Configure territories - one valid attack
    mockGame.adat[1].size = 10; // Territory exists
    mockGame.adat[1].arm = 1; // Owned by current player
    mockGame.adat[1].dice = 3; // Has 3 dice
    mockGame.adat[1].join = Array(32).fill(0);
    mockGame.adat[1].join[2] = 1; // Adjacent to territory 2

    mockGame.adat[2].size = 10; // Territory exists
    mockGame.adat[2].arm = 2; // Owned by different player
    mockGame.adat[2].dice = 1; // Has 1 die (less than attacker)

    ai_example(mockGame);

    expect(mockGame.area_from).toBe(1); // Should attack from territory 1
    expect(mockGame.area_to).toBe(2); // Should attack territory 2
  });

  test('does not attack territory with equal or more dice', () => {
    // Configure territories - attacker has 3 dice
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1;
    mockGame.adat[1].dice = 3;
    mockGame.adat[1].join = Array(32).fill(0);
    mockGame.adat[1].join[2] = 1; // Adjacent to territory 2
    mockGame.adat[1].join[3] = 1; // Adjacent to territory 3

    // Territory 2 has more dice than attacker
    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2;
    mockGame.adat[2].dice = 4;

    // Territory 3 has less dice than attacker (valid target)
    mockGame.adat[3].size = 10;
    mockGame.adat[3].arm = 2;
    mockGame.adat[3].dice = 1;

    ai_example(mockGame);

    expect(mockGame.area_from).toBe(1); // Should attack from territory 1
    expect(mockGame.area_to).toBe(3); // Should attack territory 3 (not 2)
  });

  test('chooses randomly when multiple valid attacks exist', () => {
    // Mock Math.random to control the selection
    const originalRandom = Math.random;

    // Configure territories - multiple valid attacks
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1;
    mockGame.adat[1].dice = 3;
    mockGame.adat[1].join = Array(32).fill(0);
    mockGame.adat[1].join[2] = 1; // Adjacent to territory 2
    mockGame.adat[1].join[3] = 1; // Adjacent to territory 3

    // Both territories are valid targets
    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2;
    mockGame.adat[2].dice = 1;

    mockGame.adat[3].size = 10;
    mockGame.adat[3].arm = 2;
    mockGame.adat[3].dice = 2;

    // First test: select first option
    Math.random = vi.fn().mockReturnValue(0);
    ai_example(mockGame);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);

    // Reset selection
    mockGame.area_from = 0;
    mockGame.area_to = 0;

    // Second test: select second option
    Math.random = vi.fn().mockReturnValue(0.99);
    ai_example(mockGame);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(3);

    // Restore original Math.random
    Math.random = originalRandom;
  });

  test('skips territories that do not belong to current player', () => {
    // Configure territories
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 2; // Not owned by current player (1)
    mockGame.adat[1].dice = 3;

    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 1; // Owned by current player
    mockGame.adat[2].dice = 3;
    mockGame.adat[2].join = Array(32).fill(0);
    // No valid targets for territory 2

    const result = ai_example(mockGame);
    expect(result).toBe(0); // Should end turn
  });
});
