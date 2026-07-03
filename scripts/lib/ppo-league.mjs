/**
 * PFSP opponent league for the PPO env-server (ml-bot Phase 3, task B — [D-22]).
 *
 * The env-server draws its per-episode opponent field from this league instead of a
 * static const. The league will own the opponent pool (built-in baselines + hot-loaded
 * self-play snapshots), a seeded sampler, and a per-opponent win-rate book — but step
 * built incrementally across steps **B1–B4** (see the build sequence at the bottom of this header).
 *
 * **Fixed-field (task A) is the empty-pool degenerate mode of this module:** with no
 * snapshots, `draw()` returns exactly the cycled baseline field the env-server used
 * before — content-identical (same names + fn refs), so task A's outcomes reproduce.
 *
 * Build sequence (docs/ml-bot/DECISIONS.md D-23; D-22 for the league architecture + the win-rate-
 * attribution decision):
 *   - **B1** — the empty-pool path (== task A) plus a decisive/truncated telemetry tally.
 *   - **B2** — the per-opponent win-rate book (`recordResult` pairwise crediting + `winRate(id)`).
 *   - **B3** — the snapshot pool + `refresh()`: poll the producer's `manifest.json`, hot-load each
 *     new self-play snapshot via `makeBC` (fresh filename per snapshot → ESM URL cache), FIFO-trim the
 *     in-memory pool past `poolCap` (disk GC is the producer's job — task E / PR-3; a consumer never
 *     unlinks). B3 only *loads* the pool — `draw()` does not seat it yet.
 *   - **B4** — PFSP weighting **on**: when the pool is non-empty, `draw(seed)` seeds a `mulberry32`
 *     sampler and seats `count − R` snapshots drawn by `w(S) = max(ε, 1 − learnerWinRate(S))^k`
 *     (lower learner win-rate → higher weight) plus `R` reserved baselines (the [D-15]
 *     turtle-equilibrium defense), then shuffles opponent→seat so neither group binds to fixed
 *     turn-order seats. **Empty pool still returns the byte-identical task-A field** (fixed-field
 *     stays the empty-pool mode of this one pipeline). Persistence (B6) extends the same object.
 *
 * @module scripts/lib/ppo-league
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeBC } from '../../src/ai/ai_bc.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import {
  ENCODING_VERSION,
  SUPPORTED_ENCODING_VERSIONS,
} from '../../src/arena/encodeObservation.js';
import { mulberry32 } from './mulberry32.mjs';
import { makeInMemoryStore } from './ppo-league-store.mjs';

/*
 * `makeBC` (snapshot loader, B3) and `ENCODING_VERSION` (manifest compat gate) are imported
 * statically with no extra load cost: the ~2 MB `bcPolicyWeights.js` `makeBC` pulls in is already
 * loaded eagerly via the `BUILT_IN_BOTS` import below (→ `ai_bc.js` → `bcPolicyWeights.js`), and
 * `ENCODING_VERSION` rides the far lighter `encodeObservation.js`.
 */

/*
 * A decisive game must carry a `seatBeat[]` (both shapers guarantee one for a decided placement). A
 * single missing vector is tolerated and warned once; this many CUMULATIVELY means a persistent
 * shaper/contract regression — `recordResult` then throws, because an uncredited win-rate book
 * silently collapses B4's PFSP sampler to ~uniform (every snapshot stuck at cold-start weight) and
 * would waste a whole multi-hour training run with no other loud signal.
 */
const MAX_NO_SEATBEAT_GAMES = 10;

/**
 * `toJSON()` checkpoint schema version (B6). `restore()` rejects an unknown version rather than
 * silently mis-reading an older/newer layout. Bump only on a breaking shape change to the snapshot.
 *
 * v2 (task E / PR-1): added `episodeCount` (the resume seed-cursor — without it a relaunched
 * env-server replays seeds from 0 and re-books their outcomes, double-counting the win-rate book)
 * and `refreshSkips` (the multi-worker GC-race health counter). B6 (v1) never ran live, so there
 * are no v1 checkpoints in the wild — the bump just makes a stale checkpoint fail loud on resume.
 */
const STATE_SCHEMA_VERSION = 2;

/**
 * @typedef {object} LeagueStore the pluggable win-rate backend (see ppo-league-store.mjs).
 * @property {(id: string, beat: number) => void} record fold a pairwise result (`beat ∈ {0,0.5,1}`).
 * @property {(id: string) => number} winRate the learner's win-rate vs `id` (0 for unseen).
 * @property {() => number} size distinct booked opponent ids (the `stats().bookSize` health metric).
 * @property {() => (Array|null)} toJSON serialize the book (entries array; `null` if it lives off-band).
 * @property {(entries: Array|null) => void} restore reload the book from a `toJSON()` payload.
 * @property {() => void} flush persist this worker's book (no-op for the in-memory store).
 * @property {() => void} refreshGlobal re-fold peer books (no-op for the in-memory store).
 */

/** Split + trim the opponent id CSV, dropping blanks; throws if it resolves to nothing. */
function parseIds(idCsv) {
  const ids = idCsv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error('--opponents resolved to an empty list.');
  return ids;
}

/**
 * Resolve `count` opponent entries from BUILT_IN_BOTS by cycling the id CSV — the EXACT
 * field the env-server's old `resolveOpponents` produced (moved here verbatim so the
 * empty-pool league reproduces task A's field; the B1 parity test pins this equivalence).
 *
 * @param {string} idCsv comma-separated built-in bot ids (e.g. "ai_lookahead,ai_bc")
 * @param {number} count number of opponent seats to fill (= playerCount - 1)
 * @returns {{id: string, name: string, fn: Function}[]} length `count`; the seat-cycle index is in
 *   the name (`@i`). `id` is the stable bot id (the field is the single source of truth for the
 *   cycle, so `draw()`'s seat metadata keys on `entry.id` rather than re-deriving the cycle).
 *   `runSelfPlayEpisode` reads only `name`/`fn` and ignores the extra `id`.
 */
