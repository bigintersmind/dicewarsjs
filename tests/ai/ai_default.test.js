/**
 * Tests for Default AI implementation
 */
import { ai_default } from '../../src/ai/ai_default.js';

describe('Default AI', () => {
  // Create a mock game object
  let mockGame;

  beforeEach(() => {
    // Set up a fresh mock game for each test
    mockGame = {
      AREA_MAX: 32,
      adat: [],
      area_from: 0,
      area_to: 0,
      jun: [0, 1, 2, 3, 4, 5, 6, 7],
      ban: 1, // Current turn is player 1
      player: [],
      random: () => 0.5, // Seeded game.random stand-in (issue #151); tests override per case
    };

    // Initialize player data
    for (let i = 0; i < 8; i++) {
      mockGame.player[i] = {
        area_c: 0,
        dice_c: 0,
        dice_jun: 0,
      };
    }

    // Initialize area data
    for (let i = 0; i < mockGame.AREA_MAX; i++) {
      mockGame.adat[i] = {
        size: 0,
        arm: 0,
        dice: 0,
        join: Array(32).fill(0),
      };
    }
  });

  test('ends turn when no valid moves are available', () => {
    // Set up a game state with no valid attacks
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1; // Owned by current player
    mockGame.adat[1].dice = 1; // Only has 1 die, can't attack

    const result = ai_default(mockGame);

    expect(result).toBe(0); // Should end turn
  });

  test('selects a valid attack with dice advantage', () => {
    // Set up an attacker with more dice
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1; // Owned by current player
    mockGame.adat[1].dice = 3;
    mockGame.adat[1].join[2] = 1; // Adjacent to territory 2

    // Set up a defender with fewer dice
    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2; // Owned by opponent
    mockGame.adat[2].dice = 1;

    // Pin game.random to make the test deterministic
    mockGame.random = vi.fn().mockReturnValue(0.5);

    ai_default(mockGame);

    // Should attack from territory 1 to territory 2
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('handles equal dice attacks based on probabilities', () => {
    // Set up an attacker with equal dice
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1; // Owned by current player
    mockGame.adat[1].dice = 2;
    mockGame.adat[1].join[2] = 1; // Adjacent to territory 2

    // Set up a defender with equal dice
    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2; // Owned by opponent
    mockGame.adat[2].dice = 2;

    // Pin game.random to make the test deterministic - will attack with 90% probability
    mockGame.random = vi.fn().mockReturnValue(0.5); // > 0.1, so should attack

    ai_default(mockGame);

    // Should attack from territory 1 to territory 2
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('skips equal dice attacks when probability check fails', () => {
    // Set up an attacker with equal dice
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1; // Owned by current player
    mockGame.adat[1].dice = 2;
    mockGame.adat[1].join[2] = 1; // Adjacent to territory 2

    // Set up a defender with equal dice
    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2; // Owned by opponent
    mockGame.adat[2].dice = 2;

    // Set up a guaranteed target with dice advantage
    mockGame.adat[3].size = 10;
    mockGame.adat[3].arm = 1; // Owned by current player
    mockGame.adat[3].dice = 3;
    mockGame.adat[3].join[4] = 1; // Adjacent to territory 4

    mockGame.adat[4].size = 10;
    mockGame.adat[4].arm = 2; // Owned by opponent
    mockGame.adat[4].dice = 1;

    // Pin game.random to avoid the equal dice attack
    mockGame.random = vi
      .fn()
      .mockReturnValueOnce(0.05) // <= 0.1, should skip equal dice attack
      .mockReturnValueOnce(0.5); // For move selection

    ai_default(mockGame);

    // Should attack from territory 3 to territory 4 (avoiding the equal dice situation)
    expect(mockGame.area_from).toBe(3);
    expect(mockGame.area_to).toBe(4);
  });

  test('correctly identifies dominant player', () => {
    // Set up several territories to give player 2 dominance
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1; // Owned by current player (1)
    mockGame.adat[1].dice = 2;
    mockGame.adat[1].join[3] = 1; // Adjacent to territory 3

    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2; // Dominant player
    mockGame.adat[2].dice = 8; // Lots of dice!

    mockGame.adat[3].size = 10;
    mockGame.adat[3].arm = 3; // Regular opponent
    mockGame.adat[3].dice = 1;
    mockGame.adat[3].join[1] = 1; // Adjacent to territory 1

    mockGame.adat[4].size = 10;
    mockGame.adat[4].arm = 3; // Regular opponent
    mockGame.adat[4].dice = 1;
    mockGame.adat[4].join[1] = 1; // Adjacent to territory 1

    // Total dice: 12 (player 2 has 8, which is > 40% of total)

    // Run AI
    ai_default(mockGame);

    /*
     * With dominant player logic, should attack only territories involving the dominant player
     * In this case, we expect no attack since current player can't attack dominant player directly
     */
    expect(mockGame.area_from).toBe(0);
    expect(mockGame.area_to).toBe(0);
  });

  test('properly calculates and updates player rankings', () => {
    // Set up territories for different players
    mockGame.adat[1].size = 10;
    mockGame.adat[1].arm = 1;
    mockGame.adat[1].dice = 5;

    mockGame.adat[2].size = 10;
    mockGame.adat[2].arm = 2;
    mockGame.adat[2].dice = 8;

    mockGame.adat[3].size = 10;
    mockGame.adat[3].arm = 3;
    mockGame.adat[3].dice = 3;

    mockGame.adat[4].size = 10;
    mockGame.adat[4].arm = 1;
    mockGame.adat[4].dice = 2;

    // Run AI
    ai_default(mockGame);

    // Player dice counts should be updated
    expect(mockGame.player[1].dice_c).toBe(7); // 5 + 2
    expect(mockGame.player[2].dice_c).toBe(8);
    expect(mockGame.player[3].dice_c).toBe(3);

    /*
     * Dice rankings should be updated (lower rank = better)
     * Player 2 should be rank 0 (highest)
     * Player 1 should be rank 1
     * Player 3 should be rank 2
     */
    expect(mockGame.player[2].dice_jun).toBe(0);
    expect(mockGame.player[1].dice_jun).toBe(1);
    expect(mockGame.player[3].dice_jun).toBe(2);
  });
});
