#!/usr/bin/env node

/**
 * Parallel Self-Play Harness (ML-bot Phase 1, task 5)
 *
 * Generates self-play training data for the ML-bot initiative (docs/ml-bot/):
 * runs a field of bots over a range of seeds and streams each game's *lean*
 * trajectory (seed + action list + terminal label) to JSONL. Built per
 * DECISIONS D-12/D-13/D-14:
 *
 *   - **Parallel.** A `worker_threads` pool (default ~50% of cores, to respect
 *     the machine policy in CLAUDE.md). Workers receive bot *names*, not
 *     closures (bot fns aren't structured-cloneable — D-12), and each owns a
 *     contiguous seed sub-range written to its own shard part-file.
 *   - **Streaming, RAM-bounded.** Trajectories stream to disk; the heavy
 *     `MatchResult`/`finalState` objects are never retained (a blow-up at
 *     100k–1M games). Only tiny per-game summaries survive, for the stats pass.
 *   - **Deterministic aggregation.** ELO is path-dependent, so it is replayed
 *     single-threaded over summaries sorted by seed — independent of worker
 *     scheduling.
 *   - **Shardable by seed range.** `--seed-start`/`--seed-count`/`--out` make the
 *     output concatenate losslessly across machines (engine determinism + game
 *     independence), so data-gen fans out across every available box (D-13).
 *   - **Data-quality filter (D-14).** A game where any bot's
 *     `errors`/`invalidMoves`/`maxMovesHit` counter is > 0 is *quarantined* — its
 *     trajectory dropped, the game counted but not written. This harness owns
 *     forced-end cleanup; the lean record stays pure.
 *
 * Usage:
 *   npm run selfplay                                   # default field, seeds 1..1000
 *   npm run selfplay -- --seed-count 100000            # 100k games
 *   npm run selfplay -- --bots Lookahead,Strategist,Expectimax,Defensive
 *   npm run selfplay -- --seed-start 1000000 --seed-count 100000 --out shard-b.jsonl
 *   npm run selfplay -- --workers 1                    # single-core baseline
 *   npm run selfplay -- --no-write --seed-count 2000   # throughput only (no JSONL)
 *
 * @module scripts/selfplay
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pipeline } from 'node:stream/promises';
import {
  DEFAULT_FIELD,
  NON_DETERMINISTIC_BOT_IDS,
  resolveBotsByName,
  generateShard,
  aggregateStats,
  makeFileWriter,
  chunkSeeds,
  rangeToSeeds,
} from './lib/selfplay-core.mjs';
import { getArg, hasFlag, colors } from './lib/cli-utils.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'data', 'selfplay');
const WORKER_URL = new URL('./lib/selfplay-worker.mjs', import.meta.url);

// --- Parse CLI args ---

const args = process.argv.slice(2);

if (hasFlag(args, 'help')) {
  printHelp();
  process.exit(0);
}

const seedStart = parseInt(getArg(args, 'seed-start', '1'), 10);
if (!Number.isInteger(seedStart)) {
  fail('--seed-start must be an integer.');
}

// --seed-count is canonical; --games is accepted as a familiar alias.
const seedCount = parseInt(getArg(args, 'seed-count', getArg(args, 'games', '1000')), 10);
if (!Number.isInteger(seedCount) || seedCount < 1) {
  fail('--seed-count (a.k.a. --games) must be a positive integer.');
}

const maxTurns = parseInt(getArg(args, 'max-turns', '500'), 10);
if (!Number.isInteger(maxTurns) || maxTurns < 1) {
  fail('--max-turns must be a positive integer.');
}

const cpuCount = os.cpus().length;
const defaultWorkers = Math.max(1, Math.floor(cpuCount / 2));
let workers = parseInt(getArg(args, 'workers', String(defaultWorkers)), 10);
if (!Number.isInteger(workers) || workers < 1) {
  fail('--workers must be a positive integer.');
}
if (workers > cpuCount) {
  warnLine(
    `--workers ${workers} exceeds ${cpuCount} CPU cores; oversubscription will slow each worker.`
  );
}
// No point spawning more workers than games.
workers = Math.min(workers, seedCount);

const noWrite = hasFlag(args, 'no-write');

const fieldNames = (getArg(args, 'bots', DEFAULT_FIELD.join(',')) || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Resolve + validate the field up front (workers re-resolve from names).
let resolved;
try {
  resolved = resolveBotsByName(fieldNames);
} catch (err) {
  fail(err.message);
}
if (resolved.length < 2) {
  fail('Need at least 2 bots for a self-play field.');
}

const botNames = resolved.map(b => b.name);
const bots = resolved.map(b => ({ name: b.name, fn: b.fn }));

/*
 * Warn (don't block) on non-reproducible bots — the seed-sharding merge story
 * assumes "same seed → same game", which Math.random bots break (D-13).
 */
