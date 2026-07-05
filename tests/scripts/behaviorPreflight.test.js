/**
 * behavior-preflight CLI — the Wave-1 launch pre-flight (PERSONAS §10.7 item 5).
 *
 * Validation/usage exits and the #97 loader path are fast (no arena games). The A/A negative
 * control necessarily runs a small real sweep; its gate LOGIC is pinned exhaustively in
 * behaviorCore.test.js (signatureNoiseFloor over synthetic runs), so the CLI cases here assert the
 * WIRING: the probe pre-flight block, the exit codes, the override labeling, the --curve reader,
 * and one deterministic A/A pass and halt.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const REAL_WEIGHTS = path.join(projectRoot, 'src/ai/bcPolicyWeights.js');
const REAL_FIXTURE = path.join(projectRoot, 'tests/fixtures/bc/forwardCases.json');

function run(args, { timeout = 60000 } = {}) {
  const res = spawnSync('node', ['scripts/behavior-preflight.mjs', ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status };
}

/** A temp `*.weights.js` re-exporting the real BC policy + a copied sibling fixture — a valid,
 *  parity-passing checkpoint the #97 loader path accepts, built without any real export. */
function syntheticCheckpoint() {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-'));
  const weights = path.join(dir, 'cp.weights.js');
  const fixture = path.join(dir, 'cp.fixture.json');
  writeFileSync(weights, `export { BC_POLICY } from '${pathToFileURL(REAL_WEIGHTS).href}';\n`);
  copyFileSync(REAL_FIXTURE, fixture);
  return { dir, weights, fixture };
}

// --- Usage / validation exits (no games) ---

describe('behavior-preflight — usage exits', () => {
  it('exits 1 when neither --weights nor --bot is given', () => {
    const { exitCode, stderr } = run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/exactly one of --weights .* or --bot/);
  });

  it('exits 1 when BOTH --weights and --bot are given', () => {
    expect(run(['--weights', 'x.weights.js', '--bot', 'Default']).exitCode).toBe(1);
  });

  it('exits 1 on an unknown flag', () => {
    expect(run(['--bot', 'Default', '--frobnicate']).exitCode).toBe(1);
  });

  it('exits 1 on a repeated flag (silent-drop guard)', () => {
    const { exitCode, stderr } = run(['--bot', 'Default', '--bot', 'Example']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/passed more than once/);
  });

  it('exits 1 on a trailing value flag (--mde with no value)', () => {
    expect(run(['--bot', 'Default', '--mde']).exitCode).toBe(1);
    expect(run(['--bot', 'Default', '--mde', '--json']).exitCode).toBe(1);
  });

  it('exits 1 on a positional argument (flags only)', () => {
    expect(run(['profile.json', '--bot', 'Default']).exitCode).toBe(1);
  });

  it('exits 1 on --runs < 2 (the A/A needs ≥ 2 paired runs)', () => {
    expect(run(['--bot', 'Default', '--runs', '1']).exitCode).toBe(1);
  });

  it('exits 1 on a non-positive --divisor', () => {
    expect(run(['--bot', 'Default', '--divisor', '0']).exitCode).toBe(1);
  });

  it('exits 1 on an unknown --bot', () => {
    expect(run(['--bot', 'Nonesuch']).exitCode).toBe(1);
  });

  it('exits 1 when --fixture is passed without --weights', () => {
    expect(run(['--bot', 'Default', '--fixture', 'f.json']).exitCode).toBe(1);
  });

  it('exits 1 when the base name collides with an --opponents entry', () => {
    expect(run(['--bot', 'Default', '--opponents', 'Default,Example']).exitCode).toBe(1);
  });
});

// --- #97 probe pre-flight (loader path; tiny A/A) ---

