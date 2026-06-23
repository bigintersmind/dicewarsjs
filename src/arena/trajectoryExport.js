/**
 * Trajectory Export
 *
 * Self-play training-data capture for the ML-bot initiative (docs/ml-bot/).
 *
 * A "trajectory" is the per-decision record of a match: for every action a bot
 * actually applies, a fat step `{ observation, legalMoves, chosenMove, outcome }`.
 * Per [D-13], the *canonical on-disk* artifact is the **lean** form (seed +
 * action list + terminal label) — fat steps are re-derivable from it because the
 * engine is seed-deterministic. This module therefore provides:
 *
 *   1. A live capture recorder ({@link createTrajectoryRecorder}) fed by a
 *      per-step callback threaded `runMatch → runBotTurn`. It records the action
 *      list *independently of `state.history`*, so a trajectory survives
 *      training mode (`recordHistory:false`, where `state.history` is empty and
 *      the plain replay builder would yield nothing).
 *   2. The lean → fat re-derivation ({@link trajectoryFromReplay} /
 *      {@link trajectoryStepFromReplay}) — used by the round-trip test now and
 *      by the Phase-2 "one-time JS pass to packed tensors" later.
 *   3. JSONL-oriented (de)serialization with version gates.
 *
 * The fat observation encoding (BotState) is version-stamped via
 * {@link OBSERVATION_SCHEMA_VERSION}; its feature set is finalized in Phase 2
 * (see DECISIONS D-Encoding). The lean envelope reuses the replay format.
 *
 * @module arena/trajectoryExport
 */

import { createGame } from '../engine/GameRunner.js';
import { applyAction, getValidMoves } from '../engine/StateManager.js';
import { ACTION_TYPES } from '../engine/constants.js';
import { createBotState } from './botState.js';
import { createReplayFromActions, replayToState, REPLAY_VERSION } from './replayFormat.js';

/**
 * Version of the fat observation/step schema. The on-disk record is lean, but
 * this stamps which fat-derivation contract applies. Bump when the BotState
 * encoding or the step shape changes incompatibly (finalized in Phase 2).
 */
export const OBSERVATION_SCHEMA_VERSION = 1;

/**
 * STOP decision sentinel — a bot ending its turn. Shaped like the END_TURN
 * action so it round-trips through the replay action list unchanged, and used
 * as the always-available last entry of `legalMoves` (a turn is a *sequence* of
 * attacks ended by STOP, not a single batched move).
 *
 * @type {{ type: 'END_TURN' }}
 */
export const STOP = Object.freeze({ type: ACTION_TYPES.END_TURN });

/**
 * True for the STOP decision — whether the canonical frozen {@link STOP} singleton
 * (the in-process value) or a structurally-equal `{type:'END_TURN'}` rehydrated from
 * a deserialized record. Prefer this over `=== STOP` so STOP-ness survives the
 * on-disk round-trip (a parsed record's END_TURN is a fresh object, not the singleton).
 *
 * @param {{from:number,to:number}|{type:string}} move
 * @returns {boolean}
 */
export const isStopMove = move => move === STOP || move?.type === ACTION_TYPES.END_TURN;

/**
 * @typedef {Object} TrajectoryStep
 * @property {number} playerId    - Player who made the decision
 * @property {number} turnNumber  - Engine turn number at the decision
 * @property {import('./types.js').BotState} observation - Sanitized board the bot saw (before the action)
 * @property {Array<Object>} legalMoves - getValidMoves() output plus a trailing STOP sentinel
 * @property {{from:number,to:number}|{type:'END_TURN'}} chosenMove - The applied move (STOP === end turn)
 * @property {{won:boolean}|null} outcome - ATTACK result (won/lost); null for STOP
 *
 * STOP labels are voluntary-only by convention (explicit-(c), [D-14]). Every recorded
 * END_TURN is stored as a *voluntary* STOP decision; the match harness ends a turn for
 * several reasons — the bot returning null (genuine stop), a bot error, repeated invalid
 * moves, or the `MAX_MOVES_PER_TURN` cap — and this record does NOT distinguish them
 * (there is no per-step forced-end marker). That keeps the lean action list pure and
 * exactly round-trippable. Forced ends are rare (~0%) for a well-behaved teacher; each
 * kind is surfaced as a per-bot counter on `MatchResult.botStats` — `errors`,
 * `invalidMoves`, and `maxMovesHit` (turns force-ended by the cap). The planned task-5
 * self-play harness (not yet implemented) — which owns "is this game clean enough to
 * train on" — will quarantine any game where a teacher's counter is > 0, without
 * inspecting per-step records. (If we ever train on a noisier teacher and need the data
 * to self-describe, the planned escape hatch is a `metadata.forcedEndTurns: number[]` of
 * action indices — still leaving the action list pure — not per-action flags. See PLAN
 * task 5 / D-14.)
 */

