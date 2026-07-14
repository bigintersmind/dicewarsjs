/**
 * Self-Play Core
 *
 * Shared, worker-agnostic core of the parallel self-play harness
 * (`scripts/selfplay.mjs`, ML-bot Phase 1 task 5 — see docs/ml-bot/PLAN.md and
 * DECISIONS D-12/D-13/D-14). Everything here is pure Node with no
 * `worker_threads` dependency, so it runs identically in the main thread (the
 * `--workers 1` single-core baseline) and inside a worker, and is unit-testable
 * without spawning a pool.
 *
 * Responsibilities:
 *
 *   1. {@link generateShard} — run a contiguous block of seeds through
 *      `runMatch` in *training mode* (`recordHistory:false` +
 *      `recordTrajectory:true`), stream each *clean* lean trajectory out via an
 *      injected `write` callback, and return only tiny per-game summaries. The
 *      heavy `MatchResult`/`finalState`/`trajectory` objects are dropped each
 *      iteration (never retained in an array) — the RAM-safety crux at 100k–1M
 *      games (D-12).
 *   2. {@link forcedEndReason} — the D-14 data-quality filter. A self-play game
 *      is *quarantined* (its trajectory dropped, not written) when any bot's
 *      `errors`, `invalidMoves`, or `maxMovesHit` counter on `MatchResult.botStats`
 *      is > 0. These are the three forced-turn-end signals the lean record cannot
 *      self-describe (a forced END_TURN is recorded as a voluntary STOP — D-14);
 *      enforcement lives *here*, at the data-gen boundary, not in the per-step
 *      record.
 *   3. {@link aggregateStats} — the single-threaded, deterministic ELO/stats
 *      post-pass. ELO is path-dependent (order matters), so it is replayed over
 *      summaries sorted by seed, never computed per-worker.
 *   4. {@link makeFileWriter} — a synchronous, backpressure-free JSONL sink
 *      (`fs.writeSync`) shared by the inline and worker write paths.
 *
 * @module scripts/lib/selfplay-core
 */

import fs from 'node:fs';
import { runMatch } from '../../src/arena/matchRunner.js';
import { serializeTrajectory } from '../../src/arena/trajectoryExport.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { updateEloRatings, DEFAULT_RATING } from '../../src/arena/elo.js';

/**
 * Default self-play field: a *heterogeneous, decisive, seed-pure* set of
 * built-in bots. Heterogeneous + decisive so games actually resolve (a field of
 * identical Strategists 0-attacks and stalemates to `maxTurns` every game — the
 * PLAN's explicit warning); seed-pure so the same seed reproduces the same game
 * on every machine, which is what makes seed-range sharding merge losslessly
 * across boxes (D-13).
 *
 * @type {string[]}
 */
export const DEFAULT_FIELD = ['Strategist', 'Expectimax', 'Lookahead', 'Defensive'];

/**
 * Bots that are NOT reproducible from a seed. Including one breaks the "same
 * seed → same game" guarantee that seed-range sharding relies on (a given seed
 * yields different games on different machines), so the harness warns when one
 * is selected. Empty since issue #151: the three former `Math.random` bots
 * (default/example/adaptive) now draw from the seeded per-decision
 * `game.random()`, making every built-in seed-pure. Kept as the registration
 * point — a future bot that can't be seed-pure goes here.
 *
 * @type {Set<string>}
 */
export const NON_DETERMINISTIC_BOT_IDS = new Set();

/**
 * Resolve bot display names to `{ id, name, fn }` from the built-in registry.
 *
 * The harness passes bot *names* (identifiers), not closures, across the worker
 * boundary — bot functions are not structured-cloneable, so each worker imports
 * the registry and resolves names itself (D-12). Names are matched
 * case-insensitively (mirrors `cli-utils.resolveBot`).
 *
 * @param {string[]} names
 * @returns {Array<{ id: string, name: string, fn: Function }>}
 * @throws {Error} If any name is unknown (lists the available names).
 */