const nonDeterministic = resolved.filter(b => NON_DETERMINISTIC_BOT_IDS.has(b.id));
if (nonDeterministic.length > 0) {
  warnLine(
    `Field includes non-reproducible bot(s): ${nonDeterministic.map(b => b.name).join(', ')}. ` +
      'Same seed will NOT reproduce the same game across machines; seed-range shards no longer ' +
      'merge deterministically (the recorded trajectories are still valid and replayable).'
  );
}

const outPath = noWrite
  ? null
  : path.resolve(
      ROOT,
      getArg(args, 'out', path.join(DEFAULT_OUT_DIR, defaultOutName(seedStart, seedCount)))
    );

// --- Run ---

console.log(
  `${colors.bold}Self-play data generation${colors.reset}\n` +
    `  Field:   ${botNames.join(', ')}\n` +
    `  Seeds:   ${seedStart}..${seedStart + seedCount - 1} (${seedCount} games)\n` +
    `  Workers: ${workers} of ${cpuCount} cores\n` +
    `  Output:  ${outPath ? displayPath(outPath) : '(none — throughput only)'}\n`
);

if (outPath) fs.mkdirSync(path.dirname(outPath), { recursive: true });

const startTime = Date.now();
let summaries;
let aborted;
let effectiveWorkers;

try {
  if (workers === 1) {
    ({ summaries, aborted } = await runInline());
    effectiveWorkers = 1;
  } else {
    ({ summaries, aborted, effectiveWorkers } = await runPool());
  }
} catch (err) {
  console.error(`\n${colors.red}Self-play run failed: ${err.message}${colors.reset}`);
  /*
   * Print the trace for diagnosability — the in-worker stack for a worker failure
   * (the original site, in another thread), else this error's own stack.
   */
  const trace = err.workerStack ?? err.stack;
  if (trace) console.error(trace);
  process.exit(1);
}

const elapsed = (Date.now() - startTime) / 1000;
process.stdout.write('\n\n');

if (aborted) {
  console.error(
    `${colors.red}Run aborted: excessive game failures (likely a misconfigured field).${colors.reset}\n`
  );
}

report(aggregateStats(summaries, botNames), { elapsed, workers: effectiveWorkers });

// --- Execution paths ---

/** Single-core baseline: run the whole range inline (no worker overhead). */
async function runInline() {
  const writer = makeFileWriter(outPath);
  try {
    return generateShard({
      bots,
      seeds: rangeToSeeds(seedStart, seedCount),
      maxTurns,
      write: writer.write,
      onProgress: p => process.stdout.write(`\rGames: ${p.done}/${seedCount}`),
      progressEvery: 50,
    });
  } finally {
    // Flush + release the fd even if generateShard throws (idempotent close).
    writer.close();
  }
}

