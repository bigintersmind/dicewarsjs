import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Spawn the behavior-profile CLI and capture its exit code + stderr. Mirrors the
 * `benchmark-bot.test.js` pattern. Every case here is a CONFIG-error branch that exits
 * BEFORE the (slow) arena sweep, so the suite stays fast — no match is ever run. The
 * deep weight-loading path is covered by `loadBcPolicy.test.js` + the `behavior-core`
 * unit tests; this file pins the CLI's argument-validation exit codes (the one layer the
 * unit tests can't reach), which is the project convention for sibling CLIs.
 */
function run(args, expectFail = true) {
  try {
    const stdout = execSync(`node scripts/behavior-profile.mjs ${args}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

describe('behavior-profile CLI — fail-fast config validation (no sweep)', () => {
  it('rejects --mde axis:0 (the gate-collapse guard) end-to-end', () => {
    const { stderr, exitCode } = run('--mde aggression:0');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/positive number/);
  });

  it('rejects an unknown --mde axis', () => {
    const { stderr, exitCode } = run('--mde bogus:1');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/not a known axis/);
  });

  it('rejects --runs below 2 (a CI needs >= 2 runs)', () => {
    const { stderr, exitCode } = run('--runs 1');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Invalid --runs/);
  });

  it('rejects an unknown built-in bot name', () => {
    const { stderr, exitCode } = run('--bots Nonexistent');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Unknown bot/);
  });

  it('rejects a weights spec with an empty path (Name=)', () => {
    const { stderr, exitCode } = run('--bots Blitz=');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/empty path/);
  });

  it('rejects a profiled bot that also appears in --opponents', () => {
    // Lookahead is in the default opponent field, so profiling it collides.
    const { stderr, exitCode } = run('--bots Lookahead');
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/also appear in --opponents/);
  });

  it('rejects a non-integer or non-positive --holm-family', () => {
    for (const bad of ['0', '-2', '2.5', 'abc']) {
      const { stderr, exitCode } = run(`--holm-family ${bad}`);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/Invalid --holm-family/);
    }
  });

  it('rejects a --holm-family below the REGISTERED family size (family shrink guard)', () => {
    // The registered family is the PERSONA_SIGNATURES count (4; 5 when the Blitz escalation
    // fires) — any smaller m loosens the step-down thresholds (e.g. m=2 doubles the rank-1
    // threshold to 0.025) and can flip CONFIRMED. Must fail BEFORE the sweep, regardless of
    // how many personas this invocation gates.
    for (const m of [1, 2, 3]) {
      const { stderr, exitCode } = run(`--bots Blitz,Survivor --holm-family ${m}`);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/below the registered family size \(4/);
    }
  });
});

describe('behavior-profile CLI — Holm end-to-end (small real sweep)', () => {
  // The one seam the unit suites cannot reach: the CLI's report → holmSignatures wiring and
  // the report.holm JSON/stderr surface. holmAdjust reads a MISSING p as a legitimate null,
  // so without this pin a report-shape refactor would silently grade every persona
  // NOT CONFIRMED with exit 0 (holmSignatures now also throws on a malformed detail, but the
  // e2e is what proves the CLI passes a well-formed one). Budget: 2 runs × 1 game × 6
  // rotations × 2 profiled bots = 24 matches (~3 s local; timeout sized for a slow CI runner).
  it('emits a well-formed report.holm and the family verdict block', () => {
    const res = spawnSync(
      'node',
      'scripts/behavior-profile.mjs --bots Blitz --runs 2 --games 1 --holm-family 5 --json'.split(
        ' '
      ),
      { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 }
    );
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.holm.alpha).toBe(0.05);
    expect(report.holm.familySize).toBe(5); // the --holm-family escalation override flowed through
    expect(report.holm.results).toHaveLength(1);
    const r = report.holm.results[0];
    const blitz = report.bots.find(b => b.name === 'Blitz');
    expect(r.persona).toBe('Blitz');
    expect(r.p).toBe(blitz.signature.p); // the family consumed the signature's IUT p
    expect(r.unadjustedPass).toBe(blitz.signature.pass);
    expect(r.confirmatoryPass).toBe(blitz.signature.pass && r.holmReject);
    // Either a real p flowed through, or the no-data path was taken — both are well-formed.
    if (r.p != null) {
      expect(r.pAdj).toBeGreaterThanOrEqual(r.p);
      expect(r.rank).toBe(1);
      expect(r.threshold).toBeCloseTo(0.01, 12); // α/5 at rank 1 of the escalated family
    } else {
      expect(r.holmReject).toBe(false);
    }
    // Every signature axis carries its one-sided p (null only alongside a null delta).
    for (const a of blitz.signature.axes) {
      expect('p' in a).toBe(true);
      if (a.delta != null) expect(a.p).toBeGreaterThanOrEqual(0);
    }
    // The human verdict block on stderr, with the override provenance labeled.
    expect(res.stderr).toMatch(/Holm confirmatory family: m=5 \(--holm-family\)/);
    expect(res.stderr).toMatch(/Blitz signature \(AND\)/);
    // The separation-script contract (§10.5 profile pairing): per-run arrays + provenance.
    // Pinned here so a report-shape refactor can't silently strand behavior:separation.
    expect(report.config.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // CI checkouts are git repos too; a dev tree with uncommitted changes stamps -dirty.
    expect(report.config.gitSha).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
    // Full opponent provenance — names AND weights paths (all built-ins here).
    expect(report.config.opponentSpecs).toEqual(
      report.config.opponents.map(name => ({ name, weightsPath: null }))
    );
    for (const b of report.bots) {
      expect(b.weightsPath).toBeNull(); // both bots here are built-ins
      expect(b.perRun).toHaveLength(report.config.runs);
      for (const runRecord of b.perRun) {
        // Every axis key present, values numeric or null (JSON-safe, alignable).
        expect(Object.keys(runRecord).sort()).toEqual(
          Object.keys(blitz.metrics).sort() // metrics is keyed by AXES too
        );
        for (const v of Object.values(runRecord)) {
          expect(v === null || Number.isFinite(v)).toBe(true);
        }
      }
    }
  }, 130000);

  it('report.holm is null when no gated persona is profiled', () => {
    const res = spawnSync(
      'node',
      'scripts/behavior-profile.mjs --bots Strategist --runs 2 --games 1 --json'.split(' '),
      { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 }
    );
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.holm).toBeNull();
    expect(report.bots.find(b => b.name === 'Strategist').signature).toBeNull();
    expect(res.stderr).not.toMatch(/Holm confirmatory family/);
  }, 130000);
});