export function resolveBotsByName(names) {
  return names.map(rawName => {
    const name = rawName.trim();
    const bot = BUILT_IN_BOTS.find(b => b.name.toLowerCase() === name.toLowerCase());
    if (!bot) {
      throw new Error(
        `Unknown bot "${name}". Available: ${BUILT_IN_BOTS.map(b => b.name).join(', ')}`
      );
    }
    return { id: bot.id, name: bot.name, fn: bot.fn };
  });
}

/**
 * Expand a raw `--bots` field, honoring an `<count>x<BotName>` multiplier per token
 * so a duplicate / mirror field is ergonomic (`7xLookahead` → seven Lookahead seats)
 * without typing the name seven times — the natural way to ask for `N`-player pure
 * self-play of one policy (D-Encoding sub-decision). A token without the leading
 * `<digits>x` prefix is passed through unchanged; literal repeats
 * (`Lookahead,Lookahead`) work too (the uniquification in {@link resolveSeats}
 * handles the resulting duplicate seats). The built-in bot names contain no leading
 * `<digits>x`, so there is no ambiguity with the multiplier.
 *
 * @param {string[]} tokens - Trimmed, non-empty field tokens (post comma-split)
 * @returns {string[]} The per-seat base-name list, multipliers expanded (repeats kept)
 * @throws {Error} On a multiplier whose count is < 1 or whose name is blank.
 */
export function expandFieldTokens(tokens) {
  const seats = [];
  for (const token of tokens) {
    const m = /^(\d+)x(.+)$/i.exec(token);
    if (!m) {
      seats.push(token);
      continue;
    }
    const count = parseInt(m[1], 10);
    const base = m[2].trim();
    if (count < 1) throw new Error(`Invalid field multiplier "${token}": count must be >= 1.`);
    if (!base) throw new Error(`Invalid field multiplier "${token}": missing bot name.`);
    for (let i = 0; i < count; i++) seats.push(base);
  }
  return seats;
}

/**
 * Assign a unique display name per seat. A bot occupying a single seat keeps its
 * plain name; a bot occupying multiple seats gets a `#<n>` suffix per occurrence
 * (`Lookahead#1`, `Lookahead#2`, …). Distinct names are required because
 * `matchRunner` rejects a duplicate-name field and ELO/wins are keyed by name — the
 * suffix lets one policy fill many seats (mirror self-play) while each seat stays an
 * independently-tracked competitor. Deterministic in input order, so the main thread
 * and each worker (which both call this on the same per-seat list) derive identical
 * names without coordinating.
 *
 * @param {string[]} names - Per-seat (canonical) bot names, repeats allowed
 * @returns {string[]} Per-seat display names, all distinct
 */
export function assignSeatNames(names) {
  const total = new Map();
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1);
  const seen = new Map();
  return names.map(n => {
    if (total.get(n) === 1) return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return `${n}#${k}`;
  });
}

/**
 * Resolve a per-seat base-name list (already multiplier-expanded by
 * {@link expandFieldTokens}) into per-seat bot descriptors, assigning unique display
 * names ({@link assignSeatNames}) so a duplicate / mirror field is legal. The result
 * maps index `i` to player `i` (seat order preserved). Both the CLI and each worker
 * call this on the same list, so they agree on seat names without passing a second
 * array across the worker boundary.
 *
 * @param {string[]} baseNames - Per-seat bot names (repeats allowed)
 * @returns {Array<{ id: string, baseName: string, displayName: string, fn: Function }>}
 *   One descriptor per seat: `baseName` = canonical registry name, `displayName` =
 *   unique `#n`-suffixed seat name.
 * @throws {Error} If any name is unknown (via {@link resolveBotsByName}).
 */
export function resolveSeats(baseNames) {
  const resolved = resolveBotsByName(baseNames);
  const displayNames = assignSeatNames(resolved.map(r => r.name));
  return resolved.map((r, i) => ({
    id: r.id,
    baseName: r.name,
    displayName: displayNames[i],
    fn: r.fn,
  }));
}

/**
 * Project {@link resolveSeats} descriptors down to the `{ name, fn }` bots
 * {@link generateShard} / `runMatch` consume. `name` must be the *display* name:
 * matchRunner rejects a duplicate-name field, and trajectory metadata / the ELO
 * post-pass are keyed by it.
 *
 * @param {Array<{ displayName: string, fn: Function }>} seats - From {@link resolveSeats}
 * @returns {Array<{ name: string, fn: Function }>}
 */
