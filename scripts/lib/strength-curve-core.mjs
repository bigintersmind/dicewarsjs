/**
 * Core logic for the [D-29] strength-curve scorer (`scripts/ppo-strength-curve.mjs`)
 * — kept out of the CLI so every piece is unit testable without spinning up an
 * arena or importing the bot registry.
 *
 * The scorer walks a Phase-0 producer eval dir (`index.jsonl` + per-checkpoint
 * `.weights.js`/`.fixture.json`, see docs/ml-bot/STRENGTH_CURVE.md), grades each
 * checkpoint on the seat-fair gate ({@link runGateSweep} — the exact ppo-gate
 * methodology), and persists one row per checkpoint including the **per-run
 * win%/placement arrays** that make every cross-checkpoint comparison a
 * run-paired test (constant seedBase ⇒ run i of checkpoint A and run i of
 * checkpoint B share seed blocks).
 *
 * Heavy dependencies (policy loader, makeBC, the bot registry, runMatch) are
 * injected via `deps` in {@link gradeCheckpoint} rather than imported here, so
 * unit tests drive the full grading/failure policy with stubs.
 *
 * @module scripts/lib/strength-curve-core
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mean, meanCi, meanSe, tCritOneSided } from './stats.mjs';
import { buildGateField, classifyGate, pairedDelta, runGateSweep } from './ppo-gate-core.mjs';

/**
 * Fixed key for the graded checkpoint's own per-run arrays in `row.perRunWin`.
 * The candidate's field NAME varies per checkpoint (`CP-<step>`), so analysis
 * code addresses it via this stable key; references keep their field names.
 */
export const CANDIDATE_KEY = 'candidate';

/** Unique, non-colliding field name for a graded checkpoint. */
export const checkpointName = step => `CP-${step}`;

// ---------------------------------------------------------------------------
// Index walking
// ---------------------------------------------------------------------------

/**
 * Parse a producer `index.jsonl` (line-delimited JSON) tolerantly: unparsable
 * or field-incomplete lines are warn-and-skipped, never fatal — under the
 * rsync-pull transport a torn/partial index line is "not yet synced", not an
 * error. Rows are returned ascending by step; a duplicate step keeps the last
 * row (the producer never re-emits a step, so a dupe means a hand-edited index).
 *
 * @param {string} text - raw index.jsonl contents
 * @returns {{ rows: Array<object>, warnings: string[] }}
 */
export function parseIndex(text) {
  const rows = [];
  const warnings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      warnings.push(`index line ${i + 1}: unparsable JSON — skipped`);
      continue;
    }
    if (
      !row ||
      typeof row.id !== 'string' ||
      !Number.isFinite(row.step) ||
      typeof row.weights !== 'string'
    ) {
      warnings.push(`index line ${i + 1}: missing id/step/weights — skipped`);
      continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.step - b.step);
  const byStep = new Map();
  for (const r of rows) {
    if (byStep.has(r.step))
      warnings.push(`duplicate step ${r.step} in index — keeping the last row`);
    byStep.set(r.step, r);
  }
  return { rows: [...byStep.values()], warnings };
}

/**
 * Decide what this walk grades. Incremental and resume-safe:
 * - `dropped` = existing strength rows whose step vanished from the index — a
 *   trainer resume rolled those checkpoints back; the caller must persist
 *   `kept` (without them) before grading.
 * - already-graded steps (any status: a `parity-failed` row is permanent for
 *   that checkpoint — the producer never re-emits a step with different
 *   artifacts) are skipped.
 * - `--every-n` subsampling is positional over the index (index is append-only
 *   ascending, so ordinals are stable across walks); skipped rows are returned
 *   for logging, never silently dropped.
 * - `maxPoints` caps this walk's work (budget escape hatch / the mini
 *   acceptance run); the deferred remainder is returned for logging.
 *
 * @param {object} args
 * @param {Array<object>} args.indexRows - from {@link parseIndex}
 * @param {Array<object>} args.existingRows - current strength.jsonl rows
 * @param {number} [args.everyN=1]
 * @param {number} [args.maxPoints=0] - 0 = unlimited
 * @returns {{ toGrade: Array<object>, deferred: Array<object>, dropped: Array<object>,
 *   kept: Array<object>, skippedBySubsample: Array<object>, eligibleSteps: number[] }} -
 *   `eligibleSteps` = every index step this curve is expected to grade under
 *   `everyN` (graded or not) — feed it to {@link analyzeCurve} as `indexSteps`
 *   so a not-yet-graded expected point breaks k-consecutive windows, while
 *   deliberately subsampled steps don't.
 */
