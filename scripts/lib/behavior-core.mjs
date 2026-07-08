/**
 * Pure logic for the behavioral-eval harness — kept out of the CLI so it is unit
 * testable without spinning up an arena. The harness answers "is this bot DIFFERENT,
 * and how?" (paired Δ on behavioral axes vs a control) as the complement to
 * `ppo:gate`'s "is it STRONGER?" (paired Δwin% vs Lookahead). See
 * `docs/ml-bot/EVAL_HARNESS.md` for the full spec.
 *
 * This file: the metric extraction + aggregation + control comparison, the pre-registered
 * signature gate (`signatureDetail`/`signaturePass` over PERSONA_SIGNATURES), and the CLI
 * spec/MDE parsing (`parseBotSpec`/`parseMdeOverrides`). All runnable today; the only thing
 * still pending is the persona *weight files* the CLI points at (see PERSONA_SIGNATURES below).
 *
 * Design notes that the spec's review pinned down (do not regress):
 *   - Active turns are counted from `onTurn` firings attributed to the profiled seat,
 *     which INCLUDE the victory turn — so aggression is NOT biased upward on won games
 *     (counting STOP steps would miss the victory turn, which emits none). Relies on the
 *     `onTurn(turnNumber, state, actingPlayerId)` engine signal.
 *   - Kills are credited to the acting player of the turn during which an opponent's
 *     `eliminated` flag flips — O(1) live, no second replay pass.
 *   - meanCi's n is the RUN count, not the game count: CI width is driven by between-run
 *     variance / √runs. Aggregate per-game → per-run scalar → meanCi across runs.
 *
 * @module scripts/lib/behavior-core
 */

import { meanCi, meanSe, tSf, holmAdjust } from './stats.mjs';
import { pairedDelta, classifyGate } from './ppo-gate-core.mjs';
import { isStopMove } from '../../src/arena/trajectoryExport.js';
import { DEFAULT_MAX_TURNS } from '../../src/arena/matchRunner.js';

/**
 * PERSONAS §10.4 "the clock cuts both ways" — near-cap windows for the clock-hack monitor.
 * Both are in PLAYER-TURNS, the unit of `runMatch`'s `turnCount`/`maxTurns` and the `onTurn`
 * `turnNumber` (a game truncates at `turnCount >= maxTurns`, default {@link DEFAULT_MAX_TURNS}=500).
 *
 * - `NEAR_CAP_WINDOW` — a self-elimination in the last this-many turns before the cap counts as a
 *   "near-cap death" (§10.4's "dying at rank 2–4 to bank ~0.5 rather than truncating to 0").
 * - `LATE_WINDOW` — the bot's own turns at `turn >= maxTurns - LATE_WINDOW` are the "late-game"
 *   window whose aggression is compared to the game's own baseline (the "late-game-aggression spike").
 *
 * 50 ≈ 10% of the 500-turn cap (≈ 7 rounds in a 7-player game). Drafted 2026-07-05 for Ivan's
 * ratification alongside the §10.4 tripwire thresholds (see {@link CLOCK_HACK_TRIPWIRES}).
 */
export const NEAR_CAP_WINDOW = 50;
export const LATE_WINDOW = 50;

/**
 * @typedef {Object} GameCapture
 * Per-game accumulator filled by the live `onTurn`/`onStep` handlers from {@link makeCapture}.
 * @property {number}   playerIndex   - the profiled seat this capture follows
 * @property {number}   activeTurns   - count of the profiled bot's own completed turns (incl. a win)
 * @property {number[]} territory     - territoryCount at the end of each of the bot's own turns
 * @property {number[]} dice          - diceCount at the end of each of the bot's own turns
 * @property {number[]} largestGroup  - largestGroup at the end of each of the bot's own turns
 * @property {number}   kills         - opponents the bot eliminated (last-territory capture)
 * @property {Array<{victimTerr:number|null, victimOneTerrTurns:number|null}>} killVictims - §10.3
 *   scavenge co-read: one entry per kill, the victim's state as of the END of the player-turn
 *   immediately before the killing blow — territory count, and consecutive observed player-turns
 *   spent at exactly 1 territory (a vulture snipes long-doomed 1-territory players; a hunter takes
 *   multi-territory players down itself). Both null for a kill on the game's first observed turn
 *   (no prior observation — practically unreachable on real maps). Read the pair JOINTLY: a victim
 *   a THIRD PARTY softened to 1 the turn before reads victimTerr 1 with a LOW streak (not vulture
 *   prey), and the streak counts turns across ALL live seats, so its raw magnitude scales with
 *   field size (the paired Δ on an identical field cancels this).
 * @property {number|null} eliminatedAtTurn - turn the bot was itself eliminated, or null if it survived
 * @property {number}   zeroAttackTurns  - the bot's own turns that ended with 0 attacks (pass turns)
 * @property {Array<{turn:number, attacks:number}>} attacksByTurn - per own-turn attack count keyed by
 *   the turn's `turnNumber` (player-turn index) — the raw signal for the §10.4 late-game-aggression spike
 * @property {number}   _sinceStop    - internal: attacks since the bot's last STOP (do not read)
 * @property {number}   _ownAttacks   - internal: cumulative own attacks across the game (do not read)
 * @property {number}   _lastOwnTurnAttackTotal - internal: `_ownAttacks` at the previous own turn (do not read)
 * @property {Set<number>} _seenEliminated - internal: players already counted as eliminated
 * @property {Map<number, number>} _lastSeenTerr - internal: per-player territoryCount as of the
 *   last observed post-turn state (do not read)
 * @property {Map<number, number>} _oneTerrStreak - internal: per-player consecutive observed
 *   player-turns at exactly 1 territory (do not read)
 */

/**
 * Build a per-game capture plus the `onTurn`/`onStep` handlers to wire into `runMatch`.
 * Pure: no arena import, so it is unit-tested by feeding synthetic callback calls.
 *
 * @param {number} playerIndex - the seat to profile
 * @returns {{ capture: GameCapture, onTurn: Function, onStep: Function }}
 */
export function makeCapture(playerIndex) {
  const capture = {
    playerIndex,
    activeTurns: 0,
    territory: [],
    dice: [],
    largestGroup: [],
    kills: 0,
    killVictims: [],
    eliminatedAtTurn: null,
    zeroAttackTurns: 0,
    attacksByTurn: [],
    _sinceStop: 0,
    _ownAttacks: 0,
    _lastOwnTurnAttackTotal: 0,
    _seenEliminated: new Set(),
    _lastSeenTerr: new Map(),
    _oneTerrStreak: new Map(),
  };

  // Fires after every player-turn with the post-turn state and the acting player.
  const onTurn = (turnNumber, state, actingPlayerId) => {
    // Credit any NEW eliminations this turn to the acting player; record the bot's own death.
    for (const p of state.players) {
      if (!p.eliminated || capture._seenEliminated.has(p.id)) continue;
      capture._seenEliminated.add(p.id);
      if (p.id === playerIndex) {
        capture.eliminatedAtTurn = turnNumber;
      } else if (actingPlayerId === playerIndex) {
        capture.kills += 1;
        // §10.3 scavenge co-read: the victim as of the END of the previous player-turn — read
        // BEFORE the tracker ingest below, so a bot that softened the victim itself this turn
        // still reads the pre-turn count, and the post-kill 0 is never what's recorded. A kill
        // with no prior observation (the game's first observed turn) records nulls.
        capture.killVictims.push({
          victimTerr: capture._lastSeenTerr.get(p.id) ?? null,
          victimOneTerrTurns: capture._oneTerrStreak.get(p.id) ?? null,
        });
      }
    }
    // §10.3 victim trackers ingest the current post-turn state (all live seats, every firing).
    for (const p of state.players) {
      if (p.eliminated) continue;
      capture._lastSeenTerr.set(p.id, p.territoryCount);
      capture._oneTerrStreak.set(
        p.id,
        p.territoryCount === 1 ? (capture._oneTerrStreak.get(p.id) ?? 0) + 1 : 0
      );
    }
    // Board-shape snapshots are taken at the END of the bot's OWN turns ("what it holds").
    if (actingPlayerId === playerIndex) {
      capture.activeTurns += 1;
      const me = state.players[playerIndex];
      capture.territory.push(me.territoryCount);
      capture.dice.push(me.diceCount);
      capture.largestGroup.push(me.largestGroup);
      // Attacks THIS turn = the cumulative-own-attacks delta since the previous own turn. `onStep`'s
      // STOP resets `_sinceStop`, and `onTurn` fires AFTER that reset, so the per-turn count is
      // diffed off the monotonic `_ownAttacks` counter (which survives the STOP) instead.
      capture.attacksByTurn.push({
        turn: turnNumber,
        attacks: capture._ownAttacks - capture._lastOwnTurnAttackTotal,
      });
      capture._lastOwnTurnAttackTotal = capture._ownAttacks;
    }
  };

  // Fires per applied ATTACK and once per turn-end STOP (the victory turn emits no STOP).
  const onStep = step => {
    if (step.playerId !== playerIndex) return;
    if (isStopMove(step.chosenMove)) {
      if (capture._sinceStop === 0) capture.zeroAttackTurns += 1;
      capture._sinceStop = 0;
    } else {
      capture._sinceStop += 1;
      capture._ownAttacks += 1;
    }
  };

  return { capture, onTurn, onStep };
}

