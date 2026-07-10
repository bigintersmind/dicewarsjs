#!/usr/bin/env node

/**
 * [D-29] strength-curve scorer (Phase 1 of docs/ml-bot/STRENGTH_CURVE.md).
 *
 * Walks a Phase-0 producer eval dir (`index.jsonl` + fixtured per-checkpoint
 * exports, emitted by `EvalCheckpointCallback` every `--eval-every` steps),
 * grades each checkpoint on the seat-fair gate (the exact `ppo:gate`
 * methodology via `runGateSweep`), and emits a strength-vs-steps curve:
 * `strength.jsonl` (one row per checkpoint, INCLUDING the per-run win% and
 * placement arrays that make cross-checkpoint tests run-paired) + optional CSV
 * + a `strength.meta.json` provenance sidecar, then prints the [D-29] analysis
 * (k=2 paired regression detector, k=3 plateau onset, argmax + winner's-curse
 * disclaimer, win%-vs-placement divergence flag).
 *
 * Runs out-of-band on the mini (CPU) while shodan trains — read-only on the
 * eval dir apart from its own outputs; never run it ON shodan mid-training.
 *
 * Usage:
 *   node scripts/ppo-strength-curve.mjs --eval-dir ml/runs/<run>/eval
 *   ... --runs 20 --games 150 --seedbase 0     # gate knobs (held constant across the curve)
 *   ... --ref Strategist                       # extra IN-FIELD reference tallies
 *                                              # (Lookahead + PPO are always tallied)
 *   ... --every-n 2 --max-points 1             # budget escape hatches (skips are logged)
 *   ... --watch --poll-sec 60                  # poll + grade incrementally + alert on regression
 *   ... --rsync-from shodan:/path/to/eval      # pull the eval dir before each walk
 *   ... --test-retest                          # re-grade the argmax once: harness-determinism check (0.00 post-#151)
 *   ... --out ml/runs/<run>/eval/strength.jsonl --csv
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { ENCODING_VERSION, SUPPORTED_ENCODING_VERSIONS } from '../src/arena/encodeObservation.js';
import { getArg, hasFlag } from './lib/cli-args.mjs';
import { loadExportedPolicy } from './lib/load-bc-policy.mjs';
import { LOOKAHEAD_PIN, buildGateField } from './lib/ppo-gate-core.mjs';
import {
  analyzeCurve,
  buildMeta,
  gradeCheckpoint,
  metaMismatches,
  parseIndex,
  planCurveWork,
  pointLine,
  readStrengthRows,
  renderAnalysis,
  toCsv,
  writeRowsAtomic,
} from './lib/strength-curve-core.mjs';

const args = process.argv.slice(2);

/** All values of a repeatable flag, comma-splitting each occurrence. */
function getAllArgs(name) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === `--${name}`) out.push(args[i + 1]);
  }
  return out
    .flatMap(v => v.split(','))
    .map(s => s.trim())
    .filter(Boolean);
}

function die(msg) {
  console.error(`\nCurve scorer aborted: ${msg}`);
  process.exit(1);
}

/**
 * Parse a JSON file, routing a torn (killed mid-write) or hand-edited file through
 * the clean `die()` abort instead of a raw SyntaxError — matching this scorer's
 * warn-and-skip stance on the index/rows it reads and CLAUDE.md's "surface errors
 * explicitly." Used for the meta sidecar, which is small enough that a partial
 * write is a real possibility.
 */
function readJsonOrDie(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(
      `${what} at ${path} is unreadable (${err.message}) — a torn or hand-edited file; delete it to regenerate.`
    );
    return null; // unreachable: die() exits.
  }
}

// --- Args -------------------------------------------------------------------------
const evalDir = getArg(args, 'eval-dir', null);
if (!evalDir) die('--eval-dir is required (a Phase-0 producer dir containing index.jsonl)');
const runs = parseInt(getArg(args, 'runs', '20'), 10);
const games = parseInt(getArg(args, 'games', '150'), 10);
const seedBase = parseInt(getArg(args, 'seedbase', '0'), 10);
const everyN = parseInt(getArg(args, 'every-n', '1'), 10);
const maxPoints = parseInt(getArg(args, 'max-points', '0'), 10);
const pollSec = parseInt(getArg(args, 'poll-sec', '60'), 10);
const watch = hasFlag(args, 'watch');
const wantCsv = hasFlag(args, 'csv');
const testRetest = hasFlag(args, 'test-retest');
const rsyncFrom = getArg(args, 'rsync-from', null);
const outPath = getArg(args, 'out', join(evalDir, 'strength.jsonl'));