export function toMatchBots(seats) {
  return seats.map(s => ({ name: s.displayName, fn: s.fn }));
}

/**
 * Build a contiguous seed range `[start, start+count)` as an array.
 *
 * @param {number} start - First seed
 * @param {number} count - Number of seeds
 * @returns {number[]}
 */
export function rangeToSeeds(start, count) {
  const seeds = new Array(count);
  for (let i = 0; i < count; i++) seeds[i] = start + i;
  return seeds;
}

/**
 * Split `[start, start+count)` into `n` contiguous ascending blocks, spreading
 * the remainder over the first blocks. Contiguous + ascending so concatenating
 * each worker's part-file in worker order reproduces strict seed order on disk —
 * the lossless cross-machine merge story (D-13). Zero-size blocks are skipped, so
 * `n > count` yields `count` singletons rather than empty chunks.
 *
 * @param {number} start - First seed
 * @param {number} count - Total seeds to split
 * @param {number} n - Number of blocks (workers)
 * @returns {number[][]} Up to `n` contiguous ascending seed blocks
 */
export function chunkSeeds(start, count, n) {
  const base = Math.floor(count / n);
  const rem = count % n;
  const chunks = [];
  let next = start;
  for (let w = 0; w < n; w++) {
    const size = base + (w < rem ? 1 : 0);
    if (size > 0) {
      chunks.push(rangeToSeeds(next, size));
      next += size;
    }
  }
  return chunks;
}

/**
 * The D-14 quarantine predicate. Inspects a match's per-bot stats for any
 * forced-turn-end signal and returns the first one found, or `null` if the game
 * is clean.
 *
 * Priority is fixed (errors → invalidMoves → maxMovesHit) only so the reported
 * `signal` is stable; quarantine triggers on *any* of them being > 0. We check
 * every seat because in self-play every bot is a "teacher" and a misbehaving bot
 * distorts the board for all players after it, so the whole game is dropped
 * (D-14).
 *
 * @param {import('../../src/arena/matchRunner.js').MatchBotStat[]} botStats
 * @returns {{ bot: string, signal: 'errors'|'invalidMoves'|'maxMovesHit', count: number }|null}
 */
export function forcedEndReason(botStats) {
  for (const s of botStats) {
    if (s.errors > 0) return { bot: s.name, signal: 'errors', count: s.errors };
    if (s.invalidMoves > 0) return { bot: s.name, signal: 'invalidMoves', count: s.invalidMoves };
    if (s.maxMovesHit > 0) return { bot: s.name, signal: 'maxMovesHit', count: s.maxMovesHit };
  }
  return null;
}

/**
 * @typedef {Object} GameSummary
 * @property {number}        seed       - The game's seed (the aggregation sort key)
 * @property {number[]}      [placements] - Player indices ordered by placement (for ELO/win%)
 * @property {number|null}   [winner]   - Winning player index (null = stalemate)
 * @property {number}        [turnCount] - Turns played
 * @property {number}        [actionCount] - Lean action-list length (action-count distribution)
 * @property {boolean}       quarantined - True if dropped by {@link forcedEndReason}
 * @property {string|null}   [quarantineSignal] - Which forced-end signal triggered the drop
 * @property {boolean}       [failed]   - True if `runMatch` threw (game unplayable)
 * @property {string}        [error]    - The thrown message (failed games only)
 *
 * Summaries are intentionally tiny (≈10 numbers/game): they are the *only*
 * per-game state the harness retains, so the ELO post-pass and stats stay
 * RAM-bounded while the heavy match objects are GC'd each iteration.
 */

/**
 * @typedef {Object} ShardResult
 * @property {GameSummary[]} summaries  - One per seed (clean, quarantined, and failed)
 * @property {number}        written    - Clean trajectories handed to `write`
 * @property {number}        quarantined - Games dropped by the D-14 filter
 * @property {number}        failed     - Games where `runMatch` threw
 * @property {boolean}       aborted    - True if the run bailed on an excessive failure rate
 */