/** Mean of an array, or null for an empty array (so empty never poisons an average). */
const meanOrNull = xs => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * @typedef {Object} GameProfile - per-game behavioral scalars for one bot. `null` where
 *   undefined for this game (e.g. turnsToWin when the bot did not win).
 */

/**
 * Reduce a finished match + its capture to per-game behavioral scalars for the profiled seat.
 *
 * @param {import('../../src/arena/matchRunner.js').MatchResult} result
 * @param {number} playerIndex
 * @param {GameCapture} capture
 * @param {number} [maxTurns=DEFAULT_MAX_TURNS] - the game's truncation cap (player-turns); the §10.4
 *   near-cap signals are measured relative to it. Must match the `maxTurns` passed to `runMatch`.
 * @returns {GameProfile}
 */
export function profileGameFromCapture(result, playerIndex, capture, maxTurns = DEFAULT_MAX_TURNS) {
  const stat = result.botStats.find(b => b.playerIndex === playerIndex);
  if (!stat) throw new Error(`profileGameFromCapture: no botStats for seat ${playerIndex}`);
  if (capture.playerIndex !== playerIndex) {
    throw new Error(
      `profileGameFromCapture: capture seat ${capture.playerIndex} != ${playerIndex}`
    );
  }

  const won = result.winner === playerIndex;
  const { attacksMade, attacksWon } = stat;
  const at = capture.activeTurns;

  // The three board-shape arrays AND `attacksByTurn` are all pushed together once per the bot's own
  // turn, so each must have exactly `activeTurns` entries. Assert it: a drift would index past the
  // end (e.g. dice[i] === undefined ⇒ NaN), and NaN slips past every `!= null` guard downstream and
  // reads as a TIE/SAME verdict rather than erroring. Fail loud here instead, per the file's contract.
  if (
    capture.territory.length !== at ||
    capture.dice.length !== at ||
    capture.largestGroup.length !== at ||
    capture.attacksByTurn.length !== at
  ) {
    throw new Error(
      `profileGameFromCapture: misaligned capture arrays for seat ${playerIndex} ` +
        `(activeTurns=${at}, territory=${capture.territory.length}, ` +
        `dice=${capture.dice.length}, largestGroup=${capture.largestGroup.length}, ` +
        `attacksByTurn=${capture.attacksByTurn.length})`
    );
  }

  // §10.3 scavenge co-read: every kill pushes exactly one killVictims entry, so a missing field
  // or a count mismatch is a capture-contract drift — fail loud like the array misalignment
  // above, and on the FIRST profiled game (a lenient default would only surface mid-sweep on the
  // first game with a kill).
  const { killVictims } = capture;
  if (!Array.isArray(killVictims) || killVictims.length !== capture.kills) {
    throw new Error(
      `profileGameFromCapture: misaligned capture killVictims for seat ${playerIndex} ` +
        `(kills=${capture.kills}, killVictims=${Array.isArray(killVictims) ? killVictims.length : 'missing'})`
    );
  }
  // Per-kill victim context, unobserved (null) victims excluded — a no-kill game (or an
  // all-unobserved one) yields null, the turnsToWin-style sparsity, never a diluting 0.
  const victimField = field => killVictims.map(k => k[field]).filter(v => Number.isFinite(v));
  // The derived kill-steal rate shares killVictimTerr's observed-victim base, so the same
  // exclusions apply to its numerator AND denominator.
  const victimTerrs = victimField('victimTerr');

  // Per-turn dice density, then averaged below: a mean of per-turn (dice/territory) ratios — NOT
  // aggregate totalDice/totalTerritory. Both are defensible; this one weights each turn equally.
  const dicePerTerritory = capture.territory.map((t, i) => (t > 0 ? capture.dice[i] / t : 0));

  // --- §10.4 clock-hack signals (the placement-arm near-cap reward hazard) ---
  // A game truncates when the loop exits at `turnCount >= maxTurns` with no winner (`winner === null`).
  const truncated = result.winner === null ? 1 : 0;
  // "Forcing a decisive end": the bot lets ITSELF be eliminated in the final NEAR_CAP_WINDOW turns
  // before the cap (banking rank 2–4 ≈ 0.5 rather than truncating to 0). 0/1 → reduced to a rate.
  const nearCapDeath =
    capture.eliminatedAtTurn != null && capture.eliminatedAtTurn >= maxTurns - NEAR_CAP_WINDOW
      ? 1
      : 0;
  // Late-game aggression spike: mean attacks/turn in the last LATE_WINDOW turns MINUS the game's own
  // per-turn mean. null (not 0) when the game never reached the late window — the hazard only exists
  // in games that approach the cap, so short games contribute no signal rather than a diluting 0.
  const lateTurns = capture.attacksByTurn.filter(t => t.turn >= maxTurns - LATE_WINDOW);
  const lateGameAggressionSpike =
    lateTurns.length === 0
      ? null
      : lateTurns.reduce((s, t) => s + t.attacks, 0) / lateTurns.length -
        capture.attacksByTurn.reduce((s, t) => s + t.attacks, 0) / at;

  return {
    won,
    placement: stat.placement,
    turnsToWin: won ? result.turnCount : null,
    attacksMade,
    aggression: at > 0 ? attacksMade / at : null,
    captureEfficiency: attacksMade > 0 ? attacksWon / attacksMade : null,
    avgDiceReserve: meanOrNull(capture.dice),
    avgTerritory: meanOrNull(capture.territory),
    dicePerTerritory: meanOrNull(dicePerTerritory),
    largestGroup: meanOrNull(capture.largestGroup),
    kills: capture.kills,
    // Survived to game end ⇒ survival time is the full game length.
    survivalTurn: capture.eliminatedAtTurn ?? result.turnCount,
    zeroAttackTurnFrac: at > 0 ? capture.zeroAttackTurns / at : null,
    truncated,
    nearCapDeath,
    lateGameAggressionSpike,
    killVictimTerr: meanOrNull(victimTerrs),
    killVictimOneTerrTurns: meanOrNull(victimField('victimOneTerrTurns')),
    // §10.3 derived "kill-steal rate": the fraction of this game's OBSERVED kill victims that
    // entered the killing turn at exactly 1 territory — the mean of a per-victim indicator, so
    // meanOrNull carries the same no-observed-victims ⇒ null (never 0/0) sparsity as the sibling
    // axes. A per-GAME scalar like every axis (reduceRun then game-weights kill-carrying games,
    // NOT victim-pools the run) — the same aggregation both comparison sides get.
    killVictimOneTerrFrac: meanOrNull(victimTerrs.map(t => (t === 1 ? 1 : 0))),
  };
}

/** The behavioral axes, in display order. Each maps a GameProfile field to a per-run scalar. */
export const AXES = [
  'winPct',
  'aggression',
  'captureEfficiency',
  'avgDiceReserve',
  'avgTerritory',
  'dicePerTerritory',
  'largestGroup',
  'kills',
  'turnsToWin',
  'survivalTurn',
  'zeroAttackTurnFrac',
  'avgPlacement',
  // §10.4 clock-hack cluster — descriptive/tripwire axes (NOT persona signatures, so absent from
  // PERSONA_SIGNATURES/SIGNATURE_AXES). Gated by {@link CLOCK_HACK_TRIPWIRES}, not the Holm family.
  'truncationRate',
  'nearCapDeathRate',
  'lateGameAggressionSpike',
  // §10.3 scavenge co-read cluster — per-kill victim context (the vulture-hack guard for the
  // Predator arms). Like the §10.4 cluster it is absent from PERSONA_SIGNATURES/SIGNATURE_AXES/
  // SEPARATION_AXES/Holm and gated by its own tripwire panel instead ({@link SCAVENGE_TRIPWIRES}
  // — the mechanical, pre-committed §10.8 Predator kill condition; reconciled ruling 2026-07-06,
  // superseding the earlier descriptive-only call). Units: territories, player-turns at exactly
  // 1 territory before the kill, and the fraction of observed victims at exactly 1 territory.
  'killVictimTerr',
  'killVictimOneTerrTurns',
  'killVictimOneTerrFrac',
];

/**
 * Reduce a run's per-game profiles (post-quarantine) to one scalar per axis. Winners-only
 * and other partial axes yield `null` for the run when no game contributes (handled by the
 * paired-comparison's null-alignment, never silently dropped on one side only).
 *
 * @param {GameProfile[]} profiles - the games in one seed block
 * @returns {Record<string, number|null>}
 */