/**
 * Build the legal-action set for a decision: every legal attack plus STOP.
 *
 * @param {import('../engine/types.js').GameState} state
 * @returns {Array<Object>}
 */
function legalMovesWithStop(state) {
  return [...getValidMoves(state), STOP];
}

/**
 * Apply a compact recorded action ({type, from?, to?}) to a state. Mirrors the
 * engine action shape replayGame uses, so trajectory actions replay identically.
 *
 * @param {import('../engine/types.js').GameState} state
 * @param {import('./replayFormat.js').CompactAction} action
 * @returns {import('../engine/types.js').GameState}
 */
function applyRecordedAction(state, action) {
  if (action.type === ACTION_TYPES.ATTACK) {
    return applyAction(state, { type: ACTION_TYPES.ATTACK, from: action.from, to: action.to });
  }
  return applyAction(state, { type: ACTION_TYPES.END_TURN });
}

/**
 * Build a fat step from a pre-action state, the action taken, and the resulting
 * state. The single producer of a {@link TrajectoryStep} — used by both live capture
 * (matchRunner's `onStep` hook) and re-derivation ({@link trajectoryFromReplay}) — so
 * the `outcome`-is-null-iff-STOP invariant and the `Object.freeze` live in one place.
 *
 * @param {import('../engine/types.js').GameState} state - State BEFORE the action
 * @param {import('./replayFormat.js').CompactAction} action
 * @param {import('../engine/types.js').GameState} nextState - State after the action
 *   (only read for an ATTACK's outcome; pass `state` for a non-attack)
 * @param {{observation?: import('./types.js').BotState, legalMoves?: Array<Object>}} [cached]
 *   Pre-computed observation/legal set from the live decision point. The hot path
 *   passes these (already built for the bot call + validation) so buildStep adds no
 *   extra engine work; re-derivation omits them and they are computed here.
 * @returns {TrajectoryStep}
 */
export function buildStep(state, action, nextState, cached) {
  const playerId = state.turnOrder[state.currentPlayerIndex];
  const isAttack = action.type === ACTION_TYPES.ATTACK;
  return Object.freeze({
    playerId,
    turnNumber: state.turnNumber,
    observation: cached?.observation ?? createBotState(state, playerId),
    legalMoves: cached?.legalMoves ?? legalMovesWithStop(state),
    chosenMove: isAttack ? { from: action.from, to: action.to } : STOP,
    outcome: isAttack ? { won: nextState.areas[action.to].owner === playerId } : null,
  });
}

/**
 * @typedef {Object} TrajectoryRecorder
 * @property {(step: TrajectoryStep) => void} onStep - Pass as the matchRunner per-step callback
 * @property {(terminal: {winner: number|null, placements: number[], turnCount: number}) => void} finalize
 * @property {(opts: {config: Object, botNames: string[]}) => TrajectoryRecord} toRecord
 * @property {Array<import('./replayFormat.js').CompactAction>} actions - Lean action list (live)
 * @property {TrajectoryStep[]} fatSteps - In-memory fat steps (ground truth for tests/debug)
 */

/**
 * Create a live trajectory recorder. Wire `onStep` as the matchRunner per-step
 * callback; it records the lean action list out-of-band from `state.history`
 * (so it survives `recordHistory:false`) and keeps the fat steps in memory.
 *
 * @returns {TrajectoryRecorder}
 */
