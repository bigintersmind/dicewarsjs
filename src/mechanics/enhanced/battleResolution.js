/**
 * Enhanced Battle Resolution Module
 *
 * An ES6+ implementation of the battle resolution module that uses modern data structures
 * like Maps for better performance. Provides functions for handling battles, dice rolls,
 * and attack mechanics.
 */

import { Battle, HistoryData } from '../../models/enhanced/index.js';

// Import to avoid circular dependency
import { setAreaTc } from './mapGenerator.js';

/**
 * Roll dice for attack or defense
 *
 * Simulates rolling a specified number of dice for battle.
 *
 * @param {number} count - Number of dice to roll
 * @returns {Object} Dice values and total
 */
export function rollDice(count) {
  if (count <= 0) {
    return { values: [], total: 0 };
  }

  const values = [];
  let total = 0;

  // Generate 1-6 for each die
  for (let i = 0; i < count; i++) {
    const value = Math.floor(Math.random() * 6) + 1;
    values.push(value);
    total += value;
  }

  return { values, total };
}

/**
 * Calculate Probability of Successful Attack
 *
 * Estimates the probability of winning a battle based on attacker and defender dice.
 *
 * @param {number} attackerDice - Number of dice the attacker has
 * @param {number} defenderDice - Number of dice the defender has
 * @returns {number} Probability of success as a value from 0 to 1
 */
export function calculateAttackProbability(attackerDice, defenderDice) {
  // Simple probability model based on dice counts
  if (attackerDice <= 0 || defenderDice <= 0) {
    return 0;
  }

  // Base probability comes from the ratio of dice
  const ratio = attackerDice / defenderDice;

  /*
   * Apply sigmoid function to get a probability between 0 and 1
   * This creates an S-curve that's more realistic than linear
   */
  const probability = 1 / (1 + Math.exp(-2 * (ratio - 1)));

  // Adjust probability for extreme cases
  if (attackerDice >= defenderDice * 3) {
    return 0.95; // Almost certain win with 3:1 advantage
  }

  if (defenderDice >= attackerDice * 3) {
    return 0.05; // Almost certain loss with 1:3 disadvantage
  }

  return probability;
}

/**
 * Resolve Battle between Territories
 *
 * Simulates dice battle between attacking and defending territories.
 *
 * @param {Object} gameState - Game state including territories
 * @param {number} fromArea - Index of attacking territory
 * @param {number} toArea - Index of defending territory
 * @returns {Object} Battle results including success flag and dice values
 */
export function resolveBattle(gameState, fromArea, toArea) {
  const { adat } = gameState;

  // Get dice counts
  const attackerDice = adat[fromArea].dice;
  const defenderDice = adat[toArea].dice;

  // Roll dice
  const attackerRoll = rollDice(attackerDice);
  const defenderRoll = rollDice(defenderDice);

  // Determine outcome
  const success = attackerRoll.total > defenderRoll.total;

  // Create battle data object
  const battleData = {
    attackerArea: fromArea,
    defenderArea: toArea,
    attackerDice,
    defenderDice,
    attackerRoll,
    defenderRoll,
    success,
  };

  return battleData;
}

/**
 * Execute an Attack
 *
 * Performs an attack between territories, updates game state, and records in history.
 *
 * @param {Object} gameState - Game state including territories
 * @param {number} fromArea - Index of attacking territory
 * @param {number} toArea - Index of defending territory
 * @returns {Object} Updated game state and battle results
 */
