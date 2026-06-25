/**
 * PPO throughput-probe worker (ml-bot Phase 3 — [D-19], tracer step 3).
 *
 * Runs one shard of the throughput probe on a worker thread (the `--workers K` aggregate
 * measurement — the number that matters, since PPO trains over many parallel envs; a
 * CPU-bound worker pool is a faithful proxy for SB3 `SubprocVecEnv` processes). Bot functions
 * aren't structured-cloneable, so the parent passes seat *names* and the worker resolves them
 * from the registry itself (mirrors `selfplay-worker.mjs`, D-12).
 *
 * @module scripts/lib/ppo-probe-worker
 */

import { parentPort, workerData } from 'node:worker_threads';

import { resolveBotsByName } from './selfplay-core.mjs';
import { runProbeShard } from './ppo-probe-core.mjs';

const {
  seatNames,
  learner,
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  episodes,
  prngSeed,
  maxEdgesCap,
} = workerData;

const seats = resolveBotsByName(seatNames).map(b => ({ name: b.name, fn: b.fn }));

const result = runProbeShard({
  seats,
  learner,
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  episodes,
  prngSeed,
  maxEdgesCap,
});

parentPort.postMessage(result);
