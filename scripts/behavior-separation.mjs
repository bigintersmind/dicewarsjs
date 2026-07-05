#!/usr/bin/env node

/**
 * Profile-Pairing Separation Matrix — CLI (PERSONAS §10.5, Wave-0 item 3)
 *
 * Consumes one or more `behavior:profile --json` reports (which persist per-run axis arrays)
 * and emits the pairwise separation matrix: every pair of profiled bots compared with a
 * paired per-axis Δ over the shared seed blocks, judged SEPARATED on an axis iff the paired-Δ
 * 95% CI excludes 0 (either direction) AND |Δ| ≥ the registered pairwise MDE — EVAL_HARNESS
 * §3.5's "paired-diff CI with MDE", deliberately NOT marginal-CI overlap. The §10.5 ship
 * requirement is that every shipped persona pair separates on ≥ 1 registered axis; the
 * pre-committed kill condition (a Predator that cannot separate from Survivor has no roster
 * slot) is judged from this matrix.
 *
 * Registered axes + MDEs (PERSONAS §10.5): aggression 0.3, turnsToWin 5.0, avgPlacement 0.4
 * (the calibrated DEFAULT_MDE values, `--mde`-overridable), and kills at the §10.3 RELATIVE
 * bar — 15% of the realized comparator's kills, comparator = the pair's lower-kills side over
 * the paired runs. An explicit `--mde kills:X` reverts kills to an absolute bar. Any override
 * of a separation-axis bar is a deviation from the registered protocol and is labeled loudly
 * (stderr WARNING + `config.mdeOverridden` + the gate verdict line).
 *
 * The `--require-separated` gate is scoped to the SHIPPED ROSTER, not just the signature
 * registry: §10.5's "every shipped pair" includes base×persona pairs, so the default roster
 * is the PERSONA_SIGNATURES names + the shipped base (Conqueror), intersected with the
 * selected bots. `--shipped A,B,...` names the roster explicitly (e.g. versioned arm names)
 * and hard-fails if a named roster bot is missing; a gate with fewer than 2 roster bots
 * exits 1 (a ship gate that gates nothing must fail loud, not pass). A non-comparable roster
 * pair fails the gate (fail closed).
 *
 * Pairing honesty: within one report all bots were profiled in an identical field over the
 * same seed blocks (§3.5 seed/map-level pairing — documented as such, not within-game).
 * Across MULTIPLE reports the script hard-fails on any config mismatch (runs/games/stride/
 * rotations/fieldSize/opponents/opponentSpecs/quarantine) and on git-SHA drift (§10.5:
 * cross-time "pairing" is not pairing — a code change can alter field-bot behavior on the
 * same seeds); `--allow-sha-drift` downgrades the SHA check to a warning for commits known
 * to be behavior-identical (e.g. docs-only).
 *
 * This is the §10.5 profile-pairing matrix, NOT the §3.5 "melee" mode (co-seating all
 * personas in one shared field), which remains a Phase-2b deferral.
 *
 * Usage:
 *   npm run behavior:profile -- --bots Blitz=...,Survivor=... --control Conqueror=... --json > profile.json
 *   npm run behavior:separation -- profile.json
 *   npm run behavior:separation -- waveA.json waveB.json --bots Blitz,Survivor,Predator --json
 *   npm run behavior:separation -- profile.json --require-separated   # exit 2 if a shipped pair fails
 *   npm run behavior:separation -- wave1.json --require-separated --shipped Blitz-v3,Survivor-v3,Conqueror
 *
 * Exit codes: 0 = matrix reported (and gate passed, if requested); 1 = usage/validation error
 * (including an ungateable --require-separated); 2 = --require-separated unmet.
 */

import fs from 'node:fs';

import { getArg, hasFlag } from './lib/cli-args.mjs';
import {
  separationPair,
  assertPairableReports,
  compareToControl,
  parseMdeOverrides,
  SEPARATION_AXES,
  KILLS_MDE_FRACTION,
  PERSONA_SIGNATURES,
  SHIPPED_BASE,
  DEFAULT_MDE,
  AXES,
} from './lib/behavior-core.mjs';

const args = process.argv.slice(2);
const log = (...a) => console.error(...a); // human output → stderr so --json owns stdout

// --- Parse args: positional report paths + a closed flag set ---
// getPositionalArg() assumes every --flag takes a value, which would swallow a report path
// after a boolean flag like --json — so collect positionals with an explicit flag inventory,
// which also rejects typo'd flags instead of silently reading them as report paths.
const USAGE =
  'Usage: behavior:separation <report.json> [more.json ...] [--bots A,B,...] ' +
  '[--mde axis:value,...] [--shipped A,B,...] [--json] [--require-separated] [--allow-sha-drift]';
