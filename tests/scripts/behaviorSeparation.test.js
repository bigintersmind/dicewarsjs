/**
 * behavior-separation CLI — the §10.5 profile-pairing separation matrix.
 *
 * The input is a JSON file, so nearly every CLI path is pinned with SYNTHETIC reports
 * (fast — no arena games): the validation exits, the sha-drift policy, bot selection,
 * the JSON/stderr output shape, and the --require-separated exit code. One real
 * end-to-end at the bottom pins the only seam synthetic data can't reach: a live
 * behavior:profile --json report flowing into the separation script unmodified.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AXES } from '../../scripts/lib/behavior-core.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');

function run(args, { timeout = 30000 } = {}) {
  const res = spawnSync('node', ['scripts/behavior-separation.mjs', ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status };
}

// --- Synthetic reports ---

const CONFIG = {
  runs: 4,
  games: 2,
  rotations: 3,
  stride: 1_000_000,
  reference: 'Default',
  control: 'Base',
  opponents: ['Default', 'Example'],
  opponentSpecs: [
    { name: 'Default', weightsPath: null },
    { name: 'Example', weightsPath: null },
  ],
  fieldSize: 3,
  generatedAt: '2026-07-05T00:00:00.000Z',
  gitSha: 'abc1234',
  mde: {},
  quarantine: { on: true, rate: 0, ratePerBot: {} },
};

/** Full per-run records: every axis gets a plausible constant + per-run jitter, overridable. */
const perRunOf = (over = {}) => {
  const base = {
    winPct: [25, 30, 20, 25],
    aggression: [2.5, 2.55, 2.45, 2.5],
    captureEfficiency: [0.7, 0.71, 0.69, 0.7],
    avgDiceReserve: [9, 9.2, 8.8, 9],
    avgTerritory: [8, 8.1, 7.9, 8],
    dicePerTerritory: [1.2, 1.25, 1.15, 1.2],
    largestGroup: [6, 6.1, 5.9, 6],
    kills: [1.0, 1.05, 0.95, 1.0],
    turnsToWin: [40, 42, 38, 40],
    survivalTurn: [60, 62, 58, 60],
    zeroAttackTurnFrac: [0.1, 0.11, 0.09, 0.1],
    avgPlacement: [2.5, 2.55, 2.45, 2.5],
    truncationRate: [0.05, 0.06, 0.04, 0.05],
    nearCapDeathRate: [0.02, 0.03, 0.01, 0.02],
    lateGameAggressionSpike: [0.1, 0.15, 0.05, 0.1],
    killVictimTerr: [2.0, 2.1, 1.9, 2.0],
    killVictimOneTerrTurns: [1.0, 1.1, 0.9, 1.0],
    killVictimOneTerrFrac: [0.1, 0.12, 0.08, 0.1],
    ...over,
  };
  return Array.from({ length: CONFIG.runs }, (_, i) =>
    Object.fromEntries(AXES.map(a => [a, base[a][i]]))
  );
};

const mkBot = (name, over = {}) => ({
  name,
  weightsPath: null,
  liveRuns: CONFIG.runs,
  perRun: perRunOf(over),
});

// A fully-quarantined bot: right-shaped perRun records but every axis null, 0 live runs.
const mkNullBot = name => ({
  name,
  weightsPath: null,
  liveRuns: 0,
  perRun: Array.from({ length: CONFIG.runs }, () => Object.fromEntries(AXES.map(a => [a, null]))),
});

const mkReport = (bots, configOver = {}) => ({ config: { ...CONFIG, ...configOver }, bots });

// A Blitz that clearly separates from the base profile on aggression (Δ≈+0.55 ≥ MDE 0.3).
const BLITZY = { aggression: [3.0, 3.2, 2.9, 3.1] };
// A Survivor that separates on avgPlacement (Δ≈−0.55, |Δ| ≥ MDE 0.4).
const SURVIVORY = { avgPlacement: [1.95, 2.0, 1.9, 1.95] };

let dir;
let file = 0;
const writeReport = report => {
  const p = path.join(dir, `report-${(file += 1)}.json`);
  writeFileSync(p, JSON.stringify(report));
  return p;
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'behavior-separation-'));
});