export function planCurveWork({ indexRows, existingRows, everyN = 1, maxPoints = 0 }) {
  const indexSteps = new Set(indexRows.map(r => r.step));
  const dropped = existingRows.filter(r => !indexSteps.has(r.step));
  const kept = existingRows.filter(r => indexSteps.has(r.step));
  const gradedSteps = new Set(kept.map(r => r.step));
  const skippedBySubsample = [];
  const eligibleSteps = [];
  let toGrade = [];
  indexRows.forEach((row, i) => {
    if (everyN > 1 && i % everyN !== 0) {
      if (!gradedSteps.has(row.step)) skippedBySubsample.push(row);
      return;
    }
    eligibleSteps.push(row.step);
    if (!gradedSteps.has(row.step)) toGrade.push(row);
  });
  let deferred = [];
  if (maxPoints > 0 && toGrade.length > maxPoints) {
    deferred = toGrade.slice(maxPoints);
    toGrade = toGrade.slice(0, maxPoints);
  }
  return { toGrade, deferred, dropped, kept, skippedBySubsample, eligibleSteps };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** sha256 hex digest of a file's bytes. */
export const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Short stable hash of the ordered base-field bot names (win% is field-relative). */
export const fieldHash = names =>
  createHash('sha256').update(names.join('|')).digest('hex').slice(0, 12);

/**
 * The `strength.meta.json` sidecar: the curve's grading invariants. Win% is
 * field-relative and encoding-gated, so rows are only comparable to each other
 * under identical knobs/field/encoding — {@link metaMismatches} enforces that
 * on every resumed walk.
 */
export function buildMeta({
  knobs,
  baseFieldNames,
  refNames,
  gitSha,
  encodingVersion,
  lookaheadPin,
  evalDir,
}) {
  return {
    createdAt: new Date().toISOString(),
    evalDir,
    gitSha,
    encodingVersion,
    lookaheadPin,
    baseFieldNames,
    fieldHash: fieldHash(baseFieldNames),
    candidateNamePattern: 'CP-<step>',
    refNames,
    knobs,
  };
}

/**
 * Comparability check between an existing sidecar and the current invocation.
 * Returns the list of HARD mismatches (knobs, field, encoding, refs) — any of
 * these makes new rows incomparable with the existing curve, so the caller must
 * abort (grade to a different `--out` instead). A `gitSha` drift is returned
 * separately: the codebase moving under a long-lived curve is expected and only
 * warned about (rows carry their own per-row `gitSha`).
 *
 * @returns {{ hard: string[], gitShaDrift: string|null }}
 */
export function metaMismatches(existing, current) {
  const hard = [];
  for (const k of ['runs', 'games', 'seedBase']) {
    if (existing.knobs?.[k] !== current.knobs?.[k]) {
      hard.push(`knobs.${k}: existing=${existing.knobs?.[k]} current=${current.knobs?.[k]}`);
    }
  }
  if (existing.fieldHash !== current.fieldHash) {
    hard.push(`fieldHash: existing=${existing.fieldHash} current=${current.fieldHash}`);
  }
  if (existing.encodingVersion !== current.encodingVersion) {
    hard.push(
      `encodingVersion: existing=${existing.encodingVersion} current=${current.encodingVersion}`
    );
  }
  const refsA = JSON.stringify(existing.refNames ?? []);
  const refsB = JSON.stringify(current.refNames ?? []);
  if (refsA !== refsB) hard.push(`refNames: existing=${refsA} current=${refsB}`);
  const gitShaDrift =
    existing.gitSha && existing.gitSha !== current.gitSha
      ? `${existing.gitSha} -> ${current.gitSha}`
      : null;
  return { hard, gitShaDrift };
}

// ---------------------------------------------------------------------------
// Grading one checkpoint
// ---------------------------------------------------------------------------

/** Best-effort peek at an exported module's encodingVersion (null if unreadable). */
async function peekEncodingVersion(weightsPath) {
  try {
    const mod = await import(pathToFileURL(weightsPath).href);
    return mod.BC_POLICY?.encodingVersion ?? null;
  } catch {
    return null;
  }
}

const round = (v, dp) => Number(v.toFixed(dp));
const roundDelta = d => ({
  mean: round(d.mean, 2),
  ci: round(d.ci, 2),
  lo: round(d.lo, 2),
  hi: round(d.hi, 2),
});

/**
 * Grade one index row on the seat-fair gate. Returns a discriminated union —
 * the [D-29] three-way failure policy:
 *
 * - `{ kind: 'not-synced', missing }` — an artifact file the row references is
 *   absent. Under the rsync-pull transport that means "not yet synced, retry
 *   next poll" — never an error, never a row.
 * - `{ kind: 'encoding-abort', version, reason }` — an encoding-contract break
 *   that is a property of the whole run (every checkpoint shares the
 *   encoding/layout): the caller must abort the scorer. `reason` distinguishes
 *   `'unsupported-version'` (stamp outside `SUPPORTED_ENCODING_VERSIONS`) from
 *   `'incompatible-widths'` (supported stamp, but the net's feature widths
 *   break the live encoder — makeBC's guard) so the operator message can point
 *   at the right remediation.
 * - `{ kind: 'row', row }` — a strength row: `status: 'ok'` with the full stats
 *   + per-run arrays, or `status: 'parity-failed' | 'sweep-failed'` recording
 *   the gap explicitly (the caller continues, subject to its failure threshold).
 *
 * @param {object} args
 * @param {object} args.indexRow - one {@link parseIndex} row
 * @param {string} args.evalDir - eval dir the row's relative paths resolve against
 * @param {{ runs: number, games: number, seedBase: number }} args.knobs
 * @param {string[]} [args.refNames=['PPO']] - in-field reference tallies beyond Lookahead
 * @param {string} [args.gitSha] - repo SHA recorded per row (rows are variants —
 *   the codebase can move under a long-lived curve; the sidecar's SHA is only
 *   the starting point)
 * @param {object} args.deps - injected heavy deps:
 *   `{ loadPolicy, makeBot, builtInBots, matchFn, supportedEncodingVersions,
 *      onRunComplete?, onMatchError? }`
 * @returns {Promise<object>} the discriminated union above
 */
export async function gradeCheckpoint({
  indexRow,
  evalDir,
  knobs,
  refNames = ['PPO'],
  gitSha,
  deps,
}) {
  const {
    loadPolicy,
    makeBot,
    builtInBots,
    matchFn,
    supportedEncodingVersions,
    onRunComplete,
    onMatchError,
  } = deps;

  const resolvePath = p => (isAbsolute(p) ? p : join(evalDir, p));
  const weightsPath = resolvePath(indexRow.weights);
  const fixturePath = indexRow.fixture ? resolvePath(indexRow.fixture) : undefined;
  const missing = [weightsPath, fixturePath].filter(p => p && !existsSync(p));
  if (missing.length > 0) return { kind: 'not-synced', missing };

  const base = {
    id: indexRow.id,
    step: indexRow.step,
    indexCreatedAt: indexRow.createdAt ?? null,
    ...(gitSha ? { gitSha } : {}),
  };

  let loaded;
  try {
    loaded = await loadPolicy({ weightsPath, fixturePath, label: indexRow.id });
  } catch (err) {
    /*
     * Split systemic-from-broken: if the module itself loads and carries an
     * out-of-support encodingVersion, this is the run-global "re-export needed"
     * case (skipping would grind through ~20 identical failures); anything else
     * is a per-checkpoint parity/fixture failure recorded as a curve gap.
     */
    const version = await peekEncodingVersion(weightsPath);
    if (version != null && !supportedEncodingVersions.includes(version)) {
      return { kind: 'encoding-abort', version, reason: 'unsupported-version', error: err.message };
    }
    return {
      kind: 'row',
      row: {
        ...base,
        status: 'parity-failed',
        error: err.message,
        weightsSha256: sha256File(weightsPath),
        gradedAt: new Date().toISOString(),
      },
    };
  }
  const { policy, parity, params } = loaded;
  if (!supportedEncodingVersions.includes(policy.encodingVersion)) {
    return {
      kind: 'encoding-abort',
      version: policy.encodingVersion,
      reason: 'unsupported-version',
    };
  }

  let candidateFn;
  try {
    candidateFn = makeBot({ policy });
  } catch (err) {
    /*
     * makeBC's own guard. The version is already known-supported here (the
     * explicit check above returned first), so what it caught is a width/layout
     * incompatibility with the live encoder — a different remediation than
     * "wrong version", hence the distinct reason.
     */
    return {
      kind: 'encoding-abort',
      version: policy.encodingVersion,
      reason: 'incompatible-widths',
      error: err.message,
    };
  }

  const cpName = checkpointName(indexRow.step);
  const field = buildGateField(builtInBots, candidateFn, cpName);
  const allRefs = ['Lookahead', ...refNames.filter(n => n !== 'Lookahead')];
  const tallyNames = [cpName, ...allRefs];

  const t0 = Date.now();
  let sweep;
  try {
    sweep = await runGateSweep({
      field,
      matchFn,
      runs: knobs.runs,
      gamesPerRun: knobs.games,
      seedBase: knobs.seedBase,
      tallyNames,
      onRunComplete,
      onMatchError,
    });
  } catch (err) {
    return {
      kind: 'row',
      row: {
        ...base,
        status: 'sweep-failed',
        error: err.message,
        parity,
        params,
        weightsSha256: sha256File(weightsPath),
        gradedAt: new Date().toISOString(),
      },
    };
  }
  const wallClockSec = round((Date.now() - t0) / 1000, 1);

  const cand = sweep.perRun[cpName];
  const cw = meanCi(cand.winPct);
  const perRunWin = { [CANDIDATE_KEY]: cand.winPct };
  const refResults = {};
  for (const ref of allRefs) {
    perRunWin[ref] = sweep.perRun[ref].winPct;
    const delta = pairedDelta(cand.winPct, sweep.perRun[ref].winPct);
    refResults[ref] = { delta, verdict: classifyGate(delta) };
  }
  const extraRefNames = allRefs.filter(n => n !== 'Lookahead' && n !== 'PPO');
  const extraRefs = {};
  for (const n of extraRefNames) {
    extraRefs[n] = { delta: roundDelta(refResults[n].delta), verdict: refResults[n].verdict };
  }

  const row = {
    ...base,
    status: 'ok',
    gradedAt: new Date().toISOString(),
    wallClockSec,
    weightsSha256: sha256File(weightsPath),
    parity,
    params,
    games: sweep.games,
    failedGames: sweep.failedGames,
    winPct: round(cw.mean, 2),
    winCi: round(cw.ci, 2),
    avgPlacement: round(mean(cand.avgPlacement), 3),
    deltaVsLook: roundDelta(refResults.Lookahead.delta),
    verdictVsLook: refResults.Lookahead.verdict,
    ...(refResults.PPO
      ? { deltaVsPPO: roundDelta(refResults.PPO.delta), verdictVsPPO: refResults.PPO.verdict }
      : {}),
    ...(extraRefNames.length > 0 ? { extraRefs } : {}),
    perRunWin,
    perRunPlacement: cand.avgPlacement,
  };
  return { kind: 'row', row };
}

// ---------------------------------------------------------------------------
// analyzeCurve — the [D-29] detection rules
// ---------------------------------------------------------------------------

/**
 * One-sided run-paired t-test: does `diffs` (per-run paired differences) test
 * significantly BELOW `threshold` at α = 0.05? Degenerate zero-variance samples
 * fall back to a strict compare (t would be ±∞).
 */
export function testsBelow(diffs, threshold = 0) {
  if (diffs.length < 2) return false;
  const { mean: m, se, n } = meanSe(diffs);
  if (se === 0) return m < threshold;
  return (m - threshold) / se < -tCritOneSided(n - 1);
}

/** One-sided counterpart of {@link testsBelow}: significantly ABOVE `threshold`. */
export function testsAbove(diffs, threshold = 0) {
  if (diffs.length < 2) return false;
  const { mean: m, se, n } = meanSe(diffs);
  if (se === 0) return m > threshold;
  return (m - threshold) / se > tCritOneSided(n - 1);
}

/**
 * Per-run Δ-vs-reference array for one ok row: `candidateWin[r] − refWin[r]`.
 * This is the curve's y-axis as a per-run sample — the unit every run-paired
 * cross-checkpoint test operates on. Null when the row lacks the arrays.
 */
export function perRunDeltaVsRef(row, refName) {
  const cand = row.perRunWin?.[CANDIDATE_KEY];
  const ref = row.perRunWin?.[refName];
  if (!Array.isArray(cand) || !Array.isArray(ref) || cand.length !== ref.length) return null;
  return cand.map((v, i) => v - ref[i]);
}

/**
 * The [D-29] curve analysis over graded rows. All cross-checkpoint comparisons
 * are run-paired (constant seedBase makes per-run samples pairable by run
 * index); the naive "CIs disjoint" rule is deliberately absent (retired to a
 * cross-curve fallback — it needs a ~5.4 pp gap for significance).
 *
 * - **Regression**: point i tests one-sided-significantly below the *running
 *   best's lower CI bound* (null shifted by the best's CI half-width — the raw
 *   argmax is selection-biased high), for `regressionK = 2` consecutive points.
 *   Failed/missing points break the window ("gaps break windows").
 * - **Plateau onset**: earliest s* whose next `plateauK = 3` points show no
 *   significant paired gain over s*.
 * - **Best**: argmax Δ-vs-Lookahead, reported with CI + ties-within-CI — a
 *   *selection*, not a measurement (winner's curse ≈ +2 pp); the confirmation
 *   protocol is printed by the renderer as the mandatory next step.
 * - **Divergence** (descriptive, never gated): placement improving while win%
 *   is flat — the Survivor-style drift signal (win% flips with field
 *   composition, placement is field-stable).
 *
 * @param {Array<object>} rows - strength rows, any order/status
 * @param {{ regressionK?: number, plateauK?: number, indexSteps?: number[] }} [opts] -
 *   `indexSteps` = the steps this curve is *expected* to grade (the caller's
 *   subsample-eligible index steps). Without it, only failed ROWS can break a
 *   k-consecutive window — an indexed-but-ungraded checkpoint (artifacts not
 *   yet synced) would be invisible and let a window bridge a missing point.
 * @returns {object} analysis summary (see fields set below)
 */
export function analyzeCurve(rows, { regressionK = 2, plateauK = 3, indexSteps } = {}) {
  const sorted = [...rows].sort((a, b) => a.step - b.step);
  const ok = sorted.filter(r => r.status === 'ok');
  const analysis = {
    points: ok.length,
    failedPoints: sorted.length - ok.length,
    best: null,
    ties: [],
    regressions: [],
    activeSlump: null,
    plateauStep: null,
    divergence: null,
  };
  if (ok.length === 0) return analysis;

  /*
   * contiguous[i] — no missing/failed curve point sits between ok[i-1] and
   * ok[i]; a gap breaks any "k consecutive" window rather than bridging it.
   * "Missing" = a failed row, or (when the caller supplies `indexSteps`) an
   * expected step with no ok row yet — e.g. artifacts awaiting sync.
   */
  const okSteps = new Set(ok.map(r => r.step));
  const contiguous = ok.map((r, i) => {
    if (i === 0) return true;
    const prev = ok[i - 1];
    if (sorted.some(x => x.status !== 'ok' && x.step > prev.step && x.step < r.step)) return false;
    if (indexSteps?.some(s => s > prev.step && s < r.step && !okSteps.has(s))) return false;
    return true;
  });

  // Best (a selection, not a measurement)
  let best = ok[0];
  for (const r of ok) if (r.deltaVsLook.mean > best.deltaVsLook.mean) best = r;
  analysis.best = {
    step: best.step,
    id: best.id,
    delta: best.deltaVsLook,
    verdict: best.verdictVsLook,
  };
  analysis.ties = ok
    .filter(r => r !== best && r.deltaVsLook.hi >= best.deltaVsLook.lo)
    .map(r => r.step);

  // Regression: one-sided paired test vs the running best's lower CI bound, k consecutive
  const belowFlags = new Array(ok.length).fill(false);
  const refSteps = new Array(ok.length).fill(null);
  let runningBest = null;
  for (let i = 0; i < ok.length; i++) {
    const cur = ok[i];
    if (runningBest) {
      const dCur = perRunDeltaVsRef(cur, 'Lookahead');
      const dRef = perRunDeltaVsRef(runningBest, 'Lookahead');
      if (dCur && dRef && dCur.length === dRef.length) {
        const diffs = dCur.map((v, r) => v - dRef[r]);
        // Null shifted to the best's LOWER CI bound: only flag when i is
        // significantly below even the selection-discounted best.
        belowFlags[i] = testsBelow(diffs, -runningBest.deltaVsLook.ci);
        refSteps[i] = runningBest.step;
      }
    }
    if (!runningBest || cur.deltaVsLook.mean > runningBest.deltaVsLook.mean) runningBest = cur;
  }
  let windowLen = 0;
  for (let i = 0; i < ok.length; i++) {
    if (i > 0 && !contiguous[i]) windowLen = 0;
    windowLen = belowFlags[i] ? windowLen + 1 : 0;
    if (windowLen === regressionK) {
      analysis.regressions.push({
        steps: ok.slice(i - regressionK + 1, i + 1).map(r => r.step),
        endStep: ok[i].step,
        refStep: refSteps[i],
      });
    }
  }
  // Trailing slump (the watch-mode alert condition): the newest ≥k points all flag.
  let trailing = 0;
  for (let i = ok.length - 1; i >= 0; i--) {
    if (!belowFlags[i]) break;
    trailing++;
    if (i > 0 && !contiguous[i]) break;
  }
  if (trailing >= regressionK) {
    analysis.activeSlump = {
      steps: ok.slice(ok.length - trailing).map(r => r.step),
      refStep: refSteps[ok.length - 1],
    };
  }

  // Plateau onset: earliest s* with plateauK following points showing no paired gain
  for (let i = 0; i < ok.length - plateauK; i++) {
    let chainContiguous = true;
    for (let j = i + 1; j <= i + plateauK; j++) {
      if (!contiguous[j]) {
        chainContiguous = false;
        break;
      }
    }
    if (!chainContiguous) continue;
    const dStar = perRunDeltaVsRef(ok[i], 'Lookahead');
    if (!dStar) continue;
    let plateau = true;
    for (let j = i + 1; j <= i + plateauK; j++) {
      const dJ = perRunDeltaVsRef(ok[j], 'Lookahead');
      if (!dJ || dJ.length !== dStar.length) {
        plateau = false;
        break;
      }
      if (
        testsAbove(
          dJ.map((v, r) => v - dStar[r]),
          0
        )
      ) {
        plateau = false;
        break;
      }
    }
    if (plateau) {
      analysis.plateauStep = ok[i].step;
      break;
    }
  }

  /*
   * Win%-vs-placement divergence (first-half vs second-half means; thresholds
   * are descriptive heuristics, clearly below the paired tests' rigor — this
   * flag is printed, never gated on).
   */
  if (ok.length >= 4) {
    const half = Math.floor(ok.length / 2);
    const first = ok.slice(0, half);
    const second = ok.slice(ok.length - half);
    const placementGain =
      mean(first.map(r => r.avgPlacement)) - mean(second.map(r => r.avgPlacement));
    const winGain =
      mean(second.map(r => r.deltaVsLook.mean)) - mean(first.map(r => r.deltaVsLook.mean));
    if (placementGain >= 0.15 && winGain < 1.0) {
      analysis.divergence = {
        placementGain: round(placementGain, 2),
        winDeltaGain: round(winGain, 1),
      };
    }
  }

  return analysis;
}

// ---------------------------------------------------------------------------
// Persistence + rendering
// ---------------------------------------------------------------------------

/**
 * Read a strength.jsonl tolerantly (same warn-and-skip stance as
 * {@link parseIndex} — a torn write must not brick the walker).
 */
export function readStrengthRows(path) {
  if (!existsSync(path)) return { rows: [], warnings: [] };
  const rows = [];
  const warnings = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      warnings.push(`${path} line ${i + 1}: unparsable JSON — skipped`);
      continue;
    }
    if (!row || !Number.isFinite(row.step) || typeof row.status !== 'string') {
      warnings.push(`${path} line ${i + 1}: missing step/status — skipped`);
      continue;
    }
    rows.push(row);
  }
  return { rows, warnings };
}