export function reduceRun(profiles) {
  if (profiles.length === 0) throw new Error('reduceRun: empty run');
  // Number.isFinite (not `!= null`) so a stray NaN/Infinity is dropped like missing data rather
  // than averaged in — a non-finite scalar must never survive to read as a real measurement.
  const defined = (field, filter = () => true) =>
    meanOrNull(
      profiles
        .filter(filter)
        .map(p => p[field])
        .filter(v => Number.isFinite(v))
    );

  return {
    winPct: meanOrNull(profiles.map(p => (p.won ? 100 : 0))),
    aggression: defined('aggression'),
    captureEfficiency: defined('captureEfficiency'),
    avgDiceReserve: defined('avgDiceReserve'),
    avgTerritory: defined('avgTerritory'),
    dicePerTerritory: defined('dicePerTerritory'),
    largestGroup: defined('largestGroup'),
    kills: defined('kills'),
    turnsToWin: defined('turnsToWin', p => p.won), // null when the bot won nothing this run
    survivalTurn: defined('survivalTurn'),
    zeroAttackTurnFrac: defined('zeroAttackTurnFrac'),
    avgPlacement: defined('placement'),
    // §10.4: truncated/nearCapDeath are 0/1 on EVERY game ⇒ full-sample rates; the spike is
    // populated only for games that reached the late window (null on short games — regardless of
    // win/loss — dropped by `defined`'s finite filter).
    truncationRate: defined('truncated'),
    nearCapDeathRate: defined('nearCapDeath'),
    lateGameAggressionSpike: defined('lateGameAggressionSpike'),
    // §10.3: populated only for games where the bot killed an observed victim (null otherwise,
    // dropped by `defined`'s finite filter — a no-kill game must not dilute the mean).
    killVictimTerr: defined('killVictimTerr'),
    killVictimOneTerrTurns: defined('killVictimOneTerrTurns'),
    killVictimOneTerrFrac: defined('killVictimOneTerrFrac'),
  };
}

/** Mean ± 95% CI of a run array, ignoring null/non-finite runs. Returns null if < 1 finite run. */
export function summarizeAxis(perRunValues) {
  const vals = perRunValues.filter(v => Number.isFinite(v));
  if (vals.length === 0) return null;
  if (vals.length === 1) return { mean: vals[0], ci: null, n: 1 };
  return { ...meanCi(vals), n: vals.length };
}

/**
 * Whether a reduced run (from {@link reduceRun}) carries behavioral data. A fully-quarantined run is
 * `nullRun()` with `winPct === null`; a live run always has a numeric winPct (0 if it never won). So
 * `!= null` — NOT falsy — is the correct test: a genuine 0%-win run is live data, not "no data". This
 * is the sentinel the sweep's live-run count and {@link summarizeAaSample} key on (a 0/null mix-up
 * would read a real 0%-win arm as an unrun control).
 *
 * @param {Record<string, number|null>} run
 * @returns {boolean}
 */
export const isLiveRun = run => run.winPct != null;

/**
 * Drop run indices where EITHER side is null or non-finite, keeping the two arrays aligned (so
 * `pairedDelta`'s positional pairing stays valid). Returns the filtered pair + kept count. Treating
 * a NaN/Infinity as a dropped index (not a paired value) keeps it out of `pairedDelta`, where it
 * would otherwise produce a NaN CI that `classifyGate` reads as a bogus SAME at full n.
 *
 * @param {Array<number|null>} a
 * @param {Array<number|null>} b
 * @returns {{ a: number[], b: number[], n: number }}
 */
export function alignDropNull(a, b) {
  if (a.length !== b.length) {
    throw new Error(`alignDropNull: length mismatch (${a.length} vs ${b.length})`);
  }
  const ao = [];
  const bo = [];
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    ao.push(a[i]);
    bo.push(b[i]);
  }
  return { a: ao, b: bo, n: ao.length };
}

/**
 * Paired persona − control comparison on one axis over matched seed blocks. Null runs are
 * dropped from both sides first (§3.4). Returns null when fewer than 2 paired runs remain
 * (pairedDelta needs ≥ 2), so a sparse winners-only axis degrades gracefully.
 *
 * @param {Array<number|null>} personaRuns
 * @param {Array<number|null>} controlRuns
 * @returns {{ delta:number, ci:number, lo:number, hi:number, se:number, verdict:'HIGHER'|'SAME'|'LOWER', n:number } | null}
 */
export function compareAxis(personaRuns, controlRuns) {
  const { a, b, n } = alignDropNull(personaRuns, controlRuns);
  if (n < 2) return null;
  const d = pairedDelta(a, b); // { mean, ci, lo, hi }
  // Paired standard error of the same diffs — what signatureDetail turns into a t statistic
  // for the Holm-adjusted family (§3.3). Same numbers pairedDelta already used for the CI.
  const { se } = meanSe(a.map((v, i) => v - b[i]));
  // classifyGate speaks BEAT/TIE/BEHIND; relabel to the direction-neutral HIGHER/SAME/LOWER.
  const verdict = { BEAT: 'HIGHER', BEHIND: 'LOWER', TIE: 'SAME' }[classifyGate(d)];
  // Expose the paired mean as `delta` (the spec's field name; what signaturePass/CLI read).
  return { delta: d.mean, ci: d.ci, lo: d.lo, hi: d.hi, se, verdict, n };
}

/**
 * Compare every axis of a persona's per-run scalars against the control's.
 *
 * @param {Array<Record<string, number|null>>} personaRuns - reduceRun() output per run
 * @param {Array<Record<string, number|null>>} controlRuns - same, for the control, SAME seed blocks
 * @returns {Record<string, ReturnType<typeof compareAxis>>}
 */
export function compareToControl(personaRuns, controlRuns) {
  const out = {};
  for (const axis of AXES) {
    out[axis] = compareAxis(
      personaRuns.map(r => r[axis]),
      controlRuns.map(r => r[axis])
    );
  }
  return out;
}

/**
 * One-sided p-value that the paired self-difference on one axis lies BEYOND the ±tol floor, in the
 * observed direction — the per-axis test whose Holm-corrected family drives the BIASED verdict in
 * {@link signatureNoiseFloor}.
 *
 * A degenerate zero paired SE (identical diffs across every kept run — reachable on quantized axes at
 * small n) has no t statistic and its CI collapses to the point Δ; judging |Δ| against tol there is
 * exactly the raw point test the equivalence criterion exists to avoid. So cap the evidence at the
 * sign-agreement permutation bound 2⁻ⁿ (never 0), mirroring {@link oneSidedP}: n identical
 * beyond-tol diffs carry at most P(all n agree | symmetric null) = 2⁻ⁿ — so a collapsed CI can't
 * masquerade as a tight interval beyond the floor, yet the bound still tightens as n grows (8
 * identical beyond-tol diffs → 2⁻⁸ ≈ 0.004, Holm-significant; 3 → 2⁻³ = 0.125, not).
 */
function pBeyondFloor(cmp, tol) {
  const excess = Math.abs(cmp.delta) - tol;
  if (cmp.se === 0) return excess > 0 ? 2 ** -cmp.n : 1;
  return tSf(excess / cmp.se, cmp.n - 1);
}

/**
 * Negative control 1 (PERSONAS §10.5): an A/A self-comparison — the SAME policy profiled twice at
 * the SAME seeds — must show |Δ| < MDE/`divisor` on every registered {@link SIGNATURE_AXES}, or the
 * profiling harness has a bias (or is underpowered) and persona grading must HALT. The registered
 * `divisor` is 3: the harness's own noise floor on a signature axis must sit comfortably (3×) below
 * the smallest effect that axis's signature claims to detect, else an effect measured at exactly its
 * MDE could be mostly harness noise. Only signature axes gate — descriptive axes carry more of that
 * noise and are never the halt criterion.
 *
 * The two arms share map seeds, so the paired Δ CANCELS map variance and isolates the residual noise
 * the paired signature gate itself can't cancel — the heuristic opponents' unseeded Math.random (the
 * same "unseeded-opponent" noise NC2's test-retest measures on the strength metric). A same-policy
 * A/A therefore has E[Δ] = 0; each realized Δ is a random draw of that residual noise, and
 * {@link compareAxis}'s paired CI narrows at feasible run counts (a disjoint-seed A/A would re-inject
 * full map variance).
 *
 * Criterion — the registered "|Δ| < MDE/divisor" made statistically sound (EVAL_HARNESS §3.6/§3.9
 * "As built"). Two refinements keep a *stochastic* A/A from crying wolf while still catching a real
 * (systematic) harness bug:
 *   1. Equivalence, not a raw point test. Judging |Δ| against the floor false-halts a winners-only,
 *      high-variance axis (turnsToWin's per-run swings ≫ tol at feasible run counts even when the
 *      TRUE self-difference is 0). So an axis CERTIFIES only when its paired 95% CI ⊆ (−tol, +tol).
 *   2. Holm-corrected BIASED. Declaring bias from one stochastic A/A is a hypothesis test; run
 *      per-axis at the CI's ~5% it false-fires ~1-in-11 across the five signature axes, and it
 *      DEGENERATES back to the point test (1) removed when a small-n CI collapses (identical
 *      quantized diffs → SE 0 → zero-width CI). So BIASED requires a Holm-significant (family-wise
 *      `alpha`) "self-difference beyond ±tol" p-value ({@link pBeyondFloor}, which caps a zero-SE CI
 *      at the 2⁻ⁿ sign-agreement bound, never 0). A systematic bug's Δ has a t that grows with n and
 *      survives Holm; sampling noise does not.
 *   • CERTIFIED  — CI ⊆ (−tol, +tol): the true self-difference is provably within the floor.
 *   • BIASED     — Holm-significant beyond-±tol evidence → this axis HALTS the batch.
 *   • INCONCLUSIVE — neither: no Holm-significant bias, but too thin to certify ("add runs").
 * Only BIASED halts (`pass` = no BIASED axis); INCONCLUSIVE / NO DATA never halt — a thin A/A must
 * never read as a clean bill (`certified` = every axis CERTIFIED). The family-wise false-HALT rate is
 * ≤ `alpha` and → 0 as runs grow, so a true-null A/A CLEARs with high probability — NOT a guaranteed
 * CLEAR, which is why the exit-2 CLI path is exercised by a deterministic probe failure, not the A/A.
 * `divisor` (registered 3): the floor sits 3× below the smallest effect a signature claims, so an
 * effect at exactly its MDE can't be mostly harness noise.
 *
 * @param {Array<Record<string,number|null>>} armA - reduceRun() per run, arm A (the base's pass 1)
 * @param {Array<Record<string,number|null>>} armB - the SAME policy's pass 2 over the SAME seeds
 * @param {Record<string,number>} mde - per-axis absolute MDEs (DEFAULT_MDE + any --mde overrides)
 * @param {{ divisor?:number, axes?:string[], alpha?:number }} [opts]
 * @returns {{ pass:boolean, certified:boolean, divisor:number, alpha:number, axes:Array<object>, biased:string[], inconclusive:string[], noData:string[] }}
 */
