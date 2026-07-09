#!/usr/bin/env node

/**
 * Wave-1 launch pre-flight — #97 probe path + negative controls 1–2 (PERSONAS §10.7 item 5)
 *
 * The zero-GPU safety gate an operator runs BEFORE committing a persona-retrain wave. It bundles
 * the three pre-launch checks PERSONAS registers, and exits non-zero if any would let a broken
 * harness silently mis-grade a wave:
 *
 *  1. PROBE PRE-FLIGHT (#97 path). Only the fixtured [#97] `eval-<step>.weights.js` producer can
 *     feed the mid-run probe — league snapshots are fixture-less by design ([D-22]) and profiling
 *     hard-exits without a sibling fixture (DECISIONS: "an earlier plan's silent failure"). With
 *     `--weights`, the pre-flight (a) loads + parity-checks the checkpoint end-to-end through the
 *     exact `loadExportedPolicy → makeBC` path the probe uses, AND (b) asserts a fixture-LESS load
 *     is rejected loud — proving a snapshot can't silently slip into the probe. The A/A sweep below
 *     then runs the loaded net through the full profiling pipeline, so "profile one checkpoint
 *     end-to-end" is genuinely exercised, not just simulated.
 *
 *  2. NEGATIVE CONTROL 1 — A/A signature noise floor (§10.5). Profile the base against ITSELF —
 *     two passes at the SAME seeds — and judge each registered signature axis ({@link SIGNATURE_AXES})
 *     against the ±MDE/3 floor. NOT a raw |Δ| < MDE/3 point test: an axis CERTIFIES when its paired
 *     95% CI ⊆ ±MDE/3, and a Holm-significant self-difference BEYOND ±MDE/3 HALTs as BIASED (see
 *     `signatureNoiseFloor`). The base is deterministic and the maps are seeded; pre-#151 the two
 *     passes differed only by the heuristic opponents' unseeded Math.random — pairing over the
 *     shared maps cancels map variance and leaves the unseeded-opponent noise the paired signature
 *     GATE also cannot cancel (the same noise NC2 measures on the strength metric). Since #151
 *     seeded every built-in bot, a built-in field yields identical arms — the zero-noise path
 *     below — so the primary halt is now the [D-34] determinism tripwire: ANY same-seed divergence
 *     HALTS as reintroduced entropy, with BIASED layered on top for which-axis detail (a bug that
 *     makes one policy look like two). Only signature axes gate; descriptive axes carry more of that
 *     noise and are reported, never the halt criterion. The A/A runs the SAME `behavior-sweep`
 *     personas are graded on (extracted to a shared lib so it tests the real path, not a copy).
 *     Sample-health guards (summarizeAaSample) keep a degenerate A/A from reading as a clean bill:
 *     if a base LOADS but force-ends its games they are quarantined to NO DATA — that HALTS (the
 *     control could not run) rather than exiting 0 "uncertified". Post-#151 identical arms are the
 *     EXPECTED state (every built-in is seed-pure), so the invariant is enforced the other way
 *     around ([D-34]): `zeroNoise === false` — the same policy diverging from itself at identical
 *     seeds — HALTS as reintroduced entropy (a Math.random bot or harness nondeterminism). The
 *     Holm BIASED verdict cannot substitute: it detects a systematic mean shift and was built not
 *     to fire on symmetric noise, which is what entropy looks like.
 *
 *  3. NEGATIVE CONTROL 2 — test-retest noise floor. Already produced by `ppo:curve --test-retest`
 *     (STRENGTH_CURVE.md), which re-grades one checkpoint at identical settings and records the
 *     spread under `strength.meta.json` → `testRetest.spreadPp`. This pre-flight does NOT re-run it;
 *     with `--curve <strength.jsonl|.meta.json>` it surfaces the recorded floor, else it prints the
 *     command to produce it.
 *
 * Usage:
 *   npm run behavior:preflight -- --weights ml/runs/ppo-v3-scratch/eval/eval-020004864.weights.js
 *   npm run behavior:preflight -- --weights eval.weights.js --runs 12 --games 30 --curve strength.jsonl
 *   npm run behavior:preflight -- --bot Conqueror --json          # A/A a built-in (no #97 loader step)
 *
 * Exit codes: 0 = pre-flight CLEAR (all checks passed); 1 = usage/validation error; 2 = HALT — a
 * probe-path failure, a fixture-less input NOT rejected, an A/A that could not run, a same-seed
 * A/A divergence (reintroduced entropy, [D-34]), or a Holm-BIASED signature-floor violation.
 */

