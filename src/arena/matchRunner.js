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

/** Maximum moves a single bot can make per turn */
const MAX_MOVES_PER_TURN = 100;

/** Maximum consecutive invalid moves before ending a bot's turn */
const MAX_CONSECUTIVE_INVALID = 3;

/** Maximum turns before declaring a stalemate */
const DEFAULT_MAX_TURNS = 500;

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
 */

/**
 * Run a single bot's turn: repeatedly call the bot and apply attacks,
 * then apply END_TURN.
 *
 * @param {import('../engine/types.js').GameState} state
 * @param {Function} botFn - Bot function
 * @param {string}   botName - For logging
 * @param {Object}   stats - Mutable stats accumulator { attacks, wins }
 * @returns {import('../engine/types.js').GameState}
 */
function runBotTurn(state, botFn, botName, stats) {
  let currentState = state;
  const playerId = currentState.turnOrder[currentState.currentPlayerIndex];
  let consecutiveInvalid = 0;

  for (let i = 0; i < MAX_MOVES_PER_TURN; i++) {
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
    if (currentState.areas[move.to].owner === playerId) {
      stats.wins++;
    }
  }

  if (currentState.phase !== GAME_PHASES.GAME_OVER) {
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
 * @param {number}  [config.maxTurns=500] - Max turns before stalemate
 * @param {Function} [config.onTurn]     - Callback after each turn: (turnNumber, state)
 * @returns {MatchResult}
 */
export function runMatch(config) {
  const { bots, seed, maxTurns = DEFAULT_MAX_TURNS, onTurn } = config;

  const names = new Set(bots.map(b => b.name));
  if (names.size !== bots.length) {
    throw new Error('Bot names must be unique');
  }

  const gameState = createGame({
    seed,
    playerCount: bots.length,
  });

  /*
   * Map player indices to bot functions.
   * turnOrder determines which player goes first, but bots[i] maps to player i.
   */
  const botFnByPlayer = bots.map(b => b.fn);
  const botNameByPlayer = bots.map(b => b.name);

  // Per-player attack stats
  const attackStats = bots.map(() => ({ attacks: 0, wins: 0 }));

  // Track elimination order for placement calculation
  const eliminationOrder = [];

  let state = gameState;
  let turnCount = 0;

  while (state.phase !== GAME_PHASES.GAME_OVER && turnCount < maxTurns) {
    const currentPlayerId = state.turnOrder[state.currentPlayerIndex];

    // Skip eliminated players (engine should handle this, but be safe)
    if (state.players[currentPlayerId].eliminated) {
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
      attackStats[currentPlayerId]
    );

    // Track newly eliminated players
    for (const p of state.players) {
      if (p.eliminated && !prevEliminated.includes(p.id) && !eliminationOrder.includes(p.id)) {
        eliminationOrder.push(p.id);
      }
    }

    turnCount++;
    if (onTurn) onTurn(turnCount, state);
  }

  // Calculate placements
  const placements = calculatePlacements(state, eliminationOrder);

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
  }));

  return {
    winner: state.winner,
    winnerName: state.winner !== null ? botNameByPlayer[state.winner] : null,
    turnCount,
    placements,
    botStats,
    config: { seed: gameState.config.seed, playerCount: bots.length },
    finalState: state,
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
