/**
 * Bot Runner
 *
 * Provides two execution paths for bot functions:
 * - runBotDirect: synchronous, for trusted built-in bots (fast arena path)
 * - runBotMove: async via Web Worker with timeout, for untrusted user bots
 * - createBotWorker: creates a sandboxed Worker from bot source code
 *
 * @module arena/botRunner
 */

// eslint-disable-next-line no-unused-vars -- used in JSDoc
import './types.js';

/** Default timeout for worker-based bot execution (ms) */
const DEFAULT_TIMEOUT = 100;

/**
 * Run a bot function directly (no Worker, no timeout).
 * Use for trusted built-in bots where sandboxing is unnecessary.
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

/**
 * Create an isolated Web Worker for a user-provided bot.
 * The worker runs on a separate thread with timeout enforcement,
 * but is not a security sandbox (bots can still access network APIs).
 *
 * The bot source should be a function body that receives `state`
 * as a parameter and returns `{ from, to }` or `null`.
 *
 * @param {string} botSource - Bot source code (function body)
 * @returns {Promise<Worker>} Initialized Worker ready for MOVE messages
 * @throws {Error} If the bot source fails to initialize
 */
export function createBotWorker(botSource) {
  return new Promise((resolve, reject) => {
    // Create worker using Vite's native worker support
    const worker = new Worker(new URL('./botWorker.js', import.meta.url), {
      type: 'module',
    });

    const onMessage = ({ data }) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);

      if (data.type === 'READY') {
        resolve(worker);
      } else if (data.type === 'ERROR') {
        worker.terminate();
        reject(new Error(`Bot init failed: ${data.error}`));
      }
    };

    const onError = err => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      reject(new Error(`Worker error: ${err.message}`));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'INIT', botSource });
  });
}

/**
 * Run a bot move via a Web Worker with timeout enforcement.
 *
 * If the bot does not respond within the timeout, the worker is terminated
 * and the move is treated as null (end turn).
 *
 * @param {Worker} worker - Initialized bot worker
 * @param {import('./types.js').BotState} botState
 * @param {Object} [options]
 * @param {number} [options.timeout=100] - Max execution time in ms
 * @returns {Promise<{ move: import('./types.js').BotMove|null, error?: string, timedOut?: boolean }>}
 */
export function runBotMove(worker, botState, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  return new Promise(resolve => {
    let timer = null;
    let settled = false;

    const onMessage = ({ data }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);

      if (data.type === 'MOVE_RESULT') {
        resolve({
          move: data.move ?? null,
          error: data.error,
        });
      } else {
        resolve({ move: null, error: `Unexpected message type: ${data.type}` });
      }
    };

    worker.addEventListener('message', onMessage);

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.removeEventListener('message', onMessage);
      worker.terminate();
      resolve({ move: null, timedOut: true });
    }, timeout);

    worker.postMessage({ type: 'MOVE', botState });
  });
}
