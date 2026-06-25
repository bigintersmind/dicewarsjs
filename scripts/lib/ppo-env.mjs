/**
 * PPO self-play environment core (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * The transport-agnostic heart of the Node↔Python self-play env: one designated
 * **learner seat** plays an 8-FFA (or N-FFA) match against in-process opponent bots,
 * with the learner's per-decision action supplied by an injected synchronous
 * `chooseAction(encoded, botState) → i32` callback. Tests inject a deterministic
 * stub; `ppo-env-server.mjs` injects a blocking socket read.
 *
 * Design (per [D-19]): instead of editing the engine, we reuse `runMatch` **verbatim**
 * and inject the learner as an ordinary bot function — `runBotDirect` already calls
 * bot fns synchronously, so a bot fn that encodes-emits-and-blocks IS the integration
 * point. The other N-1 seats run through the same `runBotTurn` as any arena match.
 * Action decode mirrors `ai_bc.js:88-102` exactly, so the env and the shipped BC bot
 * map a policy index to a move identically.
 *
 * @module scripts/lib/ppo-env
 */

import { runMatch } from '../../src/arena/matchRunner.js';
import { encodeObservationForInference } from '../../src/arena/encodeObservation.js';

/** Display name for the learner seat in the bots roster. */
export const LEARNER_NAME = 'ppo-learner';

/**
 * Decode a policy action index against the encoder's OWN `moves[]` — never a fresh
 * `getValidMoves` (the two orderings coincide today only by construction; relying on
 * the encoder's array makes a future reorder fail the parity test rather than silently
 * mis-steer). Mirrors `ai_bc.js:88-102`: the trailing edge MUST be STOP.
 *
 * @param {{moves:Array<{from:number,to:number}|null>}} encoded - `encodeObservationForInference` output.
 * @param {number} idx - chosen edge index in [0, numEdges).
 * @returns {{from:number,to:number}|null} An attack, or null for STOP (end turn).
 */
export function decodeAction(encoded, idx) {
  const n = encoded.moves.length;
  const stopIdx = n - 1;
  if (encoded.moves[stopIdx] !== null) {
    throw new Error(
      'decodeAction: trailing edge is not STOP (moves[last] !== null) — encoder layout changed.'
    );
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
    throw new Error(
      `decodeAction: action index ${idx} out of range [0, ${n}) — learner/env desync, not a recoverable move.`
    );
  }
  return encoded.moves[idx];
}

/**
 * Build the learner's bot function: a synchronous shim that encodes the live
 * observation, asks `chooseAction` for an index, and decodes it to a move.
 *
 * @param {Object} opts
 * @param {number} opts.maxAreas - node-tensor height (policy config.maxAreas).
 * @param {(encoded:Object, botState:Object) => number} opts.chooseAction - synchronous
 *   action selector; returns the chosen edge index.
 * @param {(encoded:Object, botState:Object) => void} [opts.onObservation] - optional tap
 *   fired with each encoded observation (before the choice), e.g. for trajectory capture.
 * @returns {(botState:Object) => ({from:number,to:number}|null)}
 */
export function makeLearnerBot({ maxAreas, chooseAction, onObservation } = {}) {
  if (!Number.isInteger(maxAreas) || maxAreas <= 0) {
    throw new Error(`makeLearnerBot: maxAreas must be a positive integer, got ${maxAreas}.`);
  }
  if (typeof chooseAction !== 'function') {
    throw new Error('makeLearnerBot: chooseAction must be a function.');
  }
  const ctx = { maxAreas };
  return function learnerBot(botState) {
    const encoded = encodeObservationForInference(botState, ctx);
    if (onObservation) onObservation(encoded, botState);
    const idx = chooseAction(encoded, botState);
    return decodeAction(encoded, idx);
  };
}

/**
 * Scaled placement for the learner, matching `encodeStep`'s aux value target:
 * 1 = first … 0 = last; 0 when the seat is unplaced or there is a single seat.
 *
 * @param {number[]} placements - placement order, best-first.
 * @param {number} learnerSeat
 * @param {number} playerCount
 * @returns {number}
 */
