/**
 * Bot Runner
 *
 * Executes a bot function and normalizes its result.
 *
 * @module arena/botRunner
 */

// eslint-disable-next-line no-unused-vars -- used in JSDoc
import './types.js';

/**
 * Run a bot function directly (synchronous, no timeout).
 *
 * Bots are trusted code (built-in strategies and CI-validated community
 * submissions), so no sandboxing is needed. The match runner uses this for
 * every bot.
 *
 * @param {Function} botFn - Bot function: (BotState) → { from, to } | null
 * @param {import('./types.js').BotState} botState
 * @returns {{ move: import('./types.js').BotMove|null, error?: string }}
 */
export function runBotDirect(botFn, botState) {
  try {
    const move = botFn(botState);
    return { move: move ?? null };
  } catch (err) {
    return { move: null, error: err.message };
  }
}