export function signatureNoiseFloor(
  armA,
  armB,
  mde,
  { divisor = 3, axes = SIGNATURE_AXES, alpha = 0.05 } = {}
) {
  const rows = axes.map(axis => {
    const base = mde[axis];
    if (base == null) {
      throw new Error(`signatureNoiseFloor: no MDE registered for signature axis "${axis}".`);
    }
    const tol = base / divisor;
    const cmp = compareAxis(
      armA.map(r => r[axis]),
      armB.map(r => r[axis])
    );
    return { axis, tol, cmp };
  });
  // Holm step-down over the "self-difference beyond ±tol" tests — one per signature axis, the
  // registered family size (a NO-DATA axis stays in the family as a null p and can never reject), so
  // a single stochastic A/A can't false-HALT above the family-wise `alpha` (§3.9 "As built").
  const holm = new Map(
    holmAdjust(
      rows.map(({ axis, tol, cmp }) => ({
        name: axis,
        p: cmp == null ? null : pBeyondFloor(cmp, tol),
      })),
      { alpha, familySize: axes.length }
    ).map(h => [h.name, h])
  );
  const results = rows.map(({ axis, tol, cmp }) => {
    if (cmp == null) {
      // Fewer than 2 paired runs (both arms null, or a winners-only axis too sparse). Unmeasured —
      // not evidence of bias, but not certifiable either: reported as NO DATA, does not halt.
      return { axis, delta: null, ci: null, lo: null, hi: null, n: 0, tol, verdict: 'NO DATA' };
    }
    const { delta, ci, lo, hi, n } = cmp;
    let verdict;
    if (holm.get(axis).reject)
      verdict = 'BIASED'; // Holm-significant beyond-±tol self-difference: a real harness bug
    else if (lo > -tol && hi < tol)
      verdict = 'CERTIFIED'; // CI ⊆ (−tol, tol): floor certified clean
    else verdict = 'INCONCLUSIVE'; // neither: no Holm-significant bias, just too thin to certify
    return { axis, delta, ci, lo, hi, n, tol, verdict };
  });
  return {
    pass: results.every(r => r.verdict !== 'BIASED'),
    certified: results.every(r => r.verdict === 'CERTIFIED'),
    divisor,
    alpha,
    axes: results,
    biased: results.filter(r => r.verdict === 'BIASED').map(r => r.axis),
    inconclusive: results.filter(r => r.verdict === 'INCONCLUSIVE').map(r => r.axis),
    noData: results.filter(r => r.verdict === 'NO DATA').map(r => r.axis),
  };
}

/**
 * Reduce an A/A pair to its sample-health flags for the launch pre-flight (behavior-preflight.mjs).
 * The A/A is a valid negative control ONLY if two things hold, and each fails in a way that would
 * otherwise read as a clean bill:
 *   - **Enough games survived quarantine** to form a paired CI on ≥ 1 signature axis. A base that
 *     LOADS + parity-checks but then force-ends its games (engine error / illegal move / move-cap)
 *     has them quarantined ({@link isForcedEnd}), collapsing every arm to `nullRun()` ⇒ every axis
 *     NO DATA ⇒ `signatureNoiseFloor.pass === true`. Left unguarded, the pre-flight exits 0
 *     "CLEAR (uncertified)" on exactly the broken harness it exists to catch. `insufficient` flags it.
 *   - **The field actually injected opponent noise.** The A/A's two arms diverge only via the
 *     heuristic opponents' unseeded `Math.random`; a deterministic `--opponents` field makes arm A ≡
 *     arm B ⇒ every signature axis a zero-width CI ⇒ trivially CERTIFIED — the *strongest* "cleared"
 *     message on a control that measured nothing. `zeroNoise` flags it (a warning, not a halt: a
 *     genuinely deterministic field is a footgun, not a proven failure).
 *
 * Pure: consumes only the two sweep results (`sweepBot` already returns `played`/`quarantined`) and
 * the NC1 verdict, so it is unit-tested without an arena. The CLI turns `insufficient` into a HALT
 * and `zeroNoise` into a loud caveat.
 *
 * @param {{ perRun: Array<Record<string,number|null>>, played:number, quarantined:number }} armA
 * @param {{ perRun: Array<Record<string,number|null>>, played:number, quarantined:number }} armB
 * @param {ReturnType<typeof signatureNoiseFloor>} nc1 - the NC1 verdict over these same two arms
 * @param {{ minLiveRuns?: number }} [opts] - live-run floor for a paired CI (compareAxis needs 2)
 * @returns {{ playedA:number, quarantinedA:number, liveRunsA:number, playedB:number,
 *   quarantinedB:number, liveRunsB:number, insufficient:boolean, zeroNoise:boolean }}
 */
export function summarizeAaSample(armA, armB, nc1, { minLiveRuns = 2 } = {}) {
  const liveRunsA = armA.perRun.filter(isLiveRun).length;
  const liveRunsB = armB.perRun.filter(isLiveRun).length;
  // A MEASURED axis (not NO DATA) whose CI is exactly 0 has paired SE 0 — identical diffs across every
  // kept run, i.e. the field produced no divergence between the two passes. If EVERY measured axis is
  // like that (and there is ≥ 1), the A/A saw no opponent noise and its CERTIFIED verdicts are vacuous.
  const measured = nc1.axes.filter(a => a.verdict !== 'NO DATA');
  return {
    playedA: armA.played,
    quarantinedA: armA.quarantined,
    liveRunsA,
    playedB: armB.played,
    quarantinedB: armB.quarantined,
    liveRunsB,
    // The control could not run: either arm has < 2 live paired runs, OR not one signature axis
    // yielded a comparison (every axis NO DATA). Both mean the noise floor is unmeasured, not clean.
    insufficient: Math.min(liveRunsA, liveRunsB) < minLiveRuns || measured.length === 0,
    zeroNoise: measured.length > 0 && measured.every(a => a.ci === 0),
  };
}

/**
 * One-sided p-value of a paired axis comparison in the REGISTERED direction: P(T ≥ t) for
 * 'HIGHER', P(T ≤ t) for 'LOWER', with t = delta/se at df = n − 1. A zero paired SE (identical
 * diffs across every run — reachable on quantized axes at small kept-n) has no t statistic;
 * fall back to the sign-flip permutation bound: n identical in-direction diffs carry at most
 * P(all n signs agree | null) = 2⁻ⁿ of evidence, never certainty — so p = 2⁻ⁿ in-direction
 * (a p = 0 here would clear every Holm threshold even at n = 2, where the attainable bound is
 * 0.25), and p = 1 for anything else.
 */
function oneSidedP(cmp, direction) {
  if (cmp.se === 0) {
    const inDir = direction === 'HIGHER' ? cmp.delta > 0 : cmp.delta < 0;
    return inDir ? 2 ** -cmp.n : 1;
  }
  const t = cmp.delta / cmp.se;
  // P(T ≤ t) = P(T ≥ −t) by symmetry, so both directions go through the upper tail.
  return direction === 'HIGHER' ? tSf(t, cmp.n - 1) : tSf(-t, cmp.n - 1);
}