if (!Number.isFinite(runs) || runs < 2)
  die('--runs must be an integer >= 2 (a CI needs >= 2 runs)');
if (!Number.isFinite(games) || games < 1) die('--games must be >= 1');
if (!Number.isFinite(seedBase)) die('--seedbase must be an integer');
if (!Number.isFinite(everyN) || everyN < 1) die('--every-n must be an integer >= 1');
if (!Number.isFinite(maxPoints) || maxPoints < 0) die('--max-points must be an integer >= 0');
if (!Number.isFinite(pollSec) || pollSec < 5) die('--poll-sec must be an integer >= 5');
if (watch && testRetest) {
  die(
    '--test-retest is a batch-mode calibration (it re-grades the current argmax once) — ' +
      'run it without --watch, once the curve is caught up'
  );
}

if (!existsSync(evalDir)) {
  if (rsyncFrom) {
    // The first rsync-pull will populate it — just make the destination exist.
    mkdirSync(evalDir, { recursive: true });
  } else {
    die(`--eval-dir ${evalDir} does not exist`);
  }
}

const csvPath = `${outPath.replace(/\.jsonl$/, '')}.csv`;
const metaPath = `${outPath.replace(/\.jsonl$/, '')}.meta.json`;
const knobs = { runs, games, seedBase, everyN };

/*
 * References come from IN the field, never as extra seats (growing the field
 * 9→10 changes seeds-per-run, rotations, and every bot's absolute win% —
 * invalidating comparability with every documented baseline). Lookahead (the
 * bar) is implicit; PPO (the shipped ppo-long flagship, seated since PR #74)
 * is the free second reference; --ref adds further in-field tallies only.
 */
const refNames = [...new Set(['PPO', ...getAllArgs('ref')])];
const probeField = buildGateField(BUILT_IN_BOTS, () => null, 'CP-probe');
const baseFieldNames = probeField.slice(0, -1).map(b => b.name);
for (const ref of refNames) {
  if (!baseFieldNames.includes(ref)) {
    die(
      `--ref "${ref}" is not an in-field bot — references are tallied IN-field, never seated ` +
        `(field: ${baseFieldNames.join(', ')})`
    );
  }
}

const gitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const deps = {
  loadPolicy: loadExportedPolicy,
  makeBot: makeBC,
  builtInBots: BUILT_IN_BOTS,
  matchFn: runMatch,
  supportedEncodingVersions: SUPPORTED_ENCODING_VERSIONS,
  onRunComplete: (done, total) => process.stdout.write(`\r  runs: ${done}/${total}`),
  onMatchError: ({ seed, rotation, error }) =>
    console.error(`\n[curve] match failed (seed ${seed}, rot ${rotation}): ${error.message}`),
};

const currentMeta = buildMeta({
  knobs,
  baseFieldNames,
  refNames,
  gitSha,
  encodingVersion: ENCODING_VERSION,
  lookaheadPin: LOOKAHEAD_PIN,
  evalDir,
});
const tbHint = join(dirname(evalDir.replace(/\/+$/, '')), 'tb', 'progress-*.csv');

// --- Helpers ----------------------------------------------------------------------

