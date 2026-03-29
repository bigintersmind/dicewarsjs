import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const botsDir = path.join(projectRoot, 'bots');

function run(args, expectFail = false) {
  try {
    const stdout = execSync(`node scripts/new-bot.mjs ${args}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status };
  }
}

function cleanup(name) {
  const file = path.join(botsDir, `${name}-bot.js`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

describe('new-bot CLI', () => {
  afterEach(() => {
    cleanup('test-cli');
    cleanup('test-strategic');
  });

  it('creates a bot from the default (random) template', () => {
    const { stdout } = run('test-cli');
    expect(stdout).toContain('Created');

    const file = path.join(botsDir, 'test-cli-bot.js');
    expect(fs.existsSync(file)).toBe(true);

    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('Test Cli Bot');
    expect(content).toContain('based on random template');
    expect(content).toContain('state.myAreas');
  });

  it('creates a bot from a named template', () => {
    const { stdout } = run('test-strategic --template strategic');
    expect(stdout).toContain('Created');

    const file = path.join(botsDir, 'test-strategic-bot.js');
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('Test Strategic Bot');
    expect(content).toContain('based on strategic template');
    expect(content).toContain('score');
  });

  it('fails with no name', () => {
    const { stderr, exitCode } = run('', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('fails with invalid name characters', () => {
    const { stderr, exitCode } = run('My_Bot', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid bot name');
  });

  it('fails if file already exists', () => {
    run('test-cli'); // create first
    const { stderr, exitCode } = run('test-cli', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('already exists');
  });

  it('fails with unknown template', () => {
    const { stderr, exitCode } = run('test-cli --template unknown', true);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown template');
  });
});
