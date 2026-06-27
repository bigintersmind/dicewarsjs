/**
 * PFSP opponent league for the PPO env-server (ml-bot Phase 3, task B — [D-22]).
 *
 * The env-server draws its per-episode opponent field from this league instead of a
 * static const. The league owns the opponent pool (built-in baselines + hot-loaded
 * self-play snapshots), a seeded sampler, and a per-opponent win-rate book.
 *
 * **Fixed-field (task A) is the empty-pool degenerate mode of this module:** with no
 * snapshots, `draw()` returns exactly the cycled baseline field the env-server used
 * before — byte-identical, so task A's outcomes reproduce. This file (step **B1**)
 * ships that empty-pool path plus a decisive/truncated telemetry tally; the snapshot
 * pipeline (B3), PFSP weighting (B4), and persistence (B6) extend the same object.
 * See docs/ml-bot/DECISIONS.md D-22 for the full build sequence.
 *
 * @module scripts/lib/ppo-league
 */

import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';

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
 * Construct a league. Step **B1** ships the empty-pool path (== task A's fixed field)
 * plus a decisive/truncated telemetry tally; later steps extend the returned object
 * (B3 `refresh`/`addSnapshot`, B4 PFSP `winRate` weighting, B6 `toJSON`/`restore`).
 *
 * @param {object} opts
 * @param {string} opts.baselineCsv the resolved `--opponents` CSV. The trainer passes
 *   `DEFAULT_OPPONENTS`; the env-server's own default is `ai_bc`. Threaded in (NOT a
 *   hardcoded default) so the empty-pool field equals the launch's actual field _[D-22]_.
 * @param {number} opts.count opponent seats per game (= playerCount - 1); `draw()` always
 *   returns exactly this many (holds player_count constant, [D-22]).
 * @param {number} opts.learnerSeat the learner's seat; used to map an opponent's array
 *   index to its seat for the (B2) win-rate attribution.
 * @returns {{draw: Function, recordResult: Function, stats: Function}}
 */
export function makeLeague({ baselineCsv, count, learnerSeat }) {
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
  const baselineField = resolveBaselineField(baselineCsv, count);

  let decisiveGames = 0;
  let truncatedGames = 0;

  /*
   * Opponent-array index → seat: the learner sits at `learnerSeat`; opponents fill the remaining
   * seats in order (mirrors the seat-fill in ppo-env.mjs). Computed here so B2's win-rate
   * attribution reads `drawn[k].seat` instead of reverse-engineering the `#N`-mangled roster names.
   */
  const seatOf = k => (k < learnerSeat ? k : k + 1);

  return {
    /*
     * Draw the per-episode opponent field. B1: the pool is empty, so this is the cycled baseline
     * field — identical for every seed (the episode outcome depends on the ordered fns × the seed,
     * which the env-server passes to `runSelfPlayEpisode` separately). B4 adds snapshot seats
     * sampled by `w(S) = max(ε, 1 - winRate(S))^k`, reserving R aggressive baselines per game.
     */
    draw(seed) {
      void seed; // unused until B4 (empty-pool draw is deterministic); kept for API stability.
      return {
        opponents: baselineField,
        drawn: baselineField.map((bot, i) => ({ id: bot.id, kind: 'baseline', seat: seatOf(i) })),
      };
    },

    /*
     * Tally the episode outcome. B1: telemetry only — count decisive vs maxTurns-truncated games
     * (the [D-22] decisive-rate health metric). B2 adds per-opponent pairwise win-rate attribution
     * via a per-seat `seatBeat[]` vector keyed on `drawn[k].id`, EXCLUDING truncations.
     */
    recordResult(drawn, result) {
      if (result.truncated) truncatedGames++;
      else decisiveGames++;
    },

    /** League health snapshot (the throughput/decisive-rate re-probe in B5 reads this). */
    stats() {
      const total = decisiveGames + truncatedGames;
      return {
        poolSize: 0,
        decisiveGames,
        truncatedGames,
        decisiveRate: total > 0 ? decisiveGames / total : 0,
      };
    },
  };
}
