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
 *     new self-play snapshot via `makeBC` (fresh filename per snapshot → ESM URL cache), FIFO-evict
 *     past `poolCap`, GC the evicted `.js`. B3 only *loads* the pool — `draw()` does not seat it yet.
 *   - **B4** — PFSP weighting **on**: when the pool is non-empty, `draw(seed)` seeds a `mulberry32`
 *     sampler and seats `count − R` snapshots drawn by `w(S) = max(ε, 1 − learnerWinRate(S))^k`
 *     (lower learner win-rate → higher weight) plus `R` reserved aggressive baselines (the [D-15]
 *     turtle-equilibrium defense), then shuffles opponent→seat so neither group binds to fixed
 *     turn-order seats. **Empty pool still returns the byte-identical task-A field** (fixed-field
 *     stays the empty-pool mode of this one pipeline). Persistence (B6) extends the same object.
 *
 * @module scripts/lib/ppo-league
 */

import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeBC } from '../../src/ai/ai_bc.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { ENCODING_VERSION } from '../../src/arena/encodeObservation.js';
import { mulberry32 } from './mulberry32.mjs';

/*
 * `makeBC` (snapshot loader, B3) and `ENCODING_VERSION` (manifest compat gate) are imported
 * statically with no extra load cost: the ~2 MB `bcPolicyWeights.js` `makeBC` pulls in is already
 * loaded eagerly via the `BUILT_IN_BOTS` import below (→ `ai_bc.js` → `bcPolicyWeights.js`), and
 * `ENCODING_VERSION` rides the far lighter `encodeObservation.js`.
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
 * @param {number} [opts.poolCap=40] max snapshots kept live (sampleable) and on disk (B3). FIFO-by-
 *   step eviction keeps the most recent/hardest snapshots ([D-23]) and `unlinkSync`s the evicted
 *   `.js`, so this bounds DISK and the sampleable set. It does NOT bound process memory: Node's ESM
 *   module registry retains every dynamic-`import()`ed snapshot module for the process lifetime (each
 *   fresh filename is a distinct, permanently-cached module), so resident weights grow with the total
 *   number of snapshots ever loaded, not `poolCap`. Modest at realistic cadences (~2 MB each); if a
 *   long run needs a hard memory bound, load weights without `import()` caching (B5 concern).
 * @param {number} [opts.reserveBaselines=3] **R** — aggressive baselines reserved in every drawn
 *   field while the pool is non-empty (the [D-15] turtle-equilibrium defense). The reserve pool is
 *   the DISTINCT baseline ids minus `ai_bc` (the STOP/turtle lineage); reserved seats are sampled
 *   WITHOUT replacement, so at most `min(R, count, #distinctReserveBaselines)` seats are reserved and
 *   the remainder go to PFSP snapshots ([D-23]). 0 disables reservation. Empty-pool mode ignores it.
 * @param {number} [opts.pfspEpsilon=0.05] **ε** — the PFSP weight floor in `w(S)=max(ε,1−winRate)^k`.
 *   Must be in (0, 1]: ε>0 floors every snapshot weight at ε^k > 0 (a fully-mastered snapshot is still
 *   drawn occasionally) for any sane k. (At a pathological k, ε^k can underflow to 0.0 in floating
 *   point; `draw()` then falls back to uniform sampling so the wheel still selects.) Empty pool ignores it.
 * @param {number} [opts.pfspK=2] **k** — the PFSP weight exponent in `w(S)=max(ε,1−winRate)^k`.
 *   Must be ≥ 0; higher k sharpens the bias toward snapshots that beat the learner (k=0 → uniform).
 *   Empty-pool mode ignores it.
 * @returns {{draw: Function, recordResult: Function, winRate: Function, refresh: Function,
 *   stats: Function}}
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
   * `draw()` hands out this same array reference every episode, so freeze it (and its entries):
   * a future in-place reorder/mutation throws loudly under ESM strict mode instead of silently
   * poisoning every later draw. Near-zero cost — the fns are shared from BUILT_IN_BOTS anyway.
   */
  baselineField.forEach(entry => Object.freeze(entry));
  Object.freeze(baselineField);

  let decisiveGames = 0;
  let truncatedGames = 0;
  /*
   * Win-rate book (B2): stable opponent id → the LEARNER's pairwise record against it. `wins` is the
   * count of decisive games in which the learner outplaced that opponent; `games` the decisive games
   * the opponent appeared in (a cycled baseline seated twice in one game contributes two records).
   * Keyed on the stable id, never the `uniquifyNames` `#N` display name. B4 samples snapshots by
   * `w(S) = max(ε, 1 − winRate(S))^k`, so a lower learner-win-rate (an opponent that beats the
   * learner) earns a higher weight. maxTurns truncations are excluded (see recordResult).
   */
  const book = new Map();
  // One-shot guard so a broken-contract decisive game (no seatBeat[]) warns once, not per-episode.
  let warnedNoSeatBeat = false;

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
  const learnerWinRate = id => {
    const rec = book.get(id);
    return rec && rec.games > 0 ? rec.wins / rec.games : 0;
  };

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
     *   1. up to `min(R, count, #reserveBaselinePool)` aggressive baselines, sampled WITHOUT
     *      replacement (distinct aggressive opponents — the [D-15] turtle defense), then
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

      // (1) Reserved aggressive baselines — at most as many distinct ones as exist, no replacement.
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
         * B4's PFSP sampler quietly collapse to ~uniform). Warn ONCE so the regression is visible.
         */
        if (!warnedNoSeatBeat) {
          warnedNoSeatBeat = true;
          process.stderr.write(
            '[ppo-league] decisive game had no seatBeat[] — win-rate book not credited; check the ' +
              'runSelfPlayEpisode/runMatch placement contract.\n'
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
        let rec = book.get(d.id);
        if (!rec) {
          rec = { wins: 0, games: 0 };
          book.set(d.id, rec);
        }
        rec.games++;
        rec.wins += beat;
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
     * serves a stale module), wraps it with `makeBC({ policy })`, and FIFO-evicts past `poolCap`,
     * GC-ing the evicted snapshot's `.js` file (the manifest still lists it, but `loadedIds` stops it
     * being re-imported — restart recovery is a B6 concern). `draw()` does not sample the pool until
     * B4, so in B3 this only grows `poolSize`; episode outcomes are unchanged.
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
      if (manifest.encodingVersion !== ENCODING_VERSION) {
        throw new Error(
          `ppo-league.refresh: snapshot manifest encodingVersion ${manifest.encodingVersion} != ` +
            `encoder ENCODING_VERSION ${ENCODING_VERSION} (${snapshotManifest}). The run must freeze ` +
            `ENCODING_VERSION — re-export the snapshots against the current encoding.`
        );
      }

      const dir = dirname(snapshotManifest);
      const fresh = (manifest.snapshots ?? [])
        .filter(s => !loadedIds.has(s.id))
        .sort((a, b) => a.step - b.step); // ascending step → push order == FIFO eviction order

      let added = 0;
      for (const snap of fresh) {
        const weightsPath = resolve(dir, snap.weights);
        const mod = await import(pathToFileURL(weightsPath).href);
        const fn = makeBC({ policy: mod.BC_POLICY }); // re-checks encodingVersion per snapshot
        pool.push({ id: snap.id, step: snap.step, fn, weightsPath });
        loadedIds.add(snap.id);
        added++;
      }

      /*
       * FIFO eviction: keep the most recent `poolCap` sampleable and `unlinkSync` the evicted `.js`
       * (D-23 disk retention — the fresh-filename rule would otherwise grow disk forever). This bounds
       * DISK and the sampleable set, NOT process memory: the dynamic-`import()`ed module stays in
       * Node's ESM registry for the process lifetime, so dropping the `fn` here does not free the
       * ~2 MB weights (see the `poolCap` JSDoc note).
       */
      while (pool.length > poolCap) {
        const evicted = pool.shift();
        try {
          unlinkSync(evicted.weightsPath);
        } catch {
          /* already gone / shared / read-only — best-effort GC, never fail a refresh on it */
        }
      }

      manifestMtimeMs = stat.mtimeMs; // commit only after a clean load, so a throw retries next poll
      return { added, poolSize: pool.length };
    },

    /**
     * League health snapshot. The env-server emits this on its `PPO_ENV_SERVER DONE` line (the B5
     * throughput/decisive-rate re-probe reads it; until B4 wires the book into `draw()` it is the
     * only external window onto the win-rate book). `decisiveGames` counts every booked decisive
     * episode incl. zero-decision skips, so `decisiveGames > <wire terminals>` evidences the B2
     * "book before the zero-decision wire gate" reordering.
     */
    stats() {
      const total = decisiveGames + truncatedGames;
      return {
        poolSize: pool.length,
        loadedSnapshots: loadedIds.size,
        bookSize: book.size,
        decisiveGames,
        truncatedGames,
        decisiveRate: total > 0 ? decisiveGames / total : 0,
      };
    },
  };
}
