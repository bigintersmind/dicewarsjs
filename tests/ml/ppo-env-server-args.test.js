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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { numArg, parseArgs, resolveLeaguePersistence } from '../../scripts/ppo-env-server.mjs';

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

  it('knows the B6 persistence flags', () => {
    const opts = parseArgs([
      '--snapshot-store=disk',
      '--league-state-dir=/tmp/league',
      '--league-dump-every=25',
    ]);
    expect(opts['snapshot-store']).toBe('disk');
    expect(opts['league-state-dir']).toBe('/tmp/league');
    expect(numArg(opts, 'league-dump-every', 50)).toBe(25);
  });

  it('knows the bite-G --reward-shaping flag and defaults it OFF when absent', () => {
    // The Node side of the dense-reward bridge: Python emits `--reward-shaping=1` only when a
    // persona coef is active (test_env_server_argv.py), and the env-server reads it back as
    // `numArg(opts, 'reward-shaping', 0) !== 0`. Without this, a mistyped flag would either trip
    // the unknown-flag guard on a live shodan spawn or silently fall back to the unshaped wire =
    // a no-op dense run that wastes a multi-day GPU job (the exact bug class bite G guards).
    expect(numArg(parseArgs(['--reward-shaping=1']), 'reward-shaping', 0)).toBe(1);
    expect(numArg(parseArgs([]), 'reward-shaping', 0)).toBe(0); // absent ⇒ off (byte-identical wire)
    expect(numArg(parseArgs(['--reward-shaping=0']), 'reward-shaping', 0)).toBe(0); // explicit off
    expect(() => parseArgs(['--reward-shapng=1'])).toThrow(/Unknown flag --reward-shapng/); // typo
  });
});

describe('ppo-env-server — B6 league persistence resolution (resolveLeaguePersistence)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ppo-envargs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no flags ⇒ in-memory store, persistence OFF (strict B5 no-op)', () => {
    const r = resolveLeaguePersistence(parseArgs([]), { seedBase: 1, snapshotManifest: null });
    expect(r.store.kind).toBe('memory');
    expect(r.leagueStatePath).toBeNull(); // → no restore, no dump
  });

  it('--snapshot-manifest alone (memory) does NOT auto-enable persistence', () => {
    const manifest = join(dir, 'manifest.json');
    const r = resolveLeaguePersistence(parseArgs([`--snapshot-manifest=${manifest}`]), {
      seedBase: 1,
      snapshotManifest: manifest,
    });
    expect(r.store.kind).toBe('memory');
    expect(r.leagueStatePath).toBeNull(); // snapshot mode stays byte-identical to B5 unless opted in
  });

  it('--league-state-dir opts a memory run into checkpoint/resume with a per-worker path', () => {
    const r = resolveLeaguePersistence(parseArgs([`--league-state-dir=${dir}`]), {
      seedBase: 7,
      snapshotManifest: null,
    });
    expect(r.store.kind).toBe('memory');
    expect(r.leagueStatePath).toBe(join(dir, 'league-state-7.json')); // keyed on seedBase
  });

  it('--snapshot-store=disk derives the shared dir from the manifest when no dir is given', () => {
    const manifest = join(dir, 'manifest.json');
    const r = resolveLeaguePersistence(parseArgs(['--snapshot-store=disk']), {
      seedBase: 3,
      snapshotManifest: manifest,
    });
    expect(r.store.kind).toBe('disk');
    expect(r.leagueStateDir).toBe(dir);
    expect(r.leagueStatePath).toBe(join(dir, 'league-state-3.json'));
  });

  it('per-worker paths never collide across seedBases sharing one dir', () => {
    const mk = seedBase =>
      resolveLeaguePersistence(parseArgs([`--league-state-dir=${dir}`]), {
        seedBase,
        snapshotManifest: null,
      }).leagueStatePath;
    expect(mk(0)).not.toBe(mk(1000)); // disjoint env seed_bases → distinct shard/state files
  });

  it('--snapshot-store=disk with no resolvable dir fails loud', () => {
    expect(() =>
      resolveLeaguePersistence(parseArgs(['--snapshot-store=disk']), {
        seedBase: 1,
        snapshotManifest: null,
      })
    ).toThrow(/needs a shared directory/);
  });

  it('rejects an unknown --snapshot-store value', () => {
    expect(() =>
      resolveLeaguePersistence(parseArgs(['--snapshot-store=redis']), {
        seedBase: 1,
        snapshotManifest: null,
      })
    ).toThrow(/unknown/);
  });
});
