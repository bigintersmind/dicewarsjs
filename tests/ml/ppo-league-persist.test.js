/**
 * PFSP league persistence — `toJSON()` / `restore()` (ml-bot Phase 3, task B6 — [D-23]).
 *
 * B6 lets the env-server checkpoint a league and a relaunched env-server resume it (Task-E idempotent
 * checkpoint/resume). These tests drive the round-trip against hand-written snapshot manifests in a
 * temp dir — no GPU, no policy forward pass (a "snapshot" is the minimal `export const BC_POLICY`
 * module the B3 suite uses; `draw()` only seats the `fn`, never calls it). Coverage:
 *   1. happy round-trip → identical stats / winRate / draw sequence + post-restore liveness
 *   2. evicted-weights recovery (missing file → drop from pool, KEEP id in loadedIds, no later re-import)
 *   3. pool order is preserved on restore (NOT re-sorted by step)
 *   4. dual encoding-skew gates (top-level, before any import; and per-snapshot via makeBC)
 *   5. fingerprint mismatch fails loud (drifted count / pfspK / poolCap / reserveBaselines / opponents)
 *   6. manifestMtimeMs is reset so a post-resume refresh() re-polls even a same-mtime manifest
 *   7. the cumulative no-seatBeat guard survives a restart
 *   8. the win-rate book stays keyed on the stable id (a cycled baseline seated twice)
 *   9. toJSON emits copies — a restored league never aliases the source's records
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { makeLeague } from '../../scripts/lib/ppo-league.mjs';
import { makeSharedDiskStore } from '../../scripts/lib/ppo-league-store.mjs';

const DEFAULT_OPPONENTS = 'ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive';
const COUNT = 6;

let dir;
let mtimeTick;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ppo-persist-'));
  mtimeTick = 1_700_000_000;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal exported-policy module `snap-<step>.weights.js`; returns its bare filename. */
function writeSnapshot(step, { encodingVersion = 2, maxAreas = 32 } = {}) {
  const file = `snap-${String(step).padStart(6, '0')}.weights.js`;
  writeFileSync(
    join(dir, file),
    `export const BC_POLICY = ${JSON.stringify({ encodingVersion, config: { maxAreas } })};\n`
  );
  return file;
}

/** Write `manifest.json` with a strictly-increasing mtime (defeats coarse fs clocks). Returns its path. */
function writeManifest(snapshots, { encodingVersion = 2, mtime } = {}) {
  const path = join(dir, 'manifest.json');
  const latestStep = snapshots.reduce((m, s) => Math.max(m, s.step), 0);
  writeFileSync(path, JSON.stringify({ encodingVersion, snapshots, latestStep }));
  const t = mtime ?? ++mtimeTick;
  utimesSync(path, t, t);
  return path;
}

/** Manifest entry for a freshly-written snapshot at `step`. */
function snap(step, opts) {
  return { id: `snap-${step}`, step, weights: writeSnapshot(step, opts), createdAt: '2026-06-27' };
}

const league = (snapshotManifest, extra = {}) =>
  makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0, snapshotManifest, ...extra });

/** A decisive game crediting the learner's pairwise result `beat` at each drawn opponent's seat. */
function record(lg, drawn, beatBySeat) {
  const seatBeat = Array(COUNT + 1).fill(null);
  for (const [seat, beat] of Object.entries(beatBySeat)) seatBeat[Number(seat)] = beat;
  lg.recordResult(drawn, { truncated: false, seatBeat });
}

