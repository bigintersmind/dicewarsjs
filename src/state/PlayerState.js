/**
 * PlayerState - Immutable Player State Management
 *
 * This module provides functions for working with immutable player data.
 * It manages player state like territory count, dice count, and game status.
 */

import { deepFreeze, updateObject } from './ImmutableUtils.js';

/**
 * Create a new player state object
 *
 * @param {number} id - Player ID
 * @param {Object} props - Player properties
 * @returns {Object} Immutable player state
 */
export const createPlayer = (id, props = {}) => {
  const player = {
    id,
    isHuman: id === 0, // By default, player 0 is human
    isActive: true,
    eliminated: false,
    territoryCount: 0,
    diceCount: 0,
    reserveDice: 0,
    largestTerritorySize: 0,
    territoryGroups: [],
    color: id, // Maps to color index
    ...props,
  };

  return deepFreeze(player);
};

/**
 * PlayerState utilities for working with immutable player data
 */
export const PlayerState = {
  /**
   * Create a new player
   *
   * @param {number} id - Player ID
   * @param {Object} props - Player properties
   * @returns {Object} Immutable player state
   */
  create: (id, props) => createPlayer(id, props),

  /**
   * Update a player with new values
   *
   * @param {Object} player - Original player state
   * @param {Object} updates - Properties to update
   * @returns {Object} New immutable player state
   */
  update: (player, updates) => updateObject(player, updates),

  /**
   * Add territories to a player
   *
   * @param {Object} player - Original player state
   * @param {number} count - Number of territories to add
   * @returns {Object} New player state with updated territory count
   */
  addTerritories: (player, count) =>
    updateObject(player, {
      territoryCount: player.territoryCount + count,
    }),

  /**
   * Remove territories from a player
   *
   * @param {Object} player - Original player state
   * @param {number} count - Number of territories to remove
   * @returns {Object} New player state with updated territory count
   */
  removeTerritories: (player, count) => {
    const newCount = Math.max(0, player.territoryCount - count);

    // Check if player is eliminated
    const eliminated = newCount === 0;

    return updateObject(player, {
      territoryCount: newCount,
      eliminated: eliminated || player.eliminated,
    });
  },

  /**
   * Add dice to a player's reserve
   *
   * @param {Object} player - Original player state
   * @param {number} count - Number of dice to add
   * @returns {Object} New player state with updated reserve
   */
  addReserveDice: (player, count) =>
    updateObject(player, {
      reserveDice: player.reserveDice + count,
    }),

  /**
   * Use dice from a player's reserve
   *
   * @param {Object} player - Original player state
   * @param {number} count - Number of dice to use
   * @returns {Object} New player state with updated reserve
   */
  useReserveDice: (player, count) => {
    const newReserve = Math.max(0, player.reserveDice - count);
    return updateObject(player, {
      reserveDice: newReserve,
    });
  },

  /**
   * Update player's total dice count
   *
   * @param {Object} player - Original player state
   * @param {number} count - New total dice count
   * @returns {Object} New player state with updated dice count
   */
  setDiceCount: (player, count) =>
    updateObject(player, {
      diceCount: count,
    }),

  /**
   * Calculate and update a player's largest territory size
   *
   * @param {Object} player - Original player state
   * @param {Array} territoryGroups - Array of territory groups
   * @returns {Object} New player state with updated territory group info
   */
  updateTerritoryGroups: (player, territoryGroups) => {
    // Find the largest group size
    let largestSize = 0;

    for (const group of territoryGroups) {
      if (group.territories.length > largestSize) {
        largestSize = group.territories.length;
      }
    }

    return updateObject(player, {
      territoryGroups: Object.freeze([...territoryGroups]),
      largestTerritorySize: largestSize,
    });
  },

  /**
   * Update player's state based on territory ownership
   *
   * @param {Object} player - Original player state
   * @param {Map<number, Object>} territories - Map of territory IDs to territories
   * @returns {Object} New player state with updated counts
   */
  recalculateFromTerritories: (player, territories) => {
    let territoryCount = 0;
    let diceCount = 0;

    // Count territories and dice owned by this player
    for (const territory of territories.values()) {
      if (territory.owner === player.id) {
        territoryCount++;
        diceCount += territory.diceCount;
      }
    }

    // Check if player is eliminated
    const eliminated = territoryCount === 0;

    return updateObject(player, {
      territoryCount,
      diceCount,
      eliminated: eliminated || player.eliminated,
    });
  },

  /**
   * Eliminate a player (mark as defeated)
   *
   * @param {Object} player - Original player state
   * @returns {Object} New player state marked as eliminated
   */
  eliminate: player =>
    updateObject(player, {
      eliminated: true,
      territoryCount: 0,
      diceCount: 0,
      reserveDice: 0,
      largestTerritorySize: 0,
    }),

  /**
   * Calculate reinforcement dice for a player
   *
   * @param {Object} player - Player state
   * @returns {number} Number of reinforcement dice to award
   */
  calculateReinforcements: player => {
    if (player.eliminated || !player.isActive) {
      return 0;
    }

    // Reinforcements = largest connected territory group (matches original DiceWars)
    return player.largestTerritorySize;
  },

  /**
   * Create a player state compatible with legacy code
   *
   * @param {Object} player - Immutable player state
   * @returns {Object} Legacy format player object
   */
  toLegacyFormat: player => ({
    area_c: player.territoryCount,
    dice_c: player.diceCount,
    stock: player.reserveDice,
    area_l: player.largestTerritorySize,
  }),

  /**
   * Create an immutable player state from legacy format
   *
   * @param {number} id - Player ID
   * @param {Object} legacyPlayer - Legacy format player
   * @returns {Object} Immutable player state
   */
  fromLegacyFormat: (id, legacyPlayer) =>
    createPlayer(id, {
      territoryCount: legacyPlayer.area_c || 0,
      diceCount: legacyPlayer.dice_c || 0,
      reserveDice: legacyPlayer.stock || 0,
      largestTerritorySize: legacyPlayer.area_l || 0,
      eliminated: (legacyPlayer.area_c || 0) === 0,
    }),
};
