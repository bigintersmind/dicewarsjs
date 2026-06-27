/**
 * Pluggable win-rate backend for the PFSP opponent league (ml-bot Phase 3, task B6 — [D-23]).
 *
 * The league ([ppo-league.mjs](./ppo-league.mjs)) keeps a per-opponent win-rate **book** — the
 * LEARNER's pairwise record against each opponent id — that B4's PFSP sampler reads via
 * `w(S) = max(ε, 1 − winRate(S))^k`. B6 extracts that book behind a small synchronous interface so
 * the locality of the stats is a one-line swap:
 *
 *   - **{@link makeInMemoryStore}** (the default) — a per-process `Map`, byte-identical to the B2–B5
 *     inline book. This is what every league used through B5 and stays the default; with `DummyVecEnv`
 *     (one env-server) per-process == global, so nothing changes.
 *   - **{@link makeSharedDiskStore}** (opt-in, `--snapshot-store=disk`) — the cross-worker backend for
 *     Task E. Once `SubprocVecEnv` spawns N env-server processes ([D-22]/[D-23]), each owns a private
 *     league with a private book; a per-worker book would make every snapshot's win-rate noisy (each
 *     worker only sees ~1/N of its games). This store gives a **global** view: each worker owns one
 *     `book-shard-<workerId>.json`, periodically flushes its OWN book to it, and folds its PEERS'
 *     shards (recomputed from scratch each poll) into the win-rate read. The pool itself stays
 *     convergent for free — every worker polls the same producer snapshot manifest ([D-23]).
 *
 * **Hot-path contract.** `record`/`winRate`/`size` are synchronous and touch only in-memory maps, so
 * `draw()`'s up-to-`count` `winRate` calls and `recordResult`'s per-seat `record` never do I/O. The
 * only syscalls live in `flush()` (write own shard) and `refreshGlobal()` (re-read peers), which the
 * env-server calls at the episode boundary — never mid-decision (the main thread is parked on
 * `Atomics.wait` for the whole of each learner decision). For `InMemoryStore` both are no-ops.
 *
 * **B6 live-gating.** The cross-worker path is *implemented and unit-tested single-process* (two stores
 * over one temp dir exercise the full fold), but its genuinely-multi-worker properties are validated in
 * Task E when `SubprocVecEnv` is flipped on — no Python forwards `--snapshot-store=disk` until then.
 *
 * @module scripts/lib/ppo-league-store
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Crash-safe JSON write: serialize to a sibling `.tmp`, `fsync` it to durable storage, then
 * `rename` over the target (atomic on a single POSIX filesystem). A reader therefore never observes a
 * half-written file — it sees either the old bytes or the new, never a torn document. Mirrors the
 * producer's `snapshot_callback._write_manifest_atomic` (fsync-then-`os.replace`) so the snapshot
 * manifest and the league's own state share one durability story.
 *
 * @param {string} path destination path (overwritten atomically)
 * @param {unknown} obj JSON-serializable payload
 */
export function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(obj));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** A single opponent's record (the learner's pairwise tally). `wins` accrues `beat ∈ {0, 0.5, 1}`. */
const newRecord = () => ({ wins: 0, games: 0 });

/** Fold `beat` into `map[id]`, creating the record on first sight. Shared by both stores' `record`. */
function foldRecord(map, id, beat) {
  let rec = map.get(id);
  if (!rec) {
    rec = newRecord();
    map.set(id, rec);
  }
  rec.games++;
  rec.wins += beat;
}

/** Copy a `Map<id,{wins,games}>` to the `[[id,{wins,games}]]` entry array `toJSON` emits (deep, so
 *  the serialized form never aliases a live record). */
const mapToEntries = map => [...map].map(([id, rec]) => [id, { wins: rec.wins, games: rec.games }]);

/**
 * The default per-process book: a plain `Map<id,{wins,games}>`, byte-identical in behavior to the
 * inline book the league carried through B5. `flush`/`refreshGlobal` are no-ops (nothing to share —
 * the one process IS the global view under `DummyVecEnv`).
 *
 * @returns {import('./ppo-league.mjs').LeagueStore}
 */
export function makeInMemoryStore() {
  const book = new Map();
  return {
    kind: 'memory',
    record(id, beat) {
      foldRecord(book, id, beat);
    },
    winRate(id) {
      const rec = book.get(id);
      return rec && rec.games > 0 ? rec.wins / rec.games : 0;
    },
    size() {
      return book.size;
    },
    toJSON() {
      return mapToEntries(book);
    },
    restore(entries) {
      book.clear();
      for (const [id, rec] of entries ?? []) book.set(id, { wins: rec.wins, games: rec.games });
    },
    flush() {},
    refreshGlobal() {},
  };
}

/** Per-worker shard filename. Stable across restart since `workerId` is the env's `seed_base`, never a PID. */
const shardName = workerId => `book-shard-${workerId}.json`;
/** Match a worker shard filename and capture its workerId (so the fold can exclude OWN shard). */
const SHARD_RE = /^book-shard-(.+)\.json$/;

