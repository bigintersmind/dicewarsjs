/**
 * Engine barrel export
 *
 * @module engine
 */

export { createRng } from './rng.js';
export * from './constants.js';
export { createHexGrid, getNeighbor } from './HexGrid.js';
export {
  rollDice,
  rollAdvantage,
  resolveBattle,
  calculateAttackProbability,
} from './BattleResolver.js';
export {
  createTurnOrder,
  findLargestConnectedGroup,
  isPlayerEliminated,
  getActivePlayers,
  isGameOver,
  calculateReinforcements,
  nextTurn,
  distributeReinforcements,
} from './TurnManager.js';
export { generateMap } from './MapGenerator.js';
export {
  createInitialState,
  applyAction,
  getValidMoves,
  serializeState,
  deserializeState,
} from './StateManager.js';
export { createLegacyGameView, runAI, runFullAITurn } from './AIAdapter.js';
export { createGame, simulateGame, replayGame } from './GameRunner.js';
// types.js is JSDoc-only — no runtime exports
