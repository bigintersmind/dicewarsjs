/**
 * Tests for Battle Resolution Module
 */

// Import the actual module after mocks are set up
import {
  rollDice,
  calculateAttackProbability,
  resolveBattle,
  executeAttack,
  distributeReinforcements,
  setPlayerTerritoryData,
} from '../../src/mechanics/battleResolution.js';

// Import mocked modules
import {
  gameEvents,
  EventType,
  emitTerritoryAttack,
  emitTerritoryCapture,
  emitDiceRolled,
  emitTerritoryReinforced,
} from '../../src/mechanics/eventSystem.js';

import { validateTerritories, validatePlayer } from '../../src/mechanics/errorHandling.js';

import { setAreaTc } from '../../src/mechanics/mapGenerator.js';

import { HistoryData } from '../../src/models/index.js';

import { BattleError, PlayerError, TerritoryError } from '../../src/mechanics/errors/index.js';

// Mock dependencies before importing the module
vi.mock('../../src/mechanics/eventSystem.js', () => ({
  gameEvents: {
    emit: vi.fn(),
  },
  EventType: {
    TERRITORY_ATTACK: 'territory:attack',
    TERRITORY_CAPTURE: 'territory:capture',
    DICE_ROLLED: 'dice:rolled',
    DICE_ADDED: 'dice:added',
    TURN_START: 'turn:start',
    TERRITORY_REINFORCED: 'territory:reinforced',
    TERRITORY_DEFEND: 'territory:defend',
    PLAYER_ELIMINATED: 'player:eliminated',
    PLAYER_VICTORY: 'player:victory',
  },
  emitTerritoryAttack: vi.fn(),
  emitTerritoryCapture: vi.fn(),
  emitDiceRolled: vi.fn(),
  emitTerritoryReinforced: vi.fn(),
}));

vi.mock('../../src/mechanics/mapGenerator.js', () => ({
  setAreaTc: vi.fn(),
}));

vi.mock('../../src/mechanics/errorHandling.js', () => ({
  validateTerritories: vi.fn(),
  validatePlayer: vi.fn(),
  withErrorHandling:
    (fn, errorHandler) =>
    (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        if (errorHandler) {
          return errorHandler(error, ...args);
        }
        throw error;
      }
    },
}));

vi.mock('../../src/models/index.js', () => ({
  HistoryData: vi.fn().mockImplementation(() => ({
    from: 0,
    to: 0,
    res: 0,
  })),
}));