export function resolveBaselineField(idCsv, count) {
  const ids = parseIds(idCsv);
  const byId = new Map(BUILT_IN_BOTS.map(b => [b.id, b]));
  return Array.from({ length: count }, (_, i) => {
    const id = ids[i % ids.length];
    const bot = byId.get(id);
    if (!bot) {
      throw new Error(`Unknown opponent bot id "${id}". Known: ${[...byId.keys()].join(', ')}.`);
    }
    return { id, name: `${bot.name}@${i}`, fn: bot.fn };
  });
}

/**
 * Construct a league. Step **B1** ships the empty-pool path (== task A's fixed field) plus a
 * decisive/truncated telemetry tally; step **B2** adds the per-opponent win-rate book
 * (`recordResult` pairwise crediting + `winRate(id)`); step **B3** adds the snapshot pool +
 * `refresh()`; step **B4** turns PFSP weighting on in `draw()` (samples the pool by
 * `w(S)=max(ε,1−learnerWinRate(S))^k` + R reserved baselines); B6 adds `toJSON`/`restore`.
 *
 * @param {object} opts
 * @param {string} opts.baselineCsv the resolved `--opponents` CSV. The trainer passes
 *   `DEFAULT_OPPONENTS`; the env-server's own default is `ai_bc`. Threaded in (NOT a
 *   hardcoded default) so the empty-pool field equals the launch's actual field _[D-22]_.
 * @param {number} opts.count opponent seats per game (= playerCount - 1); `draw()` always
 *   returns exactly this many (holds player_count constant, [D-22]).
 * @param {number} opts.learnerSeat the learner's seat; used to map an opponent's array
 *   index to its seat for the (B2) win-rate attribution.
 * @param {string|null} [opts.snapshotManifest=null] path to the producer's snapshot `manifest.json`
 *   (B3). When set, `refresh()` polls it and hot-loads new self-play snapshots into the pool via
 *   `makeBC`. `null` (the default / no `--snapshot-manifest`) keeps the empty-pool fixed-field mode —
 *   `refresh()` is a no-op, so B3 is fully backward-compatible with task A / B1 / B2.
 * @param {number} [opts.poolCap=40] max snapshots kept live (sampleable) (B3). FIFO-by-step eviction
 *   keeps the most recent/hardest snapshots ([D-23]) in the in-memory pool. It bounds the SAMPLEABLE
 *   set only — disk retention is the PRODUCER's job (task E / PR-3): a consumer no longer deletes
 *   files (that would race N SubprocVecEnv workers); the single producer GCs aged-out `.js` after
 *   truncating its manifest. It does NOT bound process memory either: Node's ESM
 *   module registry retains every dynamic-`import()`ed snapshot module for the process lifetime (each
 *   fresh filename is a distinct, permanently-cached module), so resident weights grow with the total
 *   number of snapshots ever loaded, not `poolCap`. Modest at realistic cadences (~2 MB each); if a
 *   long run needs a hard memory bound, load weights without `import()` caching (B5 concern).
 * @param {number} [opts.reserveBaselines=3] **R** — baselines reserved in every drawn field while
 *   the pool is non-empty (the [D-15] turtle-equilibrium defense). The reserve pool is the DISTINCT
 *   baseline ids minus `ai_bc` (the STOP/turtle lineage is the ONLY excluded one — so the reserve set
 *   can include a defensive bot such as `ai_defensive`, not just aggressive ones). Reserved seats are
 *   sampled WITHOUT replacement, so at most `min(R, count, #distinctReserveBaselines)` seats are
 *   reserved and the remainder go to PFSP snapshots ([D-23]). 0 disables reservation. Empty-pool mode
 *   ignores it. With a snapshot manifest configured, a config that reserves ALL `count` seats (so no
 *   snapshot could ever be drawn) is rejected at construction — see the dead-PFSP guard below.
 * @param {number} [opts.pfspEpsilon=0.05] **ε** — the PFSP weight floor in `w(S)=max(ε,1−winRate)^k`.
 *   Must be in (0, 1]: ε>0 floors every snapshot weight at ε^k > 0 (a fully-mastered snapshot is still
 *   drawn occasionally) for any sane k. (At a pathological k, ε^k can underflow to 0.0 in floating
 *   point; `draw()` then falls back to uniform sampling so the wheel still selects.) Empty pool ignores it.
 * @param {number} [opts.pfspK=2] **k** — the PFSP weight exponent in `w(S)=max(ε,1−winRate)^k`.
 *   Must be ≥ 0; higher k sharpens the bias toward snapshots that beat the learner (k=0 → uniform).
 *   Empty-pool mode ignores it.
 * @param {LeagueStore} [opts.store] the win-rate backend (B6). Defaults to a fresh
 *   `makeInMemoryStore()` — a per-process `Map`, byte-identical to the B2–B5 inline book. The
 *   env-server passes `makeSharedDiskStore(...)` under `--snapshot-store=disk` for cross-worker
 *   (Task-E `SubprocVecEnv`) aggregation. `recordResult`/`winRate`/`stats().bookSize` route through
 *   it; the store's `flush()`/`refreshGlobal()` syscall methods are driven by the env-server at the
 *   episode boundary, not by the league (so `draw()`/`recordResult` stay synchronous + I/O-free).
 * @returns {{draw: Function, recordResult: Function, winRate: Function, refresh: Function,
 *   stats: Function, toJSON: Function, restore: Function}}
 */
