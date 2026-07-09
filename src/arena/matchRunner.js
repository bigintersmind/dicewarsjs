/**
 * Match Runner
 *
 * Runs a single game (match) between bots using the new Bot SDK interface.
 * Uses the engine's createGame/applyAction directly with bot-aware move loop.
 *
 * @module arena/matchRunner
 */

import { createGame } from '../engine/GameRunner.js';
import { applyAction, getValidMoves } from '../engine/StateManager.js';
import { ACTION_TYPES, GAME_PHASES } from '../engine/constants.js';
import { createBotState } from './botState.js';
import { validateMove } from './botValidator.js';
import { runBotDirect } from './botRunner.js';
import { STOP, buildStep, createTrajectoryRecorder } from './trajectoryExport.js';

/**
 * Maximum moves a single bot can make per turn. Exported as the single source of
 * truth: the task-5 data-gen filter must know this cap to reason about cap-forced
 * turns, and a per-bot `maxMovesHit` stat (below) is derived from it — so consumers
 * read this constant rather than hard-coding `100` (D-14).
 */
export const MAX_MOVES_PER_TURN = 100;

/** Maximum consecutive invalid moves before ending a bot's turn */
export const MAX_CONSECUTIVE_INVALID = 3;

/**
 * Maximum turns before declaring a stalemate. Exported so consumers that need
 * the cap (the PPO env-server's `--max-turns` default, the v3 encoder's
 * turn-clock normalizer) share one constant instead of hard-coding 500.
 */
export const DEFAULT_MAX_TURNS = 500;

/**
 * @typedef {Object} MatchBotConfig
 * @property {string}   name - Bot display name
 * @property {Function} fn   - Bot function: (BotState) → { from, to } | null
 */

/**
 * @typedef {Object} MatchBotStat
 * @property {string} name           - Bot name
 * @property {number} playerIndex    - Player index in the game
 * @property {number} finalTerritories - Territories at game end
 * @property {number} finalDice      - Total dice at game end
 * @property {number} placement      - 1-based finishing position
 * @property {number} attacksMade    - Total attacks attempted
 * @property {number} attacksWon     - Total successful attacks
 * @property {number} errors         - Bot errors (exceptions) during turn
 * @property {number} invalidMoves   - Invalid moves attempted
 * @property {number} maxMovesHit    - Turns force-ended by the MAX_MOVES_PER_TURN cap
 *   (a forced-end signal alongside `errors`/`invalidMoves`; the task-5 filter quarantines
 *   any game where a teacher's count is > 0 — see D-14)
 */

/**
 * @typedef {Object} MatchResult
 * @property {number|null}   winner      - Winning player index (null if stalemate)
 * @property {string|null}   winnerName  - Winning bot's name (null if stalemate)
 * @property {number}        turnCount   - Total turns played
 * @property {number[]}      placements  - Player indices ordered by placement
 * @property {MatchBotStat[]} botStats   - Per-bot statistics
 * @property {{ seed: number, playerCount: number }} config - Game config used (for replay)
 * @property {import('../engine/types.js').GameState} finalState - Engine state at game end
 * @property {import('./trajectoryExport.js').TrajectoryRecord} [trajectory] - Lean self-play
 *   trajectory record (present only when `recordTrajectory` is set).
 */

/**
 * Run a single bot's turn: repeatedly call the bot and apply attacks,
 * then apply END_TURN.
 *
 * @param {import('../engine/types.js').GameState} state
 * @param {Function} botFn - Bot function
 * @param {string}   botName - For logging
 * @param {Object}   stats - Mutable stats accumulator { attacks, wins }
 * @param {(step: import('./trajectoryExport.js').TrajectoryStep) => void} [onStep] - Optional
 *   per-decision callback. Fires once per *applied* ATTACK (with its outcome) and
 *   exactly once at turn end with a STOP step — never for an individual rejected or
 *   invalid attack. The turn-end STOP fires on *every* non-GAME_OVER exit of the move
 *   loop, so it covers both a voluntary stop (bot returns null) and a forced end (bot
 *   error / MAX_CONSECUTIVE_INVALID / MAX_MOVES_PER_TURN); all are recorded as a
 *   voluntary STOP and are NOT distinguished here (see the `TrajectoryStep` typedef
 *   for why, and the per-bot `stats` counters — errors/invalidMoves/maxMovesHit — for
 *   how the planned task-5 filter drops forced-end games at consumption — D-14).
 *   Captures the observation *before* the action, independently of `state.history`,
 *   so it survives training mode.
 * @returns {import('../engine/types.js').GameState}
 */
