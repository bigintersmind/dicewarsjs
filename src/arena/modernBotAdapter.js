/**
 * Modern Bot Adapter (reverse of legacyBotAdapter)
 *
 * Wraps a modern-style bot — `(BotState) => { from, to } | null`, the signature
 * used by arena and community bots — so it can run inside the in-game AI loop,
 * which drives functions through `runAI(state, fn)` in engine/AIAdapter.
 *
 * The wrapped function takes the engine GameState directly and builds a
 * BotState with the SAME `createBotState` the arena uses, so a community bot
 * behaves identically in-game and in the arena. It is tagged `__modernBot` so
 * `runAI` calls it with state (instead of building a legacy mutable game view).
 *
 * @module arena/modernBotAdapter
 */

import { createBotState } from './botState.js';

/**
 * Wrap a modern bot function for the in-game AI loop.
 *
 * `adaptModernBot` is the ONLY supported producer of `__modernBot`-tagged
 * functions: its try/catch converts a bot's own throw into end-turn, which is
 * what lets `runAI` treat any throw it sees from a tagged function as an
 * adapter/sanitization bug (see engine/AIAdapter.js). Tag a raw bot `__modernBot`
 * without this wrapper and that invariant breaks.
 *
 * @param {Function} modernFn - Modern bot: (BotState) → { from, to } | null
 * @param {string}   [name]   - Optional name for debugging
 * @returns {Function} Engine-callable bot: (GameState) → { from, to } | null,
 *   tagged with `__modernBot = true`.
 */
export function adaptModernBot(modernFn, name) {
  const botName = name || modernFn.botName || modernFn.name || 'modern_bot';

  function wrapped(state) {
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    let move;
    try {
      move = modernFn(botState);
    } catch (err) {
      /*
       * A community/arena bot throwing is a bot error, not an adapter bug —
       * log it (with stack, to match the legacy path) and end the turn rather
       * than crashing the game loop.
       */
      console.warn(`Modern bot "${botName}" threw: ${err.message}\n${err.stack}`);
      return null;
    }

    if (move && typeof move.from === 'number' && typeof move.to === 'number') {
      return { from: move.from, to: move.to };
    }

    /*
     * null / undefined is the legitimate "I'm done" signal. A truthy-but-wrong
     * shape is almost always a bot bug (e.g. a typo'd move), so warn rather than
     * silently passing — mirroring the legacy path's "unexpected value" warning.
     */
    if (move != null) {
      console.warn(
        `Modern bot "${botName}" returned a malformed move ${JSON.stringify(move)}; ` +
          `expected { from: number, to: number } or null. Ending turn.`
      );
    }
    return null;
  }

  wrapped.__modernBot = true;
  Object.defineProperty(wrapped, 'name', { value: botName });
  return wrapped;
}
