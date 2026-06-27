/**
 * PPO league-probe worker (ml-bot Phase 3 — Task B, step B5).
 *
 * Runs one shard of the league probe on a worker thread (the `--workers K` aggregate measurement — a
 * CPU-bound worker pool is the faithful proxy for SB3 `SubprocVecEnv`, [D-19]). The snapshot pool is
 * NOT structured-cloneable (loaded fns), so the parent passes the manifest PATH (a string) + the
 * serializable league opts and each worker builds its OWN `makeLeague` + `refresh()` — i.e. each worker
 * has its own cold win-rate book, which is why the merge aggregates decisive counters ratio-of-sums.
 *
 * @module scripts/lib/ppo-league-probe-worker
 */

import { parentPort, workerData } from 'node:worker_threads';

import { runLeagueProbeShard } from './ppo-league-probe-core.mjs';

runLeagueProbeShard(workerData).then(
  result => parentPort.postMessage(result),
  err => {
    // Surface the failure to the parent's `worker.once('error')` handler rather than hanging.
    setImmediate(() => {
      throw err;
    });
  }
);