describe('behavior-separation CLI — validation exits (no games ever run)', () => {
  it('rejects an empty invocation with usage', () => {
    const { stderr, exitCode } = run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Need at least one behavior:profile --json report/);
  });

  it('rejects an unknown flag instead of misreading it (or its value) as a report path', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stderr, exitCode } = run([p, '--holm-family', '5']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown flag --holm-family/);
  });

  it('rejects a missing report file', () => {
    const { stderr, exitCode } = run([path.join(dir, 'nope.json')]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Cannot read report/);
  });

  it('rejects a non-JSON report file', () => {
    const p = path.join(dir, 'not-json.json');
    writeFileSync(p, 'not json {');
    const { stderr, exitCode } = run([p]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not valid JSON/);
  });

  it('rejects a report without per-run arrays (pre-separation format)', () => {
    const r = mkReport([mkBot('A'), mkBot('B')]);
    delete r.bots[0].perRun;
    const { stderr, exitCode } = run([writeReport(r)]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no per-run arrays/);
  });

  it('rejects a cross-report config mismatch', () => {
    const a = writeReport(mkReport([mkBot('A')]));
    const b = writeReport(mkReport([mkBot('B')], { games: 99 }));
    const { stderr, exitCode } = run([a, b]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/config mismatch on "games"/);
  });

  it('rejects the same bot name in two reports', () => {
    const a = writeReport(mkReport([mkBot('A')]));
    const b = writeReport(mkReport([mkBot('A')]));
    const { stderr, exitCode } = run([a, b]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/appears in both/);
  });

  it('hard-fails on git-SHA drift, and --allow-sha-drift downgrades it to a warning', () => {
    const a = writeReport(mkReport([mkBot('A')]));
    const b = writeReport(mkReport([mkBot('B')], { gitSha: 'fff9999' }));
    const hard = run([a, b]);
    expect(hard.exitCode).toBe(1);
    expect(hard.stderr).toMatch(/git-SHA drift across reports/);
    expect(hard.stderr).toMatch(/not pairing/);
    const soft = run([a, b, '--allow-sha-drift']);
    expect(soft.exitCode).toBe(0);
    expect(soft.stderr).toMatch(/WARNING: pairing across git SHAs/);
  });

  it('rejects unknown and duplicate --bots names', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const unknown = run([p, '--bots', 'A,Nope']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toMatch(/--bots names not found.*\[Nope\]/);
    const dup = run([p, '--bots', 'A,A']);
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toMatch(/duplicate names/);
  });

  it('rejects a selection of fewer than 2 bots', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stderr, exitCode } = run([p, '--bots', 'A']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Need >= 2 bots to pair/);
  });

  it('rejects an invalid --mde (the shared gate-collapse guard)', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stderr, exitCode } = run([p, '--mde', 'kills:0']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Invalid --mde/);
  });

  it('rejects a value flag with no value — a trailing --mde must not silently revert to defaults', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    for (const argv of [
      [p, '--mde'],
      [p, '--bots'],
      [p, '--mde', '--json'], // the next flag is not a value
    ]) {
      const { stderr, exitCode } = run(argv);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/requires a value/);
    }
  });

  it('rejects the equals form (--mde=kills:0.5) loudly rather than silently dropping the override', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stderr, exitCode } = run([p, '--mde=kills:0.5']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown flag/);
  });

  it('rejects a repeated flag — getArg reads only the first, so a dropped 2nd could flip the gate', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    // A duplicate value flag: only the first --mde would be read, silently reverting the other
    // axis to its default bar (the gate-weakening the parser now closes).
    const dupMde = run([p, '--mde', 'aggression:1.5', '--mde', 'turnsToWin:8']);
    expect(dupMde.exitCode).toBe(1);
    expect(dupMde.stderr).toMatch(/--mde passed more than once/);
    // Also uniform across --bots and repeated booleans.
    expect(run([p, '--bots', 'A,B', '--bots', 'A']).stderr).toMatch(/--bots passed more than once/);
    expect(run([p, '--json', '--json']).stderr).toMatch(/--json passed more than once/);
  });

  it('rejects a report whose perRun entries are corrupt (null elements) with a validation message', () => {
    const r = mkReport([mkBot('A'), mkBot('B')]);
    r.bots[0].perRun = [null, null, null, null];
    const { stderr, exitCode } = run([writeReport(r)]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/malformed bots\[\]\.perRun entry/);
  });
});

