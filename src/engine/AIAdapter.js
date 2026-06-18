/**
 * AI Adapter Layer
 *
 * Bridges the new pure engine state to the legacy AI interface.
 * Creates a throwaway mutable "game view" that AIs can mutate,
 * then extracts the move decision.
 *
 * @module engine/AIAdapter
 */

import { applyAction, getValidMoves } from './StateManager.js';
import { ACTION_TYPES, GAME_PHASES } from './constants.js';
import { playerSlotCount } from '../ai/playerCount.js';

/**
 * Transform engine GameState into the mutable shape legacy AIs expect.
 *
 * The returned object has the same property names and layout as the
 * original Game class (see tests/mocks/gameMock.js for the canonical shape).
 * AIs write to `area_from` and `area_to`; the adapter reads them back.
 *
 * @param {import('./types.js').GameState} state
 * @returns {Object} Mutable game view for AI consumption
 */
export function createLegacyGameView(state) {
  const { areas, players, turnOrder, currentPlayerIndex } = state;
  const AREA_MAX = areas.length;

  // Build adat[] in legacy shape: { size, arm, dice, join[] }
  const adat = new Array(AREA_MAX);
  for (let a = 0; a < AREA_MAX; a++) {
    const area = areas[a];
    // join[] is a flat array indexed by area ID, 1 = adjacent
    const join = new Array(AREA_MAX).fill(0);
    for (const adjId of area.neighborAreaIds) {
      join[adjId] = 1;
    }
    adat[a] = {
      size: area.size,
      arm: area.owner,
      dice: area.dice,
      join,
    };
  }

  /*
   * Build player[] in legacy shape, one entry per real player. Games can have
   * more than 8 players, so size via playerSlotCount — the same board-aware
   * sizing the AIs use through getPlayerCount — so player.length always covers
   * every owner index. Floors at 8 because some legacy AIs still index up to 8
   * unconditionally; extra slots above players.length are empty pads.
   */
  const playerSlots = playerSlotCount(players.length, adat, AREA_MAX);
  const player = new Array(playerSlots);
  for (let i = 0; i < playerSlots; i++) {
    if (i < players.length) {
      player[i] = {
        area_c: players[i].territoryCount,
        dice_c: players[i].diceCount,
        area_tc: players[i].largestGroup,
        dice_jun: 0,
        stock: players[i].stock,
      };
    } else {
      player[i] = { area_c: 0, dice_c: 0, area_tc: 0, dice_jun: 0, stock: 0 };
    }
  }

  const view = {
    AREA_MAX,
    adat,
    player,
    jun: [...turnOrder],
    ban: currentPlayerIndex,
    area_from: 0,
    area_to: 0,
    get_pn() {
      return this.jun[this.ban];
    },
    set_area_tc(/* pn */) {
      /*
       * No-op: legacy code calls this to recalculate largest connected group
       * (area_tc), but the adapter snapshots this from engine state at creation.
       */
    },
  };

  // Pad jun up to the player-slot count if the turn order is shorter.
  while (view.jun.length < playerSlots) {
    view.jun.push(view.jun.length);
  }

  return view;
}

/**
 * Run a single AI decision step.
 *
 * Two calling conventions are supported:
 * - Legacy AIs (the built-in strategies): called with a mutable legacy game
 *   view; they set `area_from`/`area_to` and return 0 to end their turn.
 * - Modern bots (arena/community bots wrapped by `adaptModernBot`, marked with
 *   `__modernBot`): called with the engine state directly and return
 *   `{ from, to } | null`. `runAI` passes the raw state to the wrapper, and the
 *   wrapper (from `adaptModernBot`) sanitizes it into a BotState before invoking
 *   the real bot — so the untrusted bot code only ever sees the sanitized
 *   BotState, never raw engine state. A `__modernBot` function MUST come from
 *   `adaptModernBot`; that is what makes a throw here an adapter bug, not a
 *   bot bug (the wrapper already swallows the bot's own throws).
 *
 * @param {import('./types.js').GameState} state
 * @param {Function} aiFunction - Legacy AI function (game → void|0) or a modern
 *   bot tagged `__modernBot` (state → { from, to } | null)
 * @returns {{ from: number, to: number } | null} Move or null to end turn
 */
