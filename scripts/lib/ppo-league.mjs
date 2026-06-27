/**
 * PFSP opponent league for the PPO env-server (ml-bot Phase 3, task B — [D-22]).
 *
 * The env-server draws its per-episode opponent field from this league instead of a
 * static const. The league will own the opponent pool (built-in baselines + hot-loaded
 * self-play snapshots), a seeded sampler, and a per-opponent win-rate book — but step
 * **B1** ships only the empty-pool baselines (no snapshots, sampler, or win-rate book yet).
 *
 * **Fixed-field (task A) is the empty-pool degenerate mode of this module:** with no
 * snapshots, `draw()` returns exactly the cycled baseline field the env-server used
 * before — content-identical (same names + fn refs), so task A's outcomes reproduce.
 * This file (step **B1**)
 * ships that empty-pool path plus a decisive/truncated telemetry tally; **step B2 adds the
 * per-opponent win-rate book** (`recordResult` crediting + `winRate(id)`); **step B3 adds the
 * snapshot pool + `refresh()`** — poll the producer's `manifest.json`, hot-load each new self-play
 * snapshot via `makeBC` (fresh filename per snapshot → ESM URL cache), FIFO-evict past `poolCap` and
 * GC the evicted `.js`. PFSP weighting (B4, samples the pool in `draw()`) and persistence (B6) extend
 * the same object. See docs/ml-bot/DECISIONS.md D-23 for the full B0–B6 build sequence (D-22 for the
 * league architecture + the win-rate-attribution decision).
 *
 * @module scripts/lib/ppo-league
 */

import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

/*
 * `makeBC` + `ENCODING_VERSION` are dynamic-imported inside `refresh()` purely for code locality —
 * they are only referenced once a real manifest exists. This defers no LOAD cost: the ~2 MB
 * `bcPolicyWeights.js` is already pulled in eagerly at the top of this module via `BUILT_IN_BOTS`
 * (→ `ai_bc.js` → `bcPolicyWeights.js`), and the env-server imports `BC_POLICY` directly too, so the
 * `import()` below just hits the module cache. (`ENCODING_VERSION` comes from the far lighter
 * `encodeObservation.js`, also already loaded.) The B1/B2 unit tests pay the weights cost regardless.
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
 * (`recordResult` pairwise crediting + `winRate(id)`); later steps extend the returned object
 * (B3 `refresh`/`addSnapshot`, B4 PFSP `w(S)=max(ε,1−learnerWinRate(S))^k` weighting, B6
 * `toJSON`/`restore`).
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
 *   long run needs a hard memory bound, load weights without `import()` caching (B4/B5 concern).
 * @returns {{draw: Function, recordResult: Function, winRate: Function, refresh: Function,
 *   stats: Function}}
 */
export function makeLeague({
  baselineCsv,
  count,
  learnerSeat,
  snapshotManifest = null,
  poolCap = 40,
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
  const baselineField = resolveBaselineField(baselineCsv, count);
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

  return {
    /*
     * Draw the per-episode opponent field. B1: the pool is empty, so this is the cycled baseline
     * field — identical for every seed (the episode outcome depends on the ordered fns × the seed,
     * which the env-server passes to `runSelfPlayEpisode` separately). B4 adds snapshot seats
     * sampled by `w(S) = max(ε, 1 - learnerWinRate(S))^k`, reserving R aggressive baselines per game.
     */
    draw(seed) {
      void seed; // unused until B4 (empty-pool draw is deterministic); kept for API stability.
      return {
        opponents: baselineField,
        drawn: baselineField.map((bot, i) => ({ id: bot.id, kind: 'baseline', seat: seatOf(i) })),
      };
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
      const rec = book.get(id);
      return rec && rec.games > 0 ? rec.wins / rec.games : 0;
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
      /*
       * Pull in makeBC/ENCODING_VERSION here for code locality — both are already module-cached
       * (loaded eagerly via the top-of-file BUILT_IN_BOTS import; see the note there).
       */
      const [{ makeBC }, { ENCODING_VERSION }] = await Promise.all([
        import('../../src/ai/ai_bc.js'),
        import('../../src/arena/encodeObservation.js'),
      ]);
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