/** Abort a shard if the failure rate exceeds this after at least 5 games (mirrors arenaRunner). */
const ABORT_FAILURE_RATE = 0.5;
const ABORT_MIN_GAMES = 5;

/**
 * Run one shard: every seed in `seeds`, in order, streaming clean trajectories.
 *
 * Each game runs in training mode (`recordHistory:false` so retained immutable
 * states don't carry a growing history array, `recordTrajectory:true` to capture
 * the lean record out-of-band). Clean games are serialized to a single JSONL
 * line and handed to `write`; quarantined/failed games are counted but not
 * written. The match objects are never collected into an array — only the tiny
 * {@link GameSummary} is kept — so a shard of any length is RAM-bounded (D-12).
 *
 * @param {Object} opts
 * @param {Array<{name: string, fn: Function}>} opts.bots - Resolved bots, seat order = bots[i] → player i
 * @param {number[]} opts.seeds - Seeds to play (typically a contiguous block)
 * @param {number}  [opts.maxTurns=500] - Stalemate cap per game
 * @param {(line: string) => void} [opts.write] - JSONL sink for clean trajectories (newline-terminated)
 * @param {(p: {done: number, total: number, written: number, quarantined: number, failed: number}) => void} [opts.onProgress]
 * @param {number}  [opts.progressEvery=0] - Emit progress every N games (0 = only at end)
 * @param {typeof runMatch} [opts.runMatchFn=runMatch] - Match runner (a test seam; the
 *   `maxMovesHit`/`runMatch`-throw cases can't be triggered deterministically with real games)
 * @returns {ShardResult}
 */
export function generateShard({
  bots,
  seeds,
  maxTurns = 500,
  write = () => {},
  onProgress,
  progressEvery = 0,
  runMatchFn = runMatch,
}) {
  const summaries = [];
  let written = 0;
  let quarantined = 0;
  let failed = 0;
  let aborted = false;

  for (let idx = 0; idx < seeds.length; idx++) {
    const seed = seeds[idx];

    let result;
    try {
      result = runMatchFn({
        bots,
        seed,
        maxTurns,
        recordHistory: false,
        recordTrajectory: true,
      });
    } catch (err) {
      failed++;
      summaries.push({ seed, quarantined: true, failed: true, error: err.message });
      /*
       * Bail fast on a systemic failure (e.g. a misconfigured field) rather than
       * burn hours producing nothing — same guard as arenaRunner.
       */
      const attempted = idx + 1;
      if (attempted >= ABORT_MIN_GAMES && failed / attempted > ABORT_FAILURE_RATE) {
        aborted = true;
        break;
      }
      continue;
    }

    const reason = forcedEndReason(result.botStats);
    if (reason === null) {
      write(`${serializeTrajectory(result.trajectory)}\n`);
      written++;
    } else {
      quarantined++;
    }

    summaries.push({
      seed,
      placements: result.placements,
      winner: result.winner,
      turnCount: result.turnCount,
      actionCount: result.trajectory.actions.length,
      quarantined: reason !== null,
      quarantineSignal: reason?.signal ?? null,
    });
    // `result` (with finalState + trajectory) is overwritten next iteration, never collected into an array — not retained.

    if (progressEvery && onProgress && (idx + 1) % progressEvery === 0) {
      onProgress({ done: idx + 1, total: seeds.length, written, quarantined, failed });
    }
  }

  if (onProgress) {
    onProgress({ done: summaries.length, total: seeds.length, written, quarantined, failed });
  }

  return { summaries, written, quarantined, failed, aborted };
}

/** Linear-interpolated percentile of an already-sorted numeric array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Cap on distinct failure-message groups surfaced by {@link aggregateStats}. */
const FAILURE_SAMPLE_LIMIT = 5;

