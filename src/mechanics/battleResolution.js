/**
 * Battle Resolution Module
 *
 * Provides functions for handling battles, dice rolls, and attack mechanics.
 * Implemented using functional programming patterns and ES6 features.
 */

import { HistoryData } from '../models/index.js';

// Import to avoid circular dependency
import { setAreaTc } from './mapGenerator.js';

// Import event system
import {
  gameEvents,
  EventType,
  emitTerritoryAttack,
  emitTerritoryCapture,
  emitDiceRolled,
  emitTerritoryReinforced,
} from './eventSystem.js';

// Import error handling utilities
import { validateTerritories, validatePlayer, withErrorHandling } from './errorHandling.js';
import { BattleError, PlayerError } from './errors/index.js';

// Import debug tools (will be auto disabled in production)
let measurePerformance = fn => fn; // Default no-op
if (process.env.NODE_ENV === 'development') {
  import('../utils/debugTools.js')
    .then(module => {
      if (module.isDebugModeEnabled()) {
        measurePerformance = module.measurePerformance;
      }
    })
    .catch(err => console.warn('Failed to load debug tools:', err));
}

/**
 * Roll dice for attack or defense
 *
 * Simulates rolling a specified number of dice for battle using a functional approach.
 *
 * @param {number} count - Number of dice to roll
 * @returns {Object} Dice values and total
 * @throws {Error} If count is invalid
 */
export const rollDice = count => {
  // Validate input
  if (typeof count !== 'number') {
    throw new Error(`Expected count to be a number, got ${typeof count}`);
  }

  if (count <= 0) {
    return { values: [], total: 0 };
  }

  // Generate dice rolls using array methods
  const values = Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);

  // Calculate total using reduce
  const total = values.reduce((sum, value) => sum + value, 0);

  return { values, total };
};

/**
 * Calculate Probability of Successful Attack
 *
 * Estimates the probability of winning a battle based on attacker and defender dice
 * using a functional approach with specialized case handling.
 *
 * @param {number} attackerDice - Number of dice the attacker has
 * @param {number} defenderDice - Number of dice the defender has
 * @returns {number} Probability of success as a value from 0 to 1
 * @throws {Error} If dice counts are invalid
 */
export const calculateAttackProbability = (attackerDice, defenderDice) => {
  // Validate inputs
  if (typeof attackerDice !== 'number' || typeof defenderDice !== 'number') {
    throw new Error('Dice counts must be numbers');
  }

  // Early return for edge cases
  if (attackerDice <= 0 || defenderDice <= 0) {
    return 0;
  }

  // Handle special cases with specific probability assignments
  const specialCases = [
    { condition: attackerDice >= defenderDice * 3, probability: 0.95 }, // Almost certain win
    { condition: defenderDice >= attackerDice * 3, probability: 0.05 }, // Almost certain loss
  ];

  // Find a matching special case
  const matchingCase = specialCases.find(({ condition }) => condition);
  if (matchingCase) {
    return matchingCase.probability;
  }

  // General case - sigmoid function based on dice ratio
  const ratio = attackerDice / defenderDice;
  return 1 / (1 + Math.exp(-2 * (ratio - 1)));
};

/**
 * Resolve Battle between Territories
 *
 * Simulates dice battle between attacking and defending territories.
 * Uses functional composition pattern and emits events.
 *
 * @param {Object} gameState - Game state including territories
 * @param {number} fromArea - Index of attacking territory
 * @param {number} toArea - Index of defending territory
 * @returns {Object} Battle results including success flag and dice values
 * @throws {BattleError} If battle cannot be resolved
 */
export const resolveBattle = measurePerformance(resolveBattleImplementation, 'battleResolution');

function resolveBattleImplementation(gameState, fromArea, toArea) {
  try {
    const { adat } = gameState;

    // Validate territories are valid for attack
    validateTerritories(gameState, fromArea, toArea);

    // Get dice counts
    const attackerDice = adat[fromArea].dice;
    const defenderDice = adat[toArea].dice;

    // Roll dice using the functional dice roller
    const attackerRoll = rollDice(attackerDice);
    const defenderRoll = rollDice(defenderDice);

    // Emit dice rolled events
    emitDiceRolled(gameState, fromArea, attackerRoll.values, attackerRoll.total, 'attack');
    emitDiceRolled(gameState, toArea, defenderRoll.values, defenderRoll.total, 'defend');

    // Determine outcome
    const success = attackerRoll.total > defenderRoll.total;

    // Create battle data object using shorthand property names
    return {
      attackerArea: fromArea,
      defenderArea: toArea,
      attackerDice,
      defenderDice,
      attackerRoll,
      defenderRoll,
      success,
    };
  } catch (error) {
    // Convert to BattleError if not already a GameError
    if (error.name !== 'TerritoryError' && error.name !== 'BattleError') {
      throw new BattleError(`Failed to resolve battle: ${error.message}`, fromArea, toArea, {
        originalError: error,
      });
    }
    throw error;
  }
}

