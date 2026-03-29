/**
 * Tests for Enhanced PlayerData Class
 *
 * This file contains tests for the ES6+ implementation of the PlayerData class,
 * which uses private fields for better encapsulation.
 */

import { PlayerData } from '../../../src/models/enhanced/PlayerData.js';

describe('Enhanced PlayerData', () => {
  let playerData;

  beforeEach(() => {
    // Create a fresh PlayerData instance for each test
    playerData = new PlayerData();
  });

  describe('Constructor and initialization', () => {
    test('initializes with default values', () => {
      expect(playerData.areaCount).toBe(0);
      expect(playerData.largestTerritory).toBe(0);
      expect(playerData.diceCount).toBe(0);
      expect(playerData.diceRank).toBe(0);
      expect(playerData.stockedDice).toBe(0);
    });

    test('has legacy compatibility properties', () => {
      expect(playerData.area_c).toBe(0);
      expect(playerData.area_tc).toBe(0);
      expect(playerData.dice_c).toBe(0);
      expect(playerData.dice_jun).toBe(0);
      expect(playerData.stock).toBe(0);
    });
  });

  describe('Modern property accessors', () => {
    test('can set and get areaCount', () => {
      playerData.areaCount = 5;
      expect(playerData.areaCount).toBe(5);
    });

    test('can set and get largestTerritory', () => {
      playerData.largestTerritory = 8;
      expect(playerData.largestTerritory).toBe(8);
    });

    test('can set and get diceCount', () => {
      playerData.diceCount = 15;
      expect(playerData.diceCount).toBe(15);
    });

    test('can set and get diceRank', () => {
      playerData.diceRank = 2;
      expect(playerData.diceRank).toBe(2);
    });

    test('can set and get stockedDice', () => {
      playerData.stockedDice = 10;
      expect(playerData.stockedDice).toBe(10);
    });

    test('validates numeric input', () => {
      expect(() => {
        playerData.areaCount = -1;
      }).toThrow();
      expect(() => {
        playerData.areaCount = 'invalid';
      }).toThrow();
    });
  });

  describe('Legacy property compatibility', () => {
    test('area_c property matches areaCount', () => {
      playerData.areaCount = 7;
      expect(playerData.area_c).toBe(7);

      playerData.area_c = 9;
      expect(playerData.areaCount).toBe(9);
    });

    test('area_tc property matches largestTerritory', () => {
      playerData.largestTerritory = 12;
      expect(playerData.area_tc).toBe(12);

      playerData.area_tc = 15;
      expect(playerData.largestTerritory).toBe(15);
    });

    test('dice_c property matches diceCount', () => {
      playerData.diceCount = 25;
      expect(playerData.dice_c).toBe(25);

      playerData.dice_c = 30;
      expect(playerData.diceCount).toBe(30);
    });

    test('dice_jun property matches diceRank', () => {
      playerData.diceRank = 3;
      expect(playerData.dice_jun).toBe(3);

      playerData.dice_jun = 4;
      expect(playerData.diceRank).toBe(4);
    });

    test('stock property matches stockedDice', () => {
      playerData.stockedDice = 12;
      expect(playerData.stock).toBe(12);

      playerData.stock = 15;
      expect(playerData.stockedDice).toBe(15);
    });
  });

  describe('Stock management methods', () => {
    test('can add to stock', () => {
      expect(playerData.stockedDice).toBe(0);

      playerData.addStock(5);
      expect(playerData.stockedDice).toBe(5);

      playerData.addStock(3);
      expect(playerData.stockedDice).toBe(8);
    });

    test('respects max stock limit', () => {
      playerData.addStock(10, 15);
      expect(playerData.stockedDice).toBe(10);

      playerData.addStock(10, 15);
      expect(playerData.stockedDice).toBe(15); // Capped at maxStock
    });

    test('can use from stock', () => {
      playerData.stockedDice = 10;

      playerData.useStock(3);
      expect(playerData.stockedDice).toBe(7);

      playerData.useStock(5);
      expect(playerData.stockedDice).toBe(2);
    });

    test('throws error when using more than available stock', () => {
      playerData.stockedDice = 5;

      expect(() => {
        playerData.useStock(10);
      }).toThrow();
      expect(playerData.stockedDice).toBe(5); // Unchanged
    });
  });

  describe('Player state methods', () => {
    test('can update state in one operation', () => {
      playerData.updateState(5, 15, 3);

      expect(playerData.areaCount).toBe(5);
      expect(playerData.diceCount).toBe(15);
      expect(playerData.largestTerritory).toBe(3);
    });

    test('can detect defeated state', () => {
      playerData.areaCount = 0;
      expect(playerData.isDefeated()).toBe(true);

      playerData.areaCount = 3;
      expect(playerData.isDefeated()).toBe(false);
    });

    test('returns largest connected group size as reinforcements', () => {
      // No territories = no reinforcements
      playerData.areaCount = 0;
      playerData.largestTerritory = 0;
      expect(playerData.calculateReinforcements()).toBe(0);

      // Single territory
      playerData.areaCount = 1;
      playerData.largestTerritory = 2;
      expect(playerData.calculateReinforcements()).toBe(2);

      // Larger connected group
      playerData.areaCount = 5;
      playerData.largestTerritory = 9;
      expect(playerData.calculateReinforcements()).toBe(9);
    });
  });

  describe('Encapsulation', () => {
    test('private fields are properly encapsulated', () => {
      /*
       * Since private fields can't be accessed directly in tests,
       * we'll verify encapsulation by checking that the properties
       * aren't enumerable (they're accessed through getters/setters)
       */
      const propertyNames = Object.getOwnPropertyNames(playerData);
      expect(propertyNames).not.toContain('areaCount');
      expect(propertyNames).not.toContain('largestTerritory');
      expect(propertyNames).not.toContain('diceCount');
      expect(propertyNames).not.toContain('diceRank');
      expect(propertyNames).not.toContain('stockedDice');

      /*
       * We can also check that the object doesn't have direct properties
       * by using hasOwnProperty
       */
      expect(playerData.hasOwnProperty('areaCount')).toBe(false);
      expect(playerData.hasOwnProperty('largestTerritory')).toBe(false);
      expect(playerData.hasOwnProperty('diceCount')).toBe(false);
      expect(playerData.hasOwnProperty('diceRank')).toBe(false);
      expect(playerData.hasOwnProperty('stockedDice')).toBe(false);
    });
  });
});