export function makeLeague({
  baselineCsv,
  count,
  learnerSeat,
  snapshotManifest = null,
  poolCap = 40,
  reserveBaselines = 3,
  pfspEpsilon = 0.05,
  pfspK = 2,
  store = makeInMemoryStore(),
}) {
  /*
   * Fail loud at construction — both inputs are in scope here, so a bad value is caught at the
   * cheapest spot rather than surfacing later as a silently-wrong `seatOf` map (B2's win-rate
   * attribution reads `drawn[k].seat`) or an `Array.from({ length })` that floors/empties without
   * complaint. playerCount = count + 1 ⇒ valid learner seats are [0, count]. Mirrors the guard in
   * runSelfPlayEpisode (ppo-env.mjs), which re-validates `learnerSeat` against the same range.
   */
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`makeLeague: count must be a positive integer, got ${count}.`);
  }
  if (!Number.isInteger(learnerSeat) || learnerSeat < 0 || learnerSeat > count) {
    throw new Error(
      `makeLeague: learnerSeat ${learnerSeat} out of range [0, ${count}] for count ${count}.`
    );
  }
  if (!Number.isInteger(poolCap) || poolCap <= 0) {
    throw new Error(`makeLeague: poolCap must be a positive integer, got ${poolCap}.`);
  }
  /*
   * PFSP sampler knobs (B4). Validate at construction so a typo'd CLI flag fails the launch, not a
   * mid-run draw: ε must be a positive fraction (ε>0 floors every weight at ε^k > 0 mathematically, so
   * a mastered snapshot is not starved; ε≤1 since 1−winRate ∈ [0,1]); k must be a finite non-negative
   * exponent; R a non-negative integer count of reserved seats. (At a pathological k, ε^k can still
   * underflow to 0.0 in IEEE-754 — `draw()` guards that with a uniform fallback, see below.)
   */
  if (!Number.isFinite(pfspEpsilon) || pfspEpsilon <= 0 || pfspEpsilon > 1) {
    throw new Error(`makeLeague: pfspEpsilon must be in (0, 1], got ${pfspEpsilon}.`);
  }
  if (!Number.isFinite(pfspK) || pfspK < 0) {
    throw new Error(`makeLeague: pfspK must be a finite number >= 0, got ${pfspK}.`);
  }
  if (!Number.isInteger(reserveBaselines) || reserveBaselines < 0) {
    throw new Error(
      `makeLeague: reserveBaselines must be a non-negative integer, got ${reserveBaselines}.`
    );
  }
  const baselineField = resolveBaselineField(baselineCsv, count);

  /*
   * Reserve pool (B4): the DISTINCT baseline bots minus `ai_bc` (the STOP/turtle lineage — reserving
   * it would defeat the [D-15] turtle defense it exists to counter). Derived from the full
   * `baselineCsv`, NOT `baselineField`, so a CSV with more distinct ids than `count` still surfaces
   * all of them (the count-length cycle would hide the tail). We must re-validate here: above,
   * `resolveBaselineField` only checks the first `count` CYCLED positions (`ids[i % ids.length]`), so a
   * typo'd id PAST position `count−1` slips through it and would otherwise crash this `.map` with a
   * cryptic `undefined.name`. Guard with the same clear message. Bare bot name (the `@i` disambiguator
   * is appended per draw, mirroring the baseline field). When this is empty (e.g. the env-server bare
   * default `--opponents=ai_bc`), `draw()` reserves nothing and all seats go to PFSP.
   */
  const reserveById = new Map(BUILT_IN_BOTS.map(b => [b.id, b]));
  const reserveBaselinePool = [...new Set(parseIds(baselineCsv))]
    .filter(id => id !== 'ai_bc')
    .map(id => {
      const bot = reserveById.get(id);
      if (!bot) {
        throw new Error(
          `Unknown opponent bot id "${id}". Known: ${[...reserveById.keys()].join(', ')}.`
        );
      }
      return { id, name: bot.name, fn: bot.fn };
    });
  Object.freeze(reserveBaselinePool);
  /*
   * Dead-PFSP guard (B4): `draw()` computes `pfspCount = count − min(R, count, #reserveBaselinePool)`,
   * so when the reserve baselines alone fill every seat (`min(R, #reserveBaselinePool) >= count`) it
   * seats ZERO snapshots — PFSP is silently a no-op even with a fully-loaded pool. That is only ever a
   * misconfiguration when a manifest is configured (the operator clearly intends PFSP), and it is
   * decidable here at construction (the condition is independent of pool contents). Fail the launch
   * with an actionable message rather than burn a multi-hour run training against baselines only.
   * Empty-pool fixed-field mode (no manifest) never seats snapshots anyway, so it is exempt.
   */
  if (snapshotManifest && Math.min(reserveBaselines, reserveBaselinePool.length) >= count) {
    throw new Error(
      `makeLeague: reserveBaselines=${reserveBaselines} with ${reserveBaselinePool.length} distinct ` +
        `reserve baseline(s) fills all ${count} opponent seat(s), so draw() can never seat a PFSP ` +
        `snapshot despite a configured snapshot manifest. Lower reserveBaselines or raise the player count.`
    );
  }
  /*
   * `draw()` hands out this same array reference every episode, so freeze it (and its entries):
   * a future in-place reorder/mutation throws loudly under ESM strict mode instead of silently
   * poisoning every later draw. Near-zero cost — the fns are shared from BUILT_IN_BOTS anyway.
   */
  baselineField.forEach(entry => Object.freeze(entry));
  Object.freeze(baselineField);

  /*
   * Persistence fingerprint (B6): every construction arg that steers `draw()`'s output OR the
   * FIFO-trimmed sampleable pool size. `restore()` throws unless the persisted fingerprint matches
   * this league's, because a resume under drifted CLI args must fail loud, not sample divergently —
   * `pfspEpsilon`/`pfspK`/`reserveBaselines`/`poolCap`/baseline identity are as load-bearing as
   * `count`/`learnerSeat`. `baselineIds` is the trimmed ordered id list (the full determinant of both
   * the cycled `baselineField` and the `reserveBaselinePool`), normalized so cosmetic CSV whitespace
   * does not spuriously reject an otherwise-identical resume.
   */
  const fingerprint = Object.freeze({
    count,
    learnerSeat,
    poolCap,
    reserveBaselines,
    pfspEpsilon,
    pfspK,
    baselineIds: Object.freeze(parseIds(baselineCsv)),
  });

  let decisiveGames = 0;
  let truncatedGames = 0;
  /*
   * Episodes booked through `recordResult` — the **resume seed-cursor** (task E / PR-1). The
   * env-server seeds episode `ep` with `seedBase + ep` and books exactly one result per loop
   * iteration that reached a terminal (disconnect/error break out BEFORE `recordResult`), so this is
   * the count of seeds already consumed-and-booked. On resume the env-server starts its loop at this
   * value so it does NOT replay already-played seeds and re-fold their outcomes into the (restored)
   * win-rate book — the silent double-count this counter exists to prevent. Always equals
   * `decisiveGames + truncatedGames`; kept as its own field so the cursor stays correct even if a
   * future change adds a third outcome bucket (the invariant is asserted in the persist suite).
   */
  let episodeCount = 0;
  /*
   * Win-rate book (B2): stable opponent id → the LEARNER's pairwise record against it. `wins` is the
   * count of decisive games in which the learner outplaced that opponent; `games` the decisive games
   * the opponent appeared in (a cycled baseline seated twice in one game contributes two records).
   * Keyed on the stable id, never the `uniquifyNames` `#N` display name. B4 samples snapshots by
   * `w(S) = max(ε, 1 − winRate(S))^k`, so a lower learner-win-rate (an opponent that beats the
   * learner) earns a higher weight. maxTurns truncations are excluded (see recordResult).
   *
   * B6: the book now lives behind the injected `store` (default `makeInMemoryStore()` — a `Map`,
   * byte-identical to the prior inline book). `recordResult` writes via `store.record`, `winRate`/the
   * PFSP sampler read via `store.winRate`, `stats().bookSize` via `store.size`. Persistence
   * (`toJSON`/`restore`) round-trips it via `store.toJSON`/`store.restore`.
   */
  // One-shot guard so a broken-contract decisive game (no seatBeat[]) warns once, not per-episode.
  let warnedNoSeatBeat = false;
  /*
   * Cumulative count of decisive games that arrived without a `seatBeat[]`. One-off is tolerated
   * (warn-once above); past `MAX_NO_SEATBEAT_GAMES` it is a persistent contract break that has left
   * the win-rate book uncredited — `recordResult` throws so PFSP can't quietly run on a ~uniform book.
   * Surfaced on `stats()` for the DONE-line health window; should always read 0 on a healthy run.
   */
  let noSeatBeatGames = 0;

  /*
   * Snapshot pool (B3): hot-loaded self-play snapshots the trainer published, FIFO-capped at
   * `poolCap`. `pool` holds the LIVE snapshots (ascending step → `shift()` evicts the oldest); B4's
   * `draw()` samples from it. `loadedIds` records every id ever imported — an evicted id stays here so
   * `refresh()` never re-imports it after its `.js` is GC'd (a re-import would hit a deleted file).
   * `manifestMtimeMs` is a cheap no-change guard so the per-episode poll re-parses only on a rewrite.
   */
  const pool = [];
  const loadedIds = new Set();
  let manifestMtimeMs = -1;
  /*
   * Snapshots `refresh()` skipped because their `.js` was already gone at import time (task E / PR-1
   * GC-race floor): under `SubprocVecEnv` N env-servers share one snapshot dir with a single producer
   * that owns disk GC (task E / PR-3). The producer `unlink`s an aged-out snapshot after truncating
   * the manifest; a lagging worker reading a still-listing (older) manifest can try to import a file
   * the producer has since GC'd. The lagging worker tolerates the missing file (warn + skip + mark
   * loaded) instead of crashing the whole run on a benign race; this counts how often it happened so
   * the env-server can surface it on the DONE health line. Should stay low; a large value means the
   * pool cap is too small for the snapshot cadence (the producer GCs faster than a worker can load).
   */
  let refreshSkips = 0;

  /*
   * Opponent-array index → seat: the learner sits at `learnerSeat`; opponents fill the remaining
   * seats in order (mirrors the seat-fill in ppo-env.mjs). Computed here so B2's win-rate
   * attribution reads `drawn[k].seat` instead of reverse-engineering it from the `@i`-suffixed
   * roster names (whose index is the opponent array slot, not the board seat).
   */
  const seatOf = k => (k < learnerSeat ? k : k + 1);

  /*
   * The LEARNER's win-rate against opponent `id` — the B2 book read shared by the public `winRate()`
   * method and B4's PFSP sampler. Unseen / zero-game id → 0 (cold-start ⇒ max PFSP weight; an
   * opponent the learner has never beaten and one it has never met are deliberately indistinguishable,
   * both prioritised). Defined as a closure (not via the returned method) so `draw()` can read it
   * without an extra object hop.
   */
  const learnerWinRate = id => store.winRate(id);

  /*
   * Roulette-wheel pick from `items` with parallel non-negative `weights` summing to `total > 0`,
   * consuming one `rng()` draw. The caller precomputes weights/total once per draw (they are constant
   * within a draw) and samples WITH replacement, so a small pool can still fill every PFSP seat. The
   * trailing return covers the float-rounding corner where `r` never quite goes negative.
   */
  const sampleByWeight = (rng, items, weights, total) => {
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  };

  return {
    /*
     * Draw the per-episode opponent field (length `count`, opponents/drawn index-parallel).
     *
     * **Empty pool → byte-identical task-A field.** With no snapshots this returns the cycled
     * baseline field, seed-invariant (the episode outcome depends on the ordered fns × the seed, which
     * the env-server passes to `runSelfPlayEpisode` separately). This is the load-bearing fixed-field
     * parity guarantee — it must stay identical to B1/B2/B3.
     *
     * **Non-empty pool → PFSP (B4).** Seed a `mulberry32(seed)` stream and fill `count` seats with:
     *   1. up to `min(R, count, #reserveBaselinePool)` reserved baselines, sampled WITHOUT
     *      replacement (distinct non-`ai_bc` opponents — the [D-15] turtle defense), then
     *   2. the remaining seats with snapshots sampled WITH replacement by
     *      `w(S) = max(ε, 1 − learnerWinRate(S))^k` (lower learner win-rate → higher weight).
     * The combined field is then Fisher-Yates shuffled (same rng stream) so the reserve/PFSP split
     * does not bind to fixed board seats — i.e. snapshots don't systematically inherit the early
     * (first-to-move) seats. Deterministic given (seed, current pool, current win-rate book).
     */
    draw(seed) {
      if (pool.length === 0) {
        return {
          opponents: baselineField,
          drawn: baselineField.map((bot, i) => ({ id: bot.id, kind: 'baseline', seat: seatOf(i) })),
        };
      }

      const rng = mulberry32(seed >>> 0);
      const field = []; // { id, kind, name, fn } entries, length `count`

      // (1) Reserved baselines (distinct, non-ai_bc) — at most as many distinct ones as exist, no replacement.
      const reserveCount = Math.min(reserveBaselines, count, reserveBaselinePool.length);
      const reservePick = reserveBaselinePool.slice();
      for (let i = 0; i < reserveCount; i++) {
        const j = i + Math.floor(rng() * (reservePick.length - i)); // partial Fisher-Yates
        const picked = reservePick[j];
        reservePick[j] = reservePick[i];
        reservePick[i] = picked;
        field.push({ id: picked.id, kind: 'baseline', name: picked.name, fn: picked.fn });
      }

      /*
       * (2) PFSP snapshots — weighted by w(S), with replacement. Weights are constant within a draw,
       * so compute them once. ε>0 floors each weight at ε^k, which is > 0 for any sane k — but at a
       * pathological k (large enough that ε^k underflows to 0.0 in IEEE-754) AND an all-mastered pool,
       * every weight can collapse to 0. Fall back to UNIFORM there so the wheel still selects
       * meaningfully (and deterministically) instead of always degenerating to the last entry.
       */
      const pfspCount = count - reserveCount;
      if (pfspCount > 0) {
        const weights = pool.map(s =>
          Math.pow(Math.max(pfspEpsilon, 1 - learnerWinRate(s.id)), pfspK)
        );
        let total = 0;
        for (const w of weights) total += w;
        if (total === 0) {
          weights.fill(1);
          total = pool.length;
        }
        for (let i = 0; i < pfspCount; i++) {
          const snap = sampleByWeight(rng, pool, weights, total);
          field.push({ id: snap.id, kind: 'snapshot', name: snap.id, fn: snap.fn });
        }
      }

      // Shuffle opponent→seat so neither group binds to fixed turn-order seats (still seeded).
      for (let i = field.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = field[i];
        field[i] = field[j];
        field[j] = tmp;
      }

      /*
       * `@i` disambiguates duplicates (a snapshot/baseline drawn for multiple seats) for runMatch's
       * unique-name rule, matching the baseline field convention. `drawn[i]` describes `opponents[i]`.
       */
      const opponents = field.map((e, i) => ({ id: e.id, name: `${e.name}@${i}`, fn: e.fn }));
      const drawn = field.map((e, i) => ({ id: e.id, kind: e.kind, seat: seatOf(i) }));
      return { opponents, drawn };
    },

    /*
     * Tally the episode outcome. Decisive vs maxTurns-truncated counters feed the [D-22] decisive-
     * rate health metric. B2: a decisive game also credits the win-rate book — for each drawn
     * opponent, read the learner's pairwise result at that opponent's board seat from
     * `result.seatBeat[seat]` and fold it into `book[id]`. maxTurns truncations are EXCLUDED from the
     * book entirely ([D-22] decision 5: counting stalemates as losses biases the sampler toward
     * turtle fields) — they bump only the truncated counter. A cycled baseline seated at two seats
     * yields two independent records for its id (one per seat), which is correct.
     */
    recordResult(drawn, result) {
      // The resume seed-cursor (task E): one increment per booked episode, BEFORE the truncated/
      // decisive split, so it counts every seed consumed regardless of outcome bucket.
      episodeCount++;
      if (result.truncated) {
        truncatedGames++;
        return;
      }
      decisiveGames++;
      const { seatBeat } = result;
      if (!Array.isArray(seatBeat)) {
        /*
         * Both shapers always return a seatBeat[] for a decisive game (ppo-env.mjs), so a missing one
         * means an upstream shaper/contract break. Don't crash a long training run over a single bad
         * outcome — but don't let it silently empty the book either (the failure mode that would make
         * B4's PFSP sampler quietly collapse to ~uniform). Warn ONCE so the regression is visible, and
         * fail loud once it is clearly PERSISTENT (past MAX_NO_SEATBEAT_GAMES): a run that never credits
         * the book is training against an effectively uniform sampler and should stop, not spin on.
         */
        noSeatBeatGames++;
        if (!warnedNoSeatBeat) {
          warnedNoSeatBeat = true;
          process.stderr.write(
            '[ppo-league] decisive game had no seatBeat[] — win-rate book not credited; check the ' +
              'runSelfPlayEpisode/runMatch placement contract.\n'
          );
        }
        if (noSeatBeatGames >= MAX_NO_SEATBEAT_GAMES) {
          throw new Error(
            `ppo-league.recordResult: ${noSeatBeatGames} decisive games had no seatBeat[] — the ` +
              `win-rate book is not being credited and B4's PFSP sampler has collapsed to uniform. ` +
              `Fix the runSelfPlayEpisode/runMatch placement contract.`
          );
        }
        return;
      }
      for (const d of drawn) {
        const beat = seatBeat[d.seat];
        if (beat === null || beat === undefined) continue; // an unrankable seat (drawn never holds the learner)
        if (beat !== 0 && beat !== 1 && beat !== 0.5) {
          /*
           * Anything outside the documented {0, 0.5, 1} domain is a shaper/seat desync — fail loud
           * rather than fold a garbage value into `wins` and violate the book's `games >= wins`.
           */
          throw new Error(
            `ppo-league.recordResult: seatBeat[${d.seat}]=${beat} outside {0,0.5,1} — shaper/seat ` +
              `desync (a corrupt win-rate book would poison B4's PFSP sampler).`
          );
        }
        store.record(d.id, beat);
      }
    },

    /**
     * The LEARNER's win-rate against opponent `id` (B2) — the [D-19]/[D-22] PFSP signal. Returns
     * `0` for an unseen id (cold-start: a never-recorded snapshot then earns max weight
     * `w = max(ε, 1)^k`, so it is sampled hardest first — [D-23]). Indistinguishable from "lost every
     * game", which is intentional: both should be prioritised by the sampler.
     */
    winRate(id) {
      return learnerWinRate(id);
    },

    /**
     * Poll the producer's snapshot manifest and hot-load any new self-play snapshots into the pool
     * (B3). Called at each episode boundary by the env-server. No manifest configured → a no-op
     * (empty-pool fixed-field mode). Cheap when nothing changed: a single `statSync` mtime check short-
     * circuits before any parse/import. On a rewrite it diffs the manifest by stable id, dynamic-
     * `import()`s each NEW snapshot's `.js` (a fresh filename per snapshot, so the ESM URL cache never
     * serves a stale module), wraps it with `makeBC({ policy })`, and FIFO-trims its IN-MEMORY pool
     * past `poolCap`. It does NOT delete any file — disk GC is the single producer's job (task E /
     * PR-3); a consumer that unlinked would race its SubprocVecEnv peers. `loadedIds` keeps an evicted
     * id from being re-imported, and a file the producer has already GC'd is tolerated (the ENOENT
     * guard below). `draw()` does not sample the pool until B4, so in B3 this only grows `poolSize`;
     * episode outcomes are unchanged.
     *
     * @returns {Promise<{added:number, poolSize:number}>}
     */
    async refresh() {
      if (!snapshotManifest) return { added: 0, poolSize: pool.length };
      let stat;
      try {
        stat = statSync(snapshotManifest);
      } catch (err) {
        /*
         * ENOENT is the only benign case: the producer simply hasn't published its first snapshot
         * yet (expected for the first ~--snapshot-every steps). Any other errno (EACCES/ENOTDIR/an
         * unmounted share) is a misconfiguration that will never self-resolve — surface it loudly
         * instead of silently running forever in empty-pool fixed-field mode.
         */
        if (err.code === 'ENOENT') return { added: 0, poolSize: pool.length };
        throw new Error(
          `ppo-league.refresh: cannot stat snapshot manifest ${snapshotManifest} ` +
            `(${err.code ?? err.message}). Check --snapshot-manifest / the producer's --snapshot-dir.`
        );
      }
      if (stat.mtimeMs === manifestMtimeMs) return { added: 0, poolSize: pool.length };

      const manifest = JSON.parse(readFileSync(snapshotManifest, 'utf8'));
      if (!SUPPORTED_ENCODING_VERSIONS.includes(manifest.encodingVersion)) {
        throw new Error(
          `ppo-league.refresh: snapshot manifest encodingVersion ${manifest.encodingVersion} not in ` +
            `supported set [${SUPPORTED_ENCODING_VERSIONS.join(', ')}] (${snapshotManifest}). The run ` +
            `must freeze its encoding — re-export the snapshots against a supported encoding.`
        );
      }

      const dir = dirname(snapshotManifest);
      /*
       * New snapshots to load, oldest-first (ascending step → push order == FIFO eviction order).
       * De-dup by id: the producer manifest is append-only and SHOULD list each id once, but a
       * producer resume can republish an id (PR-3 truncates that at the source), and two pool entries
       * for one id would double its PFSP sampling weight and seat it twice in the pool. Belt-and-braces.
       */
      const seenFresh = new Set();
      const fresh = (manifest.snapshots ?? [])
        .filter(s => {
          if (loadedIds.has(s.id) || seenFresh.has(s.id)) return false;
          seenFresh.add(s.id);
          return true;
        })
        .sort((a, b) => a.step - b.step);

      let added = 0;
      for (const snap of fresh) {
        const weightsPath = resolve(dir, snap.weights);
        let mod;
        try {
          mod = await import(pathToFileURL(weightsPath).href);
        } catch (err) {
          if (
            (err.code === 'ENOENT' || err.code === 'ERR_MODULE_NOT_FOUND') &&
            !existsSync(weightsPath)
          ) {
            /*
             * GC-race floor (task E): under SubprocVecEnv, N env-servers share one snapshot dir with a
             * single producer (the Python `SnapshotCallback`) that owns disk GC — it `unlink`s an
             * aged-out `.js` after truncating the manifest. A lagging worker can read a still-listing
             * (older) manifest and try to import a file the producer has since GC'd. The file is gone
             * for good — the snapshot is already superseded — so warn, mark its id loaded (never retry
             * the dead path), and skip. A benign GC race must not crash a multi-hour run.
             *
             * The `!existsSync` guard makes the swallow mean "the file is genuinely gone": a present
             * module that throws `ERR_MODULE_NOT_FOUND` for a MISSING TRANSITIVE IMPORT (or any parse/
             * syntax failure) is a real bug in a published artifact → falls through to the rethrow.
             */
            refreshSkips++;
            loadedIds.add(snap.id);
            process.stderr.write(
              `[ppo-league] refresh: snapshot ${snap.id} weights gone before import (${weightsPath}); ` +
                `skipped (producer GC race). refreshSkips=${refreshSkips}.\n`
            );
            continue;
          }
          throw err;
        }
        if (!mod.BC_POLICY) {
          // No BC_POLICY export ⇒ makeBC's default param would silently load the SHIPPED BC as this
          // snapshot (a corrupt/truncated published artifact masquerading as a trained policy). Fail loud.
          throw new Error(
            `ppo-league.refresh: snapshot ${snap.id} (${weightsPath}) exports no BC_POLICY — ` +
              `corrupt/truncated weights module.`
          );
        }
        const fn = makeBC({ policy: mod.BC_POLICY }); // re-checks encodingVersion per snapshot
        pool.push({ id: snap.id, step: snap.step, fn, weightsPath });
        loadedIds.add(snap.id);
        added++;
      }

      /*
       * FIFO trim: keep the most recent `poolCap` snapshots sampleable. Disk deletion is the
       * PRODUCER's job now (task E / PR-3): the single Python process that owns the manifest GCs
       * aged-out `.js` files AFTER truncating the manifest. If a consumer also unlinked, N
       * SubprocVecEnv workers would race to delete each other's files and a lagging worker would
       * import a path a peer just removed — a self-inflicted race the producer-owned-GC model avoids.
       * Consumers still tolerate a producer-GC'd missing file in the import guard above; this loop
       * only bounds the in-memory sampleable set. `loadedIds` still prevents re-importing an evicted
       * id, and the ESM module registry retains the weights for the process lifetime regardless
       * (see the `poolCap` JSDoc note).
       */
      while (pool.length > poolCap) {
        pool.shift();
      }

      manifestMtimeMs = stat.mtimeMs; // commit only after a clean load, so a throw retries next poll
      return { added, poolSize: pool.length };
    },

    /**
     * League health snapshot. The env-server emits this on its `PPO_ENV_SERVER DONE` line (the B5
     * throughput/decisive-rate re-probe reads it). `winRate(id)` and `draw()` (which now samples the
     * book for PFSP weighting, B4) are the other windows onto the win-rate book. `decisiveGames`
     * counts every booked decisive episode incl. zero-decision skips, so `decisiveGames > <wire
     * terminals>` evidences the B2 "book before the zero-decision wire gate" reordering.
     * `noSeatBeatGames` should read 0 on a healthy run — a nonzero value means decisive games whose
     * placement contract broke (book under-credited; PFSP drifting toward uniform).
     */
    stats() {
      const total = decisiveGames + truncatedGames;
      return {
        poolSize: pool.length,
        loadedSnapshots: loadedIds.size,
        bookSize: store.size(),
        decisiveGames,
        truncatedGames,
        decisiveRate: total > 0 ? decisiveGames / total : 0,
        noSeatBeatGames,
        // episodeCount is the resume seed-cursor (== decisiveGames + truncatedGames); the env-server
        // reads it after restore() to continue the seed sequence instead of replaying from 0.
        episodeCount,
        // refreshSkips: cumulative snapshots skipped on a producer-GC race (should stay near 0).
        refreshSkips,
      };
    },

    /**
     * Serialize the league's mutable state to a plain-JSON checkpoint (B6) — the counters, the
     * win-rate book (via `store.toJSON()`), and the snapshot pool as `{id, step, weightsPath}` (NOT
     * the `fn`, which `restore()` rebuilds by re-importing the weights). No `Map`/`Set`/function leaks,
     * so `JSON.stringify` round-trips it losslessly. The env-server writes this atomically at the
     * episode boundary; a relaunched env-server feeds it back through `restore()`. The pool is emitted
     * in its CURRENT array order (NOT re-sorted) because `draw()`'s PFSP weighting is pool-index-
     * parallel and global step-monotonicity across restarts is not guaranteed.
     *
     * @returns {object} a JSON-serializable checkpoint (see `restore`).
     */
    toJSON() {
      return {
        version: STATE_SCHEMA_VERSION,
        encodingVersion: ENCODING_VERSION,
        fingerprint,
        decisiveGames,
        truncatedGames,
        episodeCount, // resume seed-cursor (task E) — see the counter declaration above
        refreshSkips, // cumulative GC-race skips (carried across restarts for a true run-total)
        noSeatBeatGames,
        warnedNoSeatBeat,
        storeKind: store.kind, // restore() rejects a backend switch — see the store-kind gate there
        book: store.toJSON(), // in-memory → entry copies; shared-disk → null (book lives in shards)
        pool: pool.map(s => ({ id: s.id, step: s.step, weightsPath: s.weightsPath })),
        loadedIds: [...loadedIds], // superset of pool ids (includes since-evicted ones)
      };
    },

    /**
     * Restore from a `toJSON()` checkpoint (B6) — the resume path for Task-E's idempotent
     * checkpoint/resume. Every cheap gate fires BEFORE any mutation or `import`, so a bad payload can
     * never half-apply. Must be a closure method (not an external helper) because it reassigns the
     * league's `let` counters and the captured `manifestMtimeMs`. Idempotent: re-restoring the same
     * state clears + reassigns, never accumulates.
     *
     * Gates, in order: (1) known `version`; (2) `encodingVersion` ∈ SUPPORTED_ENCODING_VERSIONS — fail loud on
     * skew before importing anything (a mid-run encoding bump makes pooled snapshots unloadable, [D-23]);
     * (3) `fingerprint` matches this league's config (drifted sampler/pool-cap args ⇒ divergent draws);
     * (4) `storeKind` matches this league's store — a checkpoint written by a `disk` store carries
     * `book: null` (the book lives in shards), so blindly restoring it into an in-memory store (or vice
     * versa) would silently zero the win-rate book and collapse the PFSP sampler to cold-start.
     *
     * **Atomic.** All re-imports happen into a LOCAL pool first (the only throw source past the gates);
     * the league's counters, book, pool, and `manifestMtimeMs` are mutated only AFTER every snapshot
     * loaded, so a bad payload leaves the league fully unmutated rather than half-applied. The reset
     * `manifestMtimeMs = -1` forces the next `refresh()` to re-poll (picking up snapshots published
     * between checkpoint and crash). A weights file FIFO-evicted/unlinked since the checkpoint (import
     * throws `ENOENT`/`ERR_MODULE_NOT_FOUND`) is WARN-skipped but its id is KEPT in `loadedIds`, so a
     * later `refresh()` never re-imports the deleted file and its book record is preserved. Any OTHER
     * import error — a missing `BC_POLICY` export (a truncated/corrupt snapshot, which would otherwise
     * fall through to `makeBC`'s default and silently load the shipped BC), or a per-snapshot encoding
     * skew — throws. Idempotent: re-restoring the same state replaces, never accumulates.
     *
     * @param {object} state a payload from `toJSON()` (post-`JSON.parse`).
     * @returns {Promise<{restoredPool:number, droppedPool:number, bookSize:number}>} a resume summary.
     */
    async restore(state) {
      if (!state || state.version !== STATE_SCHEMA_VERSION) {
        throw new Error(
          `ppo-league.restore: unknown checkpoint version ${state?.version} (expected ${STATE_SCHEMA_VERSION}).`
        );
      }
      // Deliberately LENIENT (any stamp in the SUPPORTED set): the JS side follows the [D-31]
      // inference rule that older, narrower nets stay loadable. The STRICT per-run invariant —
      // the encoding is frozen for the whole campaign — is owned by ml/dicewars_ppo/resume_state.py
      // on the Python side; a refactor must not remove both halves.
      if (!SUPPORTED_ENCODING_VERSIONS.includes(state.encodingVersion)) {
        throw new Error(
          `ppo-league.restore: checkpoint encodingVersion ${state.encodingVersion} not in supported ` +
            `set [${SUPPORTED_ENCODING_VERSIONS.join(', ')}]. The run must freeze its encoding — ` +
            `re-export the snapshots / start a fresh run against a supported encoding.`
        );
      }
      const fp = state.fingerprint;
      const fpOk =
        fp &&
        fp.count === fingerprint.count &&
        fp.learnerSeat === fingerprint.learnerSeat &&
        fp.poolCap === fingerprint.poolCap &&
        fp.reserveBaselines === fingerprint.reserveBaselines &&
        fp.pfspEpsilon === fingerprint.pfspEpsilon &&
        fp.pfspK === fingerprint.pfspK &&
        Array.isArray(fp.baselineIds) &&
        fp.baselineIds.length === fingerprint.baselineIds.length &&
        fp.baselineIds.every((id, i) => id === fingerprint.baselineIds[i]);
      if (!fpOk) {
        throw new Error(
          `ppo-league.restore: checkpoint fingerprint ${JSON.stringify(fp)} != this league's ` +
            `${JSON.stringify(fingerprint)}. A resume must use the same league config (count/learnerSeat/` +
            `poolCap/reserveBaselines/pfspEpsilon/pfspK/opponents) — sampling and eviction would diverge.`
        );
      }
      if (state.storeKind !== store.kind) {
        throw new Error(
          `ppo-league.restore: checkpoint storeKind "${state.storeKind}" != this league's store ` +
            `"${store.kind}". The win-rate book is serialized differently per backend — a backend ` +
            `switch on resume would silently zero the book. Relaunch with the same --snapshot-store.`
        );
      }

      /*
       * Rebuild the pool into a LOCAL first — the only throw source past the gates — so the league stays
       * fully unmutated if a snapshot fails to load (atomic restore). Serialized array order is preserved
       * (NOT re-sorted): draw()'s PFSP weighting is pool-index-parallel.
       */
      const nextPool = [];
      let droppedPool = 0;
      for (const snap of state.pool ?? []) {
        let mod;
        try {
          mod = await import(pathToFileURL(snap.weightsPath).href);
        } catch (err) {
          if (
            (err.code === 'ENOENT' || err.code === 'ERR_MODULE_NOT_FOUND') &&
            !existsSync(snap.weightsPath)
          ) {
            // FIFO-evicted/unlinked since the checkpoint — keep the id in loadedIds (below) so a later
            // refresh() never re-imports the deleted file; the book record stays credited. The
            // `!existsSync` guard mirrors refresh(): only a file that is GENUINELY GONE is dropped. A
            // PRESENT-but-broken module (a missing transitive import / a corrupt artifact raising
            // ERR_MODULE_NOT_FOUND) falls through to the rethrow below — a real bug must not be masked
            // as a benign "weights gone" drop, and the two import paths must not diverge if the
            // snapshot artifact format ever gains an import.
            droppedPool++;
            process.stderr.write(
              `[ppo-league] restore: snapshot ${snap.id} weights gone (${snap.weightsPath}); ` +
                `dropped from the live pool, id retained.\n`
            );
            continue;
          }
          throw err; // present-but-broken artifact, or any non-missing-file import error — fail loud
        }
        if (!mod.BC_POLICY) {
          // A parseable module with no BC_POLICY export would fall through to makeBC's default param and
          // silently load the SHIPPED BC as this snapshot — a corrupt/truncated artifact masquerading as
          // a trained policy. Reject it instead of swapping identities under the hood.
          throw new Error(
            `ppo-league.restore: snapshot ${snap.id} (${snap.weightsPath}) exports no BC_POLICY — ` +
              `corrupt/truncated weights module.`
          );
        }
        nextPool.push({
          id: snap.id,
          step: snap.step,
          fn: makeBC({ policy: mod.BC_POLICY }), // re-checks encodingVersion per snapshot
          weightsPath: snap.weightsPath,
        });
      }

      // All gates passed and every snapshot loaded — apply (no throw past here).
      store.restore(state.book);
      decisiveGames = state.decisiveGames ?? 0;
      truncatedGames = state.truncatedGames ?? 0;
      // The resume seed-cursor (task E). A v2 payload always carries `episodeCount` (the version gate
      // above rejects anything else), so the `??` only matters if that gate is ever loosened — it then
      // falls back to the cursor's own invariant (== decisiveGames + truncatedGames), never a wrong
      // value, so resume still skips exactly the already-played seeds. Defensive, consistent with the
      // surrounding `?? 0` reads.
      episodeCount = state.episodeCount ?? decisiveGames + truncatedGames;
      refreshSkips = state.refreshSkips ?? 0;
      noSeatBeatGames = state.noSeatBeatGames ?? 0;
      warnedNoSeatBeat = state.warnedNoSeatBeat ?? false;
      manifestMtimeMs = -1; // never trust a persisted mtime — force a fresh manifest re-poll
      pool.length = 0;
      pool.push(...nextPool);
      loadedIds.clear();
      for (const id of state.loadedIds ?? []) loadedIds.add(id);
      return { restoredPool: pool.length, droppedPool, bookSize: store.size() };
    },
  };
}
