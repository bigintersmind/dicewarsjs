/**
 * Pure logic for the Phase-3 PPO headline gate — kept out of the CLI so it is unit
 * testable without spinning up an arena.
 *
 * The gate (PLAN step 7 / the phase evaluation gate): a candidate policy must beat
 * `ai_lookahead` on `arena:sweep` **win%** with a **statistically significant**
 * edge, seat/turn-order controlled. We measure both bots in the *same* games over
 * the same seed blocks, so the per-run difference is **paired** — a far tighter
 * test of "is the candidate actually ahead" than comparing two independent CIs.
 * Judge on win%, never ELO (ELO rewards survival/placement; see RESULTS.md).
 *
 * @module scripts/lib/ppo-gate-core
 */

import { meanCi } from './stats.mjs';

/**
 * The bar the gate is measured against (pinned per [D-7]). The in-repo
 *  `ai_lookahead` differs from this SHA only in comments (verified), so it is the
 *  behavioral bar — RESULTS.md already treats it as `@596f781`.
 */
export const LOOKAHEAD_PIN = '596f781';

/**
 * Default display name for the gate candidate. Must NOT collide with any
 * `BUILT_IN_BOTS` name: since PR #74 seated `ai_ppo` ("PPO") in the gate field as
 * the strength baseline (an arrangement [D-27] kept), the old default of 'PPO' made
 * a bare `npm run ppo:gate` throw at field construction. Pinned against the real
 * registry by `tests/scripts/ppoGateCore.test.js`.
 */
export const DEFAULT_CANDIDATE_NAME = 'Candidate';

/**
 * Mean + 95% CI of the per-run paired difference `a[i] - b[i]`.
 *
 * @param {number[]} a - candidate per-run win% (one entry per seed block)
 * @param {number[]} b - bar (Lookahead) per-run win%, same blocks/order
 * @returns {{ mean: number, ci: number, lo: number, hi: number }}
 */
export function pairedDelta(a, b) {
  if (a.length !== b.length) {
    throw new Error(`pairedDelta: length mismatch (${a.length} vs ${b.length})`);
  }
  if (a.length < 2) {
    throw new Error('pairedDelta: need >= 2 runs for a confidence interval');
  }
  const diffs = a.map((v, i) => v - b[i]);
  const { mean, ci } = meanCi(diffs);
  return { mean, ci, lo: mean - ci, hi: mean + ci };
}

/**
 * Classify the gate outcome from a paired-delta CI.
 *
 * - `BEAT`   — the whole 95% CI is above 0 → a significant win% edge (gate PASSES).
 * - `BEHIND` — the whole 95% CI is below 0 → significantly worse than the bar.
 * - `TIE`    — the CI straddles 0 → no significant edge either way.
 *
 * @param {{ lo: number, hi: number }} delta - from {@link pairedDelta}
 * @returns {'BEAT'|'TIE'|'BEHIND'}
 */
export function classifyGate({ lo, hi }) {
  if (lo > 0) return 'BEAT';
  if (hi < 0) return 'BEHIND';
  return 'TIE';
}

/** Minimum match attempts before the failure-rate abort can trip (need a trend first). */
export const ABORT_MIN_ATTEMPTS = 5;

/**
 * Whether the gate should abort mid-sweep because matches are failing en masse.
 *
 * True once enough matches have been *attempted* (>= {@link ABORT_MIN_ATTEMPTS}) AND
 * more than half of those attempts threw. The denominator is real attempts
 * (successes + failures), NOT successes — a successes-only count stays pinned when
 * every match in a run fails, which would let a catastrophic run slip past the guard
 * and push a NaN win% into the verdict (`classifyGate` would then read NaN as a TIE).
 *
 * @param {number} failed - matches that threw so far (cumulative across the sweep)
 * @param {number} attempts - matches tried so far, success or fail (cumulative)
 * @returns {boolean}
 */
export function shouldAbort(failed, attempts) {
  return attempts >= ABORT_MIN_ATTEMPTS && failed / attempts > 0.5;
}

/** Human-readable one-liner for a gate verdict. */
export function verdictLine(verdict, delta) {
  const d = `${delta.mean >= 0 ? '+' : ''}${delta.mean.toFixed(1)} ± ${delta.ci.toFixed(1)} pp`;
  switch (verdict) {
    case 'BEAT':
      return `✅ BEAT — candidate is significantly ahead of the bar (Δwin% ${d}, CI above 0). Gate PASSES.`;
    case 'BEHIND':
      return `❌ BEHIND — candidate is significantly behind the bar (Δwin% ${d}, CI below 0).`;
    default:
      return `~ TIE — no significant win% edge (Δwin% ${d}, CI spans 0). Gate is OPEN.`;
  }
}