export function scaledPlacement(placements, learnerSeat, playerCount) {
  const rank = placements.indexOf(learnerSeat);
  return playerCount > 1 && rank >= 0 ? 1 - rank / (playerCount - 1) : 0;
}

/**
 * Run one self-play episode: the learner seat (`learnerSeat`) plays against the
 * given opponents and the full match is driven by `runMatch`. Returns the terminal
 * outcome relative to the learner (reward inputs for PPO).
 *
 * Opponent names are de-duplicated with `#n` suffixes (and kept distinct from the
 * learner), because `runMatch` requires unique bot names but a self-play league
 * routinely seats the same bot at several seats.
 *
 * @param {Object} cfg
 * @param {number} cfg.seed - finite numeric seed (required: training mode
 *   `recordHistory:false` makes `createGame` throw without one).
 * @param {Array<{name:string, fn:Function}>} cfg.opponents - the N-1 non-learner seats.
 * @param {number} cfg.learnerSeat - player id the learner occupies, in [0, playerCount).
 * @param {number} cfg.maxAreas - node-tensor height (policy config.maxAreas).
 * @param {(encoded:Object, botState:Object) => number} cfg.chooseAction - action selector.
 * @param {number} [cfg.maxTurns] - stalemate cap (defaults to runMatch's 500).
 * @param {(encoded:Object, botState:Object) => void} [cfg.onObservation] - per-decision tap.
 * @returns {{winner:number|null, won:number, placement:number, placements:number[],
 *   turnCount:number, learnerSeat:number, playerCount:number,
 *   finalState:import('../../src/engine/types.js').GameState,
 *   botStats:Object[]}}
 */
export function runSelfPlayEpisode(cfg) {
  const { seed, opponents, learnerSeat, maxAreas, maxTurns, chooseAction, onObservation } = cfg;

  if (!Number.isFinite(seed)) {
    throw new Error(
      `runSelfPlayEpisode: seed must be a finite number (training mode), got ${seed}.`
    );
  }
  if (!Array.isArray(opponents) || opponents.length === 0) {
    throw new Error('runSelfPlayEpisode: opponents must be a non-empty array.');
  }
  const playerCount = opponents.length + 1;
  if (!Number.isInteger(learnerSeat) || learnerSeat < 0 || learnerSeat >= playerCount) {
    throw new Error(
      `runSelfPlayEpisode: learnerSeat ${learnerSeat} out of range [0, ${playerCount}).`
    );
  }

  const learnerBot = makeLearnerBot({ maxAreas, chooseAction, onObservation });

  // Seat the learner at learnerSeat; opponents fill the rest in order.
  const roster = [];
  let oi = 0;
  for (let i = 0; i < playerCount; i++) {
    if (i === learnerSeat) {
      roster.push({ name: LEARNER_NAME, fn: learnerBot });
    } else {
      const opp = opponents[oi++];
      if (!opp || typeof opp.fn !== 'function') {
        throw new Error(`runSelfPlayEpisode: opponent at slot ${i} is missing a fn.`);
      }
      roster.push({ name: opp.name, fn: opp.fn });
    }
  }
  uniquifyNames(roster);

  const result = runMatch({ bots: roster, seed, maxTurns, recordHistory: false });

  return {
    winner: result.winner,
    won: result.winner === learnerSeat ? 1 : 0,
    placement: scaledPlacement(result.placements, learnerSeat, playerCount),
    placements: result.placements,
    turnCount: result.turnCount,
    learnerSeat,
    playerCount,
    finalState: result.finalState,
    botStats: result.botStats,
  };
}

/**
 * Suffix duplicate roster names in place with `#2`, `#3`, … so `runMatch`'s
 * unique-name requirement holds even when the league seats the same opponent
 * multiple times. The first occurrence keeps its bare name.
 *
 * @param {Array<{name:string}>} roster
 */
function uniquifyNames(roster) {
  const seen = new Map();
  for (const bot of roster) {
    const count = seen.get(bot.name) || 0;
    seen.set(bot.name, count + 1);
    if (count > 0) bot.name = `${bot.name}#${count + 1}`;
  }
}
