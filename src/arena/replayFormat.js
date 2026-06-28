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

/** Replay format version. Bump when the on-disk shape changes incompatibly. */
export const REPLAY_VERSION = 1;

/**
 * @typedef {Object} Replay
 * @property {number}         version  - Format version (REPLAY_VERSION)
 * @property {Object}         config   - Game config { seed, playerCount, mapWidth, mapHeight, maxAreas, dicePerArea }
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

  return createReplayFromActions(
    actions,
    {
      /*
       * seed/playerCount are the caller's inputs; map params are the resolved
       * (post-defaults) values on the engine state.
       */
      seed: matchResult.config.seed,
      playerCount: matchResult.config.playerCount,
      mapWidth: matchResult.finalState.config.mapWidth,
      mapHeight: matchResult.finalState.config.mapHeight,
      maxAreas: matchResult.finalState.config.maxAreas,
      dicePerArea: matchResult.finalState.config.dicePerArea,
      mapType: matchResult.finalState.config.mapType,
    },
    {
      bots: botNames,
      winner: matchResult.winner,
      turnCount: matchResult.turnCount,
    }
  );
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

  return createReplayFromActions(actions, finalState.config, {
    bots: metadata.bots || [],
    winner: metadata.winner ?? finalState.winner,
    turnCount: metadata.turnCount ?? finalState.turnNumber,
  });
}

/**
 * Assemble a replay envelope from an already-extracted action list.
 *
 * The shared builder behind {@link createReplay} and
 * {@link createReplayFromState}. Crucially, it does NOT touch `state.history`,
 * so callers that record actions out-of-band (e.g. the self-play trajectory
 * recorder running under `recordHistory:false`, where history is empty) can
 * build a valid, replayable record.
 *
 * @param {CompactAction[]} actions - Ordered compact actions ({type, from?, to?})
 * @param {Object} config - Resolved game config (seed + map/player params + dicePerArea)
 * @param {Object} metadata - { bots?: string[], winner?, turnCount?, timestamp? }
 * @returns {Replay}
 */
export function createReplayFromActions(actions, config, metadata = {}) {
  return {
    version: REPLAY_VERSION,
    config: {
      seed: config.seed,
      playerCount: config.playerCount,
      mapWidth: config.mapWidth,
      mapHeight: config.mapHeight,
      maxAreas: config.maxAreas,
      dicePerArea: config.dicePerArea,
      /*
       * Map personality is board-determining (it carves the land mask), so a
       * replay must carry it or the board reconstructs as a different (Classic)
       * map and the recorded actions desync. Older replays predate map types and
       * have no mapType — createGame defaults it to 'random', which is exactly
       * what those classic games were, so omission stays backward-compatible
       * (no REPLAY_VERSION bump needed).
       */
      mapType: config.mapType,
    },
    actions,
    metadata: {
      bots: metadata.bots || [],
      winner: metadata.winner ?? null,
      turnCount: metadata.turnCount ?? 0,
      timestamp: metadata.timestamp ?? new Date().toISOString(),
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
  } catch (err) {
    throw new Error(`Invalid replay data: could not decode — ${err.message}`, { cause: err });
  }

  let replay;
  try {
    replay = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid replay data: malformed JSON — ${err.message}`, { cause: err });
  }

  if (!replay || typeof replay !== 'object') {
    throw new Error('Invalid replay data: not an object');
  }

  if (replay.version !== REPLAY_VERSION) {
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