describe('behavior-preflight — #97 probe pre-flight', () => {
  it('loads a fixtured checkpoint and confirms the fixture-less guard fires', () => {
    const { weights } = syntheticCheckpoint();
    const { stdout, exitCode } = run([
      '--weights',
      weights,
      '--runs',
      '2',
      '--games',
      '1',
      '--opponents',
      'Default,Adaptive',
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(r.probePreflight.loaded).toBe(true);
    expect(r.probePreflight.parity).toBeLessThan(1e-3);
    expect(r.probePreflight.params).toBeGreaterThan(0);
    expect(r.probePreflight.fixturelessGuard).toBe('fired');
    // Exit code depends on the (tiny, likely-underpowered) A/A — not asserted here.
    expect([0, 2]).toContain(exitCode);
  });

  it('HALTS (exit 2) when the checkpoint fails to load (fixture absent)', () => {
    const { weights } = syntheticCheckpoint();
    const { stdout, exitCode } = run([
      '--weights',
      weights,
      '--fixture',
      path.join(tmpdir(), 'does-not-exist.fixture.json'),
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(exitCode).toBe(2);
    expect(r.probePreflight.loaded).toBe(false);
    expect(r.probePreflight.loadError).toMatch(/parity fixture not found/);
    expect(r.halt).toBe(true);
    // The A/A never ran — no base to profile.
    expect(r.nc1).toBeNull();
  });
});

// --- Negative control 1: the A/A gate wiring ---

describe('behavior-preflight — NC1 A/A wiring', () => {
  // A real self-A/A is a true null (same policy) but genuinely stochastic (unseeded-opponent
  // Math.random), so its BIASED verdict is a Holm-controlled random draw — CLEAR only WITH HIGH
  // PROBABILITY, never guaranteed. So we do NOT assert `pass` on a live run: the deterministic CLEAR
  // is pinned by the huge-MDE case below, the exit-2 HALT by the deterministic probe-failure case
  // above, and the BIASED/Holm verdict logic by behaviorCore.test.js. The live case here is a
  // smoke test of the sweep→signatureNoiseFloor path (asserting only deterministic invariants).
  it('PRE-FLIGHT CLEAR (exit 0, no bias) when the floor is huge', () => {
    // Huge MDEs ⇒ every CI ⊆ ±tol ⇒ no BIASED ⇒ pass, whatever the (noisy) realized self-diff.
    const huge = ['aggression', 'turnsToWin', 'avgTerritory', 'kills', 'avgPlacement']
      .map(a => `${a}:1000`)
      .join(',');
    const { stdout, stderr, exitCode } = run([
      '--bot',
      'Strategist',
      '--opponents',
      'Example,Default',
      '--runs',
      '3',
      '--games',
      '4',
      '--mde',
      huge,
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(r.nc1.pass).toBe(true);
    expect(r.nc1.biased).toEqual([]);
    expect(r.halt).toBe(false);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/PRE-FLIGHT CLEAR/);
  });

  it('a live self-A/A emits a well-formed NC1 verdict per signature axis (smoke test)', () => {
    // The live A/A is stochastic, so its verdicts are a random draw — we assert only the DETERMINISTIC
    // shape (never `pass`, which would flake): the five signature axes each carry a valid verdict, and
    // the halt flag agrees with the exit code. The true-null-CLEARs property lives in the unit tests.
    const { stdout, exitCode } = run([
      '--bot',
      'Default',
      '--opponents',
      'Example,Adaptive',
      '--runs',
      '3',
      '--games',
      '4',
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(new Set(r.nc1.axes.map(a => a.axis))).toEqual(
      new Set(['aggression', 'turnsToWin', 'avgTerritory', 'kills', 'avgPlacement'])
    );
    const valid = new Set(['CERTIFIED', 'BIASED', 'INCONCLUSIVE', 'NO DATA']);
    for (const ax of r.nc1.axes) expect(valid.has(ax.verdict)).toBe(true);
    expect(typeof r.nc1.pass).toBe('boolean');
    expect(r.halt).toBe(exitCode === 2); // halt flag agrees with the exit code
  });

  it('labels an MDE override on a signature axis as a non-registered floor', () => {
    const { stdout, stderr } = run([
      '--bot',
      'Default',
      '--opponents',
      'Example,Adaptive',
      '--runs',
      '2',
      '--games',
      '1',
      '--mde',
      'aggression:0.5',
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(r.config.mdeOverridden).toContain('aggression');
    expect(stderr).toMatch(/NON-REGISTERED noise floor/);
  });
});

// --- Negative control 2: the test-retest reader ---

describe('behavior-preflight — NC2 test-retest reader', () => {
  it('surfaces the recorded spread from a strength.meta.json sidecar', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'curve-'));
    const jsonl = path.join(dir, 'strength.jsonl');
    const meta = path.join(dir, 'strength.meta.json');
    writeFileSync(jsonl, '{"step":100}\n');
    writeFileSync(meta, JSON.stringify({ testRetest: { step: 100, spreadPp: 4.16 } }));
    // --curve accepts the strength.jsonl and derives the sibling .meta.json.
    const { stdout, stderr } = run([
      '--bot',
      'Default',
      '--opponents',
      'Example,Adaptive',
      '--runs',
      '2',
      '--games',
      '1',
      '--curve',
      jsonl,
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(r.nc2.testRetest.spreadPp).toBe(4.16);
    expect(stderr).toMatch(/spread 4\.16 pp at step 100/);
  });

  it('reports NC2 as not-produced when no --curve is given', () => {
    const { stdout } = run([
      '--bot',
      'Default',
      '--opponents',
      'Example,Adaptive',
      '--runs',
      '2',
      '--games',
      '1',
      '--json',
    ]);
    const r = JSON.parse(stdout);
    expect(r.nc2.testRetest).toBeNull();
    expect(r.nc2.note).toMatch(/ppo:curve/);
  });
});