/**
 * Build the gate field: the built-in heuristic + PPO bots with the BC clone and the
 * shippable personas dropped, plus the candidate in its place. Dropping `ai_bc` (a
 * near-identical clone) and the `persona`-tagged bots (Conqueror/Blitz/Survivor — these
 * are challengers measured AGAINST the field, not part of it) keeps the field at 8 seats
 * (one full FFA table), so the documented gate baselines stay fixed as personas are added.
 *
 * When `barFn` is given (the PERSONAS §10.7 Wave-0 `Name=weights.js` bar loader), the
 * bar is an EXTRA seat appended to the base field — the head-to-head bars that are not
 * built-ins (the [D-31] §4 primary bar vs `ppo-scratch-long`, the ship bar vs a persona)
 * become runnable. Note the extra seat makes it a 9-baseline field: absolute win% is not
 * comparable to 8-baseline rows, only the paired candidate−bar Δ is the judged statistic.
 *
 * @param {Array<{ name: string, fn: Function }>} builtInBots - BUILT_IN_BOTS
 * @param {Function} candidateFn - the candidate move fn (makeBC result)
 * @param {string} candidateName - display name (e.g. 'Candidate'; must not collide
 *   with a built-in name — 'PPO' is taken by the seated baseline since [D-27])
 * @param {string} [barName='Lookahead'] - the bar's display name; asserted present
 *   in the built-in field unless `barFn` seats it explicitly
 * @param {Function} [barFn] - a loaded bar policy's move fn; seats `barName` as an
 *   extra field seat instead of requiring a built-in
 * @returns {Array<{ name: string, fn: Function }>}
 */
export function buildGateField(
  builtInBots,
  candidateFn,
  candidateName,
  barName = 'Lookahead',
  barFn = undefined
) {
  const base = builtInBots
    .filter(b => b.name !== 'BC' && !b.persona)
    .map(b => ({ name: b.name, fn: b.fn }));
  if (barFn) {
    if (base.some(b => b.name === barName)) {
      throw new Error(
        `loaded bar name "${barName}" collides with a built-in bot — pick a distinct name`
      );
    }
    base.push({ name: barName, fn: barFn });
  } else if (!base.some(b => b.name === barName)) {
    throw new Error(`gate bar "${barName}" missing from the built-in field`);
  }
  if (base.some(b => b.name === candidateName)) {
    throw new Error(`candidate name "${candidateName}" collides with a field bot`);
  }
  return [...base, { name: candidateName, fn: candidateFn }];
}

/**
 * Counterbalanced seat assignment: seat `s` (0..N-1) is occupied by
 * `field[(s - r + N) % N]` under rotation `r`. Replaying one seed through all N
 * rotations puts every bot in every seat exactly once, so seat/territory advantage
 * (MapGenerator assigns territory by seat index) cancels — the "seat-fair" the gate
 * requires. Mirrors `scripts/_baseline.mjs`'s rotation (the established Phase-0 gate
 * methodology), so the PPO gate is measured the same way the shipped bots were.
 *
 * @template T
 * @param {T[]} field - the bots in field order
 * @param {number} r - rotation index (0..field.length-1)
 * @returns {T[]} the rotated seating
 */
export function rotatedField(field, r) {
  const n = field.length;
  const out = new Array(n);
  for (let s = 0; s < n; s++) out[s] = field[(((s - r) % n) + n) % n];
  return out;
}

/**
 * Derive the sweep's per-run game plan from the field size and the requested
 * per-run game budget. `gamesPerRun` is rounded to whole rotation sets
 * (`seedsPerRun × fieldSize`) — e.g. the default 150 on the 9-seat field gives
 * 17 seeds × 9 = 153 games/run. `stride` spaces the per-run seed blocks so runs
 * never share seeds (the [D-29] scorer also relies on it staying a pure function
 * of `(fieldSize, gamesPerRun)`: constant knobs ⇒ identical seeds ⇒ per-run
 * samples pairable across checkpoints).
 *
 * @param {number} fieldSize - number of seats (bots) in the field
 * @param {number} gamesPerRun - requested games per run (pre-rounding)
 * @returns {{ seedsPerRun: number, gamesPerRunActual: number, stride: number }}
 */
