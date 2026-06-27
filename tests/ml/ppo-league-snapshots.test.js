/**
 * PFSP league snapshot pool — `refresh()` hot-loading (ml-bot Phase 3, task B step B3 — [D-22]/[D-23]).
 *
 * The producer (a Python SB3 callback) publishes self-play snapshots as exported `.weights.js`
 * modules + an atomic `manifest.json`; the env-server polls `league.refresh()` at each episode
 * boundary to hot-load the new ones via `makeBC`. These tests drive that consumer side against
 * hand-written manifests + minimal weights modules in a temp dir — covering the no-op/empty-pool
 * path, incremental loading, the mtime no-change short-circuit, FIFO eviction + disk GC, the
 * `loadedIds` guard (an evicted id is never re-imported from its deleted file), and the frozen-
 * `ENCODING_VERSION` fail-loud (manifest-level and per-snapshot).
 *
 * A "snapshot" here is a minimal `export const BC_POLICY = { encodingVersion, config:{maxAreas} }`
 * module — enough for `makeBC` to accept it (it validates encodingVersion + reads config.maxAreas;
 * the forward pass only runs when the bot acts, which `refresh()` never does). Real exported policies
 * are 2 MB; the loading logic under test is identical, so tiny stand-ins keep the suite fast.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeLeague } from '../../scripts/lib/ppo-league.mjs';

const DEFAULT_OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';
const COUNT = 6;

let dir;
let mtimeTick; // monotonic mtime stamp so manifest rewrites are always seen as "changed"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ppo-snap-'));
  mtimeTick = 1_700_000_000; // fixed base (seconds) — bumped per manifest write
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a minimal exported-policy module `snap-<step>.weights.js`; returns its bare filename. */
function writeSnapshot(step, { encodingVersion = 2, maxAreas = 32 } = {}) {
  const file = `snap-${String(step).padStart(6, '0')}.weights.js`;
  writeFileSync(
    join(dir, file),
    `export const BC_POLICY = ${JSON.stringify({ encodingVersion, config: { maxAreas } })};\n`
  );
  return file;
}

/** Write `manifest.json` and stamp it with a strictly-increasing mtime (defeats coarse fs clocks). */
function writeManifest(snapshots, { encodingVersion = 2 } = {}) {
  const path = join(dir, 'manifest.json');
  const latestStep = snapshots.reduce((m, s) => Math.max(m, s.step), 0);
  writeFileSync(path, JSON.stringify({ encodingVersion, snapshots, latestStep }));
  const t = ++mtimeTick;
  utimesSync(path, t, t);
  return path;
}

/** Manifest entry for a freshly-written snapshot at `step`. */
function snap(step, opts) {
  return { id: `snap-${step}`, step, weights: writeSnapshot(step, opts), createdAt: '2026-06-27' };
}

const league = (snapshotManifest, extra = {}) =>
  makeLeague({
    baselineCsv: DEFAULT_OPPONENTS,
    count: COUNT,
    learnerSeat: 0,
    snapshotManifest,
    ...extra,
  });

describe('ppo-league snapshots — refresh() no-op paths', () => {
  it('is a no-op with no manifest configured (empty-pool fixed-field mode)', async () => {
    const lg = league(null);
    expect(await lg.refresh()).toEqual({ added: 0, poolSize: 0 });
    expect(lg.stats()).toMatchObject({ poolSize: 0, loadedSnapshots: 0 });
  });

  it('is a no-op when the manifest file does not exist yet (producer has not published)', async () => {
    const lg = league(join(dir, 'manifest.json')); // path valid, file absent
    expect(await lg.refresh()).toEqual({ added: 0, poolSize: 0 });
  });
});

