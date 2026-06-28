/**
 * Pure logic for the behavioral-eval harness — kept out of the CLI so it is unit
 * testable without spinning up an arena. The harness answers "is this bot DIFFERENT,
 * and how?" (paired Δ on behavioral axes vs a control) as the complement to
 * `ppo:gate`'s "is it STRONGER?" (paired Δwin% vs Lookahead). See
 * `docs/ml-bot/EVAL_HARNESS.md` for the full spec.
 *
 * Phase 1 (this file): the metric extraction + aggregation + control comparison,
 * runnable against existing built-in bots. Phase 2 wires the trained persona bots and
 * the pre-registered signature gates (the PERSONA_SIGNATURES stub at the bottom).
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

import { meanCi } from './stats.mjs';
import { pairedDelta, classifyGate } from './ppo-gate-core.mjs';
import { isStopMove } from '../../src/arena/trajectoryExport.js';

/**
 * @typedef {Object} GameCapture
 * Per-game accumulator filled by the live `onTurn`/`onStep` handlers from {@link makeCapture}.
 * @property {number}   playerIndex   - the profiled seat this capture follows
 * @property {number}   activeTurns   - count of the profiled bot's own completed turns (incl. a win)
 * @property {number[]} territory     - territoryCount at the end of each of the bot's own turns
 * @property {number[]} dice          - diceCount at the end of each of the bot's own turns
 * @property {number[]} largestGroup  - largestGroup at the end of each of the bot's own turns
 * @property {number}   kills         - opponents the bot eliminated (last-territory capture)
 * @property {number|null} eliminatedAtTurn - turn the bot was itself eliminated, or null if it survived
 * @property {number}   zeroAttackTurns  - the bot's own turns that ended with 0 attacks (pass turns)
 * @property {number}   _sinceStop    - internal: attacks since the bot's last STOP (do not read)
 * @property {Set<number>} _seenEliminated - internal: players already counted as eliminated
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
    eliminatedAtTurn: null,
    zeroAttackTurns: 0,
    _sinceStop: 0,
    _seenEliminated: new Set(),
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
      }
    }
    // Board-shape snapshots are taken at the END of the bot's OWN turns ("what it holds").
    if (actingPlayerId === playerIndex) {
      capture.activeTurns += 1;
      const me = state.players[playerIndex];
      capture.territory.push(me.territoryCount);
      capture.dice.push(me.diceCount);
      capture.largestGroup.push(me.largestGroup);
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
 * @returns {GameProfile}
 */
export function profileGameFromCapture(result, playerIndex, capture) {
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

  const dicePerTerritory = capture.territory.map((t, i) => (t > 0 ? capture.dice[i] / t : 0));

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
  const defined = (field, filter = () => true) =>
    meanOrNull(
      profiles
        .filter(filter)
        .map(p => p[field])
        .filter(v => v != null)
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
  };
}

/** Mean ± 95% CI of a run array, ignoring null runs. Returns null if < 1 finite run. */
export function summarizeAxis(perRunValues) {
  const vals = perRunValues.filter(v => v != null);
  if (vals.length === 0) return null;
  if (vals.length === 1) return { mean: vals[0], ci: null, n: 1 };
  return { ...meanCi(vals), n: vals.length };
}

/**
 * Drop run indices where EITHER side is null, keeping the two arrays aligned (so
 * `pairedDelta`'s positional pairing stays valid). Returns the filtered pair + kept count.
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
    if (a[i] == null || b[i] == null) continue;
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
 * @returns {{ delta:number, ci:number, lo:number, hi:number, verdict:'HIGHER'|'SAME'|'LOWER', n:number } | null}
 */
export function compareAxis(personaRuns, controlRuns) {
  const { a, b, n } = alignDropNull(personaRuns, controlRuns);
  if (n < 2) return null;
  const d = pairedDelta(a, b); // { mean, ci, lo, hi }
  // classifyGate speaks BEAT/TIE/BEHIND; relabel to the direction-neutral HIGHER/SAME/LOWER.
  const verdict = { BEAT: 'HIGHER', BEHIND: 'LOWER', TIE: 'SAME' }[classifyGate(d)];
  // Expose the paired mean as `delta` (the spec's field name; what signaturePass/CLI read).
  return { delta: d.mean, ci: d.ci, lo: d.lo, hi: d.hi, verdict, n };
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
 * Whether a persona's pre-registered signature holds: every required axis must clear its
 * minimum-detectable-effect AND have a CI excluding 0 in the expected direction (§3.2/§3.3).
 * Two requirements (|Δ| ≥ MDE and significant) guard against a statistically-significant but
 * behaviorally-trivial "difference" passing.
 *
 * @param {{ axes: Array<{axis:string, direction:'HIGHER'|'LOWER'}>, rule:'AND'|'single' }} signature
 * @param {Record<string, ReturnType<typeof compareAxis>>} vsControl
 * @param {Record<string, number>} mde - per-axis minimum |Δ| that counts as meaningful
 * @returns {boolean}
 */
export function signaturePass(signature, vsControl, mde) {
  const checks = signature.axes.map(({ axis, direction }) => {
    const cmp = vsControl[axis];
    if (!cmp) return false;
    const meetsMde = Math.abs(cmp.delta) >= (mde[axis] ?? 0);
    const sigInDir = direction === 'HIGHER' ? cmp.lo > 0 : cmp.hi < 0;
    return meetsMde && sigInDir;
  });
  // 'single' and 'AND' both require all listed axes; the distinction is documentation of intent.
  return checks.every(Boolean);
}

/**
 * Pre-registered confirmatory signature per persona (§8 of the spec). Phase-2 stub — the
 * persona bots do not exist yet; this encodes the one hypothesis each will be judged on so
 * the multiplicity story (≤ 5 confirmatory tests, Holm-adjusted) is fixed in advance.
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

/** Placeholder per-axis MDEs (§3.2). Calibrate from a pilot once a persona exists. */
export const DEFAULT_MDE = {
  aggression: 1.0,
  turnsToWin: 5.0,
  avgTerritory: 3.0,
  kills: 0.5,
  avgPlacement: 0.4,
  avgDiceReserve: 3.0,
  zeroAttackTurnFrac: 0.1,
  captureEfficiency: 0.05,
};
