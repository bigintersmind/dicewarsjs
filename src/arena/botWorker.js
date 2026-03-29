/**
 * Bot Worker Entry Point
 *
 * Web Worker that sandboxes untrusted bot execution.
 * Receives bot source on INIT, then executes it per MOVE request.
 *
 * Protocol:
 *   Main → Worker: { type: 'INIT', botSource: string }
 *   Worker → Main: { type: 'READY' } | { type: 'ERROR', error: string }
 *
 *   Main → Worker: { type: 'MOVE', botState: BotState }
 *   Worker → Main: { type: 'MOVE_RESULT', move: BotMove|null, error?: string }
 *
 * @module arena/botWorker
 */

let botFn = null;

self.onmessage = ({ data }) => {
  if (data.type === 'INIT') {
    try {
      /*
       * Create bot function from source — expects source to be a function body
       * that receives `state` as the parameter and returns a move or null.
       */
      // eslint-disable-next-line no-new-func
      botFn = new Function('state', data.botSource);
      self.postMessage({ type: 'READY' });
    } catch (err) {
      self.postMessage({ type: 'ERROR', error: err.message });
    }
    return;
  }

  if (data.type === 'MOVE') {
    if (!botFn) {
      self.postMessage({ type: 'MOVE_RESULT', move: null, error: 'Bot not initialized' });
      return;
    }

    try {
      const move = botFn(data.botState);
      self.postMessage({ type: 'MOVE_RESULT', move: move ?? null });
    } catch (err) {
      self.postMessage({ type: 'MOVE_RESULT', move: null, error: err.message });
    }
  }
};