/**
 * Per-axis breakdown of a persona's pre-registered signature: for each required axis, whether
 * it clears its minimum-detectable-effect (|Δ| ≥ MDE) AND is significant in the expected
 * direction (CI excludes 0 the right way). The boolean gate {@link signaturePass} is just
 * `detail.pass`; the CLI uses the per-axis `axes` to EXPLAIN a PASS/FAIL. Two requirements
 * (MDE and significance) guard against a statistically-significant but behaviorally-trivial
 * "difference" passing.
 *
 * Also carries the signature's one-sided p-value for the Holm family ({@link holmSignatures}):
 * per-axis p in the registered direction, combined across an AND rule as the MAX of the axis
 * p-values — the intersection–union test, a valid level-α test of "every axis moved the
 * registered way" with no further correction. `p` is null (never rejectable) if any required
 * axis has no comparison.
 *
 * @param {{ axes: Array<{axis:string, direction:'HIGHER'|'LOWER'}>, rule:'AND'|'single' }} signature
 * @param {Record<string, ReturnType<typeof compareAxis>>} vsControl
 * @param {Record<string, number>} mde - per-axis minimum |Δ| that counts as meaningful
 * @returns {{ pass:boolean, rule:string, p:number|null, axes:Array<{axis:string, direction:string, delta:number|null, lo:number|null, hi:number|null, mde:number|null, p:number|null, meetsMde:boolean, sigInDir:boolean, ok:boolean}> }}
 * @throws if a signature axis HAS a comparison but no registered MDE (see below)
 */
export function signatureDetail(signature, vsControl, mde) {
  const axes = signature.axes.map(({ axis, direction }) => {
    const cmp = vsControl[axis];
    // Fail CLOSED (not throw) when a required axis has no comparison: a persona that rarely wins
    // yields all-null turnsToWin runs → compareAxis null → the signature simply does not hold.
    // (Checked before the MDE lookup so a null-cmp axis never trips the missing-MDE throw.)
    if (!cmp) {
      return {
        axis,
        direction,
        delta: null,
        lo: null,
        hi: null,
        mde: mde[axis] ?? null,
        p: null,
        meetsMde: false,
        sigInDir: false,
        ok: false,
      };
    }
    // Fail loud on a missing MDE rather than defaulting to 0: an `?? 0` fallback would make
    // |Δ| ≥ 0 always true, silently collapsing the gate back to a bare significance test — the
    // exact "trivially-significant pass" this function exists to prevent. A pre-registered
    // signature axis without a pre-registered MDE is a config error, not a 0-threshold.
    const axisMde = mde[axis];
    if (axisMde == null) {
      throw new Error(
        `signatureDetail: no MDE registered for axis "${axis}" — every pre-registered signature ` +
          `axis must have an MDE (else the |Δ| ≥ MDE guard is silently disabled).`
      );
    }
    const meetsMde = Math.abs(cmp.delta) >= axisMde;
    const sigInDir = direction === 'HIGHER' ? cmp.lo > 0 : cmp.hi < 0;
    return {
      axis,
      direction,
      delta: cmp.delta,
      lo: cmp.lo,
      hi: cmp.hi,
      mde: axisMde,
      p: oneSidedP(cmp, direction),
      meetsMde,
      sigInDir,
      ok: meetsMde && sigInDir,
    };
  });
  // Signature-level p: intersection–union over the required axes (max p), null if any axis
  // could not be compared (fail closed — a signature with missing data can never Holm-reject).
  const p = axes.some(a => a.p == null) ? null : Math.max(...axes.map(a => a.p));
  // 'single' and 'AND' both require all listed axes; the distinction is documentation of intent.
  return { pass: axes.every(a => a.ok), rule: signature.rule, p, axes };
}

/**
 * Whether a persona's pre-registered signature holds — the boolean gate. Thin convenience
 * wrapper over {@link signatureDetail} (the single decision path), retained as the public
 * boolean entry point. See {@link signatureDetail} for the per-axis requirements and the
 * throw contract.
 *
 * @param {{ axes: Array<{axis:string, direction:'HIGHER'|'LOWER'}>, rule:'AND'|'single' }} signature
 * @param {Record<string, ReturnType<typeof compareAxis>>} vsControl
 * @param {Record<string, number>} mde - per-axis minimum |Δ| that counts as meaningful
 * @returns {boolean}
 * @throws if a signature axis has no registered MDE (see {@link signatureDetail})
 */
export function signaturePass(signature, vsControl, mde) {
  return signatureDetail(signature, vsControl, mde).pass;
}

/**
 * Holm step-down across the persona confirmatory family (EVAL_HARNESS §3.3). Input is one
 * entry per gated persona: `{ persona, detail }` with `detail` from {@link signatureDetail}
 * (its `p` is the signature-level one-sided IUT p-value; its `pass` is the registered
 * unadjusted single-test gate).
 *
 * The family-wise confirmatory verdict is `confirmatoryPass = detail.pass AND holmReject`:
 * Holm is applied ON TOP of the registered §3.2 gate (|Δ| ≥ MDE and CI excludes 0 in
 * direction), so the adjustment can only tighten it, never loosen it. That composition
 * matters at the family's last rank, where Holm's threshold relaxes to α = 0.05 one-sided —
 * weaker than the registered CI-excludes-0 criterion (one-sided 0.025); without the AND, the
 * "adjustment" would loosen the registered gate for the largest p in the family.
 *
 * @param {Array<{persona: string, detail: {p: number|null, pass: boolean}}>} entries
 * @param {{ alpha?: number, familySize?: number }} [opts] - familySize defaults to
 *   max({@link SIGNATURE_FAMILY_SIZE}, entries.length); throws (via holmAdjust) if set below
 *   entries.length. The library accepts any legal m (unit tests and negative controls need
 *   small families); the REGISTERED-floor protocol check (m ≥ SIGNATURE_FAMILY_SIZE) is
 *   enforced at the profiling CLI, the only registered consumer.
 * @returns {{ alpha:number, familySize:number, results:Array<{persona:string, p:number|null,
 *   pAdj:number|null, threshold:number|null, rank:number|null, holmReject:boolean,
 *   unadjustedPass:boolean, confirmatoryPass:boolean}> }}
 */
export function holmSignatures(entries, { alpha = 0.05, familySize } = {}) {
  // Validate the detail contract up front: holmAdjust reads a MISSING p as a legitimate
  // null ("no comparable data", never rejectable), so a caller passing a reshaped detail
  // object would silently grade every persona NOT CONFIRMED. Fail loud instead.
  for (const e of entries) {
    if (!e?.detail || !('p' in e.detail) || typeof e.detail.pass !== 'boolean') {
      throw new Error(
        `holmSignatures: entry "${e?.persona}" has no signatureDetail-shaped detail ` +
          `(need a 'p' field and a boolean 'pass') — got ${JSON.stringify(e?.detail)}`
      );
    }
  }
  const m = familySize ?? Math.max(SIGNATURE_FAMILY_SIZE, entries.length);
  const adjusted = holmAdjust(
    entries.map(e => ({ name: e.persona, p: e.detail.p })),
    { alpha, familySize: m }
  );
  return {
    alpha,
    familySize: m,
    results: entries.map((e, i) => ({
      persona: e.persona,
      p: adjusted[i].p,
      pAdj: adjusted[i].pAdj,
      threshold: adjusted[i].threshold,
      rank: adjusted[i].rank,
      holmReject: adjusted[i].reject,
      unadjustedPass: e.detail.pass,
      confirmatoryPass: e.detail.pass && adjusted[i].reject,
    })),
  };
}

/**
 * Pre-registered confirmatory signature per persona (§8 of the spec). Actively gated: when a
 * profiled bot's name matches a key here, `signatureDetail` judges it PASS/FAIL. The persona
 * weight files don't exist yet, so this still encodes the one hypothesis each will be judged on
 * — fixing the multiplicity story (≤ 5 confirmatory tests, Holm-adjusted) in advance.
 *
 * @type {Record<string, { axes: Array<{axis:string, direction:'HIGHER'|'LOWER'}>, rule:'AND'|'single' }>}
 */
export const PERSONA_SIGNATURES = {
  Blitz: {
    axes: [
      { axis: 'aggression', direction: 'HIGHER' },
      { axis: 'turnsToWin', direction: 'LOWER' },
    ],
    rule: 'AND',
  },
  Expansionist: { axes: [{ axis: 'avgTerritory', direction: 'HIGHER' }], rule: 'single' },
  Predator: { axes: [{ axis: 'kills', direction: 'HIGHER' }], rule: 'single' },
  Survivor: { axes: [{ axis: 'avgPlacement', direction: 'LOWER' }], rule: 'single' },
};

/**
 * The registered confirmatory family size: one signature test per {@link PERSONA_SIGNATURES}
 * entry (PERSONAS §10.5 registers the family as 4, "becoming 5 if the Blitz escalation fires" —
 * an escalated arm adds a 5th test via `--holm-family 5`, it does not edit the registry).
 * Defaulting m to the REGISTERED count — not the number of personas graded in one invocation —
 * is deliberate: grading personas one-per-session must not quietly un-adjust the family.
 * (Declared after the registry: the initializer runs at module evaluation.)
 */
export const SIGNATURE_FAMILY_SIZE = Object.keys(PERSONA_SIGNATURES).length;

/**
 * The distinct axes that appear in ANY registered persona signature — the axes the A/A negative
 * control ({@link signatureNoiseFloor}) holds to the MDE/3 noise floor. Derived from
 * {@link PERSONA_SIGNATURES} (deduped, registry order) so it can never drift from the family:
 * aggression + turnsToWin (Blitz), avgTerritory (Expansionist), kills (Predator), avgPlacement
 * (Survivor). Descriptive axes are deliberately excluded — only a signature axis can halt a batch.
 */