describe('Battle Resolution Module', () => {
  describe('rollDice', () => {
    it('should roll the correct number of dice', () => {
      const result = rollDice(3);
      expect(result.values).toHaveLength(3);
      expect(result.values.every(v => v >= 1 && v <= 6)).toBe(true);
      expect(result.total).toBe(result.values.reduce((a, b) => a + b, 0));
    });

    it('should handle 0 dice', () => {
      const result = rollDice(0);
      expect(result.values).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should handle negative dice count', () => {
      const result = rollDice(-1);
      expect(result.values).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should throw error for non-number input', () => {
      expect(() => rollDice('not a number')).toThrow('Expected count to be a number');
    });

    it('should produce different results on multiple rolls', () => {
      const rolls = Array.from({ length: 10 }, () => rollDice(2));
      const uniqueTotals = new Set(rolls.map(r => r.total));
      expect(uniqueTotals.size).toBeGreaterThan(1);
    });
  });

  describe('calculateAttackProbability', () => {
    it('should calculate probability for equal dice', () => {
      const prob = calculateAttackProbability(3, 3);
      expect(prob).toBeCloseTo(0.5, 2);
    });

    it('should give high probability for overwhelming attacker advantage', () => {
      const prob = calculateAttackProbability(9, 3);
      expect(prob).toBeCloseTo(0.95, 2);
    });

    it('should give low probability for overwhelming defender advantage', () => {
      const prob = calculateAttackProbability(3, 9);
      expect(prob).toBeCloseTo(0.05, 2);
    });

    it('should handle edge cases', () => {
      expect(calculateAttackProbability(0, 5)).toBe(0);
      expect(calculateAttackProbability(5, 0)).toBe(0);
      expect(calculateAttackProbability(0, 0)).toBe(0);
    });

    it('should throw error for non-number inputs', () => {
      expect(() => calculateAttackProbability('3', 3)).toThrow('Dice counts must be numbers');
      expect(() => calculateAttackProbability(3, null)).toThrow('Dice counts must be numbers');
    });

    it('should calculate reasonable probability for typical cases', () => {
      const prob1 = calculateAttackProbability(4, 3);
      expect(prob1).toBeGreaterThan(0.5);
      expect(prob1).toBeLessThan(0.8);

      const prob2 = calculateAttackProbability(2, 3);
      expect(prob2).toBeGreaterThan(0.2);
      expect(prob2).toBeLessThan(0.5);
    });
  });

  describe('resolveBattle', () => {
    let gameState;

    beforeEach(() => {
      validateTerritories.mockImplementation(() => {});

      gameState = {
        adat: {
          1: { dice: 4, arm: 1 },
          2: { dice: 3, arm: 2 },
        },
      };

      // Mock Math.random for predictable tests
      vi.spyOn(Math, 'random');
    });

    afterEach(() => {
      Math.random.mockRestore();
      vi.clearAllMocks();
    });

    it('should resolve a battle with attacker victory', () => {
      /*
       * Mock dice rolls: attacker totals to 15, defender totals to 9
       * Die calculation: Math.floor(Math.random() * 6) + 1
       */
      Math.random
        .mockReturnValueOnce(0.5) // Math.floor(0.5 * 6) + 1 = 4
        .mockReturnValueOnce(0.67) // Math.floor(0.67 * 6) + 1 = 5
        .mockReturnValueOnce(0.83) // Math.floor(0.83 * 6) + 1 = 5
        .mockReturnValueOnce(0.83) // Math.floor(0.83 * 6) + 1 = 5
        .mockReturnValueOnce(0) // Math.floor(0 * 6) + 1 = 1
        .mockReturnValueOnce(0.17) // Math.floor(0.17 * 6) + 1 = 2
        .mockReturnValueOnce(0.83); // Math.floor(0.83 * 6) + 1 = 5

      const result = resolveBattle(gameState, 1, 2);

      expect(validateTerritories).toHaveBeenCalledWith(gameState, 1, 2);
      expect(result.success).toBe(true);
      expect(result.attackerArea).toBe(1);
      expect(result.defenderArea).toBe(2);
      expect(result.attackerDice).toBe(4);
      expect(result.defenderDice).toBe(3);
      // With the mocked dice rolls, expect calculated totals
      const expectedAttackerTotal = 4 + 5 + 5 + 5; // 19
      const expectedDefenderTotal = 1 + 2 + 5; // 8
      expect(result.attackerRoll.total).toBe(expectedAttackerTotal);
      expect(result.defenderRoll.total).toBe(expectedDefenderTotal);

      expect(emitDiceRolled).toHaveBeenCalledTimes(2);
    });

    it('should resolve a battle with defender victory', () => {
      /*
       * Mock dice rolls: attacker totals to 6, defender totals to 15
       * Die calculation: Math.floor(Math.random() * 6) + 1
       */
      Math.random
        .mockReturnValueOnce(0) // Math.floor(0 * 6) + 1 = 1
        .mockReturnValueOnce(0) // Math.floor(0 * 6) + 1 = 1
        .mockReturnValueOnce(0.17) // Math.floor(0.17 * 6) + 1 = 2
        .mockReturnValueOnce(0.33) // Math.floor(0.33 * 6) + 1 = 2
        .mockReturnValueOnce(0.83) // Math.floor(0.83 * 6) + 1 = 5
        .mockReturnValueOnce(0.83) // Math.floor(0.83 * 6) + 1 = 5
        .mockReturnValueOnce(0.83); // Math.floor(0.83 * 6) + 1 = 5

      const result = resolveBattle(gameState, 1, 2);

      expect(result.success).toBe(false);
      expect(result.attackerRoll.total).toBe(6);
      expect(result.defenderRoll.total).toBe(15);
    });

    it('should throw BattleError when validation fails', () => {
      validateTerritories.mockImplementation(() => {
        throw new TerritoryError('Invalid territory', 1);
      });

      expect(() => resolveBattle(gameState, 1, 2)).toThrow(TerritoryError);
    });

    it('should convert non-GameError to BattleError', () => {
      validateTerritories.mockImplementation(() => {
        throw new Error('Generic error');
      });

      expect(() => resolveBattle(gameState, 1, 2)).toThrow(BattleError);
    });
  });

  describe('executeAttack', () => {
    let gameState;

    beforeEach(() => {
      validateTerritories.mockImplementation(() => {});
      validatePlayer.mockImplementation(() => {});
      setAreaTc.mockImplementation(() => {});

      gameState = {
        adat: {
          1: { dice: 4, arm: 1, join: { 2: 1 }, size: 5 },
          2: { dice: 3, arm: 2, join: { 1: 1 }, size: 4 },
          3: { dice: 2, arm: 2, join: {}, size: 3 },
        },
        his: {},
        his_c: 0,
        player: {
          1: { area_c: 1 },
          2: { area_c: 2 },
        },
      };

      // Mock Math.random for predictable tests
      vi.spyOn(Math, 'random');
      Math.random.mockReturnValue(0.5); // Attacker wins
    });

    afterEach(() => {
      Math.random.mockRestore();
      vi.clearAllMocks();
    });

    it('should execute a successful attack', () => {
      const result = executeAttack(gameState, 1, 2, 1);

      expect(validateTerritories).toHaveBeenCalledWith(gameState, 1, 2, 1);
      expect(validatePlayer).toHaveBeenCalledWith(gameState, 1);
      expect(emitTerritoryAttack).toHaveBeenCalledWith(expect.any(Object), 1, 2);

      expect(result.success).toBe(true);
      expect(result.gameState.defeat).toBe(1);
      expect(result.gameState.his_c).toBe(1);
      expect(result.gameState.adat[2].arm).toBe(1); // Territory captured
      expect(result.gameState.adat[2].dice).toBe(3); // 4 - 1
      expect(result.gameState.adat[1].dice).toBe(1); // Attacker left with 1

      expect(emitTerritoryCapture).toHaveBeenCalled();
      expect(setAreaTc).toHaveBeenCalledTimes(2); // For both players
    });

    it('should execute a failed attack', () => {
      // Mock dice rolls to ensure defender wins
      Math.random
        .mockReturnValueOnce(0) // Attacker dice 1: 1
        .mockReturnValueOnce(0) // Attacker dice 2: 1
        .mockReturnValueOnce(0) // Attacker dice 3: 1
        .mockReturnValueOnce(0) // Attacker dice 4: 1
        .mockReturnValueOnce(0.5) // Defender dice 1: 4
        .mockReturnValueOnce(0.5) // Defender dice 2: 4
        .mockReturnValueOnce(0.5); // Defender dice 3: 4

      const result = executeAttack(gameState, 1, 2, 1);

      expect(result.success).toBe(false);
      expect(result.gameState.defeat).toBe(0);
      expect(result.gameState.adat[2].arm).toBe(2); // Territory unchanged
      expect(result.gameState.adat[1].dice).toBe(1); // Attacker loses dice

      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.TERRITORY_DEFEND,
        expect.objectContaining({
          territoryId: 2,
          attackerId: 1,
        })
      );
    });

    it('should handle player elimination', () => {
      gameState.player[2].area_c = 1; // Last territory

      const result = executeAttack(gameState, 1, 2, 1);

      expect(result.success).toBe(true);

      // Note: area_c update would be done by setPlayerTerritoryData
      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.PLAYER_ELIMINATED,
        expect.objectContaining({
          playerId: 2,
          eliminatedBy: 1,
        })
      );
    });

    it('should handle player victory', () => {
      // Set up game state with only 2 territories to simplify the test
      gameState.player[1].area_c = 1; // Currently owns 1 territory
      gameState.player[2].area_c = 1; // Currently owns 1 territory

      // Total territories in game: 2
      gameState.adat = {
        1: { dice: 4, arm: 1, join: { 2: 1 }, size: 5 },
        2: { dice: 3, arm: 2, join: { 1: 1 }, size: 4 },
      };
      gameState.AREA_MAX = 3; // Update to match the test

      const result = executeAttack(gameState, 1, 2, 1);

      expect(result.success).toBe(true);

      // Territory capture event should be emitted through the mocked function
      expect(emitTerritoryCapture).toHaveBeenCalledWith(
        expect.any(Object), // gameState
        2, // toArea
        2, // previousOwner
        1 // attackingPlayer
      );

      // Player eliminated event should be called
      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.PLAYER_ELIMINATED,
        expect.objectContaining({
          playerId: 2,
          eliminatedBy: 1,
        })
      );

      // Player victory should be called when player owns all territories
      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.PLAYER_VICTORY,
        expect.objectContaining({
          playerId: 1,
        })
      );

      // Debug: check the final state
      expect(result.gameState.player[1].area_c).toBe(2); // Should own both territories
      expect(result.gameState.player[2].area_c).toBe(0); // Should own no territories
    });

    it('should skip validation when no player ID provided', () => {
      const result = executeAttack(gameState, 1, 2);

      expect(validateTerritories).toHaveBeenCalledWith(gameState, 1, 2, undefined);
      expect(validatePlayer).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', () => {
      validateTerritories.mockImplementation(() => {
        throw new Error('Test error');
      });

      const result = executeAttack(gameState, 1, 2);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Test error');
      expect(result.error).toBeDefined();
      expect(result.gameState).toBe(gameState);
    });
  });

  describe('distributeReinforcements', () => {
    let gameState;

    beforeEach(() => {
      validatePlayer.mockImplementation(() => {});

      gameState = {
        player: {
          1: {
            area_tc: 6,
            area_c: 2,
            stock: 3,
          },
        },
        adat: {
          1: { size: 5, arm: 1, dice: 3, join: { 2: 1, 3: 0 } },
          2: { size: 4, arm: 2, dice: 4, join: { 1: 1, 3: 1 } },
          3: { size: 3, arm: 1, dice: 7, join: { 2: 1 } },
        },
        AREA_MAX: 4,
        STOCK_MAX: 20,
        his: {},
        his_c: 0,
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should calculate and distribute reinforcements', () => {
      const result = distributeReinforcements(gameState, 1);

      expect(validatePlayer).toHaveBeenCalledWith(gameState, 1);

      // Should get area_tc=6 reinforcements (full largest connected group)
      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.DICE_ADDED,
        expect.objectContaining({
          playerId: 1,
          diceAdded: 6,
          stockTotal: 9,
        })
      );

      expect(emitTerritoryReinforced).toHaveBeenCalled();
      expect(result.his_c).toBeGreaterThan(0);
    });

    it('should give 1 reinforcement when largest group is 1', () => {
      gameState.player[1].area_tc = 1;

      const result = distributeReinforcements(gameState, 1);

      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.DICE_ADDED,
        expect.objectContaining({
          diceAdded: 1,
        })
      );
    });

    it('should handle player with no territories', () => {
      gameState.player[1].area_c = 0;
      gameState.player[1].area_tc = 0;

      const result = distributeReinforcements(gameState, 1);

      // Should get 0 reinforcements
      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.DICE_ADDED,
        expect.objectContaining({
          diceAdded: 0,
        })
      );
    });

    it('should respect stock maximum', () => {
      gameState.player[1].stock = 18;
      gameState.player[1].area_tc = 12; // Gets 12 reinforcements

      const result = distributeReinforcements(gameState, 1);

      /*
       * 18 + 12 = 30, but capped at STOCK_MAX=20
       * Territories 1 can go from 3->8 (5 dice) and 3 can go from 7->8 (1 dice)
       * Total of 6 dice can be distributed, leaving 20-6 = 14 in stock
       */

      expect(result.player[1].stock).toBe(14); // After distribution

      // The emit event should show 12 dice were added to stock (before cap)
      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.DICE_ADDED,
        expect.objectContaining({
          playerId: 1,
          diceAdded: 12,
          stockTotal: 20,
        })
      );
    });

    it('should skip territories at max dice', () => {
      gameState.adat[1].dice = 8; // Max dice
      gameState.player[1].stock = 5;

      const result = distributeReinforcements(gameState, 1);

      expect(result.adat[1].dice).toBe(8); // Unchanged
      expect(result.adat[3].dice).toBe(8); // Got the reinforcement
    });

    it('should handle no stock available', () => {
      gameState.player[1].stock = 0;
      gameState.player[1].area_tc = 0;

      const result = distributeReinforcements(gameState, 1);

      expect(result).toBe(gameState); // No changes
    });

    it('should emit turn start event', () => {
      distributeReinforcements(gameState, 1);

      expect(gameEvents.emit).toHaveBeenCalledWith(
        EventType.TURN_START,
        expect.objectContaining({
          playerId: 1,
          reinforcementsAdded: 6,
        })
      );
    });

    it('should handle errors gracefully', () => {
      validatePlayer.mockImplementation(() => {
        throw new PlayerError('Test error', 1);
      });

      const result = distributeReinforcements(gameState, 1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Test error');
      expect(result.gameState).toBe(gameState);
    });
  });

  describe('setPlayerTerritoryData', () => {
    let gameState;

    beforeEach(() => {
      setAreaTc.mockImplementation(() => {});

      gameState = {
        player: {
          1: { area_c: 0, dice_c: 0 },
        },
        adat: {
          1: { size: 5, arm: 1, dice: 3 },
          2: { size: 4, arm: 2, dice: 4 },
          3: { size: 3, arm: 1, dice: 2 },
        },
        AREA_MAX: 4,
      };
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should update player territory and dice counts', () => {
      setPlayerTerritoryData(gameState, 1);

      expect(gameState.player[1].area_c).toBe(2); // Territories 1 and 3
      expect(gameState.player[1].dice_c).toBe(5); // 3 + 2 dice
      expect(setAreaTc).toHaveBeenCalledWith(gameState, 1);
    });

    it('should handle player with no territories', () => {
      gameState.adat[1].arm = 2;
      gameState.adat[3].arm = 2;

      setPlayerTerritoryData(gameState, 1);

      expect(gameState.player[1].area_c).toBe(0);
      expect(gameState.player[1].dice_c).toBe(0);
    });

    it('should throw error for non-existent player', () => {
      expect(() => setPlayerTerritoryData(gameState, 99)).toThrow(PlayerError);
    });

    it('should skip non-existent territories', () => {
      gameState.adat[1].size = 0; // Non-existent

      setPlayerTerritoryData(gameState, 1);

      expect(gameState.player[1].area_c).toBe(1); // Only territory 3
      expect(gameState.player[1].dice_c).toBe(2);
    });
  });
});
