/**
 * Pluggable win-rate store for the PFSP league (ml-bot Phase 3, task B6 — [D-23]).
 *
 * Two backends behind one synchronous interface: `makeInMemoryStore` (the default per-process book,
 * byte-identical to the B2–B5 inline `Map`) and `makeSharedDiskStore` (the cross-worker / Task-E
 * backend — own shard in memory, peer shards folded on poll). The genuinely-multi-worker properties
 * are validated under `SubprocVecEnv` in Task E; here we exercise the FULL fold single-process by
 * running two store instances over one temp dir — idempotency, order-independence, own-shard restore,
 * torn-shard skip, and `writeJsonAtomic` crash-safety. No GPU, no policy forward pass.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makeInMemoryStore,
  makeSharedDiskStore,
  writeJsonAtomic,
} from '../../scripts/lib/ppo-league-store.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ppo-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('makeInMemoryStore', () => {
  it('records, reads win-rate, and reports size like the inline book', () => {
    const s = makeInMemoryStore();
    expect(s.winRate('x')).toBe(0); // unseen → cold-start 0
    s.record('x', 1);
    s.record('x', 0);
    s.record('x', 0.5);
    expect(s.winRate('x')).toBeCloseTo(0.5, 12); // (1+0+0.5)/3
    expect(s.size()).toBe(1);
    s.record('y', 1);
    expect(s.size()).toBe(2);
    expect(s.winRate('y')).toBe(1);
  });

  it('flush / refreshGlobal are no-ops (single-process == global)', () => {
    const s = makeInMemoryStore();
    s.record('x', 1);
    expect(() => {
      s.flush();
      s.refreshGlobal();
    }).not.toThrow();
    expect(s.winRate('x')).toBe(1);
  });

  it('toJSON emits deep COPIES so a restored store never aliases the source', () => {
    const a = makeInMemoryStore();
    a.record('x', 1);
    const entries = a.toJSON();
    const b = makeInMemoryStore();
    b.restore(entries); // direct restore, no JSON round-trip
    b.record('x', 0); // would corrupt `a` if records were shared refs
    expect(a.winRate('x')).toBe(1); // a untouched
    expect(b.winRate('x')).toBeCloseTo(0.5, 12); // (1+0)/2
  });

  it('restore(null) clears to an empty book (no throw)', () => {
    const s = makeInMemoryStore();
    s.record('x', 1);
    s.restore(null);
    expect(s.size()).toBe(0);
    expect(s.winRate('x')).toBe(0);
  });
});

describe('writeJsonAtomic', () => {
  it('writes valid JSON, overwrites in place, and leaves no .tmp behind', () => {
    const path = join(dir, 'thing.json');
    writeJsonAtomic(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    writeJsonAtomic(path, { a: 2, b: [3] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 2, b: [3] });
    expect(existsSync(`${path}.tmp`)).toBe(false); // rename consumed the tmp
  });

  it('a stale leftover .tmp never corrupts the committed file', () => {
    const path = join(dir, 'thing.json');
    writeFileSync(`${path}.tmp`, 'garbage{{{'); // simulate a torn prior write
    writeJsonAtomic(path, { ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true });
  });
});

describe('makeSharedDiskStore — single-process exercise of the cross-worker fold', () => {
  const store = workerId => makeSharedDiskStore({ dir, workerId });

  it('rejects a missing dir or workerId at construction', () => {
    expect(() => makeSharedDiskStore({ dir: '', workerId: '1' })).toThrow(/dir/);
    expect(() => makeSharedDiskStore({ dir, workerId: '' })).toThrow(/workerId/);
    expect(() => makeSharedDiskStore({ dir })).toThrow(/workerId/);
  });

  it('a fresh store sees no peers and is a clean cold start', () => {
    const a = store('1');
    expect(a.winRate('x')).toBe(0);
    expect(a.size()).toBe(0);
    a.refreshGlobal(); // empty dir / no peers — no throw
    expect(a.winRate('x')).toBe(0);
  });

  it('folds a peer shard into the win-rate read (own + peers)', () => {
    const a = store('1');
    const b = store('2');
    a.record('snap', 1);
    a.record('snap', 0); // a: 1/2
    b.record('snap', 1); // b: 1/1
    a.flush();
    b.flush();
    a.refreshGlobal(); // a folds b's shard
    expect(a.winRate('snap')).toBeCloseTo((1 + 1) / (2 + 1), 12); // 2/3
    expect(a.size()).toBe(1);
  });

  it('own book is never double-counted by its own shard', () => {
    const a = store('1');
    a.record('x', 1);
    a.flush();
    a.refreshGlobal(); // must EXCLUDE own shard
    expect(a.winRate('x')).toBe(1); // 1/1, not 2/2-with-self-fold
  });

  it('refreshGlobal is idempotent — re-reading unchanged shards never accumulates', () => {
    const a = store('1');
    const b = store('2');
    b.record('x', 1);
    b.record('x', 1);
    b.flush();
    a.refreshGlobal();
    const first = a.winRate('x');
    a.refreshGlobal();
    a.refreshGlobal();
    expect(a.winRate('x')).toBe(first); // recompute-from-scratch, not delta-accumulate
    expect(first).toBe(1);
  });

  it('the global view is independent of record/flush order', () => {
    // Path 1: a then b
    const a1 = store('1');
    const b1 = store('2');
    a1.record('x', 1);
    a1.record('x', 0);
    b1.record('x', 1);
    a1.flush();
    b1.flush();
    a1.refreshGlobal();
    const r1 = a1.winRate('x');

    rmSync(dir, { recursive: true, force: true });
    const dir2 = mkdtempSync(join(tmpdir(), 'ppo-store-'));
    // Path 2: b then a, into a fresh dir, read from b's perspective
    const a2 = makeSharedDiskStore({ dir: dir2, workerId: '1' });
    const b2 = makeSharedDiskStore({ dir: dir2, workerId: '2' });
    b2.record('x', 1);
    a2.record('x', 1);
    a2.record('x', 0);
    b2.flush();
    a2.flush();
    b2.refreshGlobal();
    const r2 = b2.winRate('x');
    rmSync(dir2, { recursive: true, force: true });

    expect(r1).toBeCloseTo(r2, 12); // both = (1+1+0)/(1+2) = 2/3
    expect(r1).toBeCloseTo(2 / 3, 12);
  });

  it('recovers OWN shard at construction (S6) and restore(null) is idempotent', () => {
    const a = store('1');
    a.record('x', 1);
    a.record('x', 1);
    a.flush();
    // Simulate restart: a brand-new store instance for the same workerId/dir recovers its own shard at
    // CONSTRUCTION — so own-book recovery does NOT depend on the league-state file existing (S6).
    const a2 = store('1');
    expect(a2.winRate('x')).toBe(1); // own history recovered without an explicit restore (2/2)
    a2.restore(null); // SharedDisk ignores the (null) arg and re-reads own shard — idempotent
    expect(a2.winRate('x')).toBe(1);
    expect(a2.size()).toBe(1);
  });

  it('toJSON returns null (the book lives in shards, not the league-state JSON)', () => {
    const a = store('1');
    a.record('x', 1);
    expect(a.toJSON()).toBeNull();
  });

  it('skips a torn/malformed peer shard and a .tmp in flight (best-effort, no crash)', () => {
    const a = store('1');
    const b = store('2');
    b.record('x', 1);
    b.flush();
    writeFileSync(join(dir, 'book-shard-3.json'), '{ this is not json'); // torn peer
    writeFileSync(join(dir, 'book-shard-4.json.tmp'), '[["x",{"wins":9,"games":9}]]'); // in-flight tmp
    expect(() => a.refreshGlobal()).not.toThrow();
    expect(a.winRate('x')).toBe(1); // only b's clean shard counted; tmp + torn ignored
    expect(a.size()).toBe(1);
  });

  it('size() counts the union of own and peer ids', () => {
    const a = store('1');
    const b = store('2');
    a.record('own-only', 1);
    a.record('shared', 1);
    b.record('shared', 0);
    b.record('peer-only', 1);
    b.flush();
    a.refreshGlobal();
    expect(a.size()).toBe(3); // own-only, shared, peer-only
  });
});
