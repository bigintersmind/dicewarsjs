/**
 * Boot smoke for the ppo-env-server `main()` loop.
 *
 * `main()` is un-exported and runs only as a process entrypoint, so the hermetic unit tests
 * (`ppo-env-server-*.test.js`) exercise its extracted helpers (`parseArgs`, `makeCheckpointDumper`,
 * `makeShapedEmission`) but never `main()`'s WIRING — the per-episode loop where an un-threaded
 * identifier throws a `ReferenceError` on episode 0 (the exact shape of the PR #134 near-miss:
 * `shapedEmission.reset(initialState)` with `initialState` never declared).
 *
 * That loop's only end-to-end guard is the `ppo:*-smoke` npm scripts, which run ONLY in the CI
 * "smoke checks" step — and CI is gated behind fork-PR approval, so a fork's `main()` regression got
 * NO automated signal at all. This test boots the same smokes under `npm test`, so a `main()`-wiring
 * crash is caught in a contributor's local run and on same-repo PRs, not just post-approval in CI.
 *
 * Each smoke spawns the real server + a live socket, drives >= 3 episodes (>= 2 per-episode
 * `reset()` boundaries), and `process.exit(1)`s on any failure; `execFileSync` throws on a non-zero
 * exit, so a boot crash fails the test. This mirrors the repo's `tests/scripts/*.test.js` idiom of
 * booting a CLI script as a subprocess. (Redundant with the CI smoke step by design — the point is
 * to also cover `main()` under `npm test`.)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Boot a smoke script; on non-zero exit, rethrow with its captured output for a debuggable failure. */
function runSmoke(script) {
  try {
    execFileSync(process.execPath, [path.join('scripts', script)], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 45_000,
    });
  } catch (err) {
    const detail = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join('\n');
    throw new Error(`${script} failed (exit ${err.status ?? err.code}):\n${detail}`);
  }
}

describe('ppo-env-server main() boots and completes episodes', () => {
  it('drives the base (unshaped) wire end-to-end', () => {
    expect(() => runSmoke('ppo-env-smoke.mjs')).not.toThrow();
  }, 60_000);

  it('drives the shaped (bite-G) wire end-to-end', () => {
    expect(() => runSmoke('ppo-env-shaped-smoke.mjs')).not.toThrow();
  }, 60_000);
});