export const SIGNATURE_AXES = [
  ...new Set(Object.values(PERSONA_SIGNATURES).flatMap(s => s.axes.map(a => a.axis))),
];

/**
 * Per-axis MDEs (§3.2) — the minimum effect a persona signature must clear to count.
 * `aggression` is calibrated from the 2026-06-30 persona pilot (see RESULTS.md): the real
 * Blitz aggression effect was Δ≈0.42 with a tight CI, so the original 1.0 placeholder
 * mis-rejected a genuine style shift (the AND-signature failed on this axis alone). Lowered
 * to 0.3 — comfortably detectable yet below the observed effect. `turnsToWin` and
 * `avgPlacement` were confirmed fine that run (effects −16.8 / −0.82, both ≫ their MDE).
 * The remaining axes stay placeholders until a persona exercises them (`avgTerritory` →
 * Expansionist, `kills` → Predator) — calibrate those in batch 2.
 */
export const DEFAULT_MDE = {
  aggression: 0.3,
  turnsToWin: 5.0,
  avgTerritory: 3.0,
  kills: 0.5,
  avgPlacement: 0.4,
  avgDiceReserve: 3.0,
  zeroAttackTurnFrac: 0.1,
  captureEfficiency: 0.05,
};

/**
 * The pre-registered pairwise separation axes (PERSONAS §10.5): every shipped persona pair
 * must separate on ≥ 1 of these at its MDE, judged from identically-seeded profiles. Three
 * carry the calibrated absolute MDEs (aggression 0.3, turnsToWin 5.0, avgPlacement 0.4 —
 * the {@link DEFAULT_MDE} values); `kills` is judged at the §10.3 RELATIVE bar instead —
 * see {@link killsPairMde}. This is the §10.5 profile-pairing matrix, NOT the §3.5 melee
 * mode (which co-seats personas in one field and remains unbuilt).
 */
export const SEPARATION_AXES = ['aggression', 'turnsToWin', 'avgPlacement', 'kills'];

/**
 * PERSONAS §10.3: the kills confirmatory bar is 15% of the realized comparator's kills —
 * a relative bar that supersedes both the +0.25 interim number and the 0.5 placeholder MDE
 * ("don't silently keep the lower number"). Applied pairwise with the comparator = the
 * pair's lower-kills side.
 */
export const KILLS_MDE_FRACTION = 0.15;

/**
 * PERSONAS §10.4 "the clock cuts both ways" — the near-cap reward-hack tripwire panel for the
 * placement arms (Survivor-v3 and both Predator arms). Distinct from the persona SIGNATURE family:
 * these axes never enter {@link PERSONA_SIGNATURES}/{@link SIGNATURE_AXES}/Holm; firing is a
 * ship-blocking KILL-gate (§10.8), not a "distinct persona" PASS. Each row is a paired Δ vs the
 * pinned comparator (control or raw v3 base) with a pre-registered magnitude threshold AND a
 * CI-excludes-0-in-direction requirement (a bare threshold on a noisy Δ over-fires).
 *
 * **Thresholds RATIFIED 2026-07-08 (Ivan)** from the pre-registered §10.4 calibration — the Wave-1
 * control's (`ppo-v3-conq-ctl`) 0.5M/1M eval checkpoints profiled 10×30×6 vs the Conqueror base in
 * the §10.3 calibration field, pooled with the 2026-07-06 scavenge-calibration innocents (v2
 * Survivor + Lookahead, same field/config/seeds). Rule per axis (the scavenge rule): final
 * threshold = max(draft, largest innocent-bot |Δ| on that axis + that Δ's CI half-width), rounded
 * UP to 2 decimals. Innocent rows with fewer than 5 live runs are excluded as no-power (the
 * checkpoints' `lateGameAggressionSpike` had n=2 — win-mode games rarely near the cap, the §10.4
 * power caveat — with ±4 CIs that would degenerate the threshold; the NO-DATA fail-open guard
 * already keeps such rows from firing at enforcement time):
 *   - `nearCapDeathRate` HIGHER by ≥ 0.05 (draft stands; innocent max |Δ|+hw = 0.002) — the direct
 *     "dies near the cap to bank rank" tell, matching the `zeroAttackTurnFrac` +0.05 threshold.
 *   - `lateGameAggressionSpike` HIGHER by ≥ 0.31 (rule: Survivor's |+0.189| + 0.117, n=9) —
 *     "suddenly attacks to force a decisive end."
 *   - `truncationRate` LOWER by ≥ 0.18 (rule: Lookahead's |+0.145| + 0.029, opposite-direction per
 *     the scavenge precedent) — the CO-SIGNAL: a hacker AVOIDS truncations (they pay 0) by forcing
 *     decisive ends. Corroborates a primary fire; does not KILL on its own (`role:'cosignal'`).
 *
 * KILL rule (§10.8): any `role:'primary'` tripwire fires. The co-signal is reported for the
 * operator's judgment (a Survivor whose deaths/aggression climb near the cap AND whose truncations
 * fall is unambiguously gaming the now-visible clock).
 *
 * @type {Tripwire[]}
 */
export const CLOCK_HACK_TRIPWIRES = [
  { axis: 'nearCapDeathRate', direction: 'HIGHER', threshold: 0.05, role: 'primary' },
  { axis: 'lateGameAggressionSpike', direction: 'HIGHER', threshold: 0.31, role: 'primary' },
  { axis: 'truncationRate', direction: 'LOWER', threshold: 0.18, role: 'cosignal' },
];

/**
 * One row of a §10.8 tripwire table: the panel fires it when the paired Δ vs the comparator
 * clears `threshold` in `direction` AND the 95% CI excludes 0 that way; any fired `primary`
 * KILLs, a fired `cosignal` only corroborates.
 *
 * @typedef {{ axis:string, direction:'HIGHER'|'LOWER', threshold:number,
 *   role:'primary'|'cosignal' }} Tripwire
 */

/**
 * PERSONAS §10.3 — the scavenge (vulture-hack) tripwire panel for the Predator arms, the
 * mechanical form of the pre-committed §10.8 kill condition (reconciled maintainer ruling,
 * 2026-07-06, superseding #123's descriptive-only call: tripwires ARE the pre-commitment, with
 * thresholds calibrated from innocent-bot profile data rather than guessed). Comparator = the
 * profile run's `--control` (the raw v3 base for Wave-2 grading, matching the Wave-1 protocol).
 * The KILL is protocol-binding for Predator arms only; printed as context for every other bot.
 *
 * **Thresholds RATIFIED 2026-07-06 (Ivan)** from the #126 calibration run — 10×30×6, innocents
 * v2 Survivor + Lookahead vs the Conqueror base, both clear (no false fire on the drafts). Rule,
 * per axis: final threshold = max(draft, largest innocent-bot |Δ| observed on that axis + that
 * Δ's CI half-width), rounded UP to 2 decimals (round-up = harder to fire = conservative for a
 * kill-gate). Every binding extreme was Lookahead's, in the OPPOSITE (innocent) direction — so
 * the calibrated bars sit well above the 0.15 / 2.0 / 0.75 drafts and the gate kills only on
 * unambiguous vulture behavior (a weak-but-not-hacking Predator still faces the Lookahead floor,
 * the §10.3 kills bar, and the Survivor-separation bar):
 *   - `killVictimOneTerrFrac` HIGHER by ≥ 0.31 (rule: |−0.274| + 0.032) — the crisp kill-steal
 *     rate: the fraction of the bot's observed kill victims that entered the killing turn at
 *     exactly 1 territory. Innocent opportunistic finishing (victims a third party softened that
 *     round) DOES count here, so this primary takes its false-fire defense from the calibrated
 *     threshold — Survivor, the kill-stealing-adjacent negative control, is what the calibration
 *     bounds it against.
 *   - `killVictimOneTerrTurns` HIGHER by ≥ 5.64 (rule: |−4.888| + 0.744) — victims long-doomed
 *     before the blow (the true vulture tell; third-party softening on the player-turn
 *     immediately before the kill reads streak = 1, but the streak counts player-turns across
 *     ALL live seats, so earlier same-round softening can read up to fieldSize − 1 — this
 *     primary's residual false-fire defense is the same calibrated threshold as the frac's).
 *   - `killVictimTerr` LOWER by ≥ 0.91 (rule: 0.825 + 0.081) — smaller victims overall; the
 *     CO-SIGNAL (victimTerr ≈ 1 alone is ambiguous per the joint-reading caveat, so it
 *     corroborates, never kills alone).
 * Field-size dependence is cancelled by construction: every tripwire is a paired Δ vs a control
 * measured in the identical field (an absolute threshold reading would need field-size calibration).
 *
 * @type {Tripwire[]}
 */
export const SCAVENGE_TRIPWIRES = [
  { axis: 'killVictimOneTerrFrac', direction: 'HIGHER', threshold: 0.31, role: 'primary' },
  { axis: 'killVictimOneTerrTurns', direction: 'HIGHER', threshold: 5.64, role: 'primary' },
  { axis: 'killVictimTerr', direction: 'LOWER', threshold: 0.91, role: 'cosignal' },
];

