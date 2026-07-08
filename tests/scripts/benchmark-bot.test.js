import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../..');

function run(args, expectFail = false) {
  try {
    const stdout = execSync(`node scripts/benchmark-bot.mjs ${args}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

describe('benchmark-bot CLI', () => {
  it('benchmarks a bot file', () => {
    const { stdout } = run('bots/greedy-bot.js --games 3');
    expect(stdout).toContain('Benchmarking');
    expect(stdout).toContain('Timing');
    expect(stdout).toContain('Avg ms/move');
    expect(stdout).toContain('Performance');
    expect(stdout).toContain('ELO');
    expect(stdout).toContain('Comparison');
  }, 30000);

  it('benchmarks a built-in bot by name', () => {
    const { stdout } = run('Adaptive --games 3');
    expect(stdout).toContain('Benchmarking');
    expect(stdout).toContain('(built-in)');
    expect(stdout).toContain('ELO');
  }, 30000);

  it('prints the "Forced ends" line for a bot that never makes a legal move (#92 item 3)', () => {
    // A bot file is a bare function body. This one returns a valid-SHAPE but illegal move
    // ({from,to} out of range), so it passes the compiler's shape smoke-test but every real
    // move is rejected — matchRunner tallies invalidMoves, tripping the "Forced ends" branch.
    const botPath = path.join(os.tmpdir(), `dwjs-forced-end-bot-${process.pid}.js`);
    fs.writeFileSync(botPath, 'return { from: -1, to: -1 };\n');
    try {
      const { stdout } = run(`"${botPath}" --games 3`);
      expect(stdout).toContain('Forced ends');
      expect(stdout).toContain('invalid move(s)');
    } finally {
      fs.rmSync(botPath, { force: true });
    }
  }, 30000);

  it('fails with no args', () => {
    const { stderr, exitCode } = run('', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('fails with nonexistent file', () => {
    const { stderr, exitCode } = run('nonexistent.js', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Error');
  });

  it('fails with invalid --games value', () => {
    const { stderr, exitCode } = run('Adaptive --games abc', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid');
  });
});