/** Atomically rewrite a jsonl file (write temp + rename — no torn reads). */
export function writeRowsAtomic(path, rows) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tmp, path);
}

const CSV_COLUMNS = [
  ['id', r => r.id],
  ['step', r => r.step],
  ['status', r => r.status],
  ['winPct', r => r.winPct],
  ['winCi', r => r.winCi],
  ['deltaVsLook', r => r.deltaVsLook?.mean],
  ['ciVsLook', r => r.deltaVsLook?.ci],
  ['loVsLook', r => r.deltaVsLook?.lo],
  ['hiVsLook', r => r.deltaVsLook?.hi],
  ['verdictVsLook', r => r.verdictVsLook],
  ['deltaVsPPO', r => r.deltaVsPPO?.mean],
  ['ciVsPPO', r => r.deltaVsPPO?.ci],
  ['verdictVsPPO', r => r.verdictVsPPO],
  ['avgPlacement', r => r.avgPlacement],
  ['parity', r => r.parity],
  ['games', r => r.games],
  ['failedGames', r => r.failedGames],
  ['wallClockSec', r => r.wallClockSec],
  ['weightsSha256', r => r.weightsSha256],
];

/** Summary-fields CSV (per-run arrays live in the jsonl only). */
export function toCsv(rows) {
  const header = CSV_COLUMNS.map(([name]) => name).join(',');
  const lines = [...rows]
    .sort((a, b) => a.step - b.step)
    .map(r => CSV_COLUMNS.map(([, get]) => get(r) ?? '').join(','));
  return `${[header, ...lines].join('\n')}\n`;
}