import fs from 'node:fs';

import { getArg, hasFlag } from './lib/cli-args.mjs';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { loadExportedPolicy, siblingFixturePath } from './lib/load-bc-policy.mjs';
import { sweepBot } from './lib/behavior-sweep.mjs';
import {
  signatureNoiseFloor,
  summarizeAaSample,
  parseMdeOverrides,
  SIGNATURE_AXES,
  DEFAULT_MDE,
} from './lib/behavior-core.mjs';

const args = process.argv.slice(2);
const log = (...a) => console.error(...a); // human output → stderr so --json owns stdout
/** Integer percentage n/d for the quarantine accounting; 'n/a' when no games were played. */
const pct = (n, d) => (d > 0 ? `${Math.round((100 * n) / d)}%` : 'n/a');

// --- Parse args: a closed flag inventory (no positionals) ------------------------------------
const USAGE =
  'Usage: behavior:preflight (--weights <eval-*.weights.js> | --bot <builtin>) ' +
  '[--fixture <path>] [--name <label>] [--opponents A,B,...] [--runs N] [--games N] ' +
  '[--divisor D] [--mde axis:value,...] [--curve <strength.jsonl|.meta.json>] ' +
  '[--no-quarantine] [--json]';
const VALUE_FLAGS = new Set([
  'weights',
  'bot',
  'fixture',
  'name',
  'opponents',
  'runs',
  'games',
  'divisor',
  'mde',
  'curve',
]);
const BOOL_FLAGS = new Set(['no-quarantine', 'json']);
const seenFlags = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) {
    console.error(`Unexpected argument "${a}" — behavior:preflight takes flags only. ${USAGE}`);
    process.exit(1);
  }
  const name = a.slice(2);
  // Reject a repeated flag: getArg reads only the FIRST occurrence, so a duplicate value flag
  // silently drops the later one (e.g. `--mde` reverting to defaults, or a second `--weights`
  // ignored) — a class of silent misconfiguration this gate exists to prevent. Fail loud.
  if (seenFlags.has(name)) {
    console.error(`--${name} passed more than once. ${USAGE}`);
    process.exit(1);
  }
  seenFlags.add(name);
  if (VALUE_FLAGS.has(name)) {
    // Fail loud on a missing value: a trailing `--mde` (or `--mde --json`) would otherwise be
    // silently ignored by getArg's default fallback and the run would proceed misconfigured.
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`--${name} requires a value. ${USAGE}`);
      process.exit(1);
    }
    i += 1;
  } else if (!BOOL_FLAGS.has(name)) {
    console.error(`Unknown flag --${name}. ${USAGE}`);
    process.exit(1);
  }
}