describe('behavior-separation CLI — matrix output (synthetic reports)', () => {
  it('emits the full JSON shape and the stderr matrix for a separating pair', () => {
    const p = writeReport(mkReport([mkBot('Blitz', BLITZY), mkBot('Base')]));
    const { stdout, stderr, exitCode } = run([p, '--json']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.config.separationAxes).toEqual([
      'aggression',
      'turnsToWin',
      'avgPlacement',
      'kills',
    ]);
    expect(out.config.mde.kills).toEqual({ rule: 'relative', fraction: 0.15 });
    expect(out.config.deltaIs).toBe('a - b');
    expect(out.config.reports[0].gitSha).toBe('abc1234');
    expect(out.pairs).toHaveLength(1);
    const pair = out.pairs[0];
    expect([pair.a, pair.b].sort()).toEqual(['Base', 'Blitz']);
    expect(pair.separated).toBe(true);
    expect(pair.onAxes).toEqual(['aggression']);
    expect(pair.axes.map(d => d.axis)).toEqual([
      'aggression',
      'turnsToWin',
      'avgPlacement',
      'kills',
    ]);
    // Descriptive axes are the non-registered rest, and never count toward the verdict.
    expect(pair.descriptive.map(d => d.axis)).toEqual(
      AXES.filter(a => !['aggression', 'turnsToWin', 'avgPlacement', 'kills'].includes(a))
    );
    expect(stderr).toMatch(/Separation matrix — 2 bots/);
    expect(stderr).toMatch(/Blitz × Base: SEPARATED on aggression/);
  });

  it('pairs across two same-config same-SHA reports (the split-session flow)', () => {
    const a = writeReport(mkReport([mkBot('Blitz', BLITZY)]));
    const b = writeReport(mkReport([mkBot('Base')]));
    const { stdout, exitCode } = run([a, b, '--json']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.config.reports).toHaveLength(2);
    expect(out.pairs[0].separated).toBe(true);
  });

  it('pairs reports that differ only in mde/control/reference (deliberately excluded from identity)', () => {
    const a = writeReport(mkReport([mkBot('Blitz', BLITZY)]));
    const b = writeReport(
      mkReport([mkBot('Base')], {
        control: 'Defensive',
        reference: 'Example',
        mde: { kills: { rule: 'absolute', value: 0.5 } },
      })
    );
    const { exitCode } = run([a, b, '--json']);
    expect(exitCode).toBe(0);
  });

  it('an identical -dirty SHA stamp across reports is drift (two dirty trees are not provably identical)', () => {
    const a = writeReport(mkReport([mkBot('A')], { gitSha: 'abc1234-dirty' }));
    const b = writeReport(mkReport([mkBot('B')], { gitSha: 'abc1234-dirty' }));
    const { stderr, exitCode } = run([a, b]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/git-SHA drift/);
  });

  it('labels overridden separation-axis MDEs loudly and records them in the JSON', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stdout, stderr, exitCode } = run([p, '--json', '--mde', 'aggression:0.05']);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/OVERRIDDEN — not the registered §10\.5 bars/);
    expect(stderr).toMatch(/WARNING: --mde overrides deviate .* \[aggression\]/);
    const out = JSON.parse(stdout);
    expect(out.config.mdeOverridden).toEqual(['aggression']);
    // The unoverridden run stays labeled registered (pinned by the shape test above via
    // 'registered axes (§10.5)').
  });

  it('a fully-quarantined bot yields NO COMPARABLE DATA, a — matrix cell, and the 0-live-runs warning', () => {
    const p = writeReport(mkReport([mkNullBot('Predator'), mkBot('Survivor', SURVIVORY)]));
    const { stdout, stderr, exitCode } = run([p, '--json']);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/WARNING: Predator — 0 live runs/);
    expect(stderr).toMatch(/Predator × Survivor: NO COMPARABLE DATA/);
    expect(stderr).toMatch(/—/);
    const out = JSON.parse(stdout);
    expect(out.pairs[0].comparable).toBe(false);
    expect(out.pairs[0].separated).toBe(false);
  });

  it('--mde kills:0.5 reverts kills to an absolute bar (recorded in config), flagged as an override', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stdout, stderr, exitCode } = run([p, '--json', '--mde', 'kills:0.5']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.config.mde.kills).toEqual({ rule: 'absolute', value: 0.5 });
    expect(out.pairs[0].axes.find(d => d.axis === 'kills').mdeBasis).toBe('absolute');
    // Switching kills OFF the §10.3 relative bar is a registered-protocol deviation and must be
    // labeled — mdeOverridden is the only machine-readable signal a PASS wasn't the §10.5 gate.
    expect(out.config.mdeOverridden).toEqual(['kills']);
    expect(stderr).toMatch(/OVERRIDDEN — not the registered §10\.5 bars/);
    expect(stderr).toMatch(/WARNING: --mde overrides deviate .* \[kills\]/);
  });

  it("a boolean flag before the report path does not swallow it (the parser's reason to exist)", () => {
    // getPositionalArg would treat --json as consuming the next token; the explicit inventory
    // must instead read the path as a positional. Pin it: flag-first still produces the matrix.
    const p = writeReport(mkReport([mkBot('Blitz', BLITZY), mkBot('Survivor', SURVIVORY)]));
    const flagFirst = run(['--json', p]);
    expect(flagFirst.exitCode).toBe(0);
    expect(JSON.parse(flagFirst.stdout).pairs).toHaveLength(1);
    // The same for a boolean flag in the gate path (Blitz×Survivor both separate → PASS exit 0).
    expect(run(['--require-separated', p]).exitCode).toBe(0);
  });

  it('near-identical profiles do NOT separate', () => {
    const p = writeReport(mkReport([mkBot('A'), mkBot('B')]));
    const { stdout, stderr, exitCode } = run([p, '--json']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.pairs[0].separated).toBe(false);
    expect(stderr).toMatch(/A × B: NOT SEPARATED/);
  });

  it('--bots restricts the matrix to the selection', () => {
    const p = writeReport(
      mkReport([mkBot('Blitz', BLITZY), mkBot('Survivor', SURVIVORY), mkBot('Base')])
    );
    const { stdout, exitCode } = run([p, '--json', '--bots', 'Blitz,Survivor']);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.pairs).toHaveLength(1);
    expect([out.pairs[0].a, out.pairs[0].b].sort()).toEqual(['Blitz', 'Survivor']);
  });
});

