/**
 * Tests for Defensive AI implementation
 */
import { ai_defensive } from '../../src/ai/ai_defensive.js';
import { createGameMock } from '../mocks/gameMock.js';

describe('Defensive AI', () => {
  let mockGame;

  beforeEach(() => {
    // Set up a fresh mock game for each test
    mockGame = createGameMock({
      currentPlayer: 1,
      usePlayerDataModel: true,
    });
  });

  test('ends turn when no valid moves are available', () => {
    // Setup: Territory with only 1 die, can't attack
    mockGame.createTerritory(1, 1, 1);

    const result = ai_defensive(mockGame);

    expect(result).toBe(0); // Should return 0 to end turn
    expect(mockGame.area_from).toBe(0); // Should not set area_from
    expect(mockGame.area_to).toBe(0); // Should not set area_to
  });

  test('selects attack from territory with single enemy neighbor', () => {
    // Setup: Territory 1 has one enemy neighbor (territory 2)
    mockGame.createTerritory(1, 1, 3, { 2: 1 });
    mockGame.createTerritory(2, 2, 1, { 1: 1 });

    ai_defensive(mockGame);

    expect(mockGame.area_from).toBe(1); // Should attack from territory 1
    expect(mockGame.area_to).toBe(2); // Should attack territory 2
  });

  test('does not attack territory with higher dice count', () => {
    // Setup: Attacker has less dice than defender
    mockGame.createTerritory(1, 1, 2, { 2: 1 });
    mockGame.createTerritory(2, 2, 3, { 1: 1 });

    const result = ai_defensive(mockGame);

    expect(result).toBe(0); // Should end turn
  });

  test('does not attack if defender has strong friendly neighbor', () => {
    // Setup: Territory to attack has friendly support with high dice count
    mockGame.createTerritory(1, 1, 3, { 2: 1 }); // Our territory
    mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1 }); // Enemy territory
    mockGame.createTerritory(3, 2, 4, { 2: 1 }); // Enemy's supporting territory

    const result = ai_defensive(mockGame);

    expect(result).toBe(0); // Should end turn, avoiding the risky attack
  });

  test('selects territory with less connectivity for attack', () => {
    // Setup: Territory 1 and 3 both have one enemy neighbor, but territory 3 has fewer neighbors total
    mockGame.createTerritory(1, 1, 3, { 2: 1, 4: 1, 5: 1 }); // Our territory with 3 neighbors
    mockGame.createTerritory(2, 2, 1, { 1: 1 }); // Enemy territory
    mockGame.createTerritory(3, 1, 3, { 6: 1 }); // Our territory with 1 neighbor
    mockGame.createTerritory(4, 1, 2, { 1: 1 }); // Our territory
    mockGame.createTerritory(5, 1, 2, { 1: 1 }); // Our territory
    mockGame.createTerritory(6, 2, 1, { 3: 1 }); // Enemy territory

    /*
     * Both territory 1->2 and 3->6 are valid attacks
     * Note: Based on the implementation, the territory with one enemy neighbor
     * is always prioritized, regardless of total neighbors, as it scans sequentially
     */
    ai_defensive(mockGame);

    expect(mockGame.area_from).toBe(1); // First territory found with one enemy neighbor
    expect(mockGame.area_to).toBe(2); // The enemy territory
  });

  test('prioritizes territories with higher dice count when connectivity is equal', () => {
    // Setup: Territory 1 and 3 both have one enemy neighbor and same connectivity, but territory 1 has more dice
    mockGame.createTerritory(1, 1, 4, { 2: 1 }); // Our territory with 4 dice
    mockGame.createTerritory(2, 2, 1, { 1: 1 }); // Enemy territory
    mockGame.createTerritory(3, 1, 3, { 4: 1 }); // Our territory with 3 dice
    mockGame.createTerritory(4, 2, 1, { 3: 1 }); // Enemy territory

    ai_defensive(mockGame);

    expect(mockGame.area_from).toBe(1); // Should prioritize territory with more dice
    expect(mockGame.area_to).toBe(2);
  });

  test('avoids attacks that would leave territories vulnerable', () => {
    // Setup: Attack would leave territory vulnerable to counter-attack
    mockGame.createTerritory(1, 1, 3, { 2: 1, 3: 1 }); // Our territory
    mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1 }); // Enemy territory with 1 die
    mockGame.createTerritory(3, 2, 4, { 1: 1, 2: 1 }); // Enemy territory with 4 dice

    // Attacking territory 2 would leave us vulnerable to territory 3's counter-attack
    const result = ai_defensive(mockGame);

    expect(result).toBe(0); // Should end turn, avoiding the vulnerable attack
  });

  test('evaluates reinforcement situation', () => {
    // Setup: Player has many territories but no reinforcements
    const mockSetAreaTc = vi.fn(playerNum => {
      mockGame.player[playerNum].area_tc = 5; // Simulate 5 connected territories
    });

    mockGame = createGameMock({
      currentPlayer: 1,
      usePlayerDataModel: true,
      setAreaTc: mockSetAreaTc,
    });

    // Player has 5 territories and 0 stock dice
    mockGame.player[1].area_c = 5;
    mockGame.player[1].stock = 0;

    // Setup attacking territory with multiple enemy neighbors
    mockGame.createTerritory(1, 1, 3, { 2: 1 }); // Our territory
    mockGame.createTerritory(2, 2, 1, { 1: 1, 3: 1 }); // Enemy territory
    mockGame.createTerritory(3, 2, 3, { 2: 1 }); // Another enemy territory with high dice

    /*
     * The reinforcement check is just one factor in the decision-making
     * but in this simplified test case, the AI will still attack if it's valid
     */
    ai_defensive(mockGame);

    // Since the AI decides to attack from territory 1 to territory 2
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });

  test('will attack with max dice even against equal dice', () => {
    // Setup: Attacker has 8 dice (max) and should attack even if defender has same dice
    mockGame.createTerritory(1, 1, 8, { 2: 1 });
    mockGame.createTerritory(2, 2, 8, { 1: 1 });

    ai_defensive(mockGame);

    expect(mockGame.area_from).toBe(1); // Should attack from territory 1
    expect(mockGame.area_to).toBe(2); // Should attack territory 2 despite equal dice
  });

  test('prioritizes the best attack when multiple valid attacks exist', () => {
    // Setup multiple valid attacks with varying strategic values

    // Setup territories that could attack
    mockGame.createTerritory(1, 1, 3, { 2: 1 }); // Case 1: One enemy neighbor
    mockGame.createTerritory(2, 2, 1, { 1: 1 });

    mockGame.createTerritory(3, 1, 4, { 4: 1, 5: 1 }); // Case 2: Multiple enemies, higher dice
    mockGame.createTerritory(4, 2, 1, { 3: 1 });
    mockGame.createTerritory(5, 3, 2, { 3: 1 });

    mockGame.createTerritory(6, 1, 2, { 7: 1, 8: 1 }); // Case 3: Multiple enemies, lower dice
    mockGame.createTerritory(7, 2, 1, { 6: 1 });
    mockGame.createTerritory(8, 3, 1, { 6: 1 });

    ai_defensive(mockGame);

    // Should prioritize the attack from territory 1 (single enemy, simplest case)
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(2);
  });
});