/**
 * Evaluate a tripwire panel from a paired comparison ({@link compareToControl} output — persona
 * vs the pinned comparator). Pure: no arena, unit-tested on synthetic Δ maps. The generic
 * evaluator behind {@link evaluateClockHack} (§10.4) and {@link evaluateScavenge} (§10.3).
 *
 * A tripwire FIRES only when BOTH its signed magnitude clears the threshold AND its 95% CI excludes
 * 0 in the flagged direction (HIGHER ⇒ `lo > 0`; LOWER ⇒ `hi < 0`). An axis with no comparable data
 * (null) never fires. `kill` is true iff any `primary` tripwire fires (§10.8); a `cosignal`
 * corroborates but never kills alone.
 *
 * @param {Record<string, {delta:number, lo:number, hi:number, ci:number, verdict:string, n:number}|null>} vsComparator
 * @param {Tripwire[]} tripwires
 * @returns {{ rows: Array<object>, primaryFired: boolean, coSignal: boolean, kill: boolean }}
 */
export function evaluateTripwirePanel(vsComparator, tripwires) {
  const rows = tripwires.map(tw => {
    const cmp = vsComparator?.[tw.axis] ?? null;
    if (!cmp) {
      return { ...tw, delta: null, lo: null, hi: null, n: 0, fired: false, verdict: 'NO DATA' };
    }
    const fired =
      tw.direction === 'HIGHER'
        ? cmp.delta >= tw.threshold && cmp.lo > 0
        : cmp.delta <= -tw.threshold && cmp.hi < 0;
    return {
      ...tw,
      delta: cmp.delta,
      lo: cmp.lo,
      hi: cmp.hi,
      n: cmp.n,
      fired,
      verdict: fired ? 'FIRED' : 'clear',
    };
  });
  const primaryFired = rows.some(r => r.role === 'primary' && r.fired);
  const coSignal = rows.some(r => r.role === 'cosignal' && r.fired);
  return { rows, primaryFired, coSignal, kill: primaryFired };
}

/** The §10.4 clock-hack panel ({@link CLOCK_HACK_TRIPWIRES}) via the generic evaluator. */
export const evaluateClockHack = (vsComparator, tripwires = CLOCK_HACK_TRIPWIRES) =>
  evaluateTripwirePanel(vsComparator, tripwires);

/** The §10.3 scavenge panel ({@link SCAVENGE_TRIPWIRES}) via the generic evaluator. */
export const evaluateScavenge = (vsComparator, tripwires = SCAVENGE_TRIPWIRES) =>
  evaluateTripwirePanel(vsComparator, tripwires);

/**
 * Human verdict for a tripwire panel ({@link evaluateTripwirePanel} output). KILL beats
 * everything; a panel whose rows ALL lack comparable data is NO DATA, never a pass-looking
 * "clear ✓" — a kill-gate that measured nothing must not print a pass.
 *
 * @param {{ rows: Array<{delta: number|null}>, kill: boolean }} panel
 * @returns {'KILL ✗'|'clear ✓'|'NO DATA'}
 */
export const panelVerdict = panel =>
  panel.kill ? 'KILL ✗' : panel.rows.every(r => r.delta == null) ? 'NO DATA' : 'clear ✓';

/**
 * Resolve the §10.3 relative kills MDE for one pair from their per-run kills arrays:
 * 15% of the comparator's mean kills over the PAIRED (null-aligned) runs, comparator = the
 * lower-kills side. Returns `mde: null` (uncalibrated — the axis can then never count as
 * separated, failing CLOSED) when fewer than 2 paired runs remain or the comparator's mean
 * is 0: a ~0 comparator collapses the 15% bar to ~0, i.e. a bare significance test — the
 * exact "trivially-significant pass" the MDE guard exists to prevent.
 *
 * @param {Array<number|null>} aKills - per-run kills for side a
 * @param {Array<number|null>} bKills - per-run kills for side b, same seed blocks
 * @returns {{ mde: number|null, comparatorMean: number|null }}
 */
export function killsPairMde(aKills, bKills) {
  const { a, b, n } = alignDropNull(aKills, bKills);
  if (n < 2) return { mde: null, comparatorMean: null };
  const mean = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
  const comparatorMean = Math.min(mean(a), mean(b));
  if (comparatorMean <= 0) return { mde: null, comparatorMean };
  return { mde: KILLS_MDE_FRACTION * comparatorMean, comparatorMean };
}

/**
 * Judge one unordered pair of profiled bots on the pre-registered separation axes
 * (PERSONAS §10.5). An axis SEPARATES the pair iff the paired-Δ 95% CI excludes 0 in either
 * direction AND |Δ| ≥ the axis MDE — the §3.5 "paired-diff CI with MDE" test, deliberately
 * NOT marginal-CI overlap (the weaker test). Direction is irrelevant here (distinctness,
 * not a registered hypothesis), so no one-sided p / Holm machinery applies — the separation
 * requirement is a distinctness FLOOR, where the conservative failure mode is failing to
 * separate, not a false rejection.
 *
 * `kills` uses the §10.3 relative MDE via {@link killsPairMde} unless `relativeKills` is
 * false (an explicit absolute `--mde kills:X` override). A missing absolute MDE for a listed
 * axis throws even when the axis has no data — a registered separation axis without a
 * registered MDE is a config error, and making the throw data-dependent would let it pass
 * silently on sparse pairs (deliberate divergence from signatureDetail's cmp-first ordering).
 *
 * @param {Array<Record<string, number|null>>} aRuns - reduceRun() output per run, side a
 * @param {Array<Record<string, number|null>>} bRuns - same, side b, SAME seed blocks
 * @param {Record<string, number>} mde - per-axis absolute MDEs (DEFAULT_MDE + overrides)
 * @param {{ axes?: string[], relativeKills?: boolean }} [opts]
 * @returns {{ separated: boolean, comparable: boolean, onAxes: string[], axes: Array<{
 *   axis:string, delta:number|null, ci:number|null, lo:number|null, hi:number|null,
 *   n:number, verdict:string|null, mde:number|null, mdeBasis:'absolute'|'relative',
 *   comparatorMean:number|null, meetsMde:boolean, sig:boolean, separated:boolean }> }}
 */
export function separationPair(
  aRuns,
  bRuns,
  mde,
  { axes = SEPARATION_AXES, relativeKills = true } = {}
) {
  const detail = axes.map(axis => {
    const rel = axis === 'kills' && relativeKills;
    let axisMde = null;
    let comparatorMean = null;
    if (rel) {
      ({ mde: axisMde, comparatorMean } = killsPairMde(
        aRuns.map(r => r.kills),
        bRuns.map(r => r.kills)
      ));
    } else {
      axisMde = mde[axis];
      if (axisMde == null) {
        throw new Error(
          `separationPair: no MDE registered for axis "${axis}" — every separation axis must ` +
            `have an MDE (else the |Δ| ≥ MDE guard is silently disabled).`
        );
      }
    }
    const cmp = compareAxis(
      aRuns.map(r => r[axis]),
      bRuns.map(r => r[axis])
    );
    const mdeBasis = rel ? 'relative' : 'absolute';
    if (!cmp) {
      return {
        axis,
        delta: null,
        ci: null,
        lo: null,
        hi: null,
        n: 0,
        verdict: null,
        mde: axisMde,
        mdeBasis,
        comparatorMean,
        meetsMde: false,
        sig: false,
        separated: false,
      };
    }
    // Two-sided significance: the paired CI excludes 0 either way (verdict ≠ SAME).
    const sig = cmp.verdict !== 'SAME';
    // An uncalibrated relative bar (axisMde null) fails closed here: meetsMde stays false.
    const meetsMde = axisMde != null && Math.abs(cmp.delta) >= axisMde;
    return {
      axis,
      delta: cmp.delta,
      ci: cmp.ci,
      lo: cmp.lo,
      hi: cmp.hi,
      n: cmp.n,
      verdict: cmp.verdict,
      mde: axisMde,
      mdeBasis,
      comparatorMean,
      meetsMde,
      sig,
      separated: meetsMde && sig,
    };
  });
  return {
    separated: detail.some(d => d.separated),
    comparable: detail.some(d => d.delta != null),
    onAxes: detail.filter(d => d.separated).map(d => d.axis),
    axes: detail,
  };
}

/**
 * The shipped base persona ([D-27]/[D-31]: Conqueror is the roster's base net). PERSONAS
 * §10.5's "every SHIPPED pair separates" includes base×persona pairs, but Conqueror
 * deliberately has no {@link PERSONA_SIGNATURES} entry (it is the thing personas are judged
 * AGAINST, not a signature hypothesis) — so the separation CLI's ship gate unions this name
 * into its default roster rather than keying on the signature registry alone.
 */
export const SHIPPED_BASE = 'Conqueror';

/**
 * The report-config keys that must be IDENTICAL for cross-report pairing to be valid:
 * together they pin the exact seed set (runs × games × stride), the rotation scheme, and
 * the opponent field — `opponents` (ordered names; order assigns seats) AND `opponentSpecs`
 * (which weights file each non-built-in opponent was loaded from: two fields with the same
 * opponent NAMES but different weights are materially different fields). `control`,
 * `reference`, and `mde` are deliberately excluded: the control is just another profiled
 * bot (not part of the field), `reference` only labels a seat, and MDEs don't affect the
 * games played.
 */
