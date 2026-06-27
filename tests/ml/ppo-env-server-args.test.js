/**
 * PPO env-server arg parsing — the NODE side of the PFSP flag bridge (Phase 3, task B — [D-23]).
 *
 * `ml/tests/test_env_server_argv.py` proves the Python EMITS `--reserve-baselines=…` etc., and
 * `ppo-league-pfsp.test.js` proves `makeLeague` HONORS `reserveBaselines: …`. Nothing tested the
 * middle hop: that `ppo-env-server.mjs` actually PARSES the flag (it is in `KNOWN_FLAGS`) and reads it
 * back with the right key/default (`numArg`). A typo on this side — a missing `KNOWN_FLAGS` entry or a
 * wrong `numArg` key/default — would otherwise surface only on a live shodan spawn: either a hard
 * "Unknown flag" launch failure or, worse, a silent fall-back to the default = a mis-tuned multi-hour run.
 *
 * Importing the module is side-effect-free: `ppo-env-server.mjs` runs the server only when it is the
 * process entry point (the `isEntryPoint` guard), so this exercises `parseArgs`/`numArg` without
 * spawning a worker or binding a socket.
 */

import { numArg, parseArgs } from '../../scripts/ppo-env-server.mjs';

describe('ppo-env-server — PFSP flag bridge (Node side)', () => {
  it('parses the PFSP/snapshot knobs and reads them back round-trip', () => {
    const opts = parseArgs([
      '--reserve-baselines=4',
      '--pfsp-epsilon=0.1',
      '--pfsp-k=3',
      '--snapshot-manifest=/tmp/snap/manifest.json',
      '--snapshot-pool-cap=12',
    ]);
    expect(numArg(opts, 'reserve-baselines', 3)).toBe(4);
    expect(numArg(opts, 'pfsp-epsilon', 0.05)).toBe(0.1);
    expect(numArg(opts, 'pfsp-k', 2)).toBe(3);
    expect(numArg(opts, 'snapshot-pool-cap', 40)).toBe(12);
    expect(opts['snapshot-manifest']).toBe('/tmp/snap/manifest.json');
  });

  it('defaults the PFSP knobs to the B4 defaults when absent (must match makeLeague / Python)', () => {
    const opts = parseArgs([]);
    expect(numArg(opts, 'reserve-baselines', 3)).toBe(3);
    expect(numArg(opts, 'pfsp-epsilon', 0.05)).toBe(0.05);
    expect(numArg(opts, 'pfsp-k', 2)).toBe(2);
  });

  it('rejects an unknown / mistyped flag loudly (never silently ignored)', () => {
    expect(() => parseArgs(['--pfsp-kk=3'])).toThrow(/Unknown flag --pfsp-kk/);
    expect(() => parseArgs(['--reserve-baseline=3'])).toThrow(/Unknown flag --reserve-baseline/);
  });

  it('rejects a non-finite numeric knob', () => {
    expect(() => numArg(parseArgs(['--pfsp-k=notnum']), 'pfsp-k', 2)).toThrow(/not a finite number/);
  });
});