describe('ppo-league snapshots — hot-loading into the pool', () => {
  it('loads each new snapshot via makeBC and grows the pool', async () => {
    const manifest = writeManifest([snap(100), snap(200)]);
    const lg = league(manifest);
    expect(await lg.refresh()).toEqual({ added: 2, poolSize: 2 });
    expect(lg.stats()).toMatchObject({ poolSize: 2, loadedSnapshots: 2 });
  });

  it('seats snapshots in draw() once the pool is non-empty (B4 sampling on)', async () => {
    const lg = league(writeManifest([snap(100), snap(200)]));
    // Before refresh the pool is empty → the pure task-A baseline field (no snapshot seats).
    expect(lg.draw(7).drawn.every(d => d.kind === 'baseline')).toBe(true);
    await lg.refresh();
    // After refresh the pool is non-empty → PFSP now seats snapshots (player_count still held).
    const after = lg.draw(7).drawn;
    expect(after).toHaveLength(COUNT);
    expect(after.some(d => d.kind === 'snapshot')).toBe(true);
    // The detailed sampling/weighting behavior is pinned in ppo-league-pfsp.test.js.
  });

  it('re-refresh with an unchanged manifest loads nothing (mtime short-circuit)', async () => {
    const lg = league(writeManifest([snap(100)]));
    expect(await lg.refresh()).toEqual({ added: 1, poolSize: 1 });
    expect(await lg.refresh()).toEqual({ added: 0, poolSize: 1 }); // same mtime → skipped
  });

  it('loads only the newly-added snapshot on a manifest rewrite (diff by id)', async () => {
    const lg = league(join(dir, 'manifest.json'));
    writeManifest([snap(100)]);
    expect(await lg.refresh()).toEqual({ added: 1, poolSize: 1 });
    // Rewrite with one more entry (snap-100 reused; snap-300 new) and a strictly-newer mtime.
    writeManifest([{ id: 'snap-100', step: 100, weights: 'snap-000100.weights.js' }, snap(300)]);
    expect(await lg.refresh()).toEqual({ added: 1, poolSize: 2 });
    expect(lg.stats()).toMatchObject({ loadedSnapshots: 2 });
  });
});

describe('ppo-league snapshots — FIFO eviction + disk GC', () => {
  it('keeps the most-recent poolCap and GCs the evicted snapshot .js (FIFO by step)', async () => {
    const f100 = snap(100);
    const f200 = snap(200);
    const f300 = snap(300);
    const lg = league(writeManifest([f100, f200, f300]), { poolCap: 2 });
    expect(await lg.refresh()).toEqual({ added: 3, poolSize: 2 }); // loaded 3, evicted oldest

    expect(lg.stats()).toMatchObject({ poolSize: 2, loadedSnapshots: 3 });
    expect(existsSync(join(dir, f100.weights))).toBe(false); // step 100 evicted → file GC'd
    expect(existsSync(join(dir, f200.weights))).toBe(true);
    expect(existsSync(join(dir, f300.weights))).toBe(true);
  });

  it('never re-imports an evicted (GC-deleted) snapshot — the loadedIds guard', async () => {
    const f100 = snap(100);
    const path = writeManifest([f100, snap(200), snap(300)]);
    const lg = league(path, { poolCap: 2 });
    await lg.refresh();
    expect(existsSync(join(dir, f100.weights))).toBe(false); // evicted + deleted

    /*
     * Force a re-read (bump mtime, same content). snap-100 is in loadedIds → not re-imported from the
     * now-missing file, so refresh must not throw and must add nothing.
     */
    utimesSync(path, ++mtimeTick, mtimeTick);
    expect(await lg.refresh()).toEqual({ added: 0, poolSize: 2 });
  });
});

describe('ppo-league snapshots — frozen ENCODING_VERSION fail-loud', () => {
  it('rejects a manifest whose encodingVersion != the encoder (fail fast, before any import)', async () => {
    const lg = league(writeManifest([snap(100)], { encodingVersion: 99 }));
    await expect(lg.refresh()).rejects.toThrow(/encodingVersion 99/);
  });

  it('rejects a snapshot module whose own encodingVersion is skewed (per-snapshot makeBC guard)', async () => {
    // Manifest says 2 (passes the manifest check), but the weights module declares 99 → makeBC throws.
    const lg = league(writeManifest([snap(100, { encodingVersion: 99 })]));
    await expect(lg.refresh()).rejects.toThrow(/encodingVersion/);
  });
});

describe('ppo-league snapshots — construction validation', () => {
  it('rejects a non-positive or fractional poolCap', () => {
    for (const poolCap of [0, -1, 2.5]) {
      expect(() => league(null, { poolCap })).toThrow(/poolCap must be a positive integer/);
    }
  });
});