const VALUE_FLAGS = new Set(['bots', 'mde', 'shipped']);
const BOOL_FLAGS = new Set(['json', 'require-separated', 'allow-sha-drift']);
const reportPaths = [];
const seenFlags = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    // Reject a repeated flag. getArg/hasFlag read only the FIRST occurrence, so a duplicate
    // value flag (e.g. `--mde aggression:1.5 --mde turnsToWin:8`) would silently drop the
    // second — reverting that axis to its DEFAULT bar with no error and no `mdeOverridden`
    // entry, which can flip the ship gate from FAIL to PASS while the operator believes both
    // overrides are in force. (The documented form is one comma-separated `--mde`.) Fail loud.
    if (seenFlags.has(name)) {
      console.error(`--${name} passed more than once. ${USAGE}`);
      process.exit(1);
    }
    seenFlags.add(name);
    if (VALUE_FLAGS.has(name)) {
      // Fail loud on a missing value: a trailing `--mde` (or `--mde --json`) would otherwise
      // be silently ignored by getArg's default fallback and the run would grade under
      // default thresholds while the operator believes an override is in force.
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
    continue;
  }
  reportPaths.push(a);
}
if (reportPaths.length === 0) {
  console.error(`Need at least one behavior:profile --json report. ${USAGE}`);
  process.exit(1);
}

const asJson = hasFlag(args, 'json');
const requireSeparated = hasFlag(args, 'require-separated');
const allowShaDrift = hasFlag(args, 'allow-sha-drift');

// MDEs: DEFAULT_MDE merged with overrides. Kills stays on the §10.3 relative bar UNLESS the
// user explicitly overrode it — detected by parsing the raw string over an empty base.
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
const relativeKills = !('kills' in explicitMde);

// Registered-protocol deviation tracking: the §10.5 pairwise bars are PRE-REGISTERED, so an
// explicit override on a separation axis (including switching kills off the §10.3 relative
// bar) is labeled loudly everywhere a verdict appears — a run at weakened bars must never
// read as the registered gate. (Overrides on non-separation axes affect nothing here.)
const mdeOverridden = SEPARATION_AXES.filter(axis =>
  axis === 'kills' ? !relativeKills : axis in explicitMde && explicitMde[axis] !== DEFAULT_MDE[axis]
);

// --- Load + validate the reports ---

const reports = reportPaths.map(p => {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    console.error(`Cannot read report "${p}": ${err.message}`);
    process.exit(1);
  }
  try {
    return { path: p, report: JSON.parse(raw) };
  } catch (err) {
    console.error(
      `"${p}" is not valid JSON (${err.message}) — expected a behavior:profile --json report.`
    );
    process.exit(1);
  }
});