describe('behavior-separation CLI — the §10.5 --require-separated ship gate', () => {
  it('exits 2 when a persona pair fails to separate, naming the pair', () => {
    // Two PERSONA_SIGNATURES names with near-identical profiles: the pre-committed §10.5
    // kill-condition shape (e.g. a Predator that is Survivor-with-kill-steals).
    const p = writeReport(mkReport([mkBot('Predator'), mkBot('Survivor')]));
    const { stderr, exitCode } = run([p, '--require-separated']);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--require-separated: FAIL/);
    expect(stderr).toMatch(/Predator × Survivor/);
  });

  it('gates shipped pairs involving the base: a non-separated Conqueror×persona pair exits 2', () => {
    // §10.5's "every shipped pair" includes base×persona — the roster is NOT just the
    // signature registry. Conqueror here is behaviorally identical to Blitz.
    const p = writeReport(
      mkReport([mkBot('Conqueror', BLITZY), mkBot('Blitz', BLITZY), mkBot('Survivor', SURVIVORY)])
    );
    const { stderr, exitCode } = run([p, '--require-separated']);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/Conqueror × Blitz/);
  });

  it('exits 0 with PASS when every shipped-roster pair separates', () => {
    const p = writeReport(mkReport([mkBot('Blitz', BLITZY), mkBot('Survivor', SURVIVORY)]));
    const { stdout, stderr, exitCode } = run([p, '--require-separated', '--json']);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/--require-separated: PASS/);
    const out = JSON.parse(stdout);
    expect(out.requireSeparated).toEqual({
      roster: ['Blitz', 'Survivor'],
      mdeOverridden: [],
      failing: [],
      pass: true,
    });
  });

  it('a gate with nothing to gate FAILS (exit 1) — the naming-drift fail-open is closed', () => {
    // Versioned arm names (Blitz-v3) match no roster name: the old behavior silently
    // passed with a stderr note; a ship gate that gates nothing must fail loud.
    const p = writeReport(mkReport([mkBot('Blitz-v3', BLITZY), mkBot('Survivor-v3', SURVIVORY)]));
    const { stderr, exitCode } = run([p, '--require-separated']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/nothing to gate/);
    expect(stderr).toMatch(/--shipped/); // points at the fix
  });

  it('--shipped names the roster explicitly, gating versioned arm names', () => {
    const p = writeReport(mkReport([mkBot('Blitz-v3', BLITZY), mkBot('Survivor-v3', SURVIVORY)]));
    const pass = run([p, '--require-separated', '--shipped', 'Blitz-v3,Survivor-v3', '--json']);
    expect(pass.exitCode).toBe(0);
    expect(JSON.parse(pass.stdout).requireSeparated.roster).toEqual(['Blitz-v3', 'Survivor-v3']);
  });

  it('--shipped hard-fails when a named roster bot is absent (exit 1) or used without the gate', () => {
    const p = writeReport(mkReport([mkBot('Blitz-v3', BLITZY), mkBot('Survivor-v3', SURVIVORY)]));
    const missing = run([p, '--require-separated', '--shipped', 'Blitz-v3,Conqueror']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/--shipped names not among the selected bots.*\[Conqueror\]/);
    const noGate = run([p, '--shipped', 'Blitz-v3,Survivor-v3']);
    expect(noGate.exitCode).toBe(1);
    expect(noGate.stderr).toMatch(/only scopes the --require-separated gate/);
  });

  it('a NON-COMPARABLE roster pair fails the gate (fail closed): unmeasurable is not separated', () => {
    const p = writeReport(mkReport([mkNullBot('Predator'), mkBot('Survivor', SURVIVORY)]));
    const { stdout, stderr, exitCode } = run([p, '--require-separated', '--json']);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/Predator × Survivor/);
    expect(JSON.parse(stdout).requireSeparated.failing).toEqual(['Predator × Survivor']);
  });

  it('a PASS at overridden MDEs is labeled as not the registered protocol', () => {
    const p = writeReport(mkReport([mkBot('Blitz', BLITZY), mkBot('Survivor', SURVIVORY)]));
    const { stdout, stderr, exitCode } = run([
      p,
      '--require-separated',
      '--json',
      '--mde',
      'aggression:0.05',
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/PASS \(at OVERRIDDEN MDEs — not the registered protocol\)/);
    expect(JSON.parse(stdout).requireSeparated.mdeOverridden).toEqual(['aggression']);
  });
});

describe('behavior-separation — real end-to-end (profile → separation)', () => {
  // The one seam synthetic reports can't pin: a LIVE behavior:profile --json report is
  // accepted unmodified. Budget: 2 runs × 1 game × 3 rotations × 2 profiled bots = 12
  // matches (~3 s local; timeout sized for a slow CI runner).
  it('pairs a live profile report', () => {
    const profile = spawnSync(
      'node',
      [
        'scripts/behavior-profile.mjs',
        ...'--bots Strategist --control Defensive --opponents Default,Example --reference Default --runs 2 --games 1 --json'.split(
          ' '
        ),
      ],
      { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 }
    );
    expect(profile.status).toBe(0);
    const p = path.join(dir, 'live-profile.json');
    writeFileSync(p, profile.stdout);
    const { stdout, stderr, exitCode } = run([p, '--json'], { timeout: 60000 });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.config.runs).toBe(2);
    expect(out.config.reports[0].gitSha).toBeTruthy(); // stamped by the live profile
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0].axes).toHaveLength(4);
    expect(stderr).toMatch(/Separation matrix — 2 bots/);
  }, 150000);
});
