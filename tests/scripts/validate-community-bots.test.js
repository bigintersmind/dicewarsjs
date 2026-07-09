import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * CLI-level regression guard for the #148 fix: the validator must propagate a broken bot
 * into a non-zero exit, not just decide correctly in the helper. This is the exact seam
 * #148 was about (the script completing and reporting PASS/exit 0 for a broken bot), so it
 * is tested end-to-end via execSync — mirroring tests/scripts/validate-bot.test.js.
 *
 * To avoid racing other suites that read the shared community-bots/registry.json under
 * vitest's parallel workers, each test points the validator at a throwaway fixture dir via
 * the DICEWARS_COMMUNITY_BOTS_DIR override rather than mutating the real registry.
 */

const projectRoot = path.resolve(import.meta.dirname, '../..');
const realConnector = path.join(projectRoot, 'community-bots', 'bigintersmind', 'connector.js');

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function runValidator(communityDir, expectFail = false) {
  try {
    const raw = execSync('node scripts/validate-community-bots.mjs', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DICEWARS_COMMUNITY_BOTS_DIR: communityDir },
    });
    return { stdout: stripAnsi(raw), exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return { stdout: stripAnsi(err.stdout || ''), exitCode: err.status };
  }
}

describe('validate-community-bots CLI', () => {
  let fixtureDir;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-community-'));
    // A real, valid community bot to serve as the "good" registry entry.
    fs.copyFileSync(realConnector, path.join(fixtureDir, 'connector.js'));
  });

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  function writeRegistry(entries) {
    fs.writeFileSync(
      path.join(fixtureDir, 'registry.json'),
      `${JSON.stringify(entries, null, 2)}\n`
    );
  }

  it('exits 0 and passes a valid community bot, printing the error counters', () => {
    writeRegistry([
      { id: 'x/connector', name: 'Connector', author: 'x', file: 'connector.js', active: true },
    ]);
    const { stdout, exitCode } = runValidator(fixtureDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('All community bots validated successfully');
    expect(stdout).toContain('0 errors, 0 invalid moves');
  });

  it('exits 1 and names the error count when a registered bot throws every turn (#148)', () => {
    fs.writeFileSync(path.join(fixtureDir, 'throw.js'), 'throw new Error("boom every turn");\n');
    writeRegistry([
      { id: 'x/throw', name: 'ThrowBot', author: 'x', file: 'throw.js', active: true },
    ]);
    const { stdout, exitCode } = runValidator(fixtureDir, true);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('[FAIL]');
    expect(stdout).toContain('ThrowBot');
    expect(stdout).toMatch(/turn\(s\) ended in an error/);
  });

  it('exits 1 when a registered bot returns an invalid move every turn', () => {
    fs.writeFileSync(path.join(fixtureDir, 'garbage.js'), 'return { from: -1, to: -1 };\n');
    writeRegistry([
      { id: 'x/garbage', name: 'GarbageBot', author: 'x', file: 'garbage.js', active: true },
    ]);
    const { stdout, exitCode } = runValidator(fixtureDir, true);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('[FAIL]');
    expect(stdout).toContain('GarbageBot');
    expect(stdout).toMatch(/invalid move/i);
  });
});
