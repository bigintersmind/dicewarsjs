/**
 * PPO self-play env-server (ml-bot Phase 3 — [D-19], tracer step 1).
 *
 * A persistent Node server the Python PPO trainer (or any learner client) connects to.
 * Per connection it runs self-play episodes: the designated learner seat plays an
 * N-FFA match against in-process opponent bots, emitting one binary observation frame
 * per learner decision and blocking for the learner's i32 action index, then a terminal
 * frame with the episode reward. The episode terminates at the LEARNER's elimination
 * (reward = loss) — not at game-over — so the opponent-only tail is never simulated (the
 * correct single-learner PPO terminal; ~2× the throughput — see `runSelfPlayEpisode`'s
 * `terminateOnElimination`). The game engine, the opponents, and the action decode are the
 * SAME code the arena and the shipped BC bot use (`runMatch`, `runSelfPlayEpisode`,
 * `decodeAction`) — the server only adds transport.
 *
 * Synchronous blocking read: `runMatch` is synchronous, so the learner shim cannot await.
 * A worker thread (`lib/ppo-socket-worker.mjs`) owns the socket and does the async IO; the
 * main thread parks on `Atomics.wait` and is woken with the action. See [D-19].
 *
 * Usage:
 *   node scripts/ppo-env-server.mjs [--port=0] [--host=127.0.0.1] [--players=7]
 *        [--learner-seat=0] [--opponents=ai_bc,ai_lookahead] [--max-areas=<N>]
 *        [--max-turns=500] [--episodes=0] [--seed-base=1] [--decision-timeout-ms=120000]
 *
 * `--decision-timeout-ms` is the per-decision watchdog: if the learner sends no action within it,
 * the server aborts loud instead of parking forever (covers a hung learner or a hard worker death).
 * 0 disables it.
 *
 * `--episodes=0` runs until the client disconnects. The chosen port is printed as
 * `PPO_ENV_SERVER LISTENING <host> <port>` once listening (use --port=0 for an OS port).
 *
 * @module scripts/ppo-env-server
 */

import { Worker } from 'node:worker_threads';

import { createBotState } from '../src/arena/botState.js';
import { encodeObservationForInference } from '../src/arena/encodeObservation.js';
import { BC_POLICY } from '../src/ai/bcPolicyWeights.js';

import { runSelfPlayEpisode } from './lib/ppo-env.mjs';
import { makeLeague } from './lib/ppo-league.mjs';
import { buildObsFrame, serializeObsFrame } from './lib/obs-frame.mjs';

const STATUS = 0;
const ACTION = 1;
const ST_WAITING = 0;
const ST_CLOSED = 2;

/** Raised when the learner client disconnects mid-episode. */
class EnvClosed extends Error {}

const KNOWN_FLAGS = new Set([
  'host',
  'port',
  'players',
  'learner-seat',
  'max-areas',
  'max-turns',
  'episodes',
  'seed-base',
  'opponents',
  'decision-timeout-ms',
]);

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (!m) throw new Error(`Malformed argument "${arg}" — expected --key=value.`);
    if (!KNOWN_FLAGS.has(m[1])) {
      throw new Error(`Unknown flag --${m[1]}. Known: ${[...KNOWN_FLAGS].join(', ')}.`);
    }
    opts[m[1]] = m[2];
  }
  return opts;
}

