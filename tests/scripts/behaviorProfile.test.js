import { execSync } from 'node:child_process';
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
});
