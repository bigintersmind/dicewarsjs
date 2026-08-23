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
  MAX_HANDICAP_LEVEL,
  ACTION_TYPES,
  GAME_PHASES,
} from './constants.js';

/**
 * Validate and copy the optional luck handicap (issue #179).
 *
 * Shape: `{ playerId: number, level: number } | null`. `null`/absent means "off"
 * — the default everywhere, so competitive surfaces (arena, tournament,
 * leaderboard) are provably unhandicapped by construction. Anything else is
 * rejected at this boundary rather than silently ignored. The silent failure
 * mode this prevents is a handicap that *looks* applied but never fires: the
 * battle reducer only boosts a side when `handicap.playerId` equals the seat
 * taking (or defending) the attack, so an out-of-range seat plays a completely
 * ordinary game while `state.config` advertises a handicap. An out-of-range
 * `level` fails the other way — it reaches `rollAdvantage` deep inside the
 * reducer, where the error is far from its cause (and `level: 1e9`, e.g. from a
 * hand-edited replay, stalls there rather than erroring at all).
 *
 * Returns a fresh, frozen object: the copy means later mutation of the caller's
 * input object can't change the running game's config, and the freeze means the
 * stored handicap's fields can't be edited through `gameState.config` either
 * (createGame freezes the config object itself, so the slot can't be swapped).
 * Together they keep the config a replay is re-derived from equal to the one the
 * game was actually played with.
 *
 * @param {unknown} handicap
 * @param {number} playerCount - Resolved player count; playerId must be a valid seat
 * @returns {Readonly<{playerId: number, level: number}>|null}
 */
function validateHandicap(handicap, playerCount) {
  if (handicap == null) return null;
  if (typeof handicap !== 'object' || Array.isArray(handicap)) {
    throw new Error(
      `createGame: config.handicap must be null or an object { playerId, level }, got ${typeof handicap}`
    );
  }
  const { playerId, level } = handicap;
  if (!Number.isInteger(playerId) || playerId < 0 || playerId >= playerCount) {
    throw new Error(
      `createGame: config.handicap.playerId must be an integer seat index in [0, ${playerCount}), got ${playerId}`
    );
  }
  if (!Number.isInteger(level) || level < 1) {
    throw new Error(
      `createGame: config.handicap.level must be an integer >= 1 (use null for no handicap), got ${level}`
    );
  }
  if (level > MAX_HANDICAP_LEVEL) {
    throw new Error(
      `createGame: config.handicap.level must be <= MAX_HANDICAP_LEVEL (${MAX_HANDICAP_LEVEL}), got ${level}`
    );
  }
  return Object.freeze({ playerId, level });
}

/**
 * Create a new game with the given config and seed.
 *
 * Training mode (`recordHistory: false`, used by the self-play harness) requires
 * an explicit `seed` and throws without one — a self-play run that isn't
 * reproducible is a bug, not a convenience. The production UI keeps the
 * `Math.random` seed fallback because it leaves `recordHistory` at its default
 * (on), so its games are never gated.
 *
 * @param {import('./types.js').GameConfig} config
 * @returns {import('./types.js').GameState}
 */
export function createGame(config = {}) {
  const recordHistory = config.recordHistory ?? true;

  /*
   * Require a finite numeric seed. `Number.isFinite` rejects null/undefined/NaN
   * *and* non-numeric strings (it never coerces) — so a bad seed can't slip past
   * the gate and either fall back to a random seed (via `?? ` below) or coerce to
   * the degenerate 0 (via `seed >>> 0` in createRng), both of which would defeat
   * training-mode reproducibility. This makes the runtime check honour the
   * "numeric" promise in the error message below.
   */
  if (recordHistory === false && !Number.isFinite(config.seed)) {
    throw new Error(
      'createGame: training mode (recordHistory:false) requires an explicit numeric config.seed for reproducibility'
    );
  }

  const playerCount = config.playerCount ?? DEFAULT_PLAYER_COUNT;

  const fullConfig = {
    mapWidth: config.mapWidth ?? DEFAULT_XMAX,
    mapHeight: config.mapHeight ?? DEFAULT_YMAX,
    maxAreas: config.maxAreas ?? DEFAULT_AREA_MAX,
    playerCount,
    dicePerArea: config.dicePerArea ?? DEFAULT_DICE_PER_AREA,
    handicap: validateHandicap(config.handicap, playerCount),
    recordHistory,
    seed: config.seed ?? Math.floor(Math.random() * 0xffffffff),
  };
  /*
   * The config rides by reference into every derived state, and applyAttack
   * re-reads `config.handicap` on each attack — so an assignable slot would let
   * a mid-game `state.config.handicap = …` change the RNG draw count and desync
   * the game from the config its replay is re-derived from. validateHandicap
   * already freezes the handicap's fields; this freezes the slots.
   */
  Object.freeze(fullConfig);

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