export function createTrajectoryRecorder() {
  const actions = [];
  const fatSteps = [];
  let terminal = null;
  let finalized = false;

  const onStep = step => {
    const isStop = isStopMove(step.chosenMove);
    actions.push(
      isStop
        ? { type: ACTION_TYPES.END_TURN }
        : { type: ACTION_TYPES.ATTACK, from: step.chosenMove.from, to: step.chosenMove.to }
    );
    fatSteps.push(step);
  };

  const finalize = t => {
    terminal = t;
    finalized = true;
  };

  const toRecord = ({ config, botNames }) => {
    if (!finalized) {
      /*
       * A trajectory's reward label (winner/placements/turnCount) comes from
       * finalize(). Without it, toRecord would silently emit winner:null/
       * placements:null/turnCount:0 — indistinguishable on disk from a real
       * stalemate, which is a poisoned label for a training pipeline. Fail loudly
       * instead (runMatch always finalizes before calling toRecord).
       */
      throw new Error(
        'TrajectoryRecorder.toRecord() called before finalize(): terminal reward ' +
          'labels are unset. Finalize with the match outcome before serializing.'
      );
    }
    const replay = createReplayFromActions(actions, config, {
      bots: botNames,
      winner: terminal.winner ?? null,
      turnCount: terminal.turnCount ?? 0,
    });
    return {
      ...replay,
      observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
      // placements is the terminal reward label — beyond a plain replay's metadata.
      metadata: { ...replay.metadata, placements: terminal.placements ?? null },
    };
  };

  return {
    onStep,
    finalize,
    toRecord,
    /*
     * Return shallow copies so a caller can't break the `fatSteps ≡ actions`
     * invariant by mutating the recorder's internals (read-only by contract).
     */
    get actions() {
      return [...actions];
    },
    get fatSteps() {
      return [...fatSteps];
    },
  };
}

/**
 * A lean replay plus the two trajectory-specific extensions: the observation-schema
 * stamp and the terminal `placements` reward label (added by `toRecord`, beyond a
 * plain replay's `metadata`).
 *
 * @typedef {import('./replayFormat.js').Replay & {
 *   observationSchemaVersion: number,
 *   metadata: import('./replayFormat.js').ReplayMetadata & { placements: number[]|null }
 * }} TrajectoryRecord
 */

/**
 * Re-derive the full fat trajectory from a lean trajectory/replay record.
 *
 * Deterministically reproduces every intermediate state from seed + config +
 * action prefix (the engine guarantees this), so it is the inverse of live
 * capture: `trajectoryFromReplay(recorder.toRecord(...))` equals
 * `recorder.fatSteps` step-for-step. This is also the Phase-2 tensor-expansion
 * pass over the canonical lean dataset.
 *
 * @param {TrajectoryRecord|import('./replayFormat.js').Replay} replay
 * @returns {TrajectoryStep[]}
 */
export function trajectoryFromReplay(replay) {
  let state = createGame(replay.config);
  const steps = [];
  for (let i = 0; i < replay.actions.length; i++) {
    const action = replay.actions[i];
    let nextState;
    try {
      nextState = applyRecordedAction(state, action);
    } catch (err) {
      /*
       * A corrupt/illegal recorded action throws deep in the engine; wrap it with
       * the action index + action so the failure is locatable in a streamed dataset.
       */
      throw new Error(
        `Trajectory re-derivation failed at action ${i} (${JSON.stringify(action)}): ${err.message}`,
        { cause: err }
      );
    }
    steps.push(buildStep(state, action, nextState));
    state = nextState;
  }
  return steps;
}

/**
 * Re-derive a single fat step (decision point) at action index `i`.
 *
 * @param {TrajectoryRecord|import('./replayFormat.js').Replay} replay
 * @param {number} i - Action index (0-based)
 * @returns {TrajectoryStep}
 * @throws {Error} If `i` is out of range
 */
export function trajectoryStepFromReplay(replay, i) {
  if (i < 0 || i >= replay.actions.length) {
    throw new Error(`Trajectory step index out of range: ${i} (length ${replay.actions.length})`);
  }
  const state = replayToState(replay, i);
  const action = replay.actions[i];
  return buildStep(state, action, applyRecordedAction(state, action));
}

/**
 * Serialize a trajectory record to a single JSON line (JSONL-ready).
 *
 * Unlike serializeReplay (base64, for compact single-string transport), the
 * self-play harness streams one record per line to a `.jsonl` file, so raw JSON
 * is the right shape. JSON.stringify escapes any newlines inside strings, so
 * the output is always single-line.
 *
 * @param {TrajectoryRecord} record
 * @returns {string}
 */