/** Parse a numeric flag, defaulting when absent and rejecting a non-finite value loudly. */
function numArg(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const v = Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key}=${opts[key]} is not a finite number.`);
  return v;
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
  const port = numArg(opts, 'port', 0);
  const playerCount = numArg(opts, 'players', 7);
  const learnerSeat = numArg(opts, 'learner-seat', 0);
  const maxAreas = numArg(opts, 'max-areas', BC_POLICY.config.maxAreas);
  const maxTurns = numArg(opts, 'max-turns', 500);
  const episodes = numArg(opts, 'episodes', 0);
  const seedBase = numArg(opts, 'seed-base', 1);
  // Per-decision watchdog deadline (ms). Generous — inference is sub-second; 0 disables it.
  const decisionTimeoutMs = numArg(opts, 'decision-timeout-ms', 120000);
  /*
   * The opponent league (ml-bot task B — [D-22]). B1: the pool is empty, so every `draw()` returns
   * the cycled baseline field — content-identical to the static field task A trained on (the env-server
   * default is the single bot `ai_bc`; the trainer passes the full `--opponents` CSV). Snapshots
   * (B3) and PFSP weighting (B4) extend the same league; fixed-field is its empty-pool mode.
   */
  const league = makeLeague({
    baselineCsv: opts.opponents ?? 'ai_bc',
    count: playerCount - 1,
    learnerSeat,
  });

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
        process.exitCode = 1;
        closed = true;
        connectedResolve();
        break;
      case 'worker-error':
        process.stderr.write(`[ppo-env-server] worker reported: ${msg.message}\n`);
        process.exitCode = 1;
        closed = true;
        connectedResolve();
        break;
      default:
        break;
    }
  });
  worker.on('error', err => {
    process.stderr.write(`[ppo-env-server] worker error: ${err.message}\n`);
    process.exitCode = 1;
    closed = true;
    connectedResolve();
  });

  /*
   * Set the moment the learner is lost — a clean disconnect (EnvClosed → exit 0), a watchdog
   * timeout, or an action-space desync (plain Error → fatal, exit 1). Every one of these is thrown
   * from chooseAction, which runs INSIDE the learner bot fn — and `runBotDirect` swallows every
   * bot-fn throw (it just forfeits the turn). So the throw here cannot unwind the match on its own;
   * `failIfLost` (an onTurn guard) re-raises it on the next turn boundary, and an onTurn throw DOES
   * propagate out of `runMatch`/`runSelfPlayEpisode` (it is not the LEARNER_ELIMINATED sentinel).
   */
  let lostError = null;

  /*
   * Learner decisions emitted in the CURRENT episode (reset per episode below). Lets the loop
   * detect a "zero-decision" episode — the learner eliminated before it ever took a turn, so
   * chooseAction never fired and no obs frame was sent. Surfacing a terminal for such an episode
   * would desync the client's reset() (which expects the next episode's first obs, not a bare
   * terminal); see the skip in the episode loop.
   */
  let decisionsThisEpisode = 0;

  /*
   * The learner's synchronous action selector: emit a frame, park (with a watchdog deadline), and
   * either return the validated index or record why the learner was lost and throw.
   */
  const chooseAction = (encoded, botState) => {
    decisionsThisEpisode++;
    const buf = serializeObsFrame(buildObsFrame({ encoded, botState, maxAreas }));
    Atomics.store(ctrl, STATUS, ST_WAITING);
    worker.postMessage({ type: 'obs', frame: frameToArrayBuffer(buf) });

    /*
     * Watchdog: without a deadline, a HARD worker death (segfault/OOM-kill — no JS exception, so the
     * worker's failSafe never runs) or a connected-but-silent learner (alive socket, never sends its
     * action — no 'close'/'error' fires) would park this thread on Atomics.wait FOREVER, and main's
     * own blocked event loop means worker.on('error')/'exit') can never rescue it. A finite timeout
     * turns every such hang into a bounded, loud abort. 0 disables it (infinite wait).
     */
    if (decisionTimeoutMs > 0) Atomics.wait(ctrl, STATUS, ST_WAITING, decisionTimeoutMs);
    else Atomics.wait(ctrl, STATUS, ST_WAITING);

    const status = Atomics.load(ctrl, STATUS);
    if (status === ST_CLOSED) {
      lostError = new EnvClosed('learner disconnected');
      throw lostError;
    }
    if (status === ST_WAITING) {
      // The deadline elapsed with no action (still ST_WAITING ⇒ nobody notified) — unresponsive.
      lostError = new Error(
        `PPO env-server: no action within ${decisionTimeoutMs}ms — learner unresponsive or worker died.`
      );
      throw lostError;
    }

    const idx = Atomics.load(ctrl, ACTION);
    const n = encoded.moves.length;
    if (idx < 0 || idx >= n) {
      /*
       * Action-space desync: the learner sent an index outside the legal range for this decision.
       * decodeAction's own range guard is DEAD on this path (runBotDirect would swallow it into a
       * silent turn-forfeit → a stream of valid-looking, corrupt low-reward episodes). Surface it as
       * a FATAL error (re-raised by failIfLost → not EnvClosed → exit 1) so a trainer-side masking /
       * MAX_EDGES bug fails loud instead of quietly poisoning the training data.
       */
      lostError = new Error(
        `PPO env-server: learner action ${idx} out of range [0, ${n}) — action-space desync ` +
          `(check the trainer's MAX_EDGES / action masking).`
      );
      throw lostError;
    }
    return idx;
  };

  /*
   * Fires after every turn (via runSelfPlayEpisode → runMatch). A throw here unwinds the match — the
   * only abort path the engine's bot-fn try/catch can't swallow — so a lost learner bounds the wasted
   * work to ≤1 forfeited learner turn instead of grinding on to the learner's elimination. EnvClosed
   * (clean disconnect) is caught by the loop → exit 0; a timeout/desync Error propagates → exit 1.
   */
  const failIfLost = () => {
    if (lostError) throw lostError;
  };

  let played = 0;
  /*
   * Consecutive zero-decision episodes skipped without surfacing a frame; a long run of these means
   * the learner can never act (degenerate field/seat) — abort loud rather than spin silently.
   */
  let consecutiveZeroDecision = 0;
  const MAX_CONSECUTIVE_ZERO_DECISION = 1000;
  try {
    /*
     * Block until the worker's server is listening and a client has connected (or it failed/closed,
     * which resolves `connected` with `closed`/exitCode already set so the loop exits immediately).
     */
    await connected;
    for (let ep = 0; episodes === 0 || ep < episodes; ep++) {
      if (closed || lostError) break;
      const seed = seedBase + ep;
      decisionsThisEpisode = 0;
      // Draw this episode's opponent field from the league (B1: the empty-pool baseline field).
      const { opponents, drawn } = league.draw(seed);
      let result;
      try {
        result = runSelfPlayEpisode({
          seed,
          opponents,
          learnerSeat,
          maxAreas,
          maxTurns,
          chooseAction,
          onTurn: failIfLost,
          // End the episode at the learner's elimination, not game-over (PPO terminal; ~2×).
          terminateOnElimination: true,
        });
      } catch (err) {
        /*
         * Clean client disconnect → stop quietly (exit 0); a timeout/desync Error propagates (exit 1).
         * Either way, do not synthesize a terminal frame into a dead/unresponsive socket.
         */
        if (err instanceof EnvClosed) break;
        throw err;
      }

      /*
       * Zero-decision episode: the learner was eliminated before it ever took a turn, so NO obs
       * frame was emitted (chooseAction never fired). The wire contract is a run of obs frames then
       * ONE terminal; a bare terminal with no preceding obs would land in the client's reset() —
       * which expects the next episode's first decision — and desync it (env.py's reset guard). Such
       * an episode carries no learner transition for PPO, so surface nothing and roll to the next
       * seed. Guard against an unbounded silent skip in a degenerate field where the learner can
       * never move.
       */
      if (decisionsThisEpisode === 0) {
        if (++consecutiveZeroDecision > MAX_CONSECUTIVE_ZERO_DECISION) {
          throw new Error(
            `PPO env-server: ${consecutiveZeroDecision} consecutive zero-decision episodes ` +
              `(learner eliminated before acting every time) — check the opponents/learner-seat config.`
          );
        }
        continue;
      }
      consecutiveZeroDecision = 0;

      /*
       * Tally the decisive episode into the league (B1: decisive/truncated counters; B2 adds
       * per-opponent win-rate attribution). Zero-decision skips above are intentionally not counted.
       */
      league.recordResult(drawn, result);

      /*
       * Terminal frame: the learner's view of the board at the episode terminal (its elimination,
       * or game-over if it survived) + the reward. On an early elimination `result.winner` is null
       * (game undecided) → -1 on the wire; `won` is 0 and `placement` is the learner's locked-in
       * finishing rank. `truncated=1` ONLY for a maxTurns stalemate cap (a Gym truncation the
       * learner side bootstraps), disambiguating it from a winner=-1 mid-game elimination — which
       * carries the same winner/won but is a genuine terminal (`truncated=0`).
       */
      const termState = createBotState(result.finalState, learnerSeat);
      const termEnc = encodeObservationForInference(termState, { maxAreas });
      const termFrame = buildObsFrame({
        encoded: termEnc,
        botState: termState,
        maxAreas,
        terminal: 1,
        winner: result.winner ?? -1,
        won: result.won,
        truncated: result.truncated ? 1 : 0,
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
  } finally {
    /*
     * Always reap the worker — otherwise its still-listening server keeps the process alive (a
     * hang) on any early exit: a thrown episode error, a disconnect break, or a bind failure.
     */
    await shutdownWorker(worker);
  }
}

/** Post the shutdown message, wait briefly for the worker to tear down its socket/server, then terminate. */
async function shutdownWorker(worker) {
  worker.postMessage({ type: 'shutdown' });
  await new Promise(res => {
    // Listen until the actual shutdown-done lands — an interleaved 'closed' must not consume a once().
    const onMsg = m => {
      if (m.type === 'shutdown-done') {
        worker.off('message', onMsg);
        res();
      }
    };
    worker.on('message', onMsg);
    // Fallback if shutdown-done never arrives; detach the listener symmetrically on that branch too.
    setTimeout(() => {
      worker.off('message', onMsg);
      res();
    }, 500).unref();
  });
  await worker.terminate();
}

main().catch(err => {
  process.stderr.write(`[ppo-env-server] fatal: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
