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
 *        [--snapshot-manifest=<path>] [--snapshot-pool-cap=40]
 *        [--reserve-baselines=3] [--pfsp-epsilon=0.05] [--pfsp-k=2]
 *        [--snapshot-store=memory|disk] [--league-state-dir=<dir>] [--league-dump-every=50]
 *        [--reward-shaping=0|1]
 *
 * The PFSP league flags (`--snapshot-*`, `--reserve-baselines`, `--pfsp-*`) only matter once a
 * snapshot pool exists; without `--snapshot-manifest` the league runs in empty-pool fixed-field mode
 * and `draw()` returns the cycled `--opponents` field unchanged (task A). See docs/ml-bot D-22/D-23.
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

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { createBotState } from '../src/arena/botState.js';
import { encodeObservationForInference } from '../src/arena/encodeObservation.js';
import { DEFAULT_MAX_TURNS } from '../src/arena/matchRunner.js';
import { BC_POLICY } from '../src/ai/bcPolicyWeights.js';

import { runSelfPlayEpisode } from './lib/ppo-env.mjs';
import { makeLeague } from './lib/ppo-league.mjs';
import {
  makeInMemoryStore,
  makeSharedDiskStore,
  writeJsonAtomic,
} from './lib/ppo-league-store.mjs';
import { buildObsFrame, serializeObsFrame } from './lib/obs-frame.mjs';
import { createRewardShapingTracker } from './lib/ppo-reward-shaping.mjs';

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
  /*
   * Snapshot pool (B3 / [D-23]). `snapshot-manifest` = the producer's manifest.json to poll for new
   * self-play snapshots; absent → empty-pool fixed-field mode. `snapshot-pool-cap` bounds the live
   * in-memory pool (FIFO-by-step). (The pluggable win-rate backend `snapshot-store` is a B6 flag,
   * grouped with the other persistence knobs below.)
   */
  'snapshot-manifest',
  'snapshot-pool-cap',
  /*
   * PFSP sampler knobs (B4 / [D-23]). Their draw-time EFFECT needs a non-empty pool (i.e. alongside
   * `--snapshot-manifest`), but the values are range-validated at launch regardless (makeLeague):
   * `reserve-baselines` = R baselines reserved per game (turtle defense — distinct, non-`ai_bc`);
   * `pfsp-epsilon`/`pfsp-k` parameterise the snapshot weight `w(S)=max(ε,1−winRate)^k`.
   */
  'reserve-baselines',
  'pfsp-epsilon',
  'pfsp-k',
  /*
   * League persistence (B6 / [D-23]). `snapshot-store=memory|disk` picks the win-rate backend:
   * `memory` (default) is the per-process book (byte-identical to B2–B5); `disk` is the cross-worker
   * `SharedDiskStore` (own shard + folded peers) for Task-E `SubprocVecEnv`. Checkpoint/resume is opted
   * into by EITHER `--league-state-dir=<dir>` OR `--snapshot-store=disk` (which derives the dir from
   * `--league-state-dir`, else the snapshot manifest's dir): the env-server then dumps
   * `league-state-<seedBase>.json` there every `league-dump-every` booked episodes (+ on SIGTERM / at the
   * DONE line) and restores it on launch. With none of these opting in, persistence is a strict no-op
   * (the empty-pool fixed-field run is byte-identical to B5).
   */
  'snapshot-store',
  'league-state-dir',
  'league-dump-every',
  /*
   * Dense-reward opt-in (bite G / [D-28], docs/ml-bot/PERSONAS.md §2/§8). `--reward-shaping=1`
   * makes the server EMIT the shaped obs-frame tail (raw per-step deltaTerritory + elimsByLearner)
   * for the Expansionist/Predator personas. Absent / 0 ⇒ byte-identical frames (the B5/B6 opt-in
   * discipline). The reward WEIGHTS live trainer-side; the server only measures + emits.
   */
  'reward-shaping',
]);