function runBotTurn(state, botFn, botName, stats, onStep) {
  let currentState = state;
  const playerId = currentState.turnOrder[currentState.currentPlayerIndex];
  let consecutiveInvalid = 0;

  /*
   * Hoisted so a post-loop `i === MAX_MOVES_PER_TURN` test can detect cap exhaustion
   * (any break — null/error/invalid — leaves i < cap).
   */
  let i;
  for (i = 0; i < MAX_MOVES_PER_TURN; i++) {
    if (currentState.phase === GAME_PHASES.GAME_OVER) return currentState;

    const botState = createBotState(currentState, playerId);
    const { move, error } = runBotDirect(botFn, botState);

    if (error) {
      stats.errors = (stats.errors || 0) + 1;
      break;
    }
    if (move === null) break;

    const validation = validateMove(move, botState);
    if (!validation.valid) {
      stats.invalidMoves = (stats.invalidMoves || 0) + 1;
      consecutiveInvalid++;
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID) break;
      continue;
    }

    const validMoves = getValidMoves(currentState);
    const isEngineValid = validMoves.some(m => m.from === move.from && m.to === move.to);
    if (!isEngineValid) {
      stats.invalidMoves = (stats.invalidMoves || 0) + 1;
      consecutiveInvalid++;
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID) break;
      continue;
    }

    const preAttackState = currentState;
    try {
      currentState = applyAction(currentState, {
        type: ACTION_TYPES.ATTACK,
        from: move.from,
        to: move.to,
      });
    } catch (err) {
      console.error(`[Match] applyAction failed for "${botName}":`, err.message);
      stats.errors = (stats.errors || 0) + 1;
      break;
    }

    consecutiveInvalid = 0;
    stats.attacks++;
    const won = currentState.areas[move.to].owner === playerId;
    if (won) stats.wins++;

    if (onStep) {
      /*
       * Build via the shared producer. botState + validMoves were captured BEFORE
       * applyAction (for the bot call + validation) — passing them as the cached
       * observation/legal set means buildStep adds no extra engine work here.
       */
      onStep(
        buildStep(
          preAttackState,
          { type: ACTION_TYPES.ATTACK, from: move.from, to: move.to },
          currentState,
          { observation: botState, legalMoves: [...validMoves, STOP] }
        )
      );
    }
  }

  if (currentState.phase !== GAME_PHASES.GAME_OVER) {
    /*
     * Cap-forced end: the loop ran all MAX_MOVES_PER_TURN iterations while the game was
     * still going. This whole block is already gated on `phase !== GAME_OVER`, so a
     * winning move (which flips the phase, even on the final iteration) is never counted
     * here; among the remaining non-terminal exits, i === MAX_MOVES_PER_TURN holds iff the
     * loop exhausted the cap (any break for null/error/invalid leaves i < cap). Surface it
     * as a per-bot stat so the task-5 filter can quarantine cap-forced games without
     * reconstructing per-turn action lengths (D-14). Tracked independently of onStep —
     * a misbehavior signal regardless of capture.
     */
    if (i === MAX_MOVES_PER_TURN) stats.maxMovesHit = (stats.maxMovesHit || 0) + 1;

    if (onStep) {
      /*
       * Turn ended short of GAME_OVER — emit the STOP training example. This fires
       * for EVERY non-terminal exit of the loop above: a voluntary stop (move ===
       * null) AND a forced end (bot error / MAX_CONSECUTIVE_INVALID / MAX_MOVES_PER_TURN).
       * We deliberately record all of them as a single voluntary STOP label
       * (explicit-(c), D-14): it keeps the lean action list pure and round-trippable,
       * and matches the teacher's true behavior at the ~0% forced-end rate. Forced ends
       * are NOT marked on the step; the planned task-5 self-play harness will filter them
       * at consumption, where the signals already live — a teacher with
       * botStats.errors/.invalidMoves/.maxMovesHit > 0 quarantines the whole game
       * (maxMovesHit counts the cap-forced turns tallied just above). (See the
       * TrajectoryStep typedef + PLAN task 5.)
       */
      onStep(buildStep(currentState, { type: ACTION_TYPES.END_TURN }, currentState));
    }
    try {
      currentState = applyAction(currentState, { type: ACTION_TYPES.END_TURN });
    } catch (err) {
      console.error(
        `[Match] END_TURN failed for "${botName}" — game state unrecoverable:`,
        err.message
      );
      stats.errors = (stats.errors || 0) + 1;
      throw err;
    }
  }

  return currentState;
}