/**
 * Execute an Attack
 *
 * Performs an attack between territories, updates game state, and records in history.
 * Uses a functional approach with clear separation of concerns.
 * Emits events for attack and territory capture.
 *
 * @param {Object} gameState - Game state including territories
 * @param {number} fromArea - Index of attacking territory
 * @param {number} toArea - Index of defending territory
 * @param {number} [currentPlayerId] - Optional ID of current player for validation
 * @returns {Object} Updated game state and battle results
 * @throws {BattleError} If attack fails due to validation or other errors
 */
export const executeAttack = withErrorHandling(
  (gameState, fromArea, toArea, currentPlayerId) => {
    const { adat } = gameState;

    // Validate territories and ownership if player ID provided
    validateTerritories(gameState, fromArea, toArea, currentPlayerId);

    // Validate player if provided
    if (currentPlayerId !== undefined) {
      validatePlayer(gameState, currentPlayerId);
    }

    // Record the attack in progress
    const updatedGameState = {
      ...gameState,
      area_from: fromArea,
      area_to: toArea,
    };

    // Emit territory attack event
    emitTerritoryAttack(updatedGameState, fromArea, toArea);

    // Resolve the battle
    const battle = resolveBattle(updatedGameState, fromArea, toArea);

    // Record outcome in game state
    updatedGameState.defeat = battle.success ? 1 : 0;

    // Ensure history entry exists
    if (!updatedGameState.his[updatedGameState.his_c]) {
      updatedGameState.his[updatedGameState.his_c] = new HistoryData();
    }

    // Record in history
    updatedGameState.his[updatedGameState.his_c].from = fromArea;
    updatedGameState.his[updatedGameState.his_c].to = toArea;
    updatedGameState.his[updatedGameState.his_c].res = battle.success ? 1 : 0;
    updatedGameState.his_c++;

    // Update territory state based on outcome using pure function pattern
    if (battle.success) {
      // Attacker conquers territory
      const previousOwner = adat[toArea].arm;
      const attackingPlayer = adat[fromArea].arm;

      // Territory changes ownership
      adat[toArea].arm = attackingPlayer;
      adat[toArea].dice = adat[fromArea].dice - 1;
      adat[fromArea].dice = 1;

      // Emit territory capture event
      emitTerritoryCapture(updatedGameState, toArea, previousOwner, attackingPlayer);

      // Update connected territories for affected players
      if (previousOwner !== attackingPlayer) {
        setPlayerTerritoryData(updatedGameState, previousOwner);
        setPlayerTerritoryData(updatedGameState, attackingPlayer);

        // Check if player has been eliminated
        if (updatedGameState.player[previousOwner].area_c === 0) {
          gameEvents.emit(EventType.PLAYER_ELIMINATED, {
            playerId: previousOwner,
            eliminatedBy: attackingPlayer,
            gameState: updatedGameState,
          });
        }

        // Check if player has won (has all territories)
        const totalTerritories = Object.values(adat).filter(area => area.size > 0).length;

        if (updatedGameState.player[attackingPlayer].area_c === totalTerritories) {
          gameEvents.emit(EventType.PLAYER_VICTORY, {
            playerId: attackingPlayer,
            gameState: updatedGameState,
          });
        }
      }
    } else {
      // Attack failed - attacker loses all but one die
      adat[fromArea].dice = 1;

      // Emit territory defend success event
      gameEvents.emit(EventType.TERRITORY_DEFEND, {
        territoryId: toArea,
        attackerId: fromArea,
        attackerPlayerId: adat[fromArea].arm,
        defenderPlayerId: adat[toArea].arm,
        gameState: updatedGameState,
      });
    }

    return {
      ...battle,
      gameState: updatedGameState,
    };
  },
  (error, gameState, fromArea, toArea) => {
    // Custom error handler for executeAttack
    console.error(`Attack failed from ${fromArea} to ${toArea}:`, error);

    // Return failure result
    return {
      success: false,
      message: error.message,
      error,
      attackerArea: fromArea,
      defenderArea: toArea,
      gameState,
    };
  }
);

/**
 * Calculate and distribute reinforcements
 *
 * Determines how many reinforcement dice a player receives and distributes them.
 * Uses functional programming patterns for territory selection and dice distribution.
 * Emits events for reinforcement.
 *
 * @param {Object} gameState - Game state including player data
 * @param {number} playerIndex - Player to distribute reinforcements for
 * @returns {Object} Updated gameState with reinforcements distributed
 * @throws {PlayerError} If player validation fails
 */