export function parseArgs(argv) {
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
export function numArg(opts, key, fallback) {
  if (opts[key] === undefined) return fallback;
  const v = Number(opts[key]);
  if (!Number.isFinite(v)) throw new Error(`--${key}=${opts[key]} is not a finite number.`);
  return v;
}

/** A fresh standalone ArrayBuffer holding exactly the frame's bytes (safe to clone). */
function frameToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Resolve the B6 league-persistence config from the parsed flags. Exported so it is unit-testable
 * without spawning the worker/socket (its store-selection + per-worker path derivation are the whole
 * of B6's env-server logic). Pure given its inputs except that the `disk` branch constructs a
 * `SharedDiskStore` (which only validates its args — no I/O until `flush`/`refreshGlobal`/`restore`).
 *
 * Persistence is OPT-IN: it is enabled (a non-null `leagueStatePath`) only when `--league-state-dir`
 * is given, or `--snapshot-store=disk` (which derives the shared dir from `--league-state-dir`, else
 * the snapshot manifest's dir). With none of the three flags set, `store` is the default in-memory
 * book and `leagueStatePath` is null — the env-server then never restores or dumps, so the empty-pool
 * fixed-field run is byte-identical to B5. The per-worker filename is keyed on `seedBase` (the env's
 * disjoint, restart-stable id) so N `SubprocVecEnv` workers sharing one dir never collide.
 *
 * @param {Record<string,string>} opts parsed flags (`parseArgs` output).
 * @param {{seedBase:number, snapshotManifest:(string|null)}} ctx
 * @returns {{store: import('./lib/ppo-league.mjs').LeagueStore, snapshotStore:string,
 *   leagueStateDir:(string|null), leagueStatePath:(string|null)}}
 */
export function resolveLeaguePersistence(opts, { seedBase, snapshotManifest }) {
  const snapshotStore = opts['snapshot-store'] ?? 'memory';
  if (snapshotStore !== 'memory' && snapshotStore !== 'disk') {
    throw new Error(`--snapshot-store=${snapshotStore} unknown (expected memory|disk).`);
  }
  const explicitDir = opts['league-state-dir'] ?? null;
  // disk store needs a shared dir; fall back to the manifest's dir when no explicit one is given.
  const leagueStateDir =
    explicitDir ??
    (snapshotStore === 'disk' && snapshotManifest ? dirname(snapshotManifest) : null);
  if (snapshotStore === 'disk' && !leagueStateDir) {
    throw new Error(
      '--snapshot-store=disk needs a shared directory: pass --league-state-dir=<dir> or ' +
        '--snapshot-manifest=<path> (whose dir is then used for the win-rate shards).'
    );
  }
  const store =
    snapshotStore === 'disk'
      ? makeSharedDiskStore({ dir: leagueStateDir, workerId: String(seedBase) })
      : makeInMemoryStore();
  const leagueStatePath = leagueStateDir
    ? join(leagueStateDir, `league-state-${seedBase}.json`)
    : null;
  return { store, snapshotStore, leagueStateDir, leagueStatePath };
}

/**
 * Build the league-state checkpoint dumper (B6 / task E PR-1). Extracted from `main()` so the
 * write ORDER and the consecutive-failure abort are unit-testable without spawning the worker/socket
 * (`main` is not exported).
 *
 * Write order (HOLE-B): the state file (`league.toJSON()`, carrying `episodeCount`) is written FIRST,
 * then the disk store's win-rate shard is flushed. They are separate files for the disk store (the
 * shard holds the book; `toJSON` emits `book: null`), so a crash can land between them. State-first
 * leaves `episodeCount` AHEAD of the shard on a crash — resume skips those seeds, so the un-flushed
 * games are LOST (bounded skew). Shard-first would leave it ahead of the cursor and resume would
 * replay + re-fold those seeds — a silent DOUBLE-COUNT that biases the PFSP sampler. Lose-a-few beats
 * count-twice. (In-memory store: the book rides inside `toJSON()`, so the order is moot.)
 *
 * Best-effort: a transient failure must not crash a multi-hour run — but a PERSISTENTLY dead path
 * (full disk / unwritable dir) writes zero checkpoints while still printing a normal DONE line, the
 * exact silent non-durability this feature prevents. So after `maxConsecutiveFailures` in a row,
 * `dump()` throws and lets the operator fix the path instead of losing the whole resume window.
 *
 * @param {object} cfg
 * @param {string|null} cfg.leagueStatePath checkpoint path; `null` ⇒ `dump()` is a no-op (persistence off).
 * @param {object} cfg.league a `makeLeague(...)` instance (read via `toJSON()`).
 * @param {object} cfg.store the win-rate backend (its `flush()` is the second write).
 * @param {(path:string, obj:object)=>void} [cfg.writeJson] state writer (injectable for tests).
 * @param {number} [cfg.maxConsecutiveFailures=10] consecutive failures before `dump()` aborts the run.
 * @returns {{ dump: () => void, getDumpFailures: () => number }}
 */
export function makeCheckpointDumper({
  leagueStatePath,
  league,
  store,
  writeJson = writeJsonAtomic,
  maxConsecutiveFailures = 10,
}) {
  let dumpFailures = 0; // total failed dumps — surfaced on the DONE line (0 on a healthy run)
  let consecutiveDumpFailures = 0;
  const dump = () => {
    if (!leagueStatePath) return;
    try {
      writeJson(leagueStatePath, league.toJSON()); // state FIRST (HOLE-B: cursor may lead the shard)
      store.flush(); // shard SECOND
      consecutiveDumpFailures = 0;
    } catch (err) {
      dumpFailures++;
      process.stderr.write(
        `[ppo-env-server] league-state dump #${dumpFailures} failed: ${err.message}\n`
      );
      if (++consecutiveDumpFailures >= maxConsecutiveFailures) {
        throw new Error(
          `PPO env-server: ${consecutiveDumpFailures} consecutive league-state dumps failed to ` +
            `${leagueStatePath} — checkpoint path unwritable; aborting (last: ${err.message}).`
        );
      }
    }
  };
  return { dump, getDumpFailures: () => dumpFailures };
}

/**
 * The `PPO_ENV_SERVER DONE …` health line (a key=value map the B5 probes parse). Extracted so the
 * field set is unit-testable and so it can be emitted identically from BOTH the normal exit and the
 * abnormal-exit path (a thrown refresh / dump-abort / zero-decision storm) without drift.
 *
 * @param {number} played wire terminals surfaced this launch.
 * @param {object} s `league.stats()`.
 * @param {number} dumpFailures from the checkpoint dumper.
 */
export function formatDoneLine(played, s, dumpFailures) {
  return (
    `PPO_ENV_SERVER DONE episodes=${played} decisiveGames=${s.decisiveGames} ` +
    `truncatedGames=${s.truncatedGames} decisiveRate=${s.decisiveRate.toFixed(4)} ` +
    `poolSize=${s.poolSize} loadedSnapshots=${s.loadedSnapshots} bookSize=${s.bookSize} ` +
    `episodeCount=${s.episodeCount} refreshSkips=${s.refreshSkips} ` +
    `noSeatBeatGames=${s.noSeatBeatGames} dumpFailures=${dumpFailures}`
  );
}

/**
 * The `ep` the episode loop starts at (task E / PR-1, HOLE-A): the league's booked-episode count, so a
 * relaunch CONTINUES the seed sequence (`seed = seedBase + ep`) instead of replaying booked seeds and
 * re-folding their outcomes into the restored win-rate book — a silent double-count. A fresh run reads
 * 0. Extracted + exported so the loop-start derivation is unit-testable without spawning the worker.
 *
 * @param {object} league a `makeLeague(...)` instance.
 * @returns {number}
 */
export function resumeStartEpisode(league) {
  return league.stats().episodeCount;
}

/**
 * Episode-loop predicate. `episodes === 0` runs until the client disconnects; otherwise `episodes` is
 * the run TOTAL across restarts (NOT per-launch), so when the resume cursor already meets it the body
 * never runs (a relaunch of an already-complete budget is a clean no-op, not a fresh N episodes).
 *
 * @param {number} ep current episode index (== the seed cursor).
 * @param {number} episodes the `--episodes` budget (0 = unbounded).
 * @returns {boolean}
 */
export function shouldRunEpisode(ep, episodes) {
  return episodes === 0 || ep < episodes;
}

/**
 * Build the env-server's dense-reward ("bite G" / [D-28]) emission glue, OR the no-op null-object
 * when reward shaping is off. Extracted from `main()` so the WHOLE shaped-emission seam — the
 * per-decision + terminal `.territories` reads, the `buildObsFrame` shaped-tail threading, the
 * per-episode `reset()`, and the `recordTurn`-before-`failIfLost` `onTurn` ORDERING — is importable
 * and unit-testable without spawning the worker + socket (`main` is not exported). This is the seam
 * issue #84 flags as untested: both ends are pinned (the codec, the tracker math, the Python step),
 * but the Node glue that wires them was only exercised on a live shodan spawn. The frame BUILD lives
 * here (not just the raw signals) so a dropped `...shapingFields` spread fails a unit test too.
 *
 * Off (`shapingTracker` null) ⇒ every method is a no-op / undefined tail, so each emitted frame is
 * byte-identical to the pre-bite-G wire (the B5/B6 opt-in discipline). The reward WEIGHTS live
 * trainer-side; this only measures (via the tracker) and threads the raw signals onto the wire.
 *
 * @param {object} cfg
 * @param {ReturnType<import('./lib/ppo-reward-shaping.mjs').createRewardShapingTracker>|null}
 *   cfg.shapingTracker - the per-episode tracker, or null when `--reward-shaping` is off.
 * @param {number} cfg.maxAreas - node-tensor height (policy config.maxAreas), for the frame header.
 * @param {number} cfg.learnerSeat - the learner's seat; the terminal `.territories` read indexes it.
 * @returns {{
 *   reset: () => void,
 *   decisionFrame: (encoded: object, botState: object) => import('./lib/obs-frame.mjs').ObsFrame,
 *   terminalFrame: (encoded: object, termState: object, meta: object) =>
 *     import('./lib/obs-frame.mjs').ObsFrame,
 *   wrapOnTurn: (failIfLost: () => void) =>
 *     ((turnNumber: number, state: object, currentPlayerId: number) => void),
 * }}
 */
export function makeShapedEmission({ shapingTracker, maxAreas, learnerSeat }) {
  return {
    /** Clear the per-episode dense-reward cursors (territory baseline + kill count). No-op when off. */
    reset(initialState) {
      if (shapingTracker) shapingTracker.reset(initialState);
    },

    /**
     * Build the per-decision observation frame. Under shaping it reads the learner's OWN
     * owned-territory count right now (`botState.myPlayer === learnerSeat`) and threads the raw
     * `{shaped, deltaTerritory, elimsByLearner}` tail; off ⇒ no tail (byte-identical frame).
     */
    decisionFrame(encoded, botState) {
      let shapingFields;
      if (shapingTracker) {
        const terr = botState.players[botState.myPlayer].territories;
        const { deltaTerritory, elimsByLearner } = shapingTracker.frameSignals(terr);
        shapingFields = { shaped: true, deltaTerritory, elimsByLearner };
      }
      return buildObsFrame({ encoded, botState, maxAreas, ...shapingFields });
    },

    /**
     * Build the terminal observation frame for `termState`, merging the caller's terminal `meta`
     * (terminal/winner/won/truncated/placement). Under shaping the tail is the last realized
     * interval up to the terminal: net territory change since the learner's final decision (its
     * elimination drives this to `-prevTerr`) and any kill on its last turn (the winning
     * elimination for Predator — `recordTurn` already folded that turn via `onTurn`). Off ⇒ no tail.
     */
    terminalFrame(encoded, termState, meta) {
      let shapingFields;
      if (shapingTracker) {
        const terr = termState.players[learnerSeat].territories;
        const { deltaTerritory, elimsByLearner } = shapingTracker.frameSignals(terr);
        shapingFields = { shaped: true, deltaTerritory, elimsByLearner };
      }
      return buildObsFrame({ encoded, botState: termState, maxAreas, ...meta, ...shapingFields });
    },

    /**
     * Wrap the loop's `failIfLost` guard as the match `onTurn` hook. Under shaping it folds the
     * just-completed turn's eliminations into the kill count via `recordTurn` BEFORE `failIfLost`
     * throws, so a kill on the learner's final (game-ending) turn is still credited for the terminal
     * frame. Off ⇒ returns `failIfLost` unchanged (byte-identical to the pre-bite-G hook).
     */
    wrapOnTurn(failIfLost) {
      if (!shapingTracker) return failIfLost;
      return (_turnNumber, state, currentPlayerId) => {
        shapingTracker.recordTurn(state, currentPlayerId);
        failIfLost();
      };
    },
  };
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
  const maxTurns = numArg(opts, 'max-turns', DEFAULT_MAX_TURNS);
  const episodes = numArg(opts, 'episodes', 0);
  const seedBase = numArg(opts, 'seed-base', 1);
  // Per-decision watchdog deadline (ms). Generous — inference is sub-second; 0 disables it.
  const decisionTimeoutMs = numArg(opts, 'decision-timeout-ms', 120000);

  /*
   * Dense-reward shaping (bite G). When on, the server emits the shaped obs-frame tail and a
   * per-episode tracker measures the learner's net territory delta + attributed eliminations.
   * Off ⇒ `shapingTracker` is null and every emitted frame stays byte-identical to today.
   */
  const rewardShaping = numArg(opts, 'reward-shaping', 0) !== 0;
  const shapingTracker = rewardShaping ? createRewardShapingTracker(learnerSeat) : null;
  /*
   * The dense-reward emission glue (per-decision/terminal `.territories` reads, the shaped-tail
   * frame threading, the per-episode reset, and the `recordTurn`-before-`failIfLost` onTurn
   * ordering). Extracted (makeShapedEmission) so this whole seam is unit-testable without the
   * worker/socket. A no-op null-object when shaping is off ⇒ byte-identical frames.
   */
  const shapedEmission = makeShapedEmission({ shapingTracker, maxAreas, learnerSeat });
  /*
   * The opponent league (ml-bot task B — [D-22]). With no `--snapshot-manifest` the pool is empty, so
   * every `draw()` returns the cycled baseline field — content-identical to the static field task A
   * trained on (the env-server default is the single bot `ai_bc`; the trainer passes the full
   * `--opponents` CSV). B3: when a manifest is given, `league.refresh()` (polled per episode below)
   * hot-loads published self-play snapshots into the pool; PFSP weighting (B4) then samples them in
   * `draw()`. Fixed-field stays the empty-pool mode of this one pipeline.
   */
  const snapshotManifest = opts['snapshot-manifest'] ?? null;
  /*
   * League persistence (B6 / [D-23]). Picks the win-rate `store` (in-memory default, or the
   * cross-worker `SharedDiskStore` under `--snapshot-store=disk`) and the per-worker checkpoint path.
   * `leagueStatePath` is null unless persistence is opted into (see resolveLeaguePersistence) → the
   * restore-on-startup and the dump triggers below are then strict no-ops (byte-identical to B5).
   */
  const { store, leagueStateDir, leagueStatePath } = resolveLeaguePersistence(opts, {
    seedBase,
    snapshotManifest,
  });
  const dumpEvery = numArg(opts, 'league-dump-every', 50);
  if (!Number.isInteger(dumpEvery) || dumpEvery < 1) {
    throw new Error(
      `--league-dump-every must be a positive integer, got ${opts['league-dump-every']}.`
    );
  }
  /*
   * Create the shared persistence dir up front (B6, S1): a typo'd / not-yet-created `--league-state-dir`
   * must fail the LAUNCH, not silently on the first dump — where the best-effort catch below would
   * swallow the ENOENT and the run would write zero checkpoints while reporting success.
   */
  if (leagueStateDir) mkdirSync(leagueStateDir, { recursive: true });
  const league = makeLeague({
    baselineCsv: opts.opponents ?? 'ai_bc',
    count: playerCount - 1,
    learnerSeat,
    snapshotManifest,
    poolCap: numArg(opts, 'snapshot-pool-cap', 40),
    reserveBaselines: numArg(opts, 'reserve-baselines', 3),
    pfspEpsilon: numArg(opts, 'pfsp-epsilon', 0.05),
    pfspK: numArg(opts, 'pfsp-k', 2),
    store,
  });

  /*
   * Resume (B6): if a prior checkpoint exists, restore the win-rate book, counters, and snapshot pool
   * before the episode loop. restore() re-imports the pooled snapshot weights (async) and resets the
   * manifest mtime so the loop's first refresh() re-polls. A missing file is a clean fresh start; a
   * version/encoding/fingerprint mismatch throws (fail loud — never resume a divergent league).
   */
  if (leagueStatePath && existsSync(leagueStatePath)) {
    const summary = await league.restore(JSON.parse(readFileSync(leagueStatePath, 'utf8')));
    process.stderr.write(
      `[ppo-env-server] resumed league from ${leagueStatePath}: ${JSON.stringify(summary)}\n`
    );
  }

  /*
   * Atomically checkpoint the league (B6) — the HOLE-B state-then-flush ordering and the
   * consecutive-failure abort live in `makeCheckpointDumper` (extracted so they are unit-testable
   * without spawning the worker). No-op unless persistence is opted in.
   */
  let bookedSinceDump = 0;
  const checkpointer = makeCheckpointDumper({ leagueStatePath, league, store });
  const dumpLeagueState = checkpointer.dump;
  /*
   * Best-effort flush on a graceful kill (SIGTERM). A signal landing mid-decision can't run until the
   * main thread unparks from Atomics.wait, so the periodic dump below — not this — is the durability
   * guarantee; this just narrows the loss window on a clean shutdown. Registered only when persisting.
   */
  if (leagueStatePath) {
    process.on('SIGTERM', () => {
      dumpLeagueState();
      process.exit(143); // 128 + SIGTERM(15)
    });
  }

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
    // Build (+ optionally shape) the per-decision obs frame; the shaped-tail glue lives in
    // shapedEmission so the `.territories` read + threading are unit-testable off the hot path.
    const buf = serializeObsFrame(shapedEmission.decisionFrame(encoded, botState));
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

  /*
   * The onTurn hook. Always re-raises a lost learner (failIfLost); under reward shaping it ALSO
   * folds the just-completed turn's eliminations into the learner's attributed-kill count BEFORE
   * the failIfLost throw (the ordering shapedEmission.wrapOnTurn pins), so a kill on the learner's
   * final (game-ending) turn is still credited for the terminal frame. Off ⇒ the bare failIfLost,
   * byte-identical to today.
   */
  const onTurnFn = shapedEmission.wrapOnTurn(failIfLost);

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
    /*
     * Resume seed-cursor (task E / PR-1, HOLE-A): start the loop at the league's booked-episode count
     * so a relaunched env-server CONTINUES the seed sequence (`seed = seedBase + ep`) instead of
     * replaying seeds from 0 and re-folding their outcomes into the restored win-rate book — a silent
     * double-count. A fresh start reads 0 (behavior unchanged). For a fixed `--episodes=N`, N is the
     * run TOTAL across restarts, not per-launch (mirrors the Python-side `remaining` budget).
     */
    const resumeEp = resumeStartEpisode(league);
    if (resumeEp > 0) {
      process.stderr.write(
        `[ppo-env-server] resuming episode loop at ep=${resumeEp} (seed-cursor).\n`
      );
    }
    for (let ep = resumeEp; shouldRunEpisode(ep, episodes); ep++) {
      if (closed || lostError) break;
      /*
       * Poll the snapshot manifest at the episode boundary (B3): hot-load any newly published
       * self-play snapshots into the league pool before drawing this episode's field. No
       * `--snapshot-manifest` → a cheap no-op (one `statSync`); an encoding-version skew throws and
       * stops the run (the frozen-`ENCODING_VERSION` run-invariant — fail loud, never train on an
       * unloadable pool).
       */
      await league.refresh();
      /*
       * B6 (disk store only): re-fold peer workers' win-rate shards into the global view before this
       * episode's draw. A no-op for the in-memory store. Co-located with refresh() at the episode
       * boundary — NOT on the hot path — so draw()'s per-snapshot winRate reads stay syscall-free.
       */
      store.refreshGlobal();
      const seed = seedBase + ep;
      decisionsThisEpisode = 0;
      // Clear the per-episode dense-reward cursors (territory baseline + kill count). No-op when off.
      shapedEmission.reset(initialState);
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
          onTurn: onTurnFn,
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
       * Book this game into the league BEFORE the wire zero-decision gate below. A zero-decision
       * episode (learner eliminated before it ever acts) emits no wire frame, but it is a real,
       * decisive loss — recording it keeps the win-rate book and decisive-rate honest and up-weights
       * the fields that crush the learner fastest (PFSP, [D-22]/[D-23]). The wire-skip is a frame
       * concern; the Node-side league is orthogonal. `recordResult` excludes maxTurns truncations
       * from the win-rate book internally. (Disconnect/error paths break/throw above, so a booked
       * episode always carries a real terminal result.)
       */
      league.recordResult(drawn, result);

      /*
       * Periodic league checkpoint (B6) — the durability guarantee. Placed right after recordResult and
       * BEFORE the zero-decision `continue` below, so a zero-decision storm (every episode books a loss
       * but skips the wire frame) still flushes on cadence. Between episodes, never mid-decision, and the
       * JSON is tiny — it cannot block a decision parked on Atomics.wait. No-op when not persisting.
       */
      if (leagueStatePath && ++bookedSinceDump >= dumpEvery) {
        bookedSinceDump = 0;
        dumpLeagueState();
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
       * Terminal frame: the learner's view of the board at the episode terminal (its elimination,
       * or game-over if it survived) + the reward. On an early elimination `result.winner` is null
       * (game undecided) → -1 on the wire; `won` is 0 and `placement` is the learner's locked-in
       * finishing rank. `truncated=1` ONLY for a maxTurns stalemate cap (a Gym truncation the
       * learner side bootstraps), disambiguating it from a winner=-1 mid-game elimination — which
       * carries the same winner/won but is a genuine terminal (`truncated=0`).
       */
      const termState = createBotState(result.finalState, learnerSeat);
      const termEnc = encodeObservationForInference(termState, { maxAreas });
      // shapedEmission.terminalFrame threads the dense-reward tail (the final realized interval up
      // to the terminal) when shaping is on, and is a plain buildObsFrame otherwise (byte-identical).
      const termFrame = shapedEmission.terminalFrame(termEnc, termState, {
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

    /*
     * Emit the league health snapshot on the DONE line (the B5 throughput/decisive-rate re-probe
     * reads this). `played` counts surfaced wire terminals; `decisiveGames` counts every booked
     * decisive episode INCLUDING zero-decision skips — so `episodes < decisiveGames` is the visible
     * signature of a zero-decision episode that was booked but surfaced no frame (the B2 reordering).
     * `noSeatBeatGames` should be 0 — a nonzero value flags a placement-contract break that left the
     * win-rate book under-credited (PFSP drifting toward uniform). `env_server.py`'s
     * `EnvServerProcess._drain_stdout` drops this line (only the anchored LISTENING line is parsed),
     * so appending fields is safe.
     */
    // Final checkpoint on a clean loop exit (B6) — captures the tail of episodes since the last
    // periodic dump. No-op when not persisting.
    dumpLeagueState();
    const s = league.stats();
    const doneLine = formatDoneLine(played, s, checkpointer.getDumpFailures());
    process.stdout.write(`${doneLine}\n`);
    /*
     * Mirror the health summary to STDERR (task E / PR-1): `env_server.py`'s `_drain_stdout` reader
     * thread captures only the anchored LISTENING line on stdout and DROPS the rest, so this window is
     * invisible to the trainer's logs unless it also lands on stderr (which the Python parent inherits,
     * `stderr=None`). `refreshSkips` (producer GC race), `dumpFailures` (unwritable checkpoint path),
     * and `noSeatBeatGames` (broken placement contract) should all read 0 on a healthy run — a nonzero
     * value is often the ONLY signal of a silent fault on a multi-day shodan run, so prefix `WARN` when
     * any is nonzero to make it greppable. Appending fields to the stdout line stays safe (it is
     * dropped; the probes parse a key=value map).
     */
    const healthWarn =
      s.refreshSkips > 0 || s.noSeatBeatGames > 0 || checkpointer.getDumpFailures() > 0;
    process.stderr.write(`[ppo-env-server]${healthWarn ? ' WARN' : ''} ${doneLine}\n`);
  } catch (err) {
    /*
     * Abnormal exit (task E / S-3): a thrown `refresh()` / encoding skew, the dump-abort, or a
     * zero-decision storm all skip the normal DONE emission above — yet these are exactly the runs
     * where `refreshSkips`/`noSeatBeatGames`/`dumpFailures` matter most. Surface the health summary on
     * stderr here (best-effort, marked ABNORMAL EXIT) before the worker is reaped, then rethrow so the
     * top-level handler still logs the fatal + sets exit 1. A failure reading stats() mid-teardown must
     * not mask the original error.
     */
    try {
      const s = league.stats();
      process.stderr.write(
        `[ppo-env-server] WARN ABNORMAL EXIT ${formatDoneLine(played, s, checkpointer.getDumpFailures())}\n`
      );
    } catch {
      /* stats() unavailable mid-teardown — the rethrown error below is what matters */
    }
    throw err;
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

/*
 * Run the server only when this file is the process entry point (the Python `EnvServerProcess`
 * spawns it via `node scripts/ppo-env-server.mjs`). Guarding the launch lets a test `import` the
 * module to exercise `parseArgs`/`numArg` — the Node side of the PFSP flag bridge — without spawning
 * a Worker/socket. `pathToFileURL` normalises argv[1] so the compare is robust on every platform.
 */
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch(err => {
    process.stderr.write(`[ppo-env-server] fatal: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