export function sweepPlan(fieldSize, gamesPerRun) {
  const seedsPerRun = Math.max(1, Math.round(gamesPerRun / fieldSize));
  const gamesPerRunActual = seedsPerRun * fieldSize;
  const stride = Math.max(1_000_000, gamesPerRunActual * 1000);
  return { seedsPerRun, gamesPerRunActual, stride };
}

/**
 * The seat-fair gate sweep, extracted from `ppo-gate.mjs` per [D-29] so the
 * strength-curve scorer can drive the identical orchestration (same seed
 * formula, same rotation order, same abort semantics) without forking the
 * gate's methodology. Runs `runs` independent seed blocks; each block replays
 * `seedsPerRun` maps through all `field.length` seat rotations
 * ({@link rotatedField}), and tallies per-run win% / mean placement /
 * attack-win-rate for every name in `tallyNames` from the same games.
 *
 * Failure semantics — THROWS instead of `process.exit` (callers decide
 * fatality), preserving the CLI's guards:
 * - mass failure ({@link shouldAbort}: >50% of attempted matches threw, past
 *   the {@link ABORT_MIN_ATTEMPTS} floor) → throw;
 * - a run that completed zero games (win% would be NaN, which `classifyGate`
 *   silently reads as TIE) → throw;
 * - an individual match throw under those thresholds → counted, reported via
 *   `onMatchError`, and skipped.
 *
 * `matchFn` is required rather than defaulted so this module keeps its "pure
 * logic, no arena import" property (its unit tests run zero games) — pass
 * `runMatch` from `src/arena/matchRunner.js`.
 *
 * Async, yielding the event loop between runs: a default-budget sweep is
 * minutes of otherwise-synchronous game crunching, which would starve signal
 * handlers (the curve scorer's Ctrl-C) and timers until the whole sweep ends.
 *
 * @param {object} args
 * @param {Array<{ name: string, fn: Function }>} args.field - from {@link buildGateField}
 * @param {Function} args.matchFn - `({ bots, seed }) => MatchResult` (i.e. `runMatch`)
 * @param {number} args.runs - independent seed blocks (>= 1; >= 2 for any CI)
 * @param {number} args.gamesPerRun - per-run game budget (see {@link sweepPlan})
 * @param {number} [args.seedBase=0] - seed-block offset; hold constant for pairable runs
 * @param {string[]} args.tallyNames - field names to tally (candidate + references)
 * @param {(done: number, total: number) => void} [args.onRunComplete]
 * @param {(info: { seed: number, rotation: number, error: Error }) => void} [args.onMatchError]
 * @returns {Promise<{
 *   perRun: Record<string, { winPct: number[], avgPlacement: number[], attackWinRate: number[] }>,
 *   errorTotals: Record<string, { errors: number, invalidMoves: number, turns: number, attacks: number }>,
 *   games: number, failedGames: number, attempts: number,
 *   seedsPerRun: number, gamesPerRunActual: number, stride: number
 * }>}
 */