const weightsPath = getArg(args, 'weights', '');
const botName = getArg(args, 'bot', '');
if ((weightsPath === '') === (botName === '')) {
  console.error(`Provide exactly one of --weights <path> or --bot <builtin>. ${USAGE}`);
  process.exit(1);
}
const fixtureArg = getArg(args, 'fixture', '');
if (fixtureArg && !weightsPath) {
  console.error('--fixture only applies to --weights (a built-in --bot has no fixture).');
  process.exit(1);
}
const baseName = getArg(args, 'name', weightsPath ? 'Base' : botName);
// Number() (not parseInt) so a fat-fingered value fails loud at the guards below rather than being
// silently truncated to a smaller, under-powered A/A: Number('10,000')/'20xyz'/'2.5' → NaN/2.5, both
// rejected; parseInt would have read 10 / 20 / 2. Matches --divisor's strict Number() parse.
const runCount = Number(getArg(args, 'runs', '8'));
const gamesPerRun = Number(getArg(args, 'games', '20'));
const divisor = Number(getArg(args, 'divisor', '3'));
const quarantine = !hasFlag(args, 'no-quarantine');
const asJson = hasFlag(args, 'json');
const curvePath = getArg(args, 'curve', '');
const opponentNames = getArg(args, 'opponents', 'Default,Adaptive,Example,Expectimax,Lookahead')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// The A/A pairs arm A run i with arm B run i, so it needs ≥ 2 runs for a CI (compareAxis floor).
if (!Number.isInteger(runCount) || runCount < 2) {
  console.error(`--runs must be an integer ≥ 2 (the A/A needs ≥ 2 paired runs). ${USAGE}`);
  process.exit(1);
}
if (!Number.isInteger(gamesPerRun) || gamesPerRun < 1) {
  console.error(`--games must be a positive integer. ${USAGE}`);
  process.exit(1);
}
if (!Number.isFinite(divisor) || divisor <= 0) {
  console.error(`--divisor must be a positive number (registered §10.5 value is 3). ${USAGE}`);
  process.exit(1);
}
if (opponentNames.length < 1) {
  console.error(`Need at least one --opponents entry (the A/A field). ${USAGE}`);
  process.exit(1);
}

// MDEs: DEFAULT_MDE + overrides. An override on a SIGNATURE axis changes the registered §10.5 noise
// floor, so it is labeled loudly (heading + JSON) — a run at a non-registered tolerance must never
// read as the registered control.
let mde;
let explicitMde;
try {
  const raw = getArg(args, 'mde', '');
  mde = parseMdeOverrides(raw, DEFAULT_MDE);
  explicitMde = parseMdeOverrides(raw, {});
} catch (err) {
  console.error(`Invalid --mde: ${err.message}`);
  process.exit(1);
}
const mdeOverridden = SIGNATURE_AXES.filter(
  axis => axis in explicitMde && explicitMde[axis] !== DEFAULT_MDE[axis]
);
const divisorOverridden = divisor !== 3;

// --- Resolve the base bot + the #97 probe pre-flight -----------------------------------------

const byName = new Map(BUILT_IN_BOTS.map(b => [b.name.toLowerCase(), b]));
const halt = [];
let baseBot;
let probePreflight = null;
// Declared up front (not at their assignment sites): reportAndExit() can fire EARLY on a probe-path
// failure, before the A/A runs, and it reads them all — a `const` declared later would be in its TDZ.
let nc1 = null;
let nc1Sample = null;
let nc2 = null;

if (weightsPath) {
  const fixturePath = fixtureArg || siblingFixturePath(weightsPath);
  probePreflight = {
    ran: true,
    weightsPath,
    fixturePath,
    loaded: false,
    parity: null,
    params: null,
    fixturelessGuard: null,
    loadError: null,
  };
  // (a) POSITIVE: the fixtured checkpoint must load + parity-check end-to-end.
  let loaded;
  try {
    loaded = await loadExportedPolicy({ weightsPath, fixturePath, label: baseName });
    probePreflight.loaded = true;
    probePreflight.parity = loaded.parity;
    probePreflight.params = loaded.params;
  } catch (err) {
    // The probe path is broken for THIS checkpoint — grading it would fake a strength signal.
    probePreflight.loadError = err.message;
    halt.push(`probe pre-flight: checkpoint failed to load — ${err.message}`);
  }
  // (b) NEGATIVE: a fixture-LESS load must be rejected loud. This is the invariant that keeps
  // fixture-less league snapshots out of the probe; assert it fires in THIS build rather than
  // trusting it. Point at a guaranteed-absent fixture (no file is touched).
  if (probePreflight.loaded) {
    const absentFixture = `${weightsPath}.__preflight_absent__.fixture.json`;
    try {
      await loadExportedPolicy({ weightsPath, fixturePath: absentFixture, label: baseName });
      // Reached here ⇒ a fixture-less input was ACCEPTED. That is the exact silent failure this
      // gate guards against (a snapshot would feed the probe unchecked). HALT.
      probePreflight.fixturelessGuard = 'DID-NOT-FIRE';
      halt.push(
        'probe pre-flight: a fixture-less checkpoint was NOT rejected (silent-accept risk)'
      );
    } catch (err) {
      if (/parity fixture not found/.test(err.message)) {
        probePreflight.fixturelessGuard = 'fired';
      } else {
        // Rejected, but NOT by the intended "parity fixture not found" guard (load-bc-policy's
        // existsSync check). An incidental error — e.g. if that guard were refactored to a bare
        // readFileSync ENOENT — proves nothing about the snapshot guard this control certifies, so
        // fail loud (unreachable in the current loader, where the positive load already succeeded;
        // kept as a future-proof).
        probePreflight.fixturelessGuard = 'fired-other';
        halt.push(
          `probe pre-flight: the fixture-less load was rejected by an UNEXPECTED error ` +
            `(${err.message}) — the intended "parity fixture not found" guard did not fire, so the ` +
            `snapshot guard is not certified`
        );
      }
    }
    baseBot = { name: baseName, fn: makeBC({ policy: loaded.policy }) };
  }
} else {
  const builtin = byName.get(botName.toLowerCase());
  if (!builtin) {
    console.error(`--bot "${botName}" is not a built-in bot. ${USAGE}`);
    process.exit(1);
  }
  baseBot = { name: builtin.name, fn: builtin.fn };
}