export function serializeTrajectory(record) {
  return JSON.stringify(record);
}

/**
 * Parse and validate a single JSONL trajectory line.
 *
 * @param {string} line
 * @returns {TrajectoryRecord}
 * @throws {Error} On malformed JSON, unsupported version, missing fields, an invalid
 *   config (seed/playerCount/map dimensions) or an invalid terminal reward label
 *   (metadata.winner / metadata.placements)
 */
export function deserializeTrajectory(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (err) {
    /*
     * Preserve the parser's position/snippet — invaluable for locating corruption
     * in a large streamed `.jsonl` dataset (the generic message alone is not).
     */
    throw new Error(`Invalid trajectory data: malformed JSON — ${err.message}`, { cause: err });
  }

  if (!record || typeof record !== 'object') {
    throw new Error('Invalid trajectory data: not an object');
  }
  if (record.version !== REPLAY_VERSION) {
    throw new Error(`Unsupported trajectory replay version: ${record.version}`);
  }
  if (record.observationSchemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported observation schema version: ${record.observationSchemaVersion}`);
  }
  if (!record.config || !Array.isArray(record.actions) || !record.metadata) {
    throw new Error('Invalid trajectory data: missing required fields');
  }
  /*
   * The config feeds createGame during re-derivation; an out-of-range field there throws
   * opaquely deep in the engine. Reject the whole config at the boundary, not just seed:
   * the seed must be a finite number, playerCount an integer >= 2, and the map/dice
   * dimensions positive finite numbers.
   */
  if (!Number.isFinite(record.config.seed)) {
    throw new Error(
      `Invalid trajectory data: config.seed must be a finite number, got ${record.config.seed}`
    );
  }
  if (!Number.isInteger(record.config.playerCount) || record.config.playerCount < 2) {
    throw new Error(
      `Invalid trajectory data: config.playerCount must be an integer >= 2, got ${record.config.playerCount}`
    );
  }
  for (const field of ['mapWidth', 'mapHeight', 'maxAreas', 'dicePerArea']) {
    const value = record.config[field];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid trajectory data: config.${field} must be a positive number, got ${value}`
      );
    }
  }

  /*
   * Validate the terminal reward labels — the fields that make this a *trajectory* rather
   * than a plain replay. toRecord can emit `placements: null` (its `?? null` fallback), and
   * a null/out-of-range reward label deserializes fine but silently poisons a training
   * target downstream. Reject it here: winner is null (stalemate) or a valid player index,
   * and placements is a full permutation of player indices.
   */
  const { winner, placements } = record.metadata;
  const { playerCount } = record.config;
  if (winner !== null && (!Number.isInteger(winner) || winner < 0 || winner >= playerCount)) {
    throw new Error(
      `Invalid trajectory data: metadata.winner must be null or an integer in [0, ${playerCount}), got ${winner}`
    );
  }
  if (
    !Array.isArray(placements) ||
    placements.length !== playerCount ||
    placements.some(p => !Number.isInteger(p) || p < 0 || p >= playerCount) ||
    new Set(placements).size !== placements.length
  ) {
    throw new Error(
      `Invalid trajectory data: metadata.placements must be a length-${playerCount} permutation ` +
        `of player indices, got ${JSON.stringify(placements)}`
    );
  }
  /*
   * Shape-check each action so a corrupt entry is caught at parse time (naming the
   * index) rather than detonating deep in engine re-derivation. Range-correctness
   * (e.g. an in-bounds-but-illegal target) is still validated by the engine via the
   * action-indexed wrapper in trajectoryFromReplay.
   */
  record.actions.forEach((action, i) => {
    if (!action || (action.type !== ACTION_TYPES.ATTACK && action.type !== ACTION_TYPES.END_TURN)) {
      throw new Error(`Invalid trajectory data: action ${i} has invalid type ${action?.type}`);
    }
    if (
      action.type === ACTION_TYPES.ATTACK &&
      (!Number.isInteger(action.from) ||
        action.from < 0 ||
        !Number.isInteger(action.to) ||
        action.to < 0)
    ) {
      throw new Error(
        `Invalid trajectory data: ATTACK action ${i} has invalid from/to (${action.from}→${action.to})`
      );
    }
  });

  return record;
}