const PAIRING_CONFIG_KEYS = [
  'runs',
  'games',
  'stride',
  'rotations',
  'fieldSize',
  'opponents',
  'opponentSpecs',
];

/**
 * Validate that a set of behavior:profile --json reports can be paired (PERSONAS §10.5:
 * "all arms + control + base are profiled with identical field/seeds"). Throws on anything
 * that breaks pairing outright: a report without per-run arrays, a config mismatch on the
 * seed/field-defining keys, differing quarantine policy, or the same bot name in two
 * reports (ambiguous arrays). Git-SHA drift across reports is RETURNED, not thrown — the
 * §10.5 "cross-time pairing is not pairing" hazard is a protocol call the CLI enforces
 * (hard by default, `--allow-sha-drift` to downgrade), while tests and same-session
 * multi-invocation flows stay expressible.
 *
 * @param {Array<{path: string, report: any}>} reports
 * @returns {{ shaDrift: string|null }} shaDrift describes per-report SHAs when they differ,
 *   any is missing, or any carries a `-dirty` stamp, across >1 report; null for a single
 *   report or a clean match.
 */
export function assertPairableReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('assertPairableReports: need at least one report');
  }
  for (const { path: p, report } of reports) {
    if (!report?.config || !Array.isArray(report.bots)) {
      throw new Error(`${p}: not a behavior:profile --json report (missing config/bots)`);
    }
    if (!Number.isInteger(report.config.runs) || report.config.runs < 2) {
      throw new Error(`${p}: config.runs is not an integer >= 2`);
    }
    if (typeof report.config.quarantine?.on !== 'boolean') {
      throw new Error(`${p}: config.quarantine.on missing — not a behavior:profile --json report`);
    }
    if (!Array.isArray(report.config.opponentSpecs)) {
      throw new Error(
        `${p}: config.opponentSpecs missing — the report predates the separation-script ` +
          `format; re-generate it with a current behavior:profile --json.`
      );
    }
    for (const b of report.bots) {
      if (!Array.isArray(b.perRun) || b.perRun.length !== report.config.runs) {
        throw new Error(
          `${p}: bot "${b.name}" has no per-run arrays (bots[].perRun) — the report predates ` +
            `the separation-script format; re-generate it with a current behavior:profile --json.`
        );
      }
      // Element shape gets its own message: a null/array entry is a CORRUPT report (the
      // format is right, the data isn't), and without this it would surface far away as a
      // context-free TypeError inside separationPair's r.kills access.
      if (b.perRun.some(r => r === null || typeof r !== 'object' || Array.isArray(r))) {
        throw new Error(
          `${p}: bot "${b.name}" has a malformed bots[].perRun entry (expected one object of ` +
            `per-run axis scalars per run) — the report is corrupt; re-generate it with ` +
            `behavior:profile --json.`
        );
      }
    }
  }
  const first = reports[0];
  for (const { path: p, report } of reports.slice(1)) {
    for (const key of PAIRING_CONFIG_KEYS) {
      const a = JSON.stringify(first.report.config[key]);
      const b = JSON.stringify(report.config[key]);
      if (a !== b) {
        throw new Error(
          `config mismatch on "${key}": ${first.path} has ${a}, ${p} has ${b} — pairing needs ` +
            `identical field/seeds (same runs/games/stride/rotations/fieldSize/opponents/` +
            `opponentSpecs).`
        );
      }
    }
    if (first.report.config.quarantine.on !== report.config.quarantine.on) {
      throw new Error(
        `config mismatch on "quarantine.on": ${first.path} has ` +
          `${first.report.config.quarantine.on}, ${p} has ${report.config.quarantine.on} — ` +
          `differing quarantine policy changes which games each side kept.`
      );
    }
  }
  // Axis-set drift: perRun records are built from AXES at generation time, so two reports (or
  // two bots) carrying different axis keys were generated by different harness versions. Pairing
  // them would read the missing axes as silent "no data" downstream (alignDropNull drops every
  // pair) — a format drift, so it fails loud like the other re-generate errors above and is
  // deliberately NOT operator-overridable (unlike SHA drift, which can be a benign doc commit).
  let axisRef = null; // { keys: string, path: string, bot: string }
  for (const { path: p, report } of reports) {
    for (const b of report.bots) {
      const keys = JSON.stringify(Object.keys(b.perRun[0]).sort());
      if (axisRef == null) {
        axisRef = { keys, path: p, bot: b.name };
      } else if (keys !== axisRef.keys) {
        throw new Error(
          `bot "${b.name}" in ${p} carries different perRun axes than bot "${axisRef.bot}" in ` +
            `${axisRef.path} — the reports were generated by different harness versions; ` +
            `re-generate them with the same behavior:profile.`
        );
      }
    }
  }
  const seen = new Map();
  for (const { path: p, report } of reports) {
    for (const b of report.bots) {
      if (seen.has(b.name)) {
        throw new Error(
          `bot "${b.name}" appears in both ${seen.get(b.name)} and ${p} — its per-run arrays ` +
            `are ambiguous. Profile each bot once, or select one copy by re-running that ` +
            `profile without it.`
        );
      }
      seen.set(b.name, p);
    }
  }
  let shaDrift = null;
  if (reports.length > 1) {
    const shas = reports.map(r => r.report.config.gitSha ?? null);
    // A `-dirty` stamp fails closed even when IDENTICAL across reports: two dirty trees at
    // the same commit are not known behavior-identical (the uncommitted changes can differ
    // between the two profile runs), mirroring the missing-SHA handling.
    const dirty = shas.some(s => typeof s === 'string' && s.endsWith('-dirty'));
    if (new Set(shas).size > 1 || shas[0] == null || dirty) {
      shaDrift = reports.map((r, i) => `${r.path}: ${shas[i] ?? 'unknown'}`).join(', ');
    }
  }
  return { shaDrift };
}

/**
 * Parse a `--bots`/`--control` entry. A bare name (`Lookahead`) is a built-in registry lookup;
 * a `Name=path/to/weights.js` entry is a weights-file bot the CLI loads + parity-checks via the
 * same `loadExportedPolicy → makeBC` path as `ppo:gate`. The display name doubles as the
 * {@link PERSONA_SIGNATURES} key, so naming a weights bot `Blitz` opts it into the Blitz gate.
 * Splits on the FIRST `=` only, so a weights path may itself contain `=`.
 *
 * @param {string} spec
 * @returns {{ name: string, weightsPath: string|null }} weightsPath null ⇒ built-in lookup
 */
export function parseBotSpec(spec) {
  const s = String(spec).trim();
  const eq = s.indexOf('=');
  if (eq === -1) return { name: s, weightsPath: null };
  return { name: s.slice(0, eq).trim(), weightsPath: s.slice(eq + 1).trim() };
}

/**
 * Parse a `--mde axis:value,...` override string, merged OVER a base MDE map (never deletes a
 * base entry, so every signature axis always keeps an MDE). This is how the placeholder
 * {@link DEFAULT_MDE} thresholds get CALIBRATED from a pilot at the CLI without a code edit.
 * Throws on a malformed entry, an unknown axis, or a non-positive/non-finite value so a typo can't
 * silently widen or disable a gate (in particular `axis:0`, which would collapse it to a bare
 * significance test).
 *
 * @param {string} str - e.g. "aggression:1.5,turnsToWin:8"
 * @param {Record<string, number>} [base=DEFAULT_MDE]
 * @returns {Record<string, number>} a fresh merged map (base is not mutated)
 */
export function parseMdeOverrides(str, base = DEFAULT_MDE) {
  const out = { ...base };
  const trimmed = (str ?? '').trim();
  if (!trimmed) return out;
  for (const pair of trimmed.split(',')) {
    const part = pair.trim();
    if (!part) continue;
    const colon = part.indexOf(':');
    if (colon === -1) {
      throw new Error(`--mde entry "${part}" is not of the form axis:value`);
    }
    const axis = part.slice(0, colon).trim();
    const value = Number(part.slice(colon + 1).trim());
    if (!AXES.includes(axis)) {
      throw new Error(`--mde axis "${axis}" is not a known axis (${AXES.join(', ')})`);
    }
    if (!Number.isFinite(value) || value <= 0) {
      // Reject 0, not just negatives: an MDE of 0 makes `|Δ| ≥ 0` always true in signatureDetail,
      // silently collapsing the gate to a bare significance test — the exact "trivially-significant
      // pass" the missing-MDE throw exists to prevent. A 0 here is the unsafe direction (it ships a
      // non-distinct persona); a too-large MDE merely fails closed. So the calibration path must
      // refuse it too, not just the implicit `?? 0` fallback signatureDetail already avoids.
      throw new Error(
        `--mde value for "${axis}" must be a positive number (got "${part}") — 0 disables the ` +
          `|Δ| ≥ MDE guard and collapses the signature to a bare significance test.`
      );
    }
    out[axis] = value;
  }
  return out;
}