// A probe-path failure is terminal: without a loadable base there is nothing to A/A.
if (!baseBot) {
  reportAndExit();
}

// --- Resolve the A/A opponent field ----------------------------------------------------------

const opponents = opponentNames.map(n => {
  const b = byName.get(n.toLowerCase());
  if (!b) {
    console.error(`--opponents entry "${n}" is not a built-in bot. ${USAGE}`);
    process.exit(1);
  }
  return { name: b.name, fn: b.fn };
});
if (opponents.some(o => o.name === baseBot.name)) {
  console.error(
    `The base "${baseBot.name}" also appears in --opponents; the profiled seat must be disjoint ` +
      `from the field. Rename with --name or drop it from --opponents.`
  );
  process.exit(1);
}

// --- Negative control 1: the A/A sweep -------------------------------------------------------

const fieldSize = opponents.length + 1;
const stride = Math.max(1_000_000, gamesPerRun * 1000);
const totalMatches = runCount * gamesPerRun * fieldSize * 2;

log(`Wave-1 launch pre-flight (PERSONAS §10.7 item 5) — base ${baseBot.name}`);
if (probePreflight) {
  log(
    `  #97 checkpoint: ${weightsPath}${
      probePreflight.loaded
        ? ` (${probePreflight.params.toLocaleString()} params, parity ${probePreflight.parity.toExponential(1)})`
        : ' (LOAD FAILED)'
    }`
  );
}
log(
  `  A/A field (${fieldSize} seats): [${baseBot.name}] + ${opponents.map(o => o.name).join(', ')}`
);
log(
  `  A/A sweep: ${runCount} runs × ${gamesPerRun} games × ${fieldSize} rot per arm ` +
    `(both arms SAME seeds — the maps cancel; post-#151 a fully-seeded built-in field yields ` +
    `identical arms, so the Δ is zero) — ${totalMatches} matches`
);
if (mdeOverridden.length || divisorOverridden) {
  log(
    `  ⚠ NON-REGISTERED noise floor: ${
      mdeOverridden.length ? `MDE overridden on [${mdeOverridden.join(', ')}]` : ''
    }${mdeOverridden.length && divisorOverridden ? '; ' : ''}${
      divisorOverridden ? `divisor ${divisor} (registered is 3)` : ''
    } — this is NOT the registered §10.5 A/A control.`
  );
}
log('');

// The two arms are the SAME sweep at the SAME seeds. Pre-#151, the heuristic opponents' unseeded
// Math.random advanced between the two passes, so arm B genuinely diverged — exactly the noise the
// paired signature gate cannot cancel. Since #151 seeded every built-in bot, a built-in field
// produces identical arms (zero noise) and the zeroNoise guard ENFORCES the A/A as a determinism
// tripwire ([D-34]): any divergence HALTs as reintroduced entropy. (A disjoint-seed A/A would
// re-inject full map variance and false-halt |Δ| at any feasible run count.)
const sweepOpts = { opponents, runCount, gamesPerRun, stride, quarantine };
const armA = sweepBot(baseBot, {
  ...sweepOpts,
  progress: run => process.stderr.write(`\r  A/A arm A: run ${run + 1}/${runCount}`),
});
log('');
const armB = sweepBot(baseBot, {
  ...sweepOpts,
  progress: run => process.stderr.write(`\r  A/A arm B: run ${run + 1}/${runCount}`),
});
log('');

