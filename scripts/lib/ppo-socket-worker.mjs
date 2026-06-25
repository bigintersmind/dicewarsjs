/**
 * PPO env-server socket worker (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * Runs on a worker thread and owns the TCP socket so the MAIN thread can drive a
 * fully-synchronous `runMatch` and still block for one action per learner decision:
 * the engine match loop is synchronous (`runBotDirect` calls the bot fn without
 * awaiting), so the learner shim cannot use async IO. Instead the main thread writes
 * the outbound frame here (via `postMessage`) and parks on `Atomics.wait`; this worker
 * does the async socket IO and wakes it with `Atomics.notify` once the 4-byte action
 * index arrives. This is the brief's risk-#1 mitigation: the only blocking read lives
 * off the main thread.
 *
 * Wire protocol (Node is the SERVER; the Python/JS learner connects):
 *   OUT (env → learner): [u32 LE byteLength][frame bytes]   (length-prefixed obs frame)
 *   IN  (learner → env): one i32 LE action index per non-terminal frame (no prefix)
 * Terminal frames (header terminal=1) expect NO reply.
 *
 * Shared control block (Int32Array over the SharedArrayBuffer in workerData.sab):
 *   ctrl[0] STATUS: 0 = main is waiting, 1 = action ready, 2 = connection closed/errored
 *   ctrl[1] ACTION: the i32 action index (valid when STATUS === 1)
 *
 * @module scripts/lib/ppo-socket-worker
 */

import net from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';

const STATUS = 0;
const ACTION = 1;
// Status values this worker WRITES (main writes 0 = waiting before parking).
const ST_READY = 1;
const ST_CLOSED = 2;

const ctrl = new Int32Array(workerData.sab);
const host = workerData.host ?? '127.0.0.1';
const port = workerData.port ?? 0;

let socket = null;
let inbound = Buffer.alloc(0);
let pendingRead = null; // { need, resolve, reject }

/** Wake a main thread parked in Atomics.wait with the given status. */
function wake(status, action = 0) {
  if (status === ST_READY) Atomics.store(ctrl, ACTION, action);
  Atomics.store(ctrl, STATUS, status);
  Atomics.notify(ctrl, STATUS);
}

/*
 * Last-resort guard. The main thread parks on Atomics.wait during a decision and can ONLY be
 * unparked by an Atomics.notify from here — its own event loop is blocked, so `worker.on('error')`
 * on the parent can't help it. If this worker is about to die with a decision outstanding, wake the
 * main thread with ST_CLOSED first (so the server fails fast instead of hanging forever) and report
 * the cause. Swallowing keeps the worker alive long enough for the woken main thread to reap it.
 */
function failSafe(err) {
  try {
    parentPort.postMessage({ type: 'worker-error', message: err?.message ?? String(err) });
  } catch {
    /* parent already gone */
  }
  try {
    wake(ST_CLOSED);
  } catch {
    /* shared memory torn down */
  }
}
process.on('uncaughtException', failSafe);
process.on('unhandledRejection', failSafe);

function tryResolveRead() {
  if (pendingRead && inbound.length >= pendingRead.need) {
    const { need, resolve } = pendingRead;
    const chunk = Buffer.from(inbound.subarray(0, need));
    inbound = inbound.subarray(need);
    pendingRead = null;
    resolve(chunk);
  }
}

/** Resolve once `n` bytes are available, consuming them from the inbound buffer. */
function readExactly(n) {
  /*
   * Strict request/response means only one read is ever outstanding; guard anyway so a future
   * re-entrant call fails loudly instead of silently abandoning a never-settled promise.
   */
  if (pendingRead) return Promise.reject(new Error('readExactly: a read is already pending'));
  return new Promise((resolve, reject) => {
    pendingRead = { need: n, resolve, reject };
    tryResolveRead();
  });
}

function writeFramed(frameArrayBuffer) {
  const frame = Buffer.from(frameArrayBuffer);
  const lenPrefix = Buffer.allocUnsafe(4);
  lenPrefix.writeUInt32LE(frame.byteLength, 0);
  socket.write(lenPrefix);
  socket.write(frame);
}

async function handleObs(frameArrayBuffer) {
  if (!socket) {
    wake(ST_CLOSED);
    return;
  }
  /*
   * writeFramed is inside the try so a synchronous write failure also wakes main (ST_CLOSED)
   * rather than escaping as an unhandled rejection that would leave main parked forever.
   */
  try {
    writeFramed(frameArrayBuffer);
    const actionBuf = await readExactly(4);
    wake(ST_READY, actionBuf.readInt32LE(0));
  } catch {
    wake(ST_CLOSED);
  }
}

function onSocketGone(reason) {
  socket = null;
  // Fail any pending read so a parked main thread unblocks with ST_CLOSED.
  if (pendingRead) {
    const { reject } = pendingRead;
    pendingRead = null;
    reject(new Error(`socket ${reason}`));
  }
  /*
   * Always tell main, even when a read was pending. A mid-decision disconnect is the COMMON case
   * (the server spends most of its time parked waiting on the learner's action), and the rejected
   * read alone only forfeits one turn — without this message the episode loop never sees `closed`
   * and, with --episodes=0, would spin forever simulating matches after the client is gone.
   */
  parentPort.postMessage({ type: 'closed', reason });
}

const server = net.createServer(conn => {
  if (socket) {
    /*
     * One learner per server instance (D-19: one env per connection). Swallow any error on this
     * rejected connection (e.g. an ECONNRESET racing the destroy) so it can't become an unhandled
     * 'error' → failSafe → spurious shutdown of the healthy server already serving a learner.
     */
    conn.on('error', () => {});
    conn.destroy();
    return;
  }
  socket = conn;
  socket.on('data', chunk => {
    inbound = inbound.length ? Buffer.concat([inbound, chunk]) : chunk;
    tryResolveRead();
  });
  socket.on('close', () => onSocketGone('closed'));
  socket.on('error', err => onSocketGone(`error: ${err.message}`));
  parentPort.postMessage({ type: 'connected' });
});

server.on('error', err => {
  parentPort.postMessage({ type: 'server-error', message: err.message });
});

server.listen(port, host, () => {
  parentPort.postMessage({ type: 'listening', port: server.address().port, host });
});

parentPort.on('message', msg => {
  switch (msg.type) {
    case 'obs':
      handleObs(msg.frame);
      break;
    case 'terminal':
      // Terminal frame: send it, expect no reply.
      if (socket) writeFramed(msg.frame);
      break;
    case 'shutdown':
      if (socket) socket.destroy();
      server.close(() => parentPort.postMessage({ type: 'shutdown-done' }));
      break;
    default:
      parentPort.postMessage({ type: 'worker-error', message: `unknown message ${msg.type}` });
  }
});