export const distributeReinforcements = withErrorHandling(
  (gameState, playerIndex) => {
    const { player, adat, AREA_MAX, STOCK_MAX } = gameState;

    // Validate player
    validatePlayer(gameState, playerIndex);

    // Calculate reinforcements with minimum of 1 if player has territories
    const calculateReinforcements = () => {
      const baseReinforcements = Math.floor(player[playerIndex].area_tc / 3);
      return player[playerIndex].area_c > 0 ? Math.max(baseReinforcements, 1) : baseReinforcements;
    };

    // Add reinforcements to player's stock, capped at maximum
    const addReinforcementsToStock = reinforcements => {
      player[playerIndex].stock = Math.min(player[playerIndex].stock + reinforcements, STOCK_MAX);

      // Emit event for reinforcements added to stock
      gameEvents.emit(EventType.DICE_ADDED, {
        playerId: playerIndex,
        diceAdded: reinforcements,
        stockTotal: player[playerIndex].stock,
        gameState,
      });
    };

    // Calculate and add reinforcements
    const reinforcements = calculateReinforcements();
    addReinforcementsToStock(reinforcements);

    // No reinforcements available
    if (player[playerIndex].stock <= 0) {
      return gameState;
    }

    // Find all territories owned by this player
    const findPlayerTerritories = () =>
      Array.from({ length: AREA_MAX })
        .map((_, i) => i)
        .filter(
          areaId =>
            areaId > 0 &&
            adat[areaId].size > 0 &&
            adat[areaId].arm === playerIndex &&
            adat[areaId].dice < 8 // Skip territories at max dice
        )
        .map(id => {
          // Check if this territory borders an enemy
          const isBorder =
            Array.from({ length: AREA_MAX })
              .map((_, j) => j)
              .filter(
                j =>
                  j > 0 && adat[j].size > 0 && adat[id].join[j] === 1 && adat[j].arm !== playerIndex
              ).length > 0;

          // Calculate priority score - border territories and those with fewer dice get priority
          const priority = (isBorder ? 100 : 0) + (8 - adat[id].dice) * 10;

          return { id, priority };
        })
        .sort((a, b) => b.priority - a.priority); // Sort by priority (higher first)

    const territories = findPlayerTerritories();

    // Distribute available reinforcements to territories based on priority
    const distributeAvailableDice = () => {
      let remainingStock = player[playerIndex].stock;
      let currentHistory = gameState.his_c;

      // Try to distribute to each territory in priority order until stock is depleted
      for (const { id } of territories) {
        if (remainingStock <= 0) break;

        // Check if territory can receive more dice
        if (adat[id].dice >= 8) {
          continue;
        }

        // Add a die to this territory
        adat[id].dice++;
        remainingStock--;

        // Emit territory reinforced event
        emitTerritoryReinforced(gameState, id, 1);

        // Add to history
        if (!gameState.his[currentHistory]) {
          gameState.his[currentHistory] = new HistoryData();
        }

        gameState.his[currentHistory].from = id;
        gameState.his[currentHistory].to = 0; // 0 indicates reinforcement, not attack
        gameState.his[currentHistory].res = 0;
        currentHistory++;
      }

      // Update the game state
      player[playerIndex].stock = remainingStock;
      return currentHistory;
    };

    // Distribute the dice and update history counter
    gameState.his_c = distributeAvailableDice();

    // Emit turn start event after reinforcements are distributed
    gameEvents.emit(EventType.TURN_START, {
      playerId: playerIndex,
      reinforcementsAdded: reinforcements,
      gameState,
    });

    return gameState;
  },
  (error, gameState, playerIndex) => {
    // Custom error handler for distributeReinforcements
    console.error(`Failed to distribute reinforcements for player ${playerIndex}:`, error);

    // Return unchanged game state
    return {
      success: false,
      message: error.message,
      error,
      gameState,
    };
  }
);

/**
 * Update player's territory and dice data
 *
 * Recalculates a player's total territories, dice, and connected groups.
 * Uses functional programming patterns for counting and grouping.
 *
 * @param {Object} gameState - Game state including player and territory data
 * @param {number} playerIndex - Player to update data for
 * @throws {PlayerError} If player data update fails
 */
export const setPlayerTerritoryData = withErrorHandling((gameState, playerIndex) => {
  const { player, adat, AREA_MAX } = gameState;

  // Validate player exists
  if (!player[playerIndex]) {
    throw new PlayerError(`Player ${playerIndex} does not exist`, playerIndex);
  }

  // Reset counters
  player[playerIndex].area_c = 0;
  player[playerIndex].dice_c = 0;

  // Count territories and dice using functional approach
  const playerTerritories = Array.from({ length: AREA_MAX })
    .map((_, i) => i)
    .filter(i => i > 0 && adat[i].size > 0 && adat[i].arm === playerIndex);

  // Update counters
  player[playerIndex].area_c = playerTerritories.length;
  player[playerIndex].dice_c = playerTerritories.reduce((total, id) => total + adat[id].dice, 0);

  // Calculate connected territory groups
  setAreaTc(gameState, playerIndex);
});
