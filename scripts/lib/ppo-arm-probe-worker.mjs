/**
 * PPO multi-arm throughput-probe worker (ml-bot Phase 3 — PERSONAS §10.7 item 6).
 *
 * One CPU-bound worker thread = one env-server proxy. Runs a single TIMED shard
 * (`runTimedProbeShard`) and posts its throughput back. All shards across all arms run
 * concurrently so they genuinely contend for cores — the measurement the probe exists for.
 * Bot fns aren't structured-cloneable, so the parent passes seat NAMES and the worker resolves
 * them from the registry itself (mirrors `ppo-probe-worker.mjs` / `selfplay-worker.mjs`, D-12).
 *
 * @module scripts/lib/ppo-arm-probe-worker
 */

import { parentPort, workerData } from 'node:worker_threads';

import { resolveBotsByName } from './selfplay-core.mjs';
import { runTimedProbeShard } from './ppo-arm-probe-core.mjs';

const {
  seatNames,
  learner,
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  prngSeed,
  warmupMs,
  measureMs,
  cooldownMs,
} = workerData;

const seats = resolveBotsByName(seatNames).map(b => ({ name: b.name, fn: b.fn }));

const result = runTimedProbeShard({
  seats,
  learner,
  learnerSeat,
  maxAreas,
  maxTurns,
  seedBase,
  prngSeed,
  warmupMs,
  measureMs,
  cooldownMs,
});

parentPort.postMessage(result);
