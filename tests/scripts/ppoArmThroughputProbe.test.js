/**
 * ppo-arm-throughput CLI — the Wave-0 item-6 concurrent-wave capacity probe (PERSONAS §10.7).
 *
 * The go/no-go LOGIC (classifyThroughput), the contention math, and the timed shard's phase machine
 * are pinned exhaustively in `tests/ml/ppo-arm-throughput-probe.test.js` (pure core). These CLI cases
 * pin the DRIVER GLUE the core tests can't reach: arg-parse/validation strictness, the empty-field
 * guard, the operator-facing exit-code contract (0 GREEN/YELLOW · 2 RED · 1 usage), and the --json
 * shape. Running cases FORCE the verdict via --target-fps so the exit code is deterministic on any
 * box (a real throughput assertion would be machine-dependent and flaky).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const SCRIPT = 'scripts/ppo-arm-throughput-probe.mjs';

function run(args, { timeout = 30000 } = {}) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout,
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.status };
}

// A fast real run: 2 arms × 1 env, 1s measure, no warmup/cooldown, cheap opponents (no Lookahead).
const FAST = [
  '--arms=2',
  '--envs-per-arm=1',
  '--seconds=1',
  '--warmup-seconds=0',
  '--cooldown-seconds=0',
  '--opponents=Default,Defensive,Example',
];

describe('ppo-arm-throughput — usage / validation exits (exit 1, no games)', () => {
  it('exits 1 on an unknown flag', () => {
    const { exitCode, stderr } = run(['--frobnicate=1']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown flag/);
  });

  it('exits 1 on a non-integer --arms (strict Number, the item-5 lesson)', () => {
    expect(run(['--arms=abc']).exitCode).toBe(1);
    expect(run(['--arms=0']).exitCode).toBe(1);
    expect(run(['--arms=2.5']).exitCode).toBe(1);
  });

  it('exits 1 on a margin below 1', () => {
    expect(run(['--margin=0.5']).exitCode).toBe(1);
  });

  it('exits 1 with a clean message on an empty --opponents= (the nullish-slip guard)', () => {
    const { exitCode, stderr } = run(['--opponents=']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/opponents resolved to an empty field/);
    expect(stderr).not.toMatch(/non-empty array/); // fails HERE, not deep inside a worker
  });

  it('exits 1 on a learner-seat out of range for the field', () => {
    expect(run(['--opponents=Default,Defensive,Example', '--learner-seat=99']).exitCode).toBe(1);
  });
});

describe('ppo-arm-throughput — go/no-go exit-code contract (forced verdicts)', () => {
  it('exits 0 and prints GREEN when the target is trivially clearable', () => {
    const { exitCode, stdout } = run([...FAST, '--target-fps=1']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/GREEN/);
    expect(stdout).toMatch(/baseline/);
    expect(stdout).toMatch(/contended/);
    expect(stdout).toMatch(/oversubscription/);
  });

  it('exits 2 and prints RED when the target is unreachable even with zero GPU cost', () => {
    const { exitCode, stdout } = run([...FAST, '--target-fps=100000000']);
    expect(exitCode).toBe(2);
    expect(stdout).toMatch(/RED/);
    expect(stdout).toMatch(/BELOW the target/);
  });
});

describe('ppo-arm-throughput — --json shape', () => {
  it('emits parseable JSON with the documented top-level keys', () => {
    const { exitCode, stdout } = run([...FAST, '--target-fps=1', '--json']);
    expect(exitCode).toBe(0);
    const j = JSON.parse(stdout); // --json ⇒ stdout is pure JSON (no header line)
    expect(Object.keys(j).sort()).toEqual([
      'baseline',
      'config',
      'contendedArms',
      'contention',
      'verdict',
    ]);
    expect(j.config.arms).toBe(2);
    expect(j.config.envsPerArm).toBe(1);
    expect(j.config.totalWorkers).toBe(2);
    expect(j.config.oversubscription).toBeCloseTo(2 / j.config.cores, 10);
    expect(j.contendedArms).toHaveLength(2); // one entry per arm
    expect(j.baseline).toHaveProperty('stepsPerSec');
    expect(j.verdict.verdict).toBe('GREEN');
    expect(j.verdict.floor).toBe(1);
  });
});