function syncEvalDir() {
  const src = `${rsyncFrom.replace(/\/+$/, '')}/`;
  const dst = `${evalDir.replace(/\/+$/, '')}/`;
  try {
    execFileSync('rsync', ['-az', src, dst], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    // Transient transport failure: grade what's local, loudly (the missing-
    // artifact retry rule keeps a partial sync safe under any copy order).
    console.error(`[curve] rsync-pull failed (${err.message}) — continuing with the local copy`);
  }
}

function ensureMetaCompatible() {
  if (!existsSync(metaPath)) {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, `${JSON.stringify(currentMeta, null, 2)}\n`);
    return currentMeta;
  }
  const existing = readJsonOrDie(metaPath, 'strength.meta.json');
  const { hard, gitShaDrift } = metaMismatches(existing, currentMeta);
  if (hard.length > 0) {
    die(
      `grading conditions differ from the existing curve at ${metaPath}:\n  - ${hard.join('\n  - ')}\n` +
        `Rows would not be comparable. Grade to a different --out (new curve), or restore the knobs.`
    );
  }
  if (gitShaDrift) {
    console.error(`[curve] note: git SHA drifted since the curve started (${gitShaDrift})`);
  }
  return existing;
}

function persist(rows) {
  writeRowsAtomic(
    outPath,
    [...rows].sort((a, b) => a.step - b.step)
  );
  if (wantCsv) writeFileSync(csvPath, toCsv(rows));
}

function loudRegressionAlert(slump) {
  const bar = '█'.repeat(74);
  console.error(`\n${bar}`);
  console.error(
    `█ REGRESSION ALERT: steps ${slump.steps.join(', ')} test significantly below the running best (step ${slump.refStep})`
  );
  console.error(`█ Diagnose: join that step range against ${tbHint}`);
  console.error(`█ (train/approx_kl, entropy_loss, value_loss — detect AND diagnose)`);
  console.error(bar);
}

/**
 * In-loop guard: stop early when the checkpoints graded THIS session are failing en
 * masse (a systematically broken producer/export stream). Scoped to session-fresh
 * rows on purpose — counting persisted historical failures would false-abort a
 * legitimately recovering resume (e.g. two stale parity-failed rows from a
 * since-fixed export bug + one fresh ok = 2/3 > 0.5). The "curve has zero usable
 * points" case is caught separately by the terminal guard, which keys on ok-count.
 */
function checkFailureThreshold(sessionRows) {
  const attempted = sessionRows.length;
  const failed = sessionRows.filter(r => r.status !== 'ok').length;
  if (attempted >= 3 && failed / attempted > 0.5) {
    die(
      `${failed}/${attempted} checkpoints graded this session failed (>50%) — the ` +
        `producer/export stream looks systematically broken; fix it before grading further.`
    );
  }
}

function encodingAbort(res) {
  const headline =
    res.reason === 'incompatible-widths'
      ? `checkpoint is stamped encodingVersion ${res.version} (supported) but its feature widths ` +
        `break the live encoder (ENCODING_VERSION ${ENCODING_VERSION}) — a layout/contract mismatch, ` +
        `not a version problem`
      : `checkpoint encodingVersion ${res.version} is outside SUPPORTED_ENCODING_VERSIONS ` +
        `[${SUPPORTED_ENCODING_VERSIONS.join(', ')}] (live ENCODING_VERSION ${ENCODING_VERSION})`;
  die(
    `${headline} — a property of the whole run, so nothing here is gradeable at HEAD. Re-export ` +
      `the stream from its .pt checkpoints with the matching exporter ` +
      `(python -m dicewars_bc.export_weights --ckpt <ckpt>.pt ...), or grade at the matching git SHA.${
        res.error ? `\nLoader said: ${res.error}` : ''
      }`
  );
}

// --- The walk ----------------------------------------------------------------------

/**
 * One full pass: sync → read index → drop rolled-back rows → grade what's new.
 * Returns { rows, indexCount, gradedNow, notSynced } for the caller's exit/alert logic.
 */