/**
 * @typedef {Object} SelfPlayStats
 * @property {number} totalGames
 * @property {number} cleanGames        - Games kept (written to JSONL)
 * @property {number} quarantinedGames  - Dropped by the D-14 filter (incl. failures)
 * @property {number} failedGames       - Subset of quarantined where `runMatch` threw
 * @property {number} cleanRate         - cleanGames / totalGames (0–1)
 * @property {{errors: number, invalidMoves: number, maxMovesHit: number, failed: number}} quarantineBySignal
 * @property {Array<{error: string, count: number, firstSeed: number}>} failureSamples
 *   Distinct `runMatch`-throw messages (capped at {@link FAILURE_SAMPLE_LIMIT}), each with its
 *   occurrence count and lowest seed — so a systemic failure is diagnosable from the report,
 *   not merely counted. Empty unless `runMatch` actually threw.
 * @property {{min: number, p50: number, mean: number, p95: number, max: number}} actionCounts - Over clean games
 * @property {Array<{name: string, wins: number, gamesPlayed: number, winRate: number, elo: number}>} bots
 *   Per-bot stats over clean games, sorted by ELO descending.
 */

/**
 * Single-threaded, deterministic ELO/stats aggregation over a shard's (or the
 * whole run's) summaries.
 *
 * ELO is path-dependent — the rating after a game depends on the ratings before
 * it — so summaries are sorted by seed and replayed in that order, exactly as a
 * serial `runArena` would, giving a result independent of worker scheduling
 * (D-12). ELO and win% are computed over *clean* games only; quarantined/failed
 * games are reported separately (the field-quality signal) but excluded from
 * strength estimates, since their outcomes are distorted by the misbehavior that
 * got them dropped.
 *
 * @param {GameSummary[]} summaries - All per-game summaries (any order)
 * @param {string[]} botNames - Bot names by player index (constant across self-play games);
 *   must be distinct (ELO/wins are keyed by name, so duplicates would collide two seats)
 * @returns {SelfPlayStats}
 * @throws {Error} If `botNames` contains a duplicate.
 */
export function aggregateStats(summaries, botNames) {
  /*
   * ELO/wins are keyed by bot name below, so two seats sharing a name would
   * silently collapse into one rating and skew the result. The CLI can't reach
   * this (matchRunner rejects a duplicate-name field before any game runs), but
   * this is an exported, independently-callable function — fail loud rather than
   * return a quietly-wrong ranking.
   */
  if (new Set(botNames).size !== botNames.length) {
    throw new Error(
      `aggregateStats requires distinct bot names (ELO/wins are keyed by name); got [${botNames.join(', ')}]`
    );
  }

  const totalGames = summaries.length;
  const clean = summaries.filter(s => !s.quarantined);
  // Deterministic ELO order: replay clean games by ascending seed.
  clean.sort((a, b) => a.seed - b.seed);

  const quarantineBySignal = { errors: 0, invalidMoves: 0, maxMovesHit: 0, failed: 0 };
  let failedGames = 0;
  /*
   * Distinct runMatch-throw messages → { count, firstSeed }. Keyed by message and
   * reduced by MIN seed so the sample is independent of summary order — the same
   * invariant the ELO replay relies on (a shuffled `summaries` must aggregate
   * identically).
   */
  const failureMessages = new Map();
  for (const s of summaries) {
    if (!s.quarantined) continue;
    if (s.failed) {
      failedGames++;
      quarantineBySignal.failed++;
      const msg = s.error || 'unknown error'; // a blank '' message must still be labeled (|| not ??)
      const prev = failureMessages.get(msg);
      if (prev) {
        prev.count++;
        prev.firstSeed = Math.min(prev.firstSeed, s.seed);
      } else {
        failureMessages.set(msg, { count: 1, firstSeed: s.seed });
      }
    } else if (s.quarantineSignal && s.quarantineSignal in quarantineBySignal) {
      quarantineBySignal[s.quarantineSignal]++;
    }
  }

  /*
   * Most frequent first, ties broken by lowest seed; capped so a pathological run
   * with thousands of distinct messages can't flood the report.
   */
  const failureSamples = [...failureMessages.entries()]
    .map(([error, { count, firstSeed }]) => ({ error, count, firstSeed }))
    .sort((a, b) => b.count - a.count || a.firstSeed - b.firstSeed)
    .slice(0, FAILURE_SAMPLE_LIMIT);

  const ratings = {};
  const wins = {};
  for (const name of botNames) {
    ratings[name] = DEFAULT_RATING;
    wins[name] = 0;
  }

  for (const game of clean) {
    const eloPlayers = game.placements.map(playerIdx => ({
      name: botNames[playerIdx],
      elo: ratings[botNames[playerIdx]],
    }));
    for (const r of updateEloRatings(eloPlayers)) {
      ratings[r.name] = r.elo;
    }
    if (game.winner !== null && game.winner !== undefined) {
      wins[botNames[game.winner]]++;
    }
  }

  const actionCountsSorted = clean.map(g => g.actionCount).sort((a, b) => a - b);
  const meanActions =
    actionCountsSorted.length > 0
      ? actionCountsSorted.reduce((a, b) => a + b, 0) / actionCountsSorted.length
      : 0;

  const bots = botNames
    .map(name => ({
      name,
      wins: wins[name],
      gamesPlayed: clean.length,
      winRate: clean.length > 0 ? +(wins[name] / clean.length).toFixed(3) : 0,
      elo: Math.round(ratings[name]),
    }))
    .sort((a, b) => b.elo - a.elo);

  return {
    totalGames,
    cleanGames: clean.length,
    quarantinedGames: totalGames - clean.length,
    failedGames,
    cleanRate: totalGames > 0 ? +(clean.length / totalGames).toFixed(4) : 0,
    quarantineBySignal,
    failureSamples,
    actionCounts: {
      min: actionCountsSorted[0] ?? 0,
      p50: Math.round(percentile(actionCountsSorted, 50)),
      mean: +meanActions.toFixed(1),
      p95: Math.round(percentile(actionCountsSorted, 95)),
      max: actionCountsSorted[actionCountsSorted.length - 1] ?? 0,
    },
    bots,
  };
}