export function runAI(state, aiFunction) {
  // Modern bots take the engine state directly and return a move.
  if (aiFunction && aiFunction.__modernBot) {
    let move;
    try {
      move = aiFunction(state);
    } catch (err) {
      const playerId = state.turnOrder[state.currentPlayerIndex];
      /*
       * The adapter already catches the bot's own throws; reaching here means
       * the adapter/sanitization layer failed — surface it as an adapter bug.
       */
      throw new Error(`Modern bot adapter error for player ${playerId}: ${err.message}`, {
        cause: err,
      });
    }
    if (move && typeof move.from === 'number' && typeof move.to === 'number') {
      if (move.from > 0 && move.to > 0) return { from: move.from, to: move.to };
      /*
       * { from: 0, to: 0 } is a conventional "no move" sentinel (area 0 is
       * unused). Any other non-positive/NaN pair is a bot bug, so warn rather
       * than silently ending the turn — consistent with the legacy path below.
       */
      if (!(move.from === 0 && move.to === 0)) {
        const playerId = state.turnOrder[state.currentPlayerIndex];
        console.warn(
          `Modern bot for player ${playerId} returned an out-of-range move ` +
            `(from=${move.from}, to=${move.to}). Treating as end turn.`
        );
      }
    }
    return null;
  }

  const view = createLegacyGameView(state);
  let result;
  try {
    result = aiFunction(view);
  } catch (err) {
    const playerId = state.turnOrder[state.currentPlayerIndex];
    console.error(`AI threw for player ${playerId}: ${err.message}\n${err.stack}`);
    // Re-throw infrastructure errors that indicate adapter bugs, not AI logic errors
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) {
      throw new Error(`AI adapter error for player ${playerId}: ${err.message}`, { cause: err });
    }
    return null;
  }

  // AI returns 0 to end turn
  if (result === 0) return null;

  // AI sets area_from and area_to
  if (view.area_from > 0 && view.area_to > 0) {
    return { from: view.area_from, to: view.area_to };
  }

  // AI returned unexpected value without setting area targets
  if (result !== undefined && result !== 0) {
    const playerId = state.turnOrder[state.currentPlayerIndex];
    console.warn(
      `AI for player ${playerId} returned unexpected value (${result}) without setting area_from/area_to. Treating as end turn.`
    );
  }
  return null;
}

/**
 * Run a full AI turn: repeatedly call the AI and apply attacks
 * until it ends its turn, then apply END_TURN.
 *
 * @param {import('./types.js').GameState} state
 * @param {Function} aiFunction - Legacy AI function
 * @param {Object} [options]
 * @param {number} [options.maxMoves=100] - Safety cap on moves per turn
 * @returns {import('./types.js').GameState} State after the full turn
 */
export function runFullAITurn(state, aiFunction, options = {}) {
  const maxMoves = options.maxMoves ?? 100;
  const maxConsecutiveInvalid = 3;
  let currentState = state;
  let consecutiveInvalid = 0;

  for (let i = 0; i < maxMoves; i++) {
    // Check if the game is over
    if (currentState.phase === GAME_PHASES.GAME_OVER) return currentState;

    // Get the AI's decision
    const move = runAI(currentState, aiFunction);

    if (move === null) break; // AI wants to end turn

    // Validate the move is legal before applying
    const validMoves = getValidMoves(currentState);
    const isValid = validMoves.some(m => m.from === move.from && m.to === move.to);

    if (!isValid) {
      consecutiveInvalid++;
      const playerId = state.turnOrder[state.currentPlayerIndex];
      if (consecutiveInvalid >= maxConsecutiveInvalid) {
        throw new Error(
          `AI for player ${playerId} produced ${maxConsecutiveInvalid} consecutive invalid moves — likely an adapter bug`
        );
      }
      console.warn(
        `AI proposed invalid move from=${move.from} to=${move.to} for player ${playerId}. Ending turn.`
      );
      break;
    }

    consecutiveInvalid = 0;

    // Apply the attack
    currentState = applyAction(currentState, {
      type: ACTION_TYPES.ATTACK,
      from: move.from,
      to: move.to,
    });
  }

  // End the turn (apply reinforcements + advance)
  if (currentState.phase !== GAME_PHASES.GAME_OVER) {
    currentState = applyAction(currentState, { type: ACTION_TYPES.END_TURN });
  }

  return currentState;
}