async function walkOnce({ alertOnRegression }) {
  if (rsyncFrom) syncEvalDir();

  const indexPath = join(evalDir, 'index.jsonl');
  if (!existsSync(indexPath)) {
    if (watch) {
      console.error(`[curve] ${indexPath} not there yet — retry next poll`);
      return { rows: null, indexCount: 0, gradedNow: 0, notSynced: 0 };
    }
    die(`no index.jsonl in ${evalDir} — is this a Phase-0 producer eval dir?`);
  }
  const { rows: indexRows, warnings: indexWarnings } = parseIndex(readFileSync(indexPath, 'utf8'));
  for (const w of indexWarnings) console.error(`[curve] ${w}`);

  const { rows: existingRows, warnings: rowWarnings } = readStrengthRows(outPath);
  for (const w of rowWarnings) console.error(`[curve] ${w}`);

  const plan = planCurveWork({ indexRows, existingRows, everyN, maxPoints });
  let rows = plan.kept;
  if (plan.dropped.length > 0) {
    console.error(
      `[curve] dropping ${plan.dropped.length} row(s) whose steps vanished from the index ` +
        `(trainer resume rolled them back): steps ${plan.dropped.map(r => r.step).join(', ')}`
    );
    persist(rows);
  }
  // Never silently skip: log every subsampled/deferred checkpoint.
  if (plan.skippedBySubsample.length > 0) {
    console.log(
      `[curve] --every-n ${everyN}: skipping ${plan.skippedBySubsample.length} checkpoint(s) ` +
        `(steps ${plan.skippedBySubsample.map(r => r.step).join(', ')})`
    );
  }
  if (plan.deferred.length > 0) {
    console.log(
      `[curve] --max-points ${maxPoints}: deferring ${plan.deferred.length} checkpoint(s) ` +
        `(next: step ${plan.deferred[0].step})`
    );
  }

  let gradedNow = 0;
  let notSynced = 0;
  const sessionRows = []; // graded THIS walk — the failure-threshold denominator
  for (const indexRow of plan.toGrade) {
    console.log(`[curve] grading ${indexRow.id} (step ${indexRow.step}) ...`);
    const res = await gradeCheckpoint({ indexRow, evalDir, knobs, refNames, gitSha, deps });
    process.stdout.write('\n');
    if (res.kind === 'not-synced') {
      notSynced++;
      console.log(
        `[curve] ${indexRow.id}: artifacts not yet synced (${res.missing.join(', ')}) — ` +
          `retry next ${watch ? 'poll' : 'walk'}`
      );
      continue;
    }
    if (res.kind === 'encoding-abort') encodingAbort(res);
    rows = [...rows, res.row];
    sessionRows.push(res.row);
    persist(rows);
    gradedNow++;
    console.log(`[curve] ${pointLine(res.row)}`);
    checkFailureThreshold(sessionRows);
    if (alertOnRegression && res.row.status === 'ok') {
      const analysis = analyzeCurve(rows, { indexSteps: plan.eligibleSteps });
      if (analysis.activeSlump) loudRegressionAlert(analysis.activeSlump);
    }
  }
  return {
    rows,
    indexCount: indexRows.length,
    gradedNow,
    notSynced,
    eligibleSteps: plan.eligibleSteps,
  };
}

function printSummary(rows, eligibleSteps) {
  if (!rows || rows.length === 0) return;
  console.log('');
  for (const row of [...rows].sort((a, b) => a.step - b.step)) console.log(pointLine(row));
  console.log('');
  const analysis = analyzeCurve(rows, { indexSteps: eligibleSteps });
  for (const line of renderAnalysis(analysis, { tbHint, knobs, evalDir })) {
    console.log(line);
  }
}

