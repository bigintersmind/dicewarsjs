/**
 * Tests for Adaptive AI implementation
 *
 * This file tests the complex adaptive AI strategy, which requires more extensive tests
 * to ensure proper behavior across different game phases and scenarios
 */
import { ai_adaptive } from '../../src/ai/ai_adaptive.js';
import { createGameMock } from '../mocks/gameMock.js';

describe('Adaptive AI', () => {
  let mockGame;

  beforeEach(() => {
    // Set up a fresh mock game for each test
    mockGame = createGameMock({
      currentPlayer: 1,
      usePlayerDataModel: true,
    });

    // Add the required set_area_tc method for testing
    mockGame.set_area_tc = vi.fn(playerNum => {
      if (mockGame.player[playerNum]) {
        // Default implementation sets area_tc to area_c
        mockGame.player[playerNum].area_tc = mockGame.player[playerNum].area_c;
      }
    });
  });

  describe('Core AI Functionality', () => {
    test('ends turn when no valid moves are available', () => {
      // Setup: Territory with only 1 die, can't attack
      mockGame.createTerritory(1, 1, 1);

      const result = ai_adaptive(mockGame);

      expect(result).toBe(0); // Should return 0 to end turn
      expect(mockGame.area_from).toBe(0); // Should not set area_from
      expect(mockGame.area_to).toBe(0); // Should not set area_to
    });

    test('selects a valid attack when one is available', () => {
      // Setup: Strong attacker vs. weak defender
      mockGame.createTerritory(1, 1, 5, { 2: 1 });
      mockGame.createTerritory(2, 2, 1, { 1: 1 });

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });

    test('will not attack territory with equal or more dice', () => {
      // Setup: Attacker has same dice as defender
      mockGame.createTerritory(1, 1, 3, { 2: 1 });
      mockGame.createTerritory(2, 2, 3, { 1: 1 });

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      const result = ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Should end turn since attack would be equal dice
      expect(result).toBe(0);
    });
  });

  describe('Game Phase Detection', () => {
    test('handles early game scenarios', () => {
      // Setup: Many players with few territories each
      for (let i = 1; i <= 6; i++) {
        mockGame.player[i].area_c = 3;
        mockGame.player[i].dice_c = i + 2;
      }

      // Setup 18 territories (6 players x 3 territories each)
      let territoryId = 1;
      for (let player = 1; player <= 6; player++) {
        for (let t = 0; t < 3; t++) {
          mockGame.createTerritory(territoryId++, player, (player % 3) + 1);
        }
      }

      // Create a specific valid attack for player 1
      mockGame.createTerritory(20, 1, 5, { 21: 1 }); // Player 1 territory with 5 dice
      mockGame.createTerritory(21, 2, 1, { 20: 1 }); // Player 2 territory with 1 die

      mockGame.recalculatePlayerStats();

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Verify that the AI selects the valid attack in the early game scenario
      expect(mockGame.area_from).toBe(20);
      expect(mockGame.area_to).toBe(21);
    });

    test('handles late game scenarios', () => {
      // Setup: Few players with many territories each
      for (let i = 1; i <= 3; i++) {
        mockGame.player[i].area_c = 8;
        mockGame.player[i].dice_c = i * 10;
      }

      // Setup 24 territories (3 players x 8 territories each)
      let territoryId = 1;
      for (let player = 1; player <= 3; player++) {
        for (let t = 0; t < 8; t++) {
          mockGame.createTerritory(territoryId++, player, player + 1);
        }
      }

      // Create a specific valid attack for player 1
      mockGame.createTerritory(25, 1, 5, { 26: 1 }); // Player 1 territory with 5 dice
      mockGame.createTerritory(26, 3, 1, { 25: 1 }); // Player 3 territory with 1 die

      mockGame.recalculatePlayerStats();
      mockGame.setPlayerRankings();

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Verify that the AI selects the valid attack in the late game scenario
      expect(mockGame.area_from).toBe(25);
      expect(mockGame.area_to).toBe(26);
    });
  });

  describe('Adaptive Strategy Selection', () => {
    test('handles scenarios with dominant player', () => {
      // Setup: Player 2 is dominant with many dice
      mockGame.createTerritory(1, 1, 4, { 2: 1, 3: 1 });
      mockGame.createTerritory(2, 2, 2, { 1: 1 });
      mockGame.createTerritory(3, 3, 1, { 1: 1 });

      // Give player 2 dominance
      for (let i = 4; i < 10; i++) {
        mockGame.createTerritory(i, 2, 3);
      }

      mockGame.recalculatePlayerStats();
      mockGame.setPlayerRankings();

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      /*
       * The adaptive AI will choose a valid attack based on multiple complex factors
       * Check that it selects one of the valid targets
       */
      expect(mockGame.area_from).toBe(1);
      expect([2, 3]).toContain(mockGame.area_to);
    });

    test('prioritizes targeting weak player when behind', () => {
      // Setup: Player 1 is in last place, player 3 is weakest but with territories
      mockGame.createTerritory(1, 1, 3, { 2: 1, 3: 1 }); // Our territory
      mockGame.createTerritory(2, 2, 2, { 1: 1 }); // Player 2 (medium)
      mockGame.createTerritory(3, 3, 1, { 1: 1 }); // Player 3 (weak)

      // Give player 2 many territories and dice
      for (let i = 4; i < 10; i++) {
        mockGame.createTerritory(i, 2, 2);
      }

      // Give player 3 few territories and dice
      for (let i = 10; i < 12; i++) {
        mockGame.createTerritory(i, 3, 1);
      }

      mockGame.recalculatePlayerStats();
      mockGame.setPlayerRankings();

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // When in last place, should target weakest player (player 3)
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(3);
    });

    test('handles fragmented territory scenarios', () => {
      // Setup: Our territories are fragmented (area_tc < area_c)
      mockGame.createTerritory(1, 1, 3, { 2: 1 }); // Territory 1 (isolated)
      mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1 }); // Enemy between our territories
      mockGame.createTerritory(3, 1, 4, { 2: 1, 4: 1 }); // Territory 3 (connects to territory 1 via territory 2)
      mockGame.createTerritory(4, 2, 1, { 3: 1 }); // Another enemy territory

      // Set fragmented territories - only half are connected
      mockGame.player[1].area_c = 2;
      mockGame.player[1].area_tc = 1;

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // The adaptive AI selects from multiple possible scenarios based on complex logic
      const validAttackPairs = [
        { from: 1, to: 2 },
        { from: 3, to: 2 },
        { from: 3, to: 4 },
      ];

      // Ensure that the AI selects one of these valid attack combinations
      const attackIsValid = validAttackPairs.some(
        pair => pair.from === mockGame.area_from && pair.to === mockGame.area_to
      );

      expect(attackIsValid).toBe(true);
    });
  });

  describe('Strategic Territory Evaluation', () => {
    test('identifies and prioritizes choke points', () => {
      // Setup: Territory 2 is a choke point connecting multiple players
      mockGame.createTerritory(1, 1, 4, { 2: 1 }); // Our territory
      mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1, 4: 1, 5: 1 }); // Choke point - connects to 4 territories
      mockGame.createTerritory(3, 3, 2, { 2: 1 }); // Player 3's territory
      mockGame.createTerritory(4, 4, 2, { 2: 1 }); // Player 4's territory
      mockGame.createTerritory(5, 5, 1, { 2: 1 }); // Player 5's territory

      // Create another valid but less strategic attack option
      mockGame.createTerritory(6, 1, 3, { 7: 1 }); // Another of our territories
      mockGame.createTerritory(7, 2, 1, { 6: 1 }); // Non-choke point enemy territory

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Should prioritize attacking the choke point (territory 2)
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });

    test('assesses attack risk correctly', () => {
      // Setup: Two potential attacks with different risk profiles

      // Attack 1: Low risk (no enemy neighbors besides target)
      mockGame.createTerritory(1, 1, 4, { 2: 1 }); // Our territory - isolated
      mockGame.createTerritory(2, 2, 1, { 1: 1 }); // Enemy territory - weak

      // Attack 2: High risk (multiple strong enemy neighbors)
      mockGame.createTerritory(3, 1, 4, { 4: 1, 5: 1, 6: 1 }); // Our territory - exposed
      mockGame.createTerritory(4, 2, 1, { 3: 1 }); // Enemy territory - target
      mockGame.createTerritory(5, 2, 7, { 3: 1 }); // Enemy territory - strong
      mockGame.createTerritory(6, 3, 6, { 3: 1 }); // Another enemy - strong

      // Set to risk-averse strategy
      mockGame.player[1].area_c = 10; // Lots of territories, so protect them
      mockGame.player[1].dice_c = 20;

      mockGame.recalculatePlayerStats();

      // Force a very low risk tolerance with deterministic random
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.1);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Should choose the low-risk attack (territory 1 -> territory 2)
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });
  });

  describe('Border and Connectivity Analysis', () => {
    test('prioritizes attacks that reduce border exposure', () => {
      // Setup: Two potential attacks with different border effects

      // Attack 1: Reduces border (fills a hole in our territory)
      mockGame.createTerritory(1, 1, 5, { 2: 1, 3: 1, 4: 1 }); // Our territory 1
      mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1, 4: 1 }); // Enemy territory (hole)
      mockGame.createTerritory(3, 1, 3, { 1: 1, 2: 1 }); // Our territory 2
      mockGame.createTerritory(4, 1, 3, { 1: 1, 2: 1 }); // Our territory 3

      // Attack 2: Increases border (extends our reach but creates more exposure)
      mockGame.createTerritory(5, 1, 5, { 6: 1 }); // Our territory 4
      mockGame.createTerritory(6, 2, 1, { 5: 1, 7: 1, 8: 1 }); // Enemy territory (bridge)
      mockGame.createTerritory(7, 3, 3, { 6: 1 }); // Other enemy 1
      mockGame.createTerritory(8, 4, 3, { 6: 1 }); // Other enemy 2

      // Set to consolidation strategy
      mockGame.player[1].area_c = 4;
      mockGame.player[1].area_tc = 4;

      mockGame.recalculatePlayerStats();

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Should prefer the attack that reduces border exposure (attack 1)
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });

    test('prioritizes attacks that improve connectivity', () => {
      // Setup: Two valid attacks with different connectivity impacts

      // First, setup a mock for set_area_tc that simulates connectivity changes
      const mockConnectivity = {
        1: 2, // Player 1 has 2 connected territories initially
      };

      mockGame.set_area_tc = vi.fn(playerNum => {
        // Simulate recalculation of area_tc
        if (playerNum === 1) {
          // When territory 2 is captured, area_tc increases to 3
          if (mockGame.adat[2].arm === 1) {
            mockConnectivity[1] = 3;
          }
          mockGame.player[1].area_tc = mockConnectivity[1];
        }
      });

      // Attack 1: Improves connectivity (connects isolated territories)
      mockGame.createTerritory(1, 1, 4, { 2: 1 }); // Our territory 1
      mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1 }); // Enemy territory (bridge)
      mockGame.createTerritory(3, 1, 3, { 2: 1 }); // Our isolated territory 2

      // Attack 2: No connectivity improvement
      mockGame.createTerritory(4, 1, 4, { 5: 1 }); // Our territory 3
      mockGame.createTerritory(5, 2, 1, { 4: 1 }); // Dead-end enemy territory

      mockGame.player[1].area_c = 3; // We have 3 territories total
      mockGame.player[1].area_tc = 2; // But only 2 are connected

      // Mock Math.random to ensure consistent results
      const originalRandom = Math.random;
      Math.random = vi.fn().mockReturnValue(0.5);

      ai_adaptive(mockGame);

      // Restore Math.random
      Math.random = originalRandom;

      // Should prefer the attack that improves connectivity (attack 1)
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(2);
    });
  });

  describe('Press-to-close (issue #115)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test('attacks 8v8 as the clear leader of a 3-player field instead of passing', () => {
      /*
       * The measured worst case (~69% endgame-lead pass): me (player 1) is the
       * strict territory leader of a 3-player field with a maxed frontier.
       * determineStrategy hands the dominant leader aggression ≈ 0.5, and the
       * old move filter required aggression > 0.7 for an even 8v8 outside the
       * 2-player endgame — so generateMoves returned [] and the bot passed.
       */
      mockGame.createTerritory(1, 1, 8, { 4: 1 });
      mockGame.createTerritory(2, 1, 8);
      mockGame.createTerritory(3, 1, 8);
      mockGame.createTerritory(4, 2, 8, { 1: 1 });
      mockGame.createTerritory(5, 2, 8);
      mockGame.createTerritory(6, 3, 8);
      mockGame.recalculatePlayerStats();
      mockGame.setPlayerRankings();

      // Pin selectBestMove's RNG onto its deterministic moves[0] path.
      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      const result = ai_adaptive(mockGame);

      expect(result).not.toBe(0);
      expect(mockGame.area_from).toBe(1);
      expect(mockGame.area_to).toBe(4);
    });

    test('still passes the same frontier when not clearly winning (4 players, tied lead)', () => {
      // Tied territories, dice share ≤ 0.35, four players alive: the press
      // gate must NOT fire, pinning pre-#115 patience outside the winning case.
      mockGame.createTerritory(1, 1, 8, { 4: 1 });
      mockGame.createTerritory(2, 1, 8);
      mockGame.createTerritory(3, 1, 8);
      mockGame.createTerritory(4, 2, 8, { 1: 1 });
      mockGame.createTerritory(5, 2, 8);
      mockGame.createTerritory(6, 2, 8);
      mockGame.createTerritory(7, 3, 8);
      mockGame.createTerritory(8, 3, 8);
      mockGame.createTerritory(9, 4, 8);
      mockGame.recalculatePlayerStats();
      mockGame.setPlayerRankings();

      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      expect(ai_adaptive(mockGame)).toBe(0);
    });
  });
});
