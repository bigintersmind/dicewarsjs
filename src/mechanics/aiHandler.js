/**
 * AI Handler Module
 *
 * Provides functions for AI execution, move validation, and AI management.
 * Extracted from Game.js for modularity.
 */

import { AI_STRATEGIES, createAIFunctionMapping } from '../ai/index.js';

/**
 * AI Strategy Registry
 *
 * Maps string AI strategy names to function references
 * Re-exports the registry from aiConfig for backward compatibility
 */
export const AI_REGISTRY = Object.fromEntries(
  Object.entries(AI_STRATEGIES).map(([key, value]) => [key, value.loader])
);

/**
 * Generate possible attack moves
 *
 * Creates a list of all valid attack moves for a player.
 * Used by AI strategies to evaluate potential moves.
 *
 * @param {Object} gameState - Game state including territories
 * @param {number} playerIndex - Player to generate moves for
 * @returns {Array} List of possible attack moves with from/to territory pairs
 */
export function generatePossibleMoves(gameState, playerIndex) {
  const { adat, AREA_MAX } = gameState;
  const moves = [];

  // Loop through all territories
  for (let i = 1; i < AREA_MAX; i++) {
    // Skip non-existent or enemy territories
    if (adat[i].size === 0) continue;
    if (adat[i].arm !== playerIndex) continue;
    if (adat[i].dice <= 1) continue; // Need at least 2 dice to attack

    // Look for adjacent enemy territories to attack
    for (let j = 1; j < AREA_MAX; j++) {
      // Skip non-existent, own, or non-adjacent territories
      if (adat[j].size === 0) continue;
      if (adat[j].arm === playerIndex) continue;
      if (adat[i].join[j] === 0) continue;

      // Found a valid attack - add to moves list
      moves.push({
        from: i,
        to: j,
        attackerDice: adat[i].dice,
        defenderDice: adat[j].dice,
        ratio: adat[i].dice / adat[j].dice,
      });
    }
  }

  return moves;
}

/**
 * Execute Computer Player Move
 *
 * Delegates to the appropriate AI strategy function for the current player.
 * Each AI function receives the game state and returns its move decision.
 *
 * @param {Object} gameState - Game state including AI array and current player
 * @returns {number} Return value from the AI (0 to end turn, non-zero to continue)
 */
export function executeAIMove(gameState) {
  const { ai, jun, ban } = gameState;

  // Look up the AI function for the current player
  const currentPlayer = jun[ban];
  const aiFunction = ai[currentPlayer];

  // Check if the AI function exists before calling it
  if (typeof aiFunction !== 'function') {
    console.error(`AI function not found for player ${currentPlayer}`);

    // Try to use default AI as a fallback
    const defaultAI = AI_STRATEGIES.ai_default?.implementation;
    if (typeof defaultAI === 'function') {
      console.log('Using default AI as fallback');
      return defaultAI(gameState);
    }
    // If no fallback available, end the turn
    console.error('No fallback AI available, ending turn');
    return 0;
  }

  // Call the AI function, passing the game state
  return aiFunction(gameState);
}

/**
 * Set AI Strategies from Configuration
 *
 * Updates the AI function array based on string identifiers from config.
 *
 * @param {Object} gameState - Game state including AI array
 * @param {Array} aiAssignments - Array of string AI type identifiers
 * @returns {Object} Updated game state with AI functions set
 */
export async function configureAI(gameState, aiAssignments) {
  if (!aiAssignments || !Array.isArray(aiAssignments)) {
    return gameState;
  }

  // Clone the game state and the ai array to avoid mutation
  const updatedGameState = {
    ...gameState,
    ai: [...gameState.ai], // Clone the array
  };

  // Use the utility function to create AI function mapping
  const aiFunctions = await createAIFunctionMapping(aiAssignments);

  // Apply the mapping to the game state
  for (let i = 0; i < aiFunctions.length && i < updatedGameState.ai.length; i++) {
    updatedGameState.ai[i] = aiFunctions[i];
  }

  return updatedGameState;
}
