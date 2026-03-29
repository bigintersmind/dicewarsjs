import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '../..');

// Strip ANSI escape codes for assertion matching
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function run(args, expectFail = false) {
  try {
    const raw = execSync(`node scripts/validate-bot.mjs ${args}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stripAnsi(raw), exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return {
      stdout: stripAnsi(err.stdout || ''),
      stderr: stripAnsi(err.stderr || ''),
      exitCode: err.status,
    };
  }
}

describe('validate-bot CLI', () => {
  const tmpBot = path.join(projectRoot, 'bots', '__test-invalid-bot.js');

  afterEach(() => {
    if (fs.existsSync(tmpBot)) fs.unlinkSync(tmpBot);
  });

  it('validates a known-good bot', () => {
    const { stdout } = run('bots/random-bot.js');
    expect(stdout).toContain('[PASS] Syntax check');
    expect(stdout).toContain('[PASS] Compilation');
    expect(stdout).toContain('PASS');
  });

  it('validates with --test flag', () => {
    const { stdout } = run('bots/greedy-bot.js --test');
    expect(stdout).toContain('[PASS] Syntax check');
    expect(stdout).toContain('[PASS] Compilation');
    expect(stdout).toContain('Test match');
    expect(stdout).toContain('PASS');
  });

  it('fails on a bot with syntax errors', () => {
    fs.writeFileSync(tmpBot, 'function {{{ bad syntax', 'utf-8');
    const { stdout, exitCode } = run(`bots/__test-invalid-bot.js`, true);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('[FAIL]');
    expect(stdout).toContain('Syntax');
  });

  it('fails on a bot that throws at runtime', () => {
    fs.writeFileSync(tmpBot, 'throw new Error("boom");', 'utf-8');
    const { stdout, exitCode } = run(`bots/__test-invalid-bot.js`, true);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('[FAIL]');
    expect(stdout).toContain('Compilation');
  });

  it('fails with no args', () => {
    const { stderr, exitCode } = run('', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('fails with nonexistent file', () => {
    const { stdout, exitCode } = run('bots/nonexistent.js', true);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('[FAIL]');
  });

  it('warns when bot returns null on test run', () => {
    fs.writeFileSync(tmpBot, 'return null;', 'utf-8');
    const { stdout } = run(`bots/__test-invalid-bot.js`);
    expect(stdout).toContain('[WARN]');
    expect(stdout).toContain('PASS');
  });
});
