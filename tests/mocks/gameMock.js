/**
 * Game Mock Helper
 *
 * Provides utilities for creating mock game objects for AI testing
 */
import { AreaData } from '../../src/models/AreaData.js';

/**
 * Creates a standardized mock game object for AI testing
 *
 * @param {Object} options - Configuration options
 * @param {number} options.currentPlayer - The current player number
 * @param {boolean} options.usePlayerDataModel - If true, use player[] array, otherwise simplified get_pn method
 * @param {Function} options.setAreaTc - Optional function to set area_tc for a player
 * @returns {Object} A mock game object
 */
export const createGameMock = (options = {}) => {
  const { currentPlayer = 1, usePlayerDataModel = true, setAreaTc = null } = options;

  // Create the basic mock game
  const mockGame = {
    AREA_MAX: 32,
    adat: [],
    area_from: 0,
    area_to: 0,
    get_pn: vi.fn().mockReturnValue(currentPlayer),
  };

  // Initialize area data
  for (let i = 0; i < mockGame.AREA_MAX; i++) {
    mockGame.adat[i] = new AreaData();
  }

  // If using player model, add player array
  if (usePlayerDataModel) {
    mockGame.jun = Array(8)
      .fill()
      .map((_, i) => i);
    mockGame.ban = currentPlayer;
    mockGame.player = [];

    for (let i = 0; i < 8; i++) {
      mockGame.player[i] = {
        area_c: 0, // Territory count
        area_tc: 0, // Connected territory count
        dice_c: 0, // Total dice count
        dice_jun: 0, // Dice ranking
        stock: 0, // Stock dice (reinforcements)
      };
    }
  }

  // Add optional set_area_tc method
  if (setAreaTc) {
    mockGame.set_area_tc = setAreaTc;
  } else {
    // Default implementation that just sets area_tc equal to area_c
    mockGame.set_area_tc = playerNum => {
      if (mockGame.player && mockGame.player[playerNum]) {
        mockGame.player[playerNum].area_tc = mockGame.player[playerNum].area_c;
      }
    };
  }

  /**
   * Utility to create a territory in the mock game
   *
   * @param {number} id - Territory ID
   * @param {number} owner - Player who owns the territory
   * @param {number} dice - Number of dice in the territory
   * @param {Object} adjacentTo - Map of adjacent territory IDs to 1 (is adjacent)
   * @returns {Object} The mock game object for chaining
   */
  mockGame.createTerritory = (id, owner, dice, adjacentTo = {}) => {
    mockGame.adat[id].size = 10; // Non-zero size means the territory exists
    mockGame.adat[id].arm = owner;
    mockGame.adat[id].dice = dice;

    // Clear existing joins and set new ones
    mockGame.adat[id].join = Array(32).fill(0);

    // Set adjacency
    Object.keys(adjacentTo).forEach(adjId => {
      const adjValue = adjacentTo[adjId];
      mockGame.adat[id].join[adjId] = adjValue;

      // Make connection bi-directional if not already set
      if (mockGame.adat[adjId].size > 0 && mockGame.adat[adjId].join[id] === 0) {
        mockGame.adat[adjId].join[id] = adjValue;
      }
    });

    // Update player counts if using player model
    if (usePlayerDataModel && mockGame.player && mockGame.player[owner]) {
      mockGame.player[owner].area_c++;
      mockGame.player[owner].dice_c += dice;
    }

    return mockGame;
  };

  /**
   * Recalculates player statistics for the game
   * Useful after setting up complex game states
   *
   * @returns {Object} The mock game object for chaining
   */
  mockGame.recalculatePlayerStats = () => {
    if (!usePlayerDataModel || !mockGame.player) return mockGame;

    // Reset counters
    for (let i = 0; i < 8; i++) {
      mockGame.player[i].area_c = 0;
      mockGame.player[i].dice_c = 0;
    }

    // Count territories and dice
    for (let i = 1; i < mockGame.AREA_MAX; i++) {
      const area = mockGame.adat[i];
      if (area.size === 0) continue;

      const playerIndex = area.arm;
      if (mockGame.player[playerIndex]) {
        mockGame.player[playerIndex].area_c++;
        mockGame.player[playerIndex].dice_c += area.dice;
      }
    }

    // Update connected territories count
    for (let i = 0; i < 8; i++) {
      if (mockGame.player[i].area_c > 0) {
        mockGame.set_area_tc(i);
      }
    }

    return mockGame;
  };

  /**
   * Sets dice rankings based on dice count
   *
   * @returns {Object} The mock game object for chaining
   */
  mockGame.setPlayerRankings = () => {
    if (!usePlayerDataModel || !mockGame.player) return mockGame;

    // Create array of player indices with their dice counts
    const playerRankings = Array.from({ length: 8 }, (_, i) => ({
      playerIndex: i,
      diceCount: mockGame.player[i].dice_c,
    }));

    // Sort by dice count (descending)
    playerRankings.sort((a, b) => b.diceCount - a.diceCount);

    // Assign ranks
    playerRankings.forEach((player, rank) => {
      mockGame.player[player.playerIndex].dice_jun = rank;
    });

    return mockGame;
  };

  return mockGame;
};
