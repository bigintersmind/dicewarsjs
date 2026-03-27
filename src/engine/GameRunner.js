/**
 * Game Runner — High-level API for running complete games.
 *
 * Combines HexGrid, MapGenerator, TurnManager, StateManager, and AIAdapter
 * into a simple interface for creating and simulating full games.
 *
 * @module engine/GameRunner
 */

import { createRng } from './rng.js';
import { generateMap } from './MapGenerator.js';
import { createTurnOrder } from './TurnManager.js';
import { createInitialState, applyAction } from './StateManager.js';
import { runFullAITurn } from './AIAdapter.js';
import {
  DEFAULT_PLAYER_COUNT,
  DEFAULT_XMAX,
  DEFAULT_YMAX,
  DEFAULT_AREA_MAX,
  DEFAULT_DICE_PER_AREA,
  ACTION_TYPES,
  GAME_PHASES,
} from './constants.js';

/**
 * Create a new game with the given config and seed.
 *
 * @param {import('./types.js').GameConfig} config
 * @returns {import('./types.js').GameState}
 */
export function createGame(config = {}) {
  const fullConfig = {
    mapWidth: config.mapWidth ?? DEFAULT_XMAX,
    mapHeight: config.mapHeight ?? DEFAULT_YMAX,
    maxAreas: config.maxAreas ?? DEFAULT_AREA_MAX,
    playerCount: config.playerCount ?? DEFAULT_PLAYER_COUNT,
    dicePerArea: config.dicePerArea ?? DEFAULT_DICE_PER_AREA,
    seed: config.seed ?? Math.floor(Math.random() * 0xffffffff),
  };

  const rng = createRng(fullConfig.seed);
  const mapData = generateMap(fullConfig, rng);
  const turnOrder = createTurnOrder(fullConfig.playerCount, rng);
  return createInitialState(fullConfig, mapData, turnOrder, rng.state());
}

/**
 * Simulate a full game from start to finish.
 *
 * @param {Object} options
 * @param {import('./types.js').GameConfig} [options.config] - Game configuration
 * @param {Function[]} options.aiAssignments - Array of AI functions per player index
 * @param {number} [options.maxTurns=500] - Maximum turns before declaring a draw
 * @param {number} [options.seed] - RNG seed (overrides config.seed)
 * @param {Function} [options.onTurn] - Callback(state) after each player's full turn
 * @returns {{ finalState: import('./types.js').GameState, winner: number|null, turnCount: number, history: Object[], completed: boolean }}
 */
export function simulateGame(options) {
  const { config = {}, aiAssignments, maxTurns = 500, seed, onTurn } = options;

  if (!Array.isArray(aiAssignments)) {
    throw new Error('simulateGame requires aiAssignments array');
  }

  const gameConfig = { ...config };
  if (seed !== undefined) gameConfig.seed = seed;

  let state = createGame(gameConfig);

  if (aiAssignments.length < state.players.length) {
    throw new Error(
      `aiAssignments has ${aiAssignments.length} entries but game has ${state.players.length} players`
    );
  }

  let turnCount = 0;

  while (state.phase !== GAME_PHASES.GAME_OVER && turnCount < maxTurns) {
    const currentPlayer = state.turnOrder[state.currentPlayerIndex];
    const aiFunction = aiAssignments[currentPlayer];

    if (typeof aiFunction !== 'function') {
      throw new Error(
        `No AI function assigned for player ${currentPlayer} (got ${typeof aiFunction})`
      );
    } else {
      state = runFullAITurn(state, aiFunction);
    }

    if (onTurn) {
      onTurn(state);
    }

    turnCount++;
  }

  return {
    finalState: state,
    winner: state.winner,
    turnCount,
    history: state.history,
    completed: state.phase === GAME_PHASES.GAME_OVER,
  };
}

/**
 * Replay a sequence of actions from an initial state.
 * Useful for verifying deterministic replay.
 *
 * @param {import('./types.js').GameState} initialState
 * @param {(import('./types.js').Action | import('./types.js').HistoryEntry)[]} actions
 * @returns {import('./types.js').GameState} Final state after all actions
 */
export function replayGame(initialState, actions) {
  let state = initialState;
  for (const [index, action] of actions.entries()) {
    if (action.type === ACTION_TYPES.ATTACK) {
      state = applyAction(state, {
        type: ACTION_TYPES.ATTACK,
        from: action.from,
        to: action.to,
      });
    } else if (action.type === ACTION_TYPES.END_TURN) {
      state = applyAction(state, { type: ACTION_TYPES.END_TURN });
    } else {
      throw new Error(`replayGame: unknown action type "${action.type}" at index ${index}`);
    }
  }
  return state;
}