/** Worker pool: contiguous seed shards, concatenated in order on completion. */
async function runPool() {
  const shards = chunkSeeds(seedStart, seedCount, workers);
  const partPaths = outPath ? shards.map((_, w) => `${outPath}.part${w}`) : shards.map(() => null);

  const done = new Map();
  const printCombined = () => {
    const total = [...done.values()].reduce((a, b) => a + b, 0);
    process.stdout.write(`\rGames: ${total}/${seedCount}`);
  };

  /*
   * Track every spawned worker so the finally can terminate any that are still
   * running if one rejects (Promise.all rejects on the first failure but leaves
   * its siblings alive), and so part-files are never orphaned on a partial
   * failure. spawned[] is populated synchronously as the executors run.
   */
  const spawned = [];
  try {
    const results = await Promise.all(
      shards.map(
        (seeds, w) =>
          new Promise((resolve, reject) => {
            /*
             * Settle exactly once. A worker emits several terminal-ish events
             * (a 'done'/'error' message, then an 'exit'); a Promise ignores all
             * but the first settle, but we gate explicitly so the 'exit' guard
             * below can reject a worker that dies *without* delivering a result
             * (any exit code) instead of leaving Promise.all to hang forever.
             */
            let settled = false;
            const ok = msg => {
              if (!settled) {
                settled = true;
                resolve(msg);
              }
            };
            const bad = err => {
              if (!settled) {
                settled = true;
                reject(err);
              }
            };
            const worker = new Worker(WORKER_URL, {
              workerData: { workerId: w, seeds, botNames, maxTurns, outPath: partPaths[w] },
            });
            spawned.push(worker);
            worker.on('message', msg => {
              if (msg.type === 'progress') {
                done.set(msg.workerId, msg.done);
                printCombined();
              } else if (msg.type === 'done') {
                ok(msg);
              } else if (msg.type === 'error') {
                // Carry the in-worker stack so the top-level catch can print it.
                const err = new Error(`worker ${msg.workerId}: ${msg.message}`);
                err.workerStack = msg.stack;
                bad(err);
              }
            });
            worker.on('error', bad);
            worker.on('exit', code => {
              /*
               * No-op once 'done'/'error' has settled; otherwise a premature exit
               * (e.g. an OOM kill that posts nothing) becomes a loud failure, not a hang.
               */
              bad(new Error(`worker ${w} exited before completing (code ${code})`));
            });
          })
      )
    );

    if (outPath) {
      await concatParts(partPaths, outPath);
    }

    return {
      summaries: results.flatMap(r => r.summaries),
      aborted: results.some(r => r.aborted),
      effectiveWorkers: shards.length,
    };
  } finally {
    // terminate() on an already-exited worker is a harmless no-op.
    await Promise.allSettled(spawned.map(w => w.terminate()));
    // Parts are merged into `dest` on success; on any failure they'd be orphaned. Remove either way.
    cleanupParts(partPaths);
  }
}

// --- Reporting ---