nc1 = signatureNoiseFloor(armA.perRun, armB.perRun, mde, { divisor });
// Sample health: a base that LOADS but force-ends its games gets them quarantined, collapsing every
// axis to NO DATA — without this the pre-flight would exit 0 "CLEAR (uncertified)" on exactly the
// broken harness it exists to catch. summarizeAaSample folds the two arms' quarantine/live-run counts
// (sweepBot already returns them; the A/A had dropped them) into a HALT-if-uninformative flag and the
// [D-34] zeroNoise determinism flag (enforced as a halt below), mirroring behavior-profile's
// per-arm accounting.
nc1Sample = summarizeAaSample(armA, armB, nc1);
if (nc1Sample.insufficient) {
  // The negative control could not run: too few games survived quarantine to form a paired CI on any
  // signature axis. That is NOT a clean bill — HALT rather than emit the soft "CLEAR (uncertified)".
  halt.push(
    `negative control 1 (A/A): could not run — only ` +
      `${Math.min(nc1Sample.liveRunsA, nc1Sample.liveRunsB)}/${runCount} live paired run(s) after ` +
      `quarantine (arm A ${pct(armA.quarantined, armA.played)}, arm B ` +
      `${pct(armB.quarantined, armB.played)} of games quarantined) — the base force-ends games or ` +
      `the field is broken; the harness noise floor is unverified.`
  );
} else {
  if (!nc1Sample.zeroNoise) {
    // [D-34] harness-determinism tripwire. Post-#151 every built-in is seed-pure and the base is
    // argmax-deterministic (parity-checked above), so the two same-seed arms must be IDENTICAL —
    // any divergence at all is reintroduced entropy (a Math.random call in a bot or the harness,
    // or state leaking between the arms). The Holm BIASED check below CANNOT catch this: entropy
    // is symmetric (~zero mean) and the criterion was built not to fire on it — a small entropy
    // source would even read CERTIFIED. So the zero-noise invariant itself is the halt condition.
    halt.push(
      `negative control 1 (A/A): the two same-seed arms DIVERGED — since #151 every built-in is ` +
        `seed-pure, so ANY nonzero self-Δ means reintroduced entropy (a Math.random call in a ` +
        `bot or the harness, or cross-arm state leakage) — the [D-34] determinism tripwire`
    );
  }
  if (!nc1.pass) {
    // A BIASED axis also halts — a signature-sized self-difference with Holm-significant
    // (family-wise) evidence it is real, i.e. a harness bug that makes one policy look like two.
    // Any divergence already fires the entropy halt above (zeroNoise requires delta 0 AND ci 0, so
    // even a constant offset trips it); BIASED is kept for the which-axis, how-big detail that
    // turns "something diverged" into a debuggable lead. INCONCLUSIVE / NO DATA never halt.
    halt.push(
      `negative control 1 (A/A): [${nc1.biased.join(', ')}] show a signature-sized self-difference ` +
        `(harness bias — the base differs from itself beyond MDE/${divisor})`
    );
  }
}

// --- Negative control 2: read the recorded test-retest floor (if provided) -------------------

nc2 = readTestRetest(curvePath);

// --- Report ----------------------------------------------------------------------------------

reportAndExit();

// --- helpers ---------------------------------------------------------------------------------

/**
 * Read the `ppo:curve --test-retest` noise floor. Accepts the strength.jsonl OR its sibling
 * meta.json (where `runTestRetest` records `testRetest.spreadPp`). Never throws — a missing/unread
 * curve just means NC2 wasn't produced yet, which the report says out loud.
 */