export async function runGateSweep({
  field,
  matchFn,
  runs,
  gamesPerRun,
  seedBase = 0,
  tallyNames,
  onRunComplete,
  onMatchError,
}) {
  if (typeof matchFn !== 'function') throw new Error('runGateSweep: matchFn is required');
  if (!Number.isFinite(runs) || runs < 1) throw new Error('runGateSweep: runs must be >= 1');
  if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) {
    throw new Error('runGateSweep: gamesPerRun must be >= 1');
  }
  /*
   * A NaN seedBase would flow into every seed as NaN, which the engine RNG
   * coerces (>>> 0) to seed 0 — every "independent" run silently replaying the
   * same map, yielding a plausible-looking but statistically bogus verdict.
   */
  if (!Number.isFinite(seedBase)) throw new Error('runGateSweep: seedBase must be a finite number');
  if (!Array.isArray(tallyNames) || tallyNames.length === 0) {
    throw new Error('runGateSweep: tallyNames must be a non-empty array');
  }
  const fieldNames = new Set(field.map(b => b.name));
  for (const t of tallyNames) {
    if (!fieldNames.has(t)) {
      throw new Error(
        `runGateSweep: tally name "${t}" is not in the field ` +
          `(${field.map(b => b.name).join(', ')}) — references must be tallied IN-field, never seated`
      );
    }
  }

  const N = field.length;
  const { seedsPerRun, gamesPerRunActual, stride } = sweepPlan(N, gamesPerRun);

  const perRun = {};
  for (const t of tallyNames) perRun[t] = { winPct: [], avgPlacement: [], attackWinRate: [] };
  /*
   * Sweep-wide forced-end totals per tallied name, for the broken-candidate check the CLI
   * runs before trusting the verdict (#92 item 5). The gate is judged purely on win%, so a
   * runtime-broken candidate (e.g. a makeBC registration / coordinate-space bug the static
   * parity check can't catch) wins ~0 games and reads as a legit 0% BEHIND — indistinguishable
   * from a weak-but-working policy. These totals let the caller hand the candidate to
   * reportBotErrors and print "broken", not just "behind".
   */
  const errorTotals = {};
  for (const t of tallyNames) {
    errorTotals[t] = { errors: 0, invalidMoves: 0, turns: 0, attacks: 0 };
  }
  let failedGames = 0;
  let attempts = 0; // every match tried (success or fail) — the abort denominator
  let games = 0;

  for (let run = 0; run < runs; run++) {
    const tally = {};
    for (const t of tallyNames) tally[t] = { wins: 0, placementSum: 0, attacks: 0, attackWins: 0 };
    let runGames = 0;
    for (let s = 0; s < seedsPerRun; s++) {
      const seed = (seedBase + run) * stride + s + 1;
      for (let r = 0; r < N; r++) {
        attempts++;
        let res;
        try {
          res = matchFn({ bots: rotatedField(field, r), seed });
        } catch (err) {
          failedGames++;
          /*
           * Count real attempts, not successes: a run whose every match throws leaves
           * `runGames` at 0, so a successes-based denominator would pin the abort and
           * let a catastrophic sweep through to a NaN verdict.
           */
          if (shouldAbort(failedGames, attempts)) {
            throw new Error(`${failedGames}/${attempts} matches failed (>50%).`);
          }
          onMatchError?.({ seed, rotation: r, error: err });
          continue;
        }
        runGames++;
        games++;
        for (const t of tallyNames) {
          const rec = tally[t];
          if (res.winnerName === t) rec.wins++;
          const stat = res.botStats.find(b => b.name === t);
          if (!stat)
            throw new Error(`runGateSweep: tallied bot "${t}" missing from match botStats`);
          rec.placementSum += stat.placement;
          rec.attacks += stat.attacksMade;
          rec.attackWins += stat.attacksWon;
          const et = errorTotals[t];
          et.errors += stat.errors;
          et.invalidMoves += stat.invalidMoves;
          et.turns += stat.turns;
          et.attacks += stat.attacksMade;
        }
      }
    }
    /*
     * A run with zero completed games (every match failed but stayed under the abort
     * threshold) would make win% = 0/0 = NaN, which classifyGate silently reads as a
     * TIE. Fail loud instead of grading a broken run.
     */
    if (runGames === 0) {
      throw new Error(
        `run ${run + 1} completed 0 of ${gamesPerRunActual} attempted games ` +
          `— win% (and the verdict) would be NaN.`
      );
    }
    for (const t of tallyNames) {
      const rec = tally[t];
      perRun[t].winPct.push((rec.wins / runGames) * 100);
      perRun[t].avgPlacement.push(rec.placementSum / runGames);
      perRun[t].attackWinRate.push(rec.attacks > 0 ? rec.attackWins / rec.attacks : 0);
    }
    onRunComplete?.(run + 1, runs);
    // Yield between runs so signals/timers can fire during a minutes-long sweep.
    await new Promise(resolve => {
      setImmediate(resolve);
    });
  }

  return {
    perRun,
    errorTotals,
    games,
    failedGames,
    attempts,
    seedsPerRun,
    gamesPerRunActual,
    stride,
  };
}

/**
 * The actionable "no weights yet" message — the exact commands that produce
 * `src/ai/ppoPolicyWeights.js` from a trained PPO checkpoint.
 * @param {string} weightsPath
 * @returns {string}
 */
export function missingWeightsHelp(weightsPath) {
  return [
    `No PPO weights at ${weightsPath}. Produce them from a trained PPO checkpoint first:`,
    '',
    '  1. (shodan / a box with torch+sb3-contrib) run the PPO tracer → repacked BC-format .pt:',
    '       python -m dicewars_ppo.train_tracer \\',
    '         --checkpoint checkpoints/v2-base/bc_model.pt --out checkpoints/ppo-tracer.pt',
    '',
    '  2. (a box with torch) export the repacked checkpoint to JS weights + parity fixture:',
    '       npm run ppo:export',
    '       # = python -m dicewars_bc.export_weights --ckpt checkpoints/ppo-tracer.pt \\',
    '       #     --out ../src/ai/ppoPolicyWeights.js --fixture ../tests/fixtures/bc/ppoForwardCases.json',
    '',
    '  3. (here) re-run the gate:  npm run ppo:gate',
  ].join('\n');
}