let shaDrift;
try {
  ({ shaDrift } = assertPairableReports(reports));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (shaDrift) {
  if (!allowShaDrift) {
    console.error(
      `git-SHA drift across reports (${shaDrift}). Cross-time "pairing" is not pairing ` +
        `(PERSONAS §10.5): a code change between sessions can alter field-bot behavior on the ` +
        `same seeds. Re-profile everything in one session, or pass --allow-sha-drift if the ` +
        `commits are known behavior-identical (e.g. docs-only).`
    );
    process.exit(1);
  }
  log(
    `WARNING: pairing across git SHAs (${shaDrift}) — valid only if bot behavior is ` +
      `identical across those commits.`
  );
}

// --- Select bots ---

const allBots = reports.flatMap(({ path: p, report }) =>
  report.bots.map(b => ({
    name: b.name,
    perRun: b.perRun,
    liveRuns: b.liveRuns ?? null,
    weightsPath: b.weightsPath ?? null,
    from: p,
  }))
);
let selected = allBots;
const botsArg = (getArg(args, 'bots', '') ?? '').trim();
if (botsArg) {
  const want = botsArg
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (new Set(want).size !== want.length) {
    console.error(`--bots has duplicate names: [${want.join(', ')}].`);
    process.exit(1);
  }
  const byName = new Map(allBots.map(b => [b.name, b]));
  const missing = want.filter(n => !byName.has(n));
  if (missing.length) {
    console.error(
      `--bots names not found in the report(s): [${missing.join(', ')}]. ` +
        `Available: ${allBots.map(b => b.name).join(', ')}`
    );
    process.exit(1);
  }
  selected = want.map(n => byName.get(n));
}
if (selected.length < 2) {
  console.error(
    `Need >= 2 bots to pair (have ${selected.length}: ${selected.map(b => b.name).join(', ') || 'none'}).`
  );
  process.exit(1);
}

// --- The §10.5 ship-gate roster scope ---
// Default roster = the PERSONA_SIGNATURES names + the shipped base (SHIPPED_BASE): §10.5's
// "every shipped pair" includes base×persona pairs, and the base deliberately has no
// signature entry. --shipped names the roster explicitly (e.g. versioned arm names like
// Blitz-v3), which also turns a naming drift into a hard failure instead of a silently
// empty gate.
const shippedArg = (getArg(args, 'shipped', '') ?? '').trim();
if (shippedArg && !requireSeparated) {
  console.error('--shipped only scopes the --require-separated gate; pass both.');
  process.exit(1);
}
let rosterNames;
if (shippedArg) {
  const want = shippedArg
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (new Set(want).size !== want.length) {
    console.error(`--shipped has duplicate names: [${want.join(', ')}].`);
    process.exit(1);
  }
  const selectedNames = new Set(selected.map(b => b.name));
  const missing = want.filter(n => !selectedNames.has(n));
  if (missing.length) {
    console.error(
      `--shipped names not among the selected bots: [${missing.join(', ')}] — a ship gate ` +
        `that cannot see a roster bot must fail, not skip it. ` +
        `Selected: ${selected.map(b => b.name).join(', ')}`
    );
    process.exit(1);
  }
  rosterNames = want;
} else {
  const defaultRoster = new Set([...Object.keys(PERSONA_SIGNATURES), SHIPPED_BASE]);
  rosterNames = selected.map(b => b.name).filter(n => defaultRoster.has(n));
}
if (requireSeparated && rosterNames.length < 2) {
  console.error(
    `--require-separated has nothing to gate: shipped-roster bots among the selected are ` +
      `[${rosterNames.join(', ') || 'none'}] (default roster = the PERSONA_SIGNATURES names + ` +
      `${SHIPPED_BASE}; name versioned arms explicitly with --shipped A,B,...). A ship gate ` +
      `that gates nothing must fail loud, not pass.`
  );
  process.exit(1);
}

// --- Pair every unordered pair on the registered axes ---

const sharedConfig = reports[0].report.config;
const runCount = sharedConfig.runs;

const pairs = [];
for (let i = 0; i < selected.length; i++) {
  for (let j = i + 1; j < selected.length; j++) {
    const a = selected[i];
    const b = selected[j];
    const sep = separationPair(a.perRun, b.perRun, mde, { relativeKills });
    // Context for the human reading the matrix: the non-registered axes' paired Δs. These
    // NEVER count toward the separation verdict (only the registered axes do).
    const vs = compareToControl(a.perRun, b.perRun);
    const descriptive = AXES.filter(x => !SEPARATION_AXES.includes(x)).map(axis => {
      const c = vs[axis];
      return c
        ? { axis, delta: c.delta, ci: c.ci, lo: c.lo, hi: c.hi, n: c.n, verdict: c.verdict }
        : { axis, delta: null, ci: null, lo: null, hi: null, n: 0, verdict: null };
    });
    pairs.push({ a: a.name, b: b.name, ...sep, descriptive });
  }
}

// --- The §10.5 ship requirement over shipped-roster pairs ---

const rosterSet = new Set(rosterNames);
const rosterPairs = pairs.filter(p => rosterSet.has(p.a) && rosterSet.has(p.b));
// A non-comparable roster pair FAILS the gate: "could not measure separation" is not
// "separated" — the requirement fails closed, like every other gate in the harness.
const failingRosterPairs = rosterPairs.filter(p => !p.separated).map(p => `${p.a} × ${p.b}`);

const out = {
  config: {
    reports: reports.map(({ path: p, report }) => ({
      path: p,
      gitSha: report.config.gitSha ?? null,
      generatedAt: report.config.generatedAt ?? null,
    })),
    // The shared sweep config (validated identical across reports by assertPairableReports).
    runs: sharedConfig.runs,
    games: sharedConfig.games,
    stride: sharedConfig.stride,
    rotations: sharedConfig.rotations,
    fieldSize: sharedConfig.fieldSize,
    opponents: sharedConfig.opponents,
    quarantine: sharedConfig.quarantine?.on ?? null,
    separationAxes: SEPARATION_AXES,
    mde: {
      aggression: mde.aggression,
      turnsToWin: mde.turnsToWin,
      avgPlacement: mde.avgPlacement,
      kills: relativeKills
        ? { rule: 'relative', fraction: KILLS_MDE_FRACTION }
        : { rule: 'absolute', value: mde.kills },
    },
    // Separation axes whose bars deviate from the registered §10.5 protocol this run.
    mdeOverridden,
    deltaIs: 'a - b',
    bots: selected.map(b => ({
      name: b.name,
      from: b.from,
      weightsPath: b.weightsPath,
      liveRuns: b.liveRuns,
    })),
  },
  pairs,
  requireSeparated: requireSeparated
    ? {
        roster: rosterNames,
        mdeOverridden,
        failing: failingRosterPairs,
        pass: failingRosterPairs.length === 0,
      }
    : null,
};

if (asJson) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

// --- Human output (stderr) ---

const killsMdeLabel = relativeKills
  ? `kills ${KILLS_MDE_FRACTION * 100}% of comparator (§10.3)`
  : `kills ${mde.kills}`;
log(
  `Separation matrix — ${selected.length} bots, paired at seed level over ` +
    `${runCount} runs × ${sharedConfig.games} games × ${sharedConfig.rotations} rotations`
);
const axesLine =
  `aggression ${mde.aggression}, turnsToWin ${mde.turnsToWin}, ` +
  `avgPlacement ${mde.avgPlacement}, ${killsMdeLabel}`;
if (mdeOverridden.length) {
  log(`  effective MDEs (OVERRIDDEN — not the registered §10.5 bars): ${axesLine}`);
  log(
    `  WARNING: --mde overrides deviate from the registered §10.5 bars on ` +
      `[${mdeOverridden.join(', ')}] — this run does not grade the registered protocol.`
  );
} else {
  log(`  registered axes (§10.5): ${axesLine}`);
}
for (const { path: p, report } of reports) {
  log(
    `  report: ${p} (git ${report.config.gitSha ?? 'unknown'}, ${report.config.generatedAt ?? 'no timestamp'})`
  );
}
for (const b of selected) {
  if (b.liveRuns === 0) {
    log(`  WARNING: ${b.name} — 0 live runs in its report; every pair with it is incomparable.`);
  }
}
log('');

// Matrix grid: ✓ separated, ✗ comparable but not separated, — no comparable registered axis.
const pairByKey = new Map(pairs.map(p => [`${p.a}|${p.b}`, p]));
const cell = (rowName, colName) => {
  if (rowName === colName) return '·';
  const p = pairByKey.get(`${rowName}|${colName}`) ?? pairByKey.get(`${colName}|${rowName}`);
  if (!p.comparable) return '—';
  return p.separated ? '✓' : '✗';
};
const nameW = Math.max(...selected.map(b => b.name.length), 4) + 2;
const colW = Math.max(...selected.map(b => b.name.length), 3) + 2;
log([''.padEnd(nameW), ...selected.map(b => b.name.padStart(colW))].join(''));
for (const row of selected) {
  log(
    [row.name.padEnd(nameW), ...selected.map(col => cell(row.name, col.name).padStart(colW))].join(
      ''
    )
  );
}
log('');

// Per-pair detail: why each registered axis did/didn't separate, then non-registered movers.
for (const p of pairs) {
  if (!p.comparable) {
    log(`${p.a} × ${p.b}: NO COMPARABLE DATA on the registered axes (insufficient paired runs)`);
    continue;
  }
  const verdict = p.separated ? `SEPARATED on ${p.onAxes.join(', ')}` : 'NOT SEPARATED';
  const detail = p.axes
    .map(d => {
      if (d.delta == null) return `${d.axis} no data`;
      const why = d.separated
        ? '✓'
        : d.mde == null
          ? 'uncalibrated (comparator kills ≈ 0)'
          : !d.meetsMde
            ? `|Δ|<MDE(${d.mdeBasis === 'relative' ? d.mde.toFixed(3) : d.mde})`
            : 'CI∋0';
      const nNote = d.n < runCount ? ` n${d.n}` : '';
      return `${d.axis} Δ${d.delta.toFixed(2)} [${d.lo.toFixed(2)}, ${d.hi.toFixed(2)}]${nNote} ${why}`;
    })
    .join(' | ');
  log(`${p.a} × ${p.b}: ${verdict}`);
  log(`  ${detail}`);
  const movers = p.descriptive.filter(d => d.verdict && d.verdict !== 'SAME');
  if (movers.length) {
    log(
      `  also differs (descriptive): ${movers.map(d => `${d.axis} (Δ${d.delta.toFixed(2)})`).join(', ')}`
    );
  }
}

// --- The pre-committed §10.5 requirement gate ---
// rosterNames.length >= 2 was enforced pre-output, so there is always something to gate here.

if (requireSeparated) {
  log('');
  const overrideNote = mdeOverridden.length
    ? ' (at OVERRIDDEN MDEs — not the registered protocol)'
    : '';
  if (failingRosterPairs.length === 0) {
    log(
      `--require-separated: PASS${overrideNote} — every shipped-roster pair ` +
        `(${rosterNames.join(', ')}) separates on >= 1 registered axis.`
    );
  } else {
    log(
      `--require-separated: FAIL${overrideNote} — shipped pair(s) not separated: ` +
        `${failingRosterPairs.join('; ')} ` +
        `(§10.5: every shipped pair must separate on >= 1 registered axis at MDE).`
    );
    process.exit(2);
  }
}