describe('toJSON / restore — happy round-trip', () => {
  it('reproduces stats, win-rates, and the full draw sequence, and stays live', async () => {
    const manifest = writeManifest([snap(100), snap(200), snap(300)]);
    const a = league(manifest);
    await a.refresh();
    // A mix: a decisive book-crediting game, a truncated game (excluded from the book), and an extra.
    record(a, a.draw(7).drawn, { 1: 1, 2: 0 });
    a.recordResult(a.draw(8).drawn, { truncated: true, seatBeat: null });
    record(a, a.draw(9).drawn, { 3: 0.5 });
    // One decisive game with NO seatBeat[] → bumps noSeatBeatGames (warns once).
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    a.recordResult(a.draw(10).drawn, { truncated: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    const state = JSON.parse(JSON.stringify(a.toJSON())); // proves plain-JSON: no fn / Map / Set leaks
    expect(state.pool.every(p => !('fn' in p))).toBe(true);

    const b = league(manifest);
    const summary = await b.restore(state);
    expect(summary).toEqual({ restoredPool: 3, droppedPool: 0, bookSize: a.stats().bookSize });

    expect(b.stats()).toEqual(a.stats());
    for (const id of ['snap-100', 'snap-200', 'snap-300', 'ai_lookahead', 'ai_strategist']) {
      expect(b.winRate(id)).toBe(a.winRate(id));
    }
    // Sampler parity: identical drawn rosters AND seated fns across many seeds.
    for (let s = 0; s <= 200; s++) {
      const da = a.draw(s);
      const db = b.draw(s);
      expect(db.drawn).toEqual(da.drawn);
      expect(db.opponents.map(o => o.id)).toEqual(da.opponents.map(o => o.id));
      expect(db.opponents.every(o => typeof o.fn === 'function')).toBe(true);
    }
    // Liveness: the restored book is live — a post-restore record moves a fresh id from cold-start to 1.
    expect(b.winRate('liveness-probe')).toBe(0);
    record(b, [{ id: 'liveness-probe', kind: 'snapshot', seat: 1 }], { 1: 1 });
    expect(b.winRate('liveness-probe')).toBe(1);
  });
});

describe('toJSON / restore — pool reconstruction edge cases', () => {
  it('drops a snapshot whose weights file is gone but keeps its id loaded (no later re-import)', async () => {
    const manifest = writeManifest([snap(100), snap(200)]);
    const a = league(manifest);
    await a.refresh();
    const state = a.toJSON();
    // A ghost entry never imported by A and absent on disk (the ESM cache would mask a real unlink).
    const ghostPath = join(dir, 'snap-999999.weights.js'); // not written
    state.pool.push({ id: 'snap-ghost', step: 999_999, weightsPath: ghostPath });
    state.loadedIds.push('snap-ghost');

    const b = league(manifest);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const summary = await b.restore(state);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    expect(summary.restoredPool).toBe(2); // the two real snapshots
    expect(summary.droppedPool).toBe(1); // the ghost
    expect(b.stats().poolSize).toBe(2);
    expect(b.stats().loadedSnapshots).toBe(3); // ghost id retained in loadedIds
    // A later refresh re-polls (mtime reset) but never tries to import the deleted ghost (not in manifest),
    // and does not re-add the already-loaded real snapshots.
    await expect(b.refresh()).resolves.toEqual({ added: 0, poolSize: 2 });
  });

  it('preserves the serialized pool order (does NOT re-sort by step)', async () => {
    const manifest = writeManifest([snap(100), snap(300)]);
    const a = league(manifest, { reserveBaselines: 0 }); // all PFSP seats → pool order steers draws
    await a.refresh();
    // Give the two snapshots different win-rates so their pool POSITION affects the weighted draw.
    record(a, [{ id: 'snap-300', kind: 'snapshot', seat: 1 }], { 1: 1 }); // winRate 1 → tiny weight
    record(a, [{ id: 'snap-300', kind: 'snapshot', seat: 1 }], { 1: 0 }); // → winRate 0.5
    const state = a.toJSON();

    const b = league(manifest, { reserveBaselines: 0 });
    await b.restore(state); // same order as A
    const rev = league(manifest, { reserveBaselines: 0 });
    await rev.restore({ ...state, pool: [...state.pool].reverse() }); // reversed order

    const seq = lg => Array.from({ length: 60 }, (_, s) => lg.draw(s).drawn.map(d => d.id).join(',')).join('|');
    expect(seq(b)).toBe(seq(a)); // same order ⇒ identical draws
    expect(seq(rev)).not.toBe(seq(a)); // reversed order ⇒ different draws (restore honored array order)
  });
});

describe('toJSON / restore — resume seed-cursor (task E / PR-1, HOLE-A)', () => {
  it('tracks episodeCount as the booked-episode count and round-trips it as the resume cursor', async () => {
    const a = league(null);
    record(a, a.draw(0).drawn, { 1: 1 }); // decisive
    a.recordResult(a.draw(1).drawn, { truncated: true, seatBeat: null }); // truncated (still booked)
    record(a, a.draw(2).drawn, { 2: 0 }); // decisive
    const s = a.stats();
    expect(s.episodeCount).toBe(3);
    // The invariant the env-server's resume cursor relies on (seed = seedBase + episodeCount).
    expect(s.episodeCount).toBe(s.decisiveGames + s.truncatedGames);

    const b = league(null);
    await b.restore(JSON.parse(JSON.stringify(a.toJSON())));
    expect(b.stats().episodeCount).toBe(3); // the seed-cursor survives the restart
    // A post-resume booking advances the cursor (resume continues, never replays seed 0..2).
    record(b, b.draw(3).drawn, { 1: 1 });
    expect(b.stats().episodeCount).toBe(4);
  });

  it('persists a nonzero refreshSkips across a restart (run-total health metric)', async () => {
    // Drive a GC-race skip (the producer GCd a file before this worker loaded it), then prove the
    // counter carries through toJSON/restore.
    const f100 = snap(100);
    const manifest = writeManifest([f100, snap(200), snap(300)]);
    rmSync(join(dir, f100.weights), { force: true }); // gone before refresh imports it
    const b = league(manifest);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await b.refresh(); // skips the gone snap-100 → refreshSkips = 1
    warn.mockRestore();
    expect(b.stats().refreshSkips).toBe(1);

    const c = league(manifest);
    await c.restore(JSON.parse(JSON.stringify(b.toJSON())));
    expect(c.stats().refreshSkips).toBe(1);
  });
});

describe('toJSON / restore — fail-loud gates', () => {
  it('rejects an unknown checkpoint version without mutating', async () => {
    const b = league(null);
    await expect(b.restore({ version: 999 })).rejects.toThrow(/version/);
    await expect(b.restore(null)).rejects.toThrow(/version/);
  });

  it('rejects a stale v1 checkpoint (schema bumped to v2 for the resume cursor)', async () => {
    // B6 (v1) never ran live, but a v1 payload must still fail loud rather than resume with a missing
    // episodeCount and replay seeds from 0. (restore() back-fills the cursor only for a v2 payload.)
    const b = league(null);
    await expect(b.restore({ version: 1 })).rejects.toThrow(/version/);
  });

  it('rejects a top-level encodingVersion skew before importing anything', async () => {
    const manifest = writeManifest([snap(100)]);
    const a = league(manifest);
    await a.refresh();
    const state = a.toJSON();
    state.encodingVersion = 99;
    const b = league(manifest);
    await expect(b.restore(state)).rejects.toThrow(/encodingVersion/);
    expect(b.stats().poolSize).toBe(0); // untouched — threw before any mutation
    expect(b.stats().bookSize).toBe(0);
  });

  it('rejects a per-snapshot encoding skew via makeBC (not swallowed by the ENOENT path)', async () => {
    const manifest = writeManifest([snap(100)]);
    const a = league(manifest);
    await a.refresh();
    const state = a.toJSON();
    // A fresh, never-imported pooled module on disk that declares the WRONG encoding version.
    const badFile = writeSnapshot(424242, { encodingVersion: 99 });
    state.pool.push({ id: 'snap-bad', step: 424242, weightsPath: resolve(dir, badFile) });
    state.loadedIds.push('snap-bad');
    const b = league(manifest);
    await expect(b.restore(state)).rejects.toThrow(); // makeBC throws on skew — propagates, not dropped
  });

  it('rejects a pooled module that exports no BC_POLICY (would silently load the shipped BC)', async () => {
    const manifest = writeManifest([snap(100)]);
    const a = league(manifest);
    await a.refresh();
    const state = a.toJSON();
    // A parseable module with no BC_POLICY export — would fall through to makeBC's default param.
    const file = `snap-${555}.weights.js`;
    writeFileSync(join(dir, file), 'export const NOT_BC_POLICY = { encodingVersion: 2 };\n');
    state.pool.push({ id: 'snap-noexport', step: 555, weightsPath: resolve(dir, file) });
    state.loadedIds.push('snap-noexport');
    const b = league(manifest);
    await expect(b.restore(state)).rejects.toThrow(/BC_POLICY/);
    expect(b.stats().poolSize).toBe(0); // atomic — nothing applied
  });

  it('rejects a store-backend switch on resume (would silently zero the book)', async () => {
    // A memory-store checkpoint carries the full book; restoring it into a disk-store league (whose book
    // lives in shards) — or the reverse — would wipe the win-rate book. The storeKind gate forbids it.
    const a = league(null); // default in-memory store
    record(a, a.draw(1).drawn, { 1: 1 });
    const memState = a.toJSON();
    expect(memState.storeKind).toBe('memory');

    const diskLeague = makeLeague({
      baselineCsv: DEFAULT_OPPONENTS,
      count: COUNT,
      learnerSeat: 0,
      store: makeSharedDiskStore({ dir, workerId: '1' }),
    });
    await expect(diskLeague.restore(memState)).rejects.toThrow(/storeKind/);

    const diskState = diskLeague.toJSON();
    expect(diskState.storeKind).toBe('disk');
    expect(diskState.book).toBeNull(); // disk book lives in shards, not the state JSON
    await expect(league(null).restore(diskState)).rejects.toThrow(/storeKind/);
  });

  it('rejects a fingerprint mismatch (drifted league config)', async () => {
    const manifest = writeManifest([snap(100)]);
    const a = league(manifest);
    await a.refresh();
    const state = a.toJSON();

    const cases = [
      ['count', { count: 5 }],
      ['learnerSeat', { learnerSeat: 1 }],
      ['poolCap', { poolCap: 20 }],
      ['reserveBaselines', { reserveBaselines: 2 }],
      ['pfspK', { pfspK: 3 }],
      ['pfspEpsilon', { pfspEpsilon: 0.1 }],
      ['opponents', { baselineCsv: 'ai_lookahead,ai_bc' }],
    ];
    for (const [, extra] of cases) {
      const b = makeLeague({
        baselineCsv: DEFAULT_OPPONENTS,
        count: COUNT,
        learnerSeat: 0,
        snapshotManifest: manifest,
        ...extra,
      });
      await expect(b.restore(state)).rejects.toThrow(/fingerprint/);
      expect(b.stats().poolSize).toBe(0); // no half-apply
    }
  });
});

describe('toJSON / restore — durability semantics', () => {
  it('resets manifestMtimeMs so a post-resume refresh re-polls a same-mtime manifest', async () => {
    const FIXED = 1_700_500_000;
    const manifest = writeManifest([snap(100)], { mtime: FIXED });
    const a = league(manifest);
    await a.refresh(); // a.manifestMtimeMs = FIXED
    const state = a.toJSON();

    // Republish with a SECOND snapshot but the SAME mtime (simulate a coarse clock).
    writeManifest([snap(100), snap(200)], { mtime: FIXED });

    // Control: a league that kept its mtime would short-circuit on the unchanged stamp.
    expect(await a.refresh()).toEqual({ added: 0, poolSize: 1 }); // same mtime → no re-poll

    // Restored league reset mtime to -1 → it re-polls despite the identical stamp and finds snap-200.
    const b = league(manifest);
    await b.restore(state);
    expect(await b.refresh()).toEqual({ added: 1, poolSize: 2 });
  });

  it('carries the cumulative no-seatBeat guard across a restart', async () => {
    const a = league(null);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // Drive noSeatBeatGames to MAX-1 = 9 (the guard throws at 10).
    for (let i = 0; i < 9; i++) a.recordResult(a.draw(i).drawn, { truncated: false });
    expect(a.stats().noSeatBeatGames).toBe(9);
    const state = a.toJSON();

    const b = league(null);
    await b.restore(state);
    expect(b.stats().noSeatBeatGames).toBe(9);
    // The 10th no-seatBeat decisive — across the restart boundary — trips the fail-loud guard.
    expect(() => b.recordResult(b.draw(99).drawn, { truncated: false })).toThrow(/seatBeat/);
    warn.mockRestore();
  });
});

describe('toJSON / restore — book integrity', () => {
  it('keeps the book keyed on the stable id when a baseline is seated at two seats', async () => {
    // 'ai_lookahead,ai_bc' over count=6 cycles, so ai_lookahead occupies multiple seats.
    const a = makeLeague({ baselineCsv: 'ai_lookahead,ai_bc', count: COUNT, learnerSeat: 0 });
    const drawn = a.draw(1).drawn; // empty pool → cycled baseline field
    const lookSeats = drawn.filter(d => d.id === 'ai_lookahead').map(d => d.seat);
    expect(lookSeats.length).toBeGreaterThanOrEqual(2);
    const seatBeat = Array(COUNT + 1).fill(null);
    seatBeat[lookSeats[0]] = 1;
    seatBeat[lookSeats[1]] = 0;
    a.recordResult(drawn, { truncated: false, seatBeat });
    expect(a.winRate('ai_lookahead')).toBeCloseTo(0.5, 12); // 1 win / 2 games, by id

    const b = makeLeague({ baselineCsv: 'ai_lookahead,ai_bc', count: COUNT, learnerSeat: 0 });
    await b.restore(JSON.parse(JSON.stringify(a.toJSON())));
    expect(b.winRate('ai_lookahead')).toBe(a.winRate('ai_lookahead'));
  });

  it('emits copies — a restored league never mutates the source records', async () => {
    const a = league(null);
    record(a, a.draw(3).drawn, { 1: 1 });
    const before = {};
    for (const d of a.draw(3).drawn) before[d.id] = a.winRate(d.id);

    const b = league(null);
    await b.restore(a.toJSON()); // direct object, NO JSON round-trip → would share refs if not copied
    for (const d of b.draw(3).drawn) record(b, [{ id: d.id, kind: d.kind, seat: d.seat }], { [d.seat]: 0 });

    for (const id of Object.keys(before)) expect(a.winRate(id)).toBe(before[id]); // A untouched
  });

  it('preserves a dropped snapshot’s book record when its weights are gone (drop pool, keep book)', async () => {
    const manifest = writeManifest([snap(100), snap(200)]);
    const a = league(manifest);
    await a.refresh();
    // Credit snap-100 a win so it has a non-cold-start book record.
    record(a, [{ id: 'snap-100', kind: 'snapshot', seat: 1 }], { 1: 1 });
    expect(a.winRate('snap-100')).toBe(1);
    const state = a.toJSON();
    // Simulate snap-100's weights evicted on another shard machine: point its pool entry at an absent file.
    const snap100 = state.pool.find(p => p.id === 'snap-100');
    snap100.weightsPath = join(dir, 'snap-100-gone.weights.js'); // never written

    const b = league(manifest);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const summary = await b.restore(state);
    warn.mockRestore();
    expect(summary.droppedPool).toBe(1);
    expect(b.stats().poolSize).toBe(1); // snap-200 only
    expect(b.winRate('snap-100')).toBe(1); // book record survived the pool drop
    expect(b.stats().bookSize).toBe(a.stats().bookSize);
  });
});

describe('toJSON / restore — SharedDiskStore through makeLeague (the Task-E config)', () => {
  it('round-trips a disk-backed league: book recovers from the own shard, draws stay in parity', async () => {
    const manifest = writeManifest([snap(100), snap(200)]);
    const store1 = makeSharedDiskStore({ dir, workerId: '1' });
    const a = league(manifest, { store: store1, reserveBaselines: 0 });
    await a.refresh();
    record(a, [{ id: 'snap-100', kind: 'snapshot', seat: 1 }], { 1: 1 }); // winRate 1 → tiny weight
    record(a, [{ id: 'snap-200', kind: 'snapshot', seat: 1 }], { 1: 0 }); // winRate 0 → max weight
    store1.flush(); // the disk book lives in the shard, not the state JSON
    const state = JSON.parse(JSON.stringify(a.toJSON()));
    expect(state.storeKind).toBe('disk');
    expect(state.book).toBeNull();

    // Restart: a fresh disk store (same dir/workerId) recovers its own shard at construction (S6).
    const store2 = makeSharedDiskStore({ dir, workerId: '1' });
    const b = league(manifest, { store: store2, reserveBaselines: 0 });
    await b.restore(state);
    expect(b.winRate('snap-100')).toBe(a.winRate('snap-100'));
    expect(b.winRate('snap-200')).toBe(a.winRate('snap-200'));
    for (let s = 0; s < 50; s++) expect(b.draw(s).drawn).toEqual(a.draw(s).drawn); // sampler parity
  });

  it('folds a peer worker’s shard into a disk-backed league’s win-rate', () => {
    const store1 = makeSharedDiskStore({ dir, workerId: '1' });
    const a = makeLeague({ baselineCsv: DEFAULT_OPPONENTS, count: COUNT, learnerSeat: 0, store: store1 });
    record(a, [{ id: 'snapX', kind: 'snapshot', seat: 1 }], { 1: 1 }); // a: 1/1
    const peer = makeSharedDiskStore({ dir, workerId: '2' });
    peer.record('snapX', 0);
    peer.record('snapX', 0); // peer: 0/2
    peer.flush();
    store1.refreshGlobal(); // a folds the peer's shard into its global view
    expect(a.winRate('snapX')).toBeCloseTo(1 / 3, 12); // (1+0) / (1+2)
  });
});