function readTestRetest(p) {
  if (!p) {
    return {
      source: null,
      testRetest: null,
      note: 'not provided — produce it with `npm run ppo:curve -- --eval-dir <dir> --test-retest`',
    };
  }
  const metaPath = p.endsWith('.meta.json') ? p : p.replace(/\.jsonl$/, '.meta.json');
  if (!fs.existsSync(metaPath)) {
    return { source: metaPath, testRetest: null, note: `no meta sidecar at ${metaPath}` };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.testRetest && Number.isFinite(meta.testRetest.spreadPp)) {
      return { source: metaPath, testRetest: meta.testRetest, note: null };
    }
    return {
      source: metaPath,
      testRetest: null,
      note: 'meta sidecar has no testRetest — re-run `ppo:curve --test-retest`',
    };
  } catch (err) {
    return { source: metaPath, testRetest: null, note: `unreadable meta: ${err.message}` };
  }
}

function reportAndExit() {
  const result = {
    config: {
      base: {
        name: baseBot?.name ?? baseName,
        weightsPath: weightsPath || null,
        params: probePreflight?.params ?? null,
        parity: probePreflight?.parity ?? null,
      },
      opponents: opponentNames,
      runs: runCount,
      games: gamesPerRun,
      divisor,
      quarantine,
      signatureAxes: SIGNATURE_AXES,
      mde: Object.fromEntries(SIGNATURE_AXES.map(a => [a, mde[a]])),
      mdeOverridden,
      divisorOverridden,
    },
    probePreflight,
    nc1,
    nc1Sample,
    nc2,
    halt: halt.length > 0,
    reasons: halt,
  };

  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  // Probe pre-flight block.
  if (probePreflight) {
    log('Probe pre-flight (#97 path):');
    log(
      probePreflight.loaded
        ? `  ✓ fixtured checkpoint loads + parity-checks (${probePreflight.parity.toExponential(1)})`
        : `  ✗ checkpoint FAILED to load — ${probePreflight.loadError}`
    );
    if (probePreflight.fixturelessGuard === 'fired') {
      log('  ✓ fixture-less input rejected loud — a snapshot cannot silently feed the probe');
    } else if (probePreflight.fixturelessGuard === 'fired-other') {
      log(
        '  ✗ fixture-less input rejected by an UNEXPECTED error — the intended guard did not fire'
      );
    } else if (probePreflight.fixturelessGuard === 'DID-NOT-FIRE') {
      log('  ✗ fixture-less input was ACCEPTED — the snapshot guard is broken');
    }
    log('');
  }

  // NC1 block.
  if (nc1) {
    log(
      `Negative control 1 — A/A signature noise floor (Holm-corrected, 95% CI vs ±MDE/${divisor}):`
    );
    log(
      [
        '  axis'.padEnd(16),
        'Δ (A−B)'.padStart(18),
        'tol'.padStart(10),
        'verdict'.padStart(14),
      ].join('')
    );
    for (const r of nc1.axes) {
      const d =
        r.delta == null
          ? '—'
          : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)}${r.ci != null ? `±${r.ci.toFixed(3)}` : ''}`;
      log(
        [
          `  ${r.axis.padEnd(14)}`,
          d.padStart(18),
          r.tol.toFixed(3).padStart(10),
          r.verdict.padStart(14),
        ].join('')
      );
    }
    if (nc1Sample) {
      const arm = (live, played, quar) =>
        `${live}/${runCount} live${quar > 0 ? ` (${quar}/${played} games quarantined)` : ''}`;
      log(
        `  sample: arm A ${arm(nc1Sample.liveRunsA, nc1Sample.playedA, nc1Sample.quarantinedA)}; ` +
          `arm B ${arm(nc1Sample.liveRunsB, nc1Sample.playedB, nc1Sample.quarantinedB)}`
      );
    }
    const uncertified = [...nc1.inconclusive, ...nc1.noData];
    if (uncertified.length) {
      // When quarantine (not thin sampling) starved the axes, "add runs" is the WRONG remedy — more
      // games just get force-ended too. Point at the real cause when either arm lost games. And when
      // the arms diverged at all (the [D-34] entropy halt below), wide CIs are a SYMPTOM of the
      // entropy, not thin sampling — more runs won't fix that either.
      const starved = nc1Sample && (nc1Sample.quarantinedA > 0 || nc1Sample.quarantinedB > 0);
      const diverged = nc1Sample && !nc1Sample.insufficient && !nc1Sample.zeroNoise;
      const remedy = diverged
        ? 'the arms diverged (see HALT below) — find the entropy source; more runs will not certify'
        : starved
          ? 'games were quarantined (forced-end) — fix the base/field so games complete, not just more runs'
          : 'increase --runs/--games to certify their floor';
      log(
        `  NOTE: [${uncertified.join(', ')}] not yet CERTIFIED (CI too wide / no winners) — ` +
          `${remedy}.${diverged ? '' : ' Not a bias, does not halt.'}`
      );
    }
    if (nc1Sample?.zeroNoise) {
      // Arm A ≡ arm B — the [D-34] expected state (every built-in seed-pure since #151). CERTIFIED
      // is vacuous as a noise floor; what the A/A certifies is harness determinism.
      log(
        '  ✓ the A/A arms are IDENTICAL (every signature axis Δ = 0, zero-width CI) — expected ' +
          'since #151 seeded every built-in bot. CERTIFIED is vacuous as a noise floor; the A/A ' +
          'instead certifies harness determinism ([D-34]).'
      );
    }
    if (nc1Sample?.insufficient) {
      log('  → NC1 HALT: the A/A could not run — too few games survived quarantine (see sample)');
    } else if (nc1Sample && !nc1Sample.zeroNoise) {
      log(
        '  → NC1 HALT: the same-seed arms DIVERGED — reintroduced entropy ' +
          `([D-34] determinism tripwire)${nc1.pass ? '' : `; Holm-BIASED: [${nc1.biased.join(', ')}]`}`
      );
    } else if (!nc1.pass) {
      log(`  → NC1 HALT: [${nc1.biased.join(', ')}] show a signature-sized self-difference (bias)`);
    } else if (nc1.certified) {
      log('  → NC1 PASS — every signature axis CERTIFIED within the floor');
    } else {
      log('  → NC1 PASS (no bias) — but not all axes certified; see NOTE');
    }
    log('');
  }

  // NC2 block. Surfaces a RECORDED spread whose provenance this script can't see (it may predate
  // #151, or the retest may have crossed a behavior-changing commit — ppo:curve tolerates gitSha
  // drift with a note). So a nonzero recording gets the [D-34] read but not a halt; the enforced
  // same-process determinism tripwire is NC1 above.
  log('Negative control 2 — test-retest noise floor:');
  if (nc2?.testRetest) {
    log(`  spread ${nc2.testRetest.spreadPp} pp at step ${nc2.testRetest.step} (${nc2.source})`);
    if (nc2.testRetest.spreadPp !== 0) {
      log(
        '  ⚠ nonzero — post-#151 a same-commit retest is byte-identical (spread 0.00): this ' +
          'recording either predates #151/crossed commits, or entropy was live when it was taken ' +
          '([D-34]). Re-run `ppo:curve --test-retest` at the current commit to tell which.'
      );
    }
  } else {
    log(`  ${nc2?.note ?? 'not run'}`);
  }
  log('');

  if (halt.length) {
    log(`PRE-FLIGHT HALT — do NOT launch the wave:`);
    for (const r of halt) log(`  • ${r}`);
    process.exit(2);
  }
  if (nc1Sample?.zeroNoise) {
    // The [D-34] expected state: identical arms. The honest "cleared" message names what the A/A
    // actually certified — harness determinism, not a noise floor (which no longer exists to measure).
    log(
      'PRE-FLIGHT CLEAR — the A/A arms are identical (see ✓ above): with a fully seeded field ' +
        '(all built-ins since #151) NC1 certifies harness determinism rather than a noise floor ' +
        '([D-34]); a divergence would have HALTed as reintroduced entropy.'
    );
  } else if (nc1 && !nc1.certified) {
    log(
      'PRE-FLIGHT CLEAR (no harness bias) — but some signature axes are uncertified (see NOTE); ' +
        'add runs to certify their floor before trusting those signatures.'
    );
  } else {
    log('PRE-FLIGHT CLEAR — the probe path and negative controls pass; cleared for Wave-1 launch.');
  }
  process.exit(0);
}