/**
 * The cross-worker (Task E / `SubprocVecEnv`) backend. Concurrency model: **single-writer-per-shard,
 * lock-free.** Each worker owns exactly one `book-shard-<workerId>.json` that ONLY it writes; reads of
 * peer shards are recompute-from-scratch, so the fold is idempotent and order-independent (re-reading
 * the same shards never double-counts). The own book is the live in-memory `Map` — the sole truth for
 * THIS worker's games — and `winRate` adds the last-polled peer totals on top, so a worker never folds
 * its own shard back over its live book (no self-double-count, and the live book survives a flush).
 *
 * @param {object} opts
 * @param {string} opts.dir shared directory holding every worker's shard (and, by convention, the
 *   snapshot manifest + per-worker league-state files). Must be one POSIX filesystem for `renameSync`
 *   atomicity — on shodan/WSL keep it on native ext4, not a `/mnt/c` DrvFs mount.
 * @param {string} opts.workerId this worker's stable id (the env `seed_base`). Defines OWN shard; every
 *   other `book-shard-*.json` in `dir` is a peer.
 * @returns {import('./ppo-league.mjs').LeagueStore}
 */
export function makeSharedDiskStore({ dir, workerId }) {
  if (!dir) throw new Error('makeSharedDiskStore: a shared `dir` is required.');
  if (workerId === undefined || workerId === null || workerId === '') {
    throw new Error('makeSharedDiskStore: a stable `workerId` is required (the env seed_base).');
  }
  const own = new Map(); // this worker's live book — the only map `record` mutates
  let peers = new Map(); // last-polled merge of every OTHER worker's shard; recomputed by refreshGlobal
  const ownShardPath = join(dir, shardName(String(workerId)));
  const ownShardFile = shardName(String(workerId));
  const warnedShards = new Set(); // rate-limit the "unreadable peer shard" warning to once per shard

  /** wins/games across own + peers for `id` (0 for unseen ⇒ cold-start max PFSP weight, like InMemory). */
  const merged = id => {
    const o = own.get(id);
    const p = peers.get(id);
    const wins = (o ? o.wins : 0) + (p ? p.wins : 0);
    const games = (o ? o.games : 0) + (p ? p.games : 0);
    return { wins, games };
  };

  /**
   * Load THIS worker's own shard back into the live `own` map. Own history lives only in `own` + its
   * shard (peers are excluded from the fold), so this is the sole recovery path for a restarted worker's
   * own contribution. A missing shard (never flushed pre-crash) is a clean cold start. Called at
   * construction AND from `restore()` so own-book recovery does NOT depend on the league-state file
   * existing (a crash between `flush()` writing the shard and `writeJsonAtomic` writing the state file
   * would otherwise leave the shard, skip restore, and let the next flush overwrite it with an empty book).
   */
  const loadOwnShard = () => {
    own.clear();
    let raw;
    try {
      raw = readFileSync(ownShardPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return; // no shard yet — cold start
      throw err;
    }
    for (const [id, rec] of JSON.parse(raw)) own.set(id, { wins: rec.wins, games: rec.games });
  };
  loadOwnShard();

  return {
    kind: 'disk',
    record(id, beat) {
      foldRecord(own, id, beat);
    },
    winRate(id) {
      const { wins, games } = merged(id);
      return games > 0 ? wins / games : 0;
    },
    size() {
      // Distinct opponents seen anywhere (own ∪ peers) — the health-metric bookSize.
      const ids = new Set(own.keys());
      for (const id of peers.keys()) ids.add(id);
      return ids.size;
    },
    toJSON() {
      // The book lives in the shards, not the league-state JSON; restore reloads OWN shard (null arg).
      return null;
    },
    restore() {
      // Resume: reload own shard (the league passes `null` for the disk store's book — it lives on disk).
      // Idempotent with the construction-time load; peers repopulate on the next `refreshGlobal()`.
      loadOwnShard();
    },
    flush() {
      writeJsonAtomic(ownShardPath, mapToEntries(own));
    },
    refreshGlobal() {
      /*
       * Recompute the peer merge from scratch (never delta-accumulate) so re-reading unchanged shards is
       * idempotent and the result is independent of poll order. Skip OWN shard (folded live), `.tmp`
       * writes-in-flight, and any malformed/torn shard (best-effort: a single bad peer must not crash a
       * multi-hour run — it simply doesn't contribute until its next clean flush).
       */
      const next = new Map();
      let names;
      try {
        names = readdirSync(dir);
      } catch (err) {
        if (err.code === 'ENOENT') return; // dir not created yet — no peers
        throw err;
      }
      for (const name of names) {
        if (name === ownShardFile || !SHARD_RE.test(name)) continue;
        let entries;
        try {
          entries = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch (err) {
          /*
           * ENOENT (a peer mid-rename) and a `SyntaxError` (a torn/partial read — near-impossible given
           * `writeJsonAtomic`'s fsync+rename) are benign: skip this poll, the peer contributes on its next
           * clean flush. Any OTHER errno (EACCES/EISDIR/EMFILE…) is a real misconfiguration that would
           * otherwise silently zero a peer's contribution for the whole run — warn once per shard.
           */
          if (err.code !== 'ENOENT' && !(err instanceof SyntaxError) && !warnedShards.has(name)) {
            warnedShards.add(name);
            process.stderr.write(
              `[ppo-league-store] cannot read peer shard ${name} (${err.code ?? err.message}); skipping.\n`
            );
          }
          continue;
        }
        if (!Array.isArray(entries)) continue;
        for (const [id, rec] of entries) {
          if (!rec || typeof rec.wins !== 'number' || typeof rec.games !== 'number') continue;
          let acc = next.get(id);
          if (!acc) {
            acc = newRecord();
            next.set(id, acc);
          }
          acc.wins += rec.wins;
          acc.games += rec.games;
        }
      }
      peers = next;
    },
  };
}