/**
 * The CLI's non-zero-exit policy, factored out as a pure predicate so the exit contract
 * is unit-testable without spawning the CLI. A run is "unusable" — and the process should
 * exit non-zero so an unattended/pipeline caller doesn't consume it as success — when it
 * aborted (excessive game failures), or it was meant to write data (`wroteOutput`) but
 * produced zero clean games. A `--no-write` throughput probe (`wroteOutput:false`) is never
 * unusable on the clean-count alone.
 *
 * @param {{ aborted: boolean, wroteOutput: boolean, cleanGames: number }} run
 * @returns {boolean}
 */
export function isUnusableRun({ aborted, wroteOutput, cleanGames }) {
  return aborted || (wroteOutput && cleanGames === 0);
}

/**
 * @typedef {Object} FileWriter
 * @property {(line: string) => void} write - Buffer a line; flushes synchronously in batches
 * @property {() => void} close - Flush the remainder and close the fd
 */

/** Flush the line buffer to disk once it reaches this many lines. */
const WRITER_FLUSH_AT = 256;

/**
 * A synchronous, backpressure-free JSONL sink.
 *
 * Uses `fs.writeSync` (batched) rather than a `WriteStream`: `generateShard` is a
 * tight synchronous loop that never yields to the event loop, so a stream's
 * `'drain'` backpressure protocol can't run mid-shard and its buffer could grow
 * unbounded on a fast/cheap field. Blocking writes from a dedicated worker (or
 * the inline path) sidestep that entirely — disk easily outpaces game generation
 * — and keep the core synchronous and testable. `outPath:null` yields a no-op
 * writer (the `--no-write` throughput-only mode).
 *
 * @param {string|null} outPath - File to (over)write, or null for a no-op sink
 * @returns {FileWriter}
 */
export function makeFileWriter(outPath) {
  if (!outPath) {
    return { write: () => {}, close: () => {} };
  }
  const fd = fs.openSync(outPath, 'w');
  let buf = [];
  let closed = false;
  const flush = () => {
    if (buf.length > 0) {
      fs.writeSync(fd, buf.join(''));
      buf = [];
    }
  };
  return {
    write: line => {
      buf.push(line);
      if (buf.length >= WRITER_FLUSH_AT) flush();
    },
    /*
     * Idempotent: callers close on the success path AND in a finally, so a
     * double-close must not double-free the fd.
     */
    close: () => {
      if (closed) return;
      closed = true;
      flush();
      fs.closeSync(fd);
    },
  };
}