/**
 * Run a single match (complete game) between bots.
 *
 * @param {Object} config
 * @param {MatchBotConfig[]} config.bots - Bot configurations (length = player count)
 * @param {number}  [config.seed]        - RNG seed (random if omitted)
 * @param {number}  [config.maxTurns=DEFAULT_MAX_TURNS] - Max turns before stalemate
 * @param {(turnNumber:number, state:import('../engine/types.js').GameState, actingPlayerId:number)=>void} [config.onTurn] -
 *   Callback after each player-turn: the turn count, the post-turn state, and the player
 *   whose turn just completed (the acting player). The third arg lets a consumer attribute
 *   the turn — e.g. count a bot's own active turns, or credit an elimination during that turn
 *   to the attacker — without re-deriving the actor. It fires for the victory turn too (after
 *   the move loop returns a GAME_OVER state). Backward-compatible: older 2-arg callers ignore it.
 * @param {(step: import('./trajectoryExport.js').TrajectoryStep) => void} [config.onStep] -
 *   Per-decision callback (see runBotTurn). For custom streaming sinks.
 * @param {boolean} [config.recordTrajectory] - When true, capture a self-play trajectory and
 *   return it as `result.trajectory`. Pair with `recordHistory:false` for training-mode
 *   self-play — the trajectory is recorded out-of-band so it survives the empty history.
 * @param {boolean} [config.recordHistory] - Forwarded to the engine; pass `false` for
 *   training mode (skips the per-move history append — see GameRunner.createGame).
 *   Leave undefined for the default (history on) so replay creation still works.
 * @returns {MatchResult}
 */