function report(stats, { elapsed: elapsedSec, workers: nWorkers }) {
  const gamesPerSec = elapsedSec > 0 ? stats.totalGames / elapsedSec : 0;
  const perWorker = nWorkers > 0 ? gamesPerSec / nWorkers : 0;

  console.log(`${colors.bold}Throughput${colors.reset}`);
  console.log(`  ${stats.totalGames} games in ${elapsedSec.toFixed(1)}s`);
  console.log(
    `  ${gamesPerSec.toFixed(1)} games/s total · ${perWorker.toFixed(1)} games/s/worker (${nWorkers} worker(s))\n`
  );

  const q = stats.quarantineBySignal;
  const breakdown =
    stats.quarantinedGames > 0
      ? ` [errors:${q.errors} invalidMoves:${q.invalidMoves} maxMovesHit:${q.maxMovesHit} failed:${q.failed}]`
      : '';
  const cleanPct = (stats.cleanRate * 100).toFixed(2);
  console.log(`${colors.bold}Data quality (D-14 forced-end quarantine)${colors.reset}`);
  console.log(
    `  Clean: ${stats.cleanGames} (${cleanPct}%) · Quarantined: ${stats.quarantinedGames}${breakdown}`
  );

  /*
   * Surface WHY games failed, not just how many: on an unattended 100k–1M-game run
   * a bare `failed:N` is undiagnosable. Print the distinct runMatch-throw messages.
   */
  if (stats.failedGames > 0 && stats.failureSamples.length > 0) {
    console.log(`  ${colors.red}runMatch threw — distinct failure messages:${colors.reset}`);
    for (const f of stats.failureSamples) {
      console.log(
        `    ${colors.red}×${f.count}${colors.reset} (first seed ${f.firstSeed}): ${f.error}`
      );
    }
    const sampled = stats.failureSamples.reduce((n, f) => n + f.count, 0);
    if (stats.failedGames > sampled) {
      console.log(`    …and ${stats.failedGames - sampled} more in other message group(s)`);
    }
  }

  const a = stats.actionCounts;
  console.log(
    `  Action-count/game (clean): min ${a.min} · p50 ${a.p50} · mean ${a.mean} · p95 ${a.p95} · max ${a.max}\n`
  );

  console.log(`${colors.bold}Field (clean games, ELO order)${colors.reset}`);
  const header = ['Rank', 'Bot', 'ELO', 'Wins', 'Win%'];
  const rows = stats.bots.map((b, i) => [
    String(i + 1),
    b.name,
    String(b.elo),
    String(b.wins),
    `${(b.winRate * 100).toFixed(1)}%`,
  ]);
  const table = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...table.map(r => r[c].length)));
  const fmt = r => r.map((cell, i) => cell.padStart(widths[i])).join('  ');
  console.log(`  ${fmt(header)}`);
  console.log(`  ${widths.map(w => '-'.repeat(w)).join('  ')}`);
  rows.forEach(r => console.log(`  ${fmt(r)}`));

  if (outPath) {
    const sizeMb = fs.existsSync(outPath) ? fs.statSync(outPath).size / 1e6 : 0;
    console.log(
      `\n${colors.green}Wrote ${stats.cleanGames} trajectories (${sizeMb.toFixed(1)} MB) to ` +
        `${displayPath(outPath)}${colors.reset}`
    );
  }
}

// --- Helpers ---

/**
 * Concatenate part-files into `dest`, in order. Removing the parts is the
 * caller's job (runPool's finally), so a mid-concat I/O failure can't leave them
 * orphaned. On error the write stream is destroyed (no dangling fd) and the
 * exception propagates.
 */
async function concatParts(parts, dest) {
  const out = fs.createWriteStream(dest, { flags: 'w' });
  try {
    for (const part of parts) {
      if (part && fs.existsSync(part)) {
        await pipeline(fs.createReadStream(part), out, { end: false });
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    throw err;
  }
}

/** Best-effort removal of shard part-files (force: no throw if already gone). */
function cleanupParts(parts) {
  for (const part of parts) {
    if (part) fs.rmSync(part, { force: true });
  }
}

function defaultOutName(start, count) {
  return `selfplay-seed-${start}-${start + count - 1}.jsonl`;
}

/** Repo-relative path when inside the repo, else the absolute path (no ugly `../../`). */
function displayPath(p) {
  const rel = path.relative(ROOT, p);
  return rel.startsWith('..') ? p : rel;
}

function warnLine(msg) {
  console.warn(`${colors.yellow}Warning: ${msg}${colors.reset}`);
}

function fail(msg) {
  console.error(`${colors.red}${msg}${colors.reset}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Parallel self-play data generation (ML-bot Phase 1, task 5)

Usage:
  npm run selfplay -- [options]

Options:
  --bots <names>        Comma-separated field (default: ${DEFAULT_FIELD.join(',')})
  --seed-start <n>      First seed in the range (default: 1)
  --seed-count <n>      Number of games/seeds to run (default: 1000; alias: --games)
  --workers <n>         Worker threads (default: ~50% of cores = ${Math.max(1, Math.floor(os.cpus().length / 2))})
  --max-turns <n>       Stalemate cap per game (default: 500)
  --out <path>          Output JSONL (default: data/selfplay/selfplay-seed-<start>-<end>.jsonl)
  --no-write            Run games for throughput only; write no JSONL
  --help                Show this help

Shard across machines by giving each a disjoint --seed-start/--seed-count and a
distinct --out; the resulting JSONL files concatenate losslessly.`);
}
