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
 * @typedef {Object} TrajectoryStep
 * @property {number} playerId    - Player who made the decision
 * @property {number} turnNumber  - Engine turn number at the decision
 * @property {import('./types.js').BotState} observation - Sanitized board the bot saw (before the action)
 * @property {Array<Object>} legalMoves - getValidMoves() output plus a trailing STOP sentinel
 * @property {{from:number,to:number}|{type:'END_TURN'}} chosenMove - The applied move (STOP === end turn)
 * @property {{won:boolean}|null} outcome - ATTACK result (won/lost); null for STOP
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
 * state. Shared by live capture re-derivation and {@link trajectoryFromReplay}.
 *
 * @param {import('../engine/types.js').GameState} state - State before the action
 * @param {import('./replayFormat.js').CompactAction} action
 * @param {import('../engine/types.js').GameState} nextState - State after the action
 * @returns {TrajectoryStep}
 */
function buildStep(state, action, nextState) {
  const playerId = state.turnOrder[state.currentPlayerIndex];
  const isAttack = action.type === ACTION_TYPES.ATTACK;
  return Object.freeze({
    playerId,
    turnNumber: state.turnNumber,
    observation: createBotState(state, playerId),
    legalMoves: legalMovesWithStop(state),
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

  const onStep = step => {
    const isStop = step.chosenMove === STOP || step.chosenMove?.type === ACTION_TYPES.END_TURN;
    actions.push(
      isStop
        ? { type: ACTION_TYPES.END_TURN }
        : { type: ACTION_TYPES.ATTACK, from: step.chosenMove.from, to: step.chosenMove.to }
    );
    fatSteps.push(step);
  };

  const finalize = t => {
    terminal = t;
  };

  const toRecord = ({ config, botNames }) => {
    const replay = createReplayFromActions(actions, config, {
      bots: botNames,
      winner: terminal?.winner ?? null,
      turnCount: terminal?.turnCount ?? 0,
    });
    return {
      ...replay,
      observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
      // placements is the terminal reward label — beyond a plain replay's metadata.
      metadata: { ...replay.metadata, placements: terminal?.placements ?? null },
    };
  };

  return {
    onStep,
    finalize,
    toRecord,
    get actions() {
      return actions;
    },
    get fatSteps() {
      return fatSteps;
    },
  };
}

/**
 * @typedef {import('./replayFormat.js').Replay & {observationSchemaVersion: number}} TrajectoryRecord
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
  for (const action of replay.actions) {
    const nextState = applyRecordedAction(state, action);
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
 * @throws {Error} On malformed JSON, unsupported version, or missing fields
 */
export function deserializeTrajectory(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw new Error('Invalid trajectory data: malformed JSON');
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

  return record;
}