export function runMatch(config) {
  const {
    bots,
    seed,
    maxTurns = DEFAULT_MAX_TURNS,
    onStart,
    onTurn,
    onStep,
    recordTrajectory,
    recordHistory,
  } = config;

  const names = new Set(bots.map(b => b.name));
  if (names.size !== bots.length) {
    throw new Error('Bot names must be unique');
  }

  const gameState = createGame({
    seed,
    playerCount: bots.length,
    recordHistory,
  });

  if (onStart) {
    onStart(gameState);
  }

  /*
   * Map player indices to bot functions.
   * turnOrder determines which player goes first, but bots[i] maps to player i.
   */
  const botFnByPlayer = bots.map(b => b.fn);
  const botNameByPlayer = bots.map(b => b.name);

  // Per-player attack stats
  const attackStats = bots.map(() => ({ attacks: 0, wins: 0 }));

  /*
   * Trajectory capture (opt-in). The recorder accumulates the lean action list
   * independently of state.history; an external onStep can also tap the stream.
   */
  const recorder = recordTrajectory ? createTrajectoryRecorder() : null;
  const stepHandler =
    recorder || onStep
      ? step => {
          recorder?.onStep(step);
          onStep?.(step);
        }
      : undefined;

  // Track elimination order for placement calculation
  const eliminationOrder = [];

  let state = gameState;
  let turnCount = 0;

  while (state.phase !== GAME_PHASES.GAME_OVER && turnCount < maxTurns) {
    const currentPlayerId = state.turnOrder[state.currentPlayerIndex];

    /*
     * Skip eliminated players. The engine's nextTurn already skips eliminated
     * players, so this branch is defensive dead code in normal play. But this
     * applyAction does NOT flow through runBotTurn's onStep, so if it fired with
     * trajectory capture active it would advance the engine by an END_TURN that is
     * absent from the recorded action list — silently desyncing re-derivation from
     * live capture. Fail loudly in that case rather than corrupt training data; keep
     * the harmless defensive skip for the no-recorder path. (See D-14.) NB: the skip
     * applies an END_TURN without a turnCount++ below, so in that hypothetical
     * no-recorder path the engine's turnsTaken counter (one per END_TURN) would run 1
     * ahead of turnCount from here on — don't make either side count this skip
     * without the other, or the turnClockNorm ↔ truncation-cap alignment drifts.
     */
    if (state.players[currentPlayerId].eliminated) {
      if (stepHandler) {
        throw new Error(
          `[Match] reached eliminated player ${currentPlayerId} mid-game with trajectory ` +
            `recording active — engine turn-advance invariant violated; aborting to avoid a ` +
            `desynced trajectory.`
        );
      }
      try {
        state = applyAction(state, { type: ACTION_TYPES.END_TURN });
      } catch (err) {
        console.error(
          `[Match] END_TURN failed for eliminated player ${currentPlayerId}:`,
          err.message
        );
        throw err;
      }
      continue;
    }

    const prevEliminated = state.players.filter(p => p.eliminated).map(p => p.id);

    state = runBotTurn(
      state,
      botFnByPlayer[currentPlayerId],
      botNameByPlayer[currentPlayerId],
      attackStats[currentPlayerId],
      stepHandler
    );

    // Track newly eliminated players
    for (const p of state.players) {
      if (p.eliminated && !prevEliminated.includes(p.id) && !eliminationOrder.includes(p.id)) {
        eliminationOrder.push(p.id);
      }
    }

    turnCount++;
    if (onTurn) onTurn(turnCount, state, currentPlayerId);
  }

  // Calculate placements
  const placements = calculatePlacements(state, eliminationOrder);

  if (recorder) {
    recorder.finalize({ winner: state.winner, placements, turnCount });
  }

  // Build per-bot stats
  const botStats = bots.map((bot, playerIndex) => ({
    name: bot.name,
    playerIndex,
    finalTerritories: state.players[playerIndex].territoryCount,
    finalDice: state.players[playerIndex].diceCount,
    placement: placements.indexOf(playerIndex) + 1,
    attacksMade: attackStats[playerIndex].attacks,
    attacksWon: attackStats[playerIndex].wins,
    errors: attackStats[playerIndex].errors || 0,
    invalidMoves: attackStats[playerIndex].invalidMoves || 0,
    maxMovesHit: attackStats[playerIndex].maxMovesHit || 0,
  }));

  return {
    winner: state.winner,
    winnerName: state.winner !== null ? botNameByPlayer[state.winner] : null,
    turnCount,
    placements,
    botStats,
    config: { seed: gameState.config.seed, playerCount: bots.length },
    finalState: state,
    ...(recorder && {
      trajectory: recorder.toRecord({ config: gameState.config, botNames: botNameByPlayer }),
    }),
  };
}

/**
 * Calculate placement order: winner first, then by elimination order (last eliminated = better).
 *
 * @param {import('../engine/types.js').GameState} state
 * @param {number[]} eliminationOrder - Player IDs in order of elimination
 * @returns {number[]} Player indices ordered by placement (0 = winner)
 */
function calculatePlacements(state, eliminationOrder) {
  const placements = [];

  // Winner first
  if (state.winner !== null) {
    placements.push(state.winner);
  }

  // Surviving non-winner players (sorted by territory count descending)
  const survivors = state.players
    .filter(p => !p.eliminated && p.id !== state.winner)
    .sort((a, b) => b.territoryCount - a.territoryCount || b.diceCount - a.diceCount)
    .map(p => p.id);
  placements.push(...survivors);

  // Eliminated players in reverse elimination order (last eliminated = better)
  const eliminated = [...eliminationOrder].reverse();
  placements.push(...eliminated);

  return placements;
}