/** One-line point summary for logs and the batch table. */
export function pointLine(row) {
  if (row.status !== 'ok') return `${row.id}  step ${row.step}  ${row.status}: ${row.error}`;
  const d = row.deltaVsLook;
  const p = row.deltaVsPPO;
  return (
    `${row.id}  step ${row.step}  ` +
    `Δlook ${d.mean >= 0 ? '+' : ''}${d.mean.toFixed(1)} ± ${d.ci.toFixed(1)} ${row.verdictVsLook}${
      p ? `  ΔPPO ${p.mean >= 0 ? '+' : ''}${p.mean.toFixed(1)} ${row.verdictVsPPO}` : ''
    }  win ${row.winPct.toFixed(1)}%  place ${row.avgPlacement.toFixed(2)}  ${row.wallClockSec}s`
  );
}

/**
 * Render the analysis as printable lines, ending with the mandatory
 * confirmation protocol (the curve's argmax is a selection, not a measurement).
 *
 * @param {object} analysis - from {@link analyzeCurve}
 * @param {{ tbHint?: string, knobs?: object, evalDir?: string }} [ctx]
 * @returns {string[]}
 */
export function renderAnalysis(analysis, ctx = {}) {
  const lines = [];
  lines.push(
    `Curve: ${analysis.points} graded point(s)${
      analysis.failedPoints ? ` + ${analysis.failedPoints} failed` : ''
    }`
  );
  if (!analysis.best) return lines;

  const b = analysis.best;
  lines.push(
    `Best (argmax — a selection, inflated ~+2 pp by winner's curse): step ${b.step} ` +
      `Δ vs Lookahead ${b.delta.mean >= 0 ? '+' : ''}${b.delta.mean.toFixed(1)} ± ${b.delta.ci.toFixed(1)} ` +
      `[${b.delta.lo.toFixed(1)}, ${b.delta.hi.toFixed(1)}] ${b.verdict}`
  );
  if (analysis.ties.length > 0) {
    lines.push(
      `  ties within CI (statistically indistinguishable): steps ${analysis.ties.join(', ')}`
    );
  }
  for (const reg of analysis.regressions) {
    lines.push(
      `⚠️ REGRESSION: steps ${reg.steps.join(', ')} test significantly below the running best ` +
        `(step ${reg.refStep}, one-sided paired t vs its lower CI bound, k=${reg.steps.length} consecutive)`
    );
    if (ctx.tbHint) {
      lines.push(
        `  diagnose (don't just detect): join steps ${reg.steps[0]}..${reg.endStep} against ` +
          `${ctx.tbHint} (train/approx_kl, entropy_loss, value_loss)`
      );
    }
  }
  if (analysis.plateauStep != null) {
    lines.push(
      `Plateau onset: step ${analysis.plateauStep} — no significant paired gain in the ` +
        `following points (honest framing: per-1M gains below ~2–3 pp are undetectable at this budget)`
    );
  }
  if (analysis.divergence) {
    lines.push(
      `Divergence flag (descriptive, never gated): placement improved ${analysis.divergence.placementGain} ` +
        `while Δwin% moved ${analysis.divergence.winDeltaGain} — a Survivor-style drift signal ` +
        `(placement is field-stable; win% flips with field composition)`
    );
  }
  const runs = ctx.knobs?.runs ?? 20;
  lines.push('');
  lines.push(
    'Confirmation protocol (MANDATORY before any ship decision — the curve was selection):'
  );
  lines.push(
    `  1. Re-grade the argmax (and any regression-flagged neighbor) at a fresh seedbase ` +
      `offset >= the run count, ideally 2x runs:`
  );
  lines.push(
    `       npm run ppo:gate -- --weights ${ctx.evalDir ?? '<eval-dir>'}/eval-<step>.weights.js \\`
  );
  lines.push(
    `         --name ${checkpointName('<step>')} --seedbase ${(ctx.knobs?.seedBase ?? 0) + Math.max(100, runs)} --runs ${runs * 2}`
  );
  lines.push("     The fresh-seed number is the checkpoint's reported strength.");
  lines.push(
    '  2. Cross-check the top 1-2 checkpoints with `npm run arena:ml` — gate-field rank alone can mislead a ship decision.'
  );
  return lines;
}
