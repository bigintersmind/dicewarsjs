/**
 * Replay Format
 *
 * Compact replay serialization, deserialization, and state reconstruction.
 * Replays store only the game config (with seed) and compact actions
 * (type + from/to) — no battle results, since those are deterministically
 * reproduced by the engine.
 *
 * @module arena/replayFormat
 */

import { createGame, replayGame } from '../engine/GameRunner.js';

/**
 * @typedef {Object} Replay
 * @property {number}         version  - Format version (currently 1)
 * @property {Object}         config   - Game config { seed, playerCount, mapWidth, mapHeight, maxAreas }
 * @property {CompactAction[]} actions  - Ordered list of game actions
 * @property {ReplayMetadata}  metadata - Summary metadata
 */

/**
 * @typedef {Object} CompactAction
 * @property {'ATTACK'|'END_TURN'} type
 * @property {number} [from] - Attacking territory ID (ATTACK only)
 * @property {number} [to]   - Defending territory ID (ATTACK only)
 */

/**
 * @typedef {Object} ReplayMetadata
 * @property {string[]}    bots      - Bot names by player index
 * @property {number|null} winner    - Winning player index
 * @property {number}      turnCount - Total turns played
 * @property {string}      timestamp - ISO 8601 creation time
 */

/**
 * Create a compact replay from a match result.
 * Uses the finalState's history to extract actions.
 *
 * @param {import('./matchRunner.js').MatchResult} matchResult
 * @param {string[]} botNames - Bot names by player index
 * @returns {Replay}
 */
export function createReplay(matchResult, botNames) {
  if (!matchResult.finalState) {
    throw new Error('Cannot create replay: match result has no finalState');
  }

  const actions = matchResult.finalState.history.map(entry =>
    entry.type === 'ATTACK'
      ? { type: 'ATTACK', from: entry.from, to: entry.to }
      : { type: 'END_TURN' }
  );

  return {
    version: 1,
    config: {
      seed: matchResult.config.seed,
      playerCount: matchResult.config.playerCount,
      mapWidth: matchResult.finalState.config.mapWidth,
      mapHeight: matchResult.finalState.config.mapHeight,
      maxAreas: matchResult.finalState.config.maxAreas,
    },
    actions,
    metadata: {
      bots: botNames,
      winner: matchResult.winner,
      turnCount: matchResult.turnCount,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Create a replay from a completed engine GameState.
 * Extracts compact actions from the state's history.
 *
 * @param {import('../engine/types.js').GameState} finalState
 * @param {Object} metadata - { bots: string[], winner, turnCount }
 * @returns {Replay}
 */
export function createReplayFromState(finalState, metadata) {
  const actions = finalState.history.map(entry => {
    if (entry.type === 'ATTACK') {
      return { type: 'ATTACK', from: entry.from, to: entry.to };
    }
    return { type: 'END_TURN' };
  });

  return {
    version: 1,
    config: {
      seed: finalState.config.seed,
      playerCount: finalState.config.playerCount,
      mapWidth: finalState.config.mapWidth,
      mapHeight: finalState.config.mapHeight,
      maxAreas: finalState.config.maxAreas,
    },
    actions,
    metadata: {
      bots: metadata.bots || [],
      winner: metadata.winner ?? finalState.winner,
      turnCount: metadata.turnCount ?? finalState.turnNumber,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Serialize a replay to a base64 string.
 * Uses encodeURIComponent to handle Unicode bot names safely.
 *
 * @param {Replay} replay
 * @returns {string}
 */
export function serializeReplay(replay) {
  const json = JSON.stringify(replay);
  return btoa(unescape(encodeURIComponent(json)));
}

/**
 * Deserialize a replay from a base64 string.
 *
 * @param {string} encoded
 * @returns {Replay}
 * @throws {Error} If the replay is invalid or corrupted
 */
export function deserializeReplay(encoded) {
  let json;
  try {
    json = decodeURIComponent(escape(atob(encoded)));
  } catch {
    throw new Error('Invalid replay data: could not decode');
  }

  let replay;
  try {
    replay = JSON.parse(json);
  } catch {
    throw new Error('Invalid replay data: malformed JSON');
  }

  if (!replay || typeof replay !== 'object') {
    throw new Error('Invalid replay data: not an object');
  }

  if (replay.version !== 1) {
    throw new Error(`Unsupported replay version: ${replay.version}`);
  }

  if (!replay.config || !Array.isArray(replay.actions) || !replay.metadata) {
    throw new Error('Invalid replay data: missing required fields');
  }

  return replay;
}

/**
 * Reconstruct the game state at a specific action index in a replay.
 *
 * Uses the engine's createGame (seeded) + replayGame to deterministically
 * reproduce the exact state.
 *
 * @param {Replay} replay
 * @param {number} actionIndex - Number of actions to apply (0 = initial state)
 * @returns {import('../engine/types.js').GameState}
 */
export function replayToState(replay, actionIndex) {
  try {
    const initialState = createGame(replay.config);
    if (actionIndex <= 0) return initialState;

    const actionsToApply = replay.actions.slice(0, actionIndex);
    return replayGame(initialState, actionsToApply);
  } catch (err) {
    throw new Error(`Replay failed at action ${actionIndex}: ${err.message}`);
  }
}

/**
 * Get the total number of actions in a replay.
 *
 * @param {Replay} replay
 * @returns {number}
 */
export function getReplayLength(replay) {
  return replay.actions.length;
}
