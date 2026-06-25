/**
 * PPO self-play env-server (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * A persistent Node server the Python PPO trainer (or any learner client) connects to.
 * Per connection it runs self-play episodes: the designated learner seat plays an
 * N-FFA match against in-process opponent bots, emitting one binary observation frame
 * per learner decision and blocking for the learner's i32 action index, then a terminal
 * frame with the episode reward. The game engine, the opponents, and the action decode
 * are the SAME code the arena and the shipped BC bot use (`runMatch`, `runSelfPlayEpisode`,
 * `decodeAction`) — the server only adds transport.
 *
 * Synchronous blocking read: `runMatch` is synchronous, so the learner shim cannot await.
 * A worker thread (`lib/ppo-socket-worker.mjs`) owns the socket and does the async IO; the
 * main thread parks on `Atomics.wait` and is woken with the action. See [D-19].
 *
 * Usage:
 *   node scripts/ppo-env-server.mjs [--port=0] [--host=127.0.0.1] [--players=7]
 *        [--learner-seat=0] [--opponents=ai_bc,ai_lookahead] [--max-areas=<N>]
 *        [--max-turns=500] [--episodes=0] [--seed-base=1]
 *
 * `--episodes=0` runs until the client disconnects. The chosen port is printed as
 * `PPO_ENV_SERVER LISTENING <host> <port>` once listening (use --port=0 for an OS port).
 *
 * @module scripts/ppo-env-server
 */

import { Worker } from 'node:worker_threads';

import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { createBotState } from '../src/arena/botState.js';
import { encodeObservationForInference } from '../src/arena/encodeObservation.js';
import { BC_POLICY } from '../src/ai/bcPolicyWeights.js';

import { runSelfPlayEpisode } from './lib/ppo-env.mjs';
import { buildObsFrame, serializeObsFrame } from './lib/obs-frame.mjs';

const STATUS = 0;
const ACTION = 1;
const ST_WAITING = 0;
const ST_CLOSED = 2;

/** Raised when the learner client disconnects mid-episode. */
class EnvClosed extends Error {}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) opts[m[1]] = m[2];
  }
  return opts;
}

/** Resolve `count` opponent bot fns from BUILT_IN_BOTS, cycling the id list to fill. */
function resolveOpponents(idCsv, count) {
  const ids = idCsv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error('--opponents resolved to an empty list.');
  const byId = new Map(BUILT_IN_BOTS.map(b => [b.id, b]));
  return Array.from({ length: count }, (_, i) => {
    const id = ids[i % ids.length];
    const bot = byId.get(id);
    if (!bot) {
      throw new Error(`Unknown opponent bot id "${id}". Known: ${[...byId.keys()].join(', ')}.`);
    }
    return { name: `${bot.name}@${i}`, fn: bot.fn };
  });
}

/** A fresh standalone ArrayBuffer holding exactly the frame's bytes (safe to clone). */
function frameToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  /*
   * A learner client (or the parent reading our stdout) can vanish mid-run; a broken
   * pipe must not crash the server — let the episode loop notice via the worker instead.
   */
  process.stdout.on('error', () => {});

  const opts = parseArgs(process.argv.slice(2));
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port !== undefined ? Number(opts.port) : 0;
  const playerCount = opts.players !== undefined ? Number(opts.players) : 7;
  const learnerSeat = opts['learner-seat'] !== undefined ? Number(opts['learner-seat']) : 0;
  const maxAreas =
    opts['max-areas'] !== undefined ? Number(opts['max-areas']) : BC_POLICY.config.maxAreas;
  const maxTurns = opts['max-turns'] !== undefined ? Number(opts['max-turns']) : 500;
  const episodes = opts.episodes !== undefined ? Number(opts.episodes) : 0;
  const seedBase = opts['seed-base'] !== undefined ? Number(opts['seed-base']) : 1;
  const opponents = resolveOpponents(opts.opponents ?? 'ai_bc', playerCount - 1);

  const sab = new SharedArrayBuffer(8); // 2 × Int32
  const ctrl = new Int32Array(sab);
  const worker = new Worker(new URL('./lib/ppo-socket-worker.mjs', import.meta.url), {
    workerData: { sab, host, port },
  });

  let closed = false;
  let connectedResolve;
  const connected = new Promise(res => {
    connectedResolve = res;
  });
  worker.on('message', msg => {
    switch (msg.type) {
      case 'listening':
        process.stdout.write(`PPO_ENV_SERVER LISTENING ${msg.host} ${msg.port}\n`);
        break;
      case 'connected':
        connectedResolve();
        break;
      case 'closed':
        closed = true;
        break;
      case 'server-error':
        process.stderr.write(`[ppo-env-server] server error: ${msg.message}\n`);
        closed = true;
        connectedResolve();
        break;
      default:
        break;
    }
  });
  worker.on('error', err => {
    process.stderr.write(`[ppo-env-server] worker error: ${err.message}\n`);
    closed = true;
    connectedResolve();
  });

  await connected;

  // The learner's synchronous action selector: emit a frame, park, wake with the index.
  const chooseAction = (encoded, botState) => {
    const buf = serializeObsFrame(buildObsFrame({ encoded, botState, maxAreas }));
    Atomics.store(ctrl, STATUS, ST_WAITING);
    worker.postMessage({ type: 'obs', frame: frameToArrayBuffer(buf) });
    Atomics.wait(ctrl, STATUS, ST_WAITING);
    if (Atomics.load(ctrl, STATUS) === ST_CLOSED) throw new EnvClosed('learner disconnected');
    return Atomics.load(ctrl, ACTION);
  };

  let played = 0;
  for (let ep = 0; episodes === 0 || ep < episodes; ep++) {
    if (closed) break;
    const seed = seedBase + ep;
    let result;
    try {
      result = runSelfPlayEpisode({
        seed,
        opponents,
        learnerSeat,
        maxAreas,
        maxTurns,
        chooseAction,
      });
    } catch (err) {
      if (err instanceof EnvClosed) break;
      throw err;
    }

    // Terminal frame: the learner's view of the final board + the episode reward.
    const termState = createBotState(result.finalState, learnerSeat);
    const termEnc = encodeObservationForInference(termState, { maxAreas });
    const termFrame = buildObsFrame({
      encoded: termEnc,
      botState: termState,
      maxAreas,
      terminal: 1,
      winner: result.winner ?? -1,
      won: result.won,
      placement: result.placement,
    });
    worker.postMessage({
      type: 'terminal',
      frame: frameToArrayBuffer(serializeObsFrame(termFrame)),
    });
    played++;

    /*
     * Yield so the worker flushes the terminal frame and any 'closed' message lands
     * before we commit to another blocking episode.
     */
    await new Promise(res => setImmediate(res));
  }

  process.stdout.write(`PPO_ENV_SERVER DONE episodes=${played}\n`);
  worker.postMessage({ type: 'shutdown' });
  await new Promise(res => {
    worker.once('message', m => m.type === 'shutdown-done' && res());
    setTimeout(res, 500).unref();
  });
  await worker.terminate();
}

main().catch(err => {
  process.stderr.write(`[ppo-env-server] fatal: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
