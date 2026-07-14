/**
 * Self-Play Worker
 *
 * `worker_threads` entry point for the parallel self-play harness
 * (`scripts/selfplay.mjs`, ML-bot Phase 1 task 5). One worker owns a contiguous
 * seed sub-range and streams its trajectories to its own shard part-file; the
 * main thread concatenates the parts in order and runs the deterministic ELO/stats
 * post-pass.
 *
 * The boundary contract (D-12): the main thread sends bot **names**, never bot
 * functions — closures are not structured-cloneable — so the worker imports the
 * registry and resolves them here. All heavy lifting is in
 * {@link module:scripts/lib/selfplay-core}; this file is just the message plumbing.
 *
 * @module scripts/lib/selfplay-worker
 */

import { parentPort, workerData } from 'node:worker_threads';
import { resolveSeats, toMatchBots, generateShard, makeFileWriter } from './selfplay-core.mjs';

const { workerId, baseSeats, seeds, maxTurns, outPath } = workerData;

let writer = null;
try {
  /*
   * `baseSeats` is the per-seat base-name list (multipliers already expanded by the
   * CLI, repeats allowed). resolveSeats assigns the same unique `#n` display names the
   * main thread does, so a duplicate / mirror field is legal across the worker boundary.
   */
  const bots = toMatchBots(resolveSeats(baseSeats));
  writer = makeFileWriter(outPath ?? null);

  const { summaries, written, quarantined, failed, aborted } = generateShard({
    bots,
    seeds,
    maxTurns,
    write: writer.write,
    onProgress: p => parentPort.postMessage({ type: 'progress', workerId, ...p }),
    progressEvery: 50,
  });

  /*
   * Close (flush) BEFORE signaling 'done' — the main thread concatenates this
   * part-file as soon as it sees 'done', so every buffered line must be on disk
   * first. The finally below is the fd-leak backstop for the throw path; close()
   * is idempotent so this isn't a double-free.
   */
  writer.close();

  parentPort.postMessage({
    type: 'done',
    workerId,
    summaries,
    written,
    quarantined,
    failed,
    aborted,
  });
} catch (err) {
  parentPort.postMessage({ type: 'error', workerId, message: err.message, stack: err.stack });
} finally {
  /*
   * fd-leak backstop only. A flush-throw here (e.g. disk full) must not escape and
   * mask the real failure already posted as {type:error} above, so swallow it.
   */
  try {
    writer?.close();
  } catch {
    // original cause already reported; nothing actionable in cleanup
  }
}