export function executeAttack(gameState, fromArea, toArea) {
  const { adat, his, his_c } = gameState;

  // Validate attack
  if (fromArea <= 0 || toArea <= 0 || fromArea === toArea) {
    return { success: false, message: 'Invalid attack parameters' };
  }

  if (adat[fromArea].dice <= 1) {
    return { success: false, message: 'Need at least 2 dice to attack' };
  }

  // Check for adjacency using the Map-based method
  if (!adat[fromArea].isAdjacentTo(toArea)) {
    return { success: false, message: 'Territories must be adjacent' };
  }

  // Record the attack in progress
  gameState.area_from = fromArea;
  gameState.area_to = toArea;

  // Resolve the battle
  const battle = resolveBattle(gameState, fromArea, toArea);

  // Record outcome in game state
  gameState.defeat = battle.success ? 1 : 0;

  // Create a history entry
  if (!gameState.his[his_c]) {
    gameState.his[his_c] = new HistoryData();
  }

  gameState.his[his_c].from = fromArea;
  gameState.his[his_c].to = toArea;
  gameState.his[his_c].res = battle.success ? 1 : 0;
  gameState.his_c++;

  // Update territory state based on outcome
  if (battle.success) {
    // Attacker conquers territory
    const previousOwner = adat[toArea].arm;

    // Territory changes ownership
    adat[toArea].arm = adat[fromArea].arm;
    adat[toArea].dice = adat[fromArea].dice - 1;
    adat[fromArea].dice = 1;

    // Update connected territories for both players
    if (previousOwner !== adat[fromArea].arm) {
      setPlayerTerritoryData(gameState, previousOwner);
      setPlayerTerritoryData(gameState, adat[fromArea].arm);
    }
  } else {
    // Attack failed - attacker loses all but one die
    adat[fromArea].dice = 1;
  }

  return {
    ...battle,
    gameState,
  };
}

/**
 * Calculate and distribute reinforcements
 *
 * Determines how many reinforcement dice a player receives and distributes them.
 * Uses modern array methods and prioritization logic.
 *
 * @param {Object} gameState - Game state including player data
 * @param {number} playerIndex - Player to distribute reinforcements for
 * @returns {Object} Updated gameState with reinforcements distributed
 */
export function distributeReinforcements(gameState, playerIndex) {
  const { player, adat, AREA_MAX, STOCK_MAX } = gameState;

  // Calculate reinforcements - larger connected territory groups give more dice
  let reinforcements = Math.floor(player[playerIndex].area_tc / 3);

  // Minimum of 1 reinforcement if player has any territories
  if (player[playerIndex].area_c > 0 && reinforcements < 1) {
    reinforcements = 1;
  }

  // Add to player's stock, up to the maximum
  player[playerIndex].stock += reinforcements;
  if (player[playerIndex].stock > STOCK_MAX) {
    player[playerIndex].stock = STOCK_MAX;
  }

  // No reinforcements available
  if (player[playerIndex].stock <= 0) {
    return gameState;
  }

  // Find all territories owned by this player
  const territories = [];

  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size === 0) continue;
    if (adat[i].arm !== playerIndex) continue;
    if (adat[i].dice >= 8) continue; // Skip territories at max dice

    // Check if this territory borders an enemy using Map-based adjacency
    const isBorder = adat[i]
      .getAdjacentAreas()
      .some(
        adjAreaId =>
          adjAreaId > 0 && adat[adjAreaId].size > 0 && adat[adjAreaId].arm !== playerIndex
      );

    // Calculate priority score - border territories and those with fewer dice get priority
    const priority = (isBorder ? 100 : 0) + (8 - adat[i].dice) * 10;

    territories.push({
      id: i,
      priority,
    });
  }

  // Sort by priority (higher first)
  territories.sort((a, b) => b.priority - a.priority);

  // Distribute available reinforcements
  for (let i = 0; i < territories.length && player[playerIndex].stock > 0; i++) {
    const territoryId = territories[i].id;

    adat[territoryId].dice++;
    player[playerIndex].stock--;

    // Add to history
    if (!gameState.his[gameState.his_c]) {
      gameState.his[gameState.his_c] = new HistoryData();
    }

    gameState.his[gameState.his_c].from = territoryId;
    gameState.his[gameState.his_c].to = 0; // 0 indicates reinforcement, not attack
    gameState.his[gameState.his_c].res = 0;
    gameState.his_c++;
  }

  return gameState;
}

/**
 * Update player's territory and dice data
 *
 * Recalculates a player's total territories, dice, and connected groups.
 * Uses modern array methods and filtering for cleaner code.
 *
 * @param {Object} gameState - Game state including player and territory data
 * @param {number} playerIndex - Player to update data for
 */
export function setPlayerTerritoryData(gameState, playerIndex) {
  const { player, adat, AREA_MAX } = gameState;

  // Reset counters
  player[playerIndex].area_c = 0;
  player[playerIndex].dice_c = 0;

  // Count territories and dice using modern array methods
  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size === 0) continue;
    if (adat[i].arm !== playerIndex) continue;

    player[playerIndex].area_c++;
    player[playerIndex].dice_c += adat[i].dice;
  }

  // Calculate connected territory groups
  setAreaTc(gameState, playerIndex);
}