async function runTestRetest(rows) {
  const analysis = analyzeCurve(rows);
  if (!analysis.best) {
    console.error('[curve] --test-retest: no ok rows to re-grade');
    return;
  }
  const indexPath = join(evalDir, 'index.jsonl');
  const { rows: indexRows } = parseIndex(readFileSync(indexPath, 'utf8'));
  const indexRow = indexRows.find(r => r.step === analysis.best.step);
  if (!indexRow) {
    console.error('[curve] --test-retest: best step missing from index');
    return;
  }
  console.log(
    `[curve] test-retest: re-grading ${indexRow.id} at identical settings ` +
      `(same seeds — post-#151 every built-in is seed-pure, so this is a harness-determinism ` +
      `check: a same-commit retest is byte-identical, spread exactly 0) ...`
  );
  const res = await gradeCheckpoint({ indexRow, evalDir, knobs, refNames, gitSha, deps });
  process.stdout.write('\n');
  if (res.kind !== 'row' || res.row.status !== 'ok') {
    console.error(`[curve] test-retest failed: ${JSON.stringify(res.kind)}`);
    return;
  }
  const first = rows.find(r => r.step === indexRow.step);
  const spread = Math.abs(res.row.deltaVsLook.mean - first.deltaVsLook.mean);
  console.log(
    `[curve] test-retest: first Δlook ${first.deltaVsLook.mean}, retest ${res.row.deltaVsLook.mean}`
  );
  // Post-#151/[D-34] a same-commit retest must reproduce the row exactly. A nonzero spread has two
  // causes: reintroduced entropy (a Math.random bot / harness nondeterminism — investigate), or the
  // first grade ran at a DIFFERENT commit that changed behavior (this walker tolerates gitSha drift
  // across sessions with a note at startup). The message names both; enforcement lives in
  // behavior-preflight's NC1, which grades both arms in one process and has no cross-commit case.
  console.log(
    spread === 0
      ? `[curve] test-retest spread: 0.00 pp — byte-identical ✓ (harness determinism holds, [D-34])`
      : `[curve] test-retest spread: ${spread.toFixed(2)} pp — NONZERO: reintroduced entropy, ` +
          `or the first grade ran at a different commit (see the gitSha drift note, if any)`
  );
  const meta = readJsonOrDie(metaPath, 'strength.meta.json');
  meta.testRetest = {
    step: indexRow.step,
    first: first.deltaVsLook,
    retest: res.row.deltaVsLook,
    spreadPp: Number(spread.toFixed(2)),
    at: new Date().toISOString(),
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

// --- Main --------------------------------------------------------------------------

console.log(
  `[D-29] strength-curve scorer — eval dir ${evalDir}\n` +
    `knobs: ${runs} runs x ${games} games (seedbase ${seedBase}, held constant across the curve), ` +
    `refs in-field: Lookahead + ${refNames.join(', ')}\n` +
    `field (${baseFieldNames.length}+CP): ${baseFieldNames.join(', ')}\n` +
    `provenance: git ${gitSha}, encoding v${ENCODING_VERSION}, lookahead @${LOOKAHEAD_PIN}, out ${outPath}\n`
);

ensureMetaCompatible();

if (!watch) {
  const { rows, indexCount, gradedNow, notSynced, eligibleSteps } = await walkOnce({
    alertOnRegression: false,
  });
  if (indexCount === 0) die('index.jsonl has no parseable rows');
  /*
   * Fatal on ZERO usable (ok) points, not zero rows: a short all-failed stream (1-2
   * parity/sweep-failed rows never reaches checkFailureThreshold's >=3 floor) or a
   * resumed walk whose whole persisted curve is failed rows with nothing new to grade
   * would otherwise print "up to date" and exit 0 — the exact "a broken/unsynced
   * stream must not exit 0" case. (The rows===0 case is subsumed here.)
   */
  const okPoints = rows ? rows.filter(r => r.status === 'ok').length : 0;
  if (okPoints === 0) {
    const failed = rows ? rows.length : 0;
    die(
      `0 usable (ok) points of ${indexCount} index rows` +
        `${failed ? ` (${failed} recorded as failed)` : ''}` +
        `${notSynced ? ` (${notSynced} awaiting artifact sync)` : ''} — ` +
        `nothing gradeable; a broken/unsynced stream must not exit 0.`
    );
  }
  if (gradedNow === 0) console.log('[curve] up to date — no new checkpoints to grade');
  printSummary(rows, eligibleSteps);
  if (testRetest) await runTestRetest(rows);
} else {
  console.log(`[curve] watch mode: polling every ${pollSec}s (Ctrl-C for final summary)\n`);
  let latestRows = [];
  let latestEligible;
  process.on('SIGINT', () => {
    console.log('\n[curve] watch interrupted — final state:');
    printSummary(latestRows, latestEligible);
    process.exit(0);
  });
  for (;;) {
    const { rows, gradedNow, eligibleSteps } = await walkOnce({ alertOnRegression: true });
    if (rows) {
      latestRows = rows;
      latestEligible = eligibleSteps;
    }
    if (gradedNow > 0) {
      console.log(`[curve] ${gradedNow} new point(s) this poll`);
      printSummary(latestRows, latestEligible);
    }
    await new Promise(resolve => {
      setTimeout(resolve, pollSec * 1000);
    });
  }
}
