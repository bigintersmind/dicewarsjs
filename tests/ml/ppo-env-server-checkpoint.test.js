/**
 * PPO env-server checkpoint dumper + DONE health line (Phase 3, task E / PR-1 — [D-26]).
 *
 * These pin the two seams the PR's crash-safety guarantees actually live in, extracted from `main()`
 * (which is not exported — it spawns a worker/socket) precisely so they can be unit-tested:
 *
 *  - `makeCheckpointDumper` — the HOLE-B write ORDER (state file BEFORE the store shard, so a crash
 *    in the window loses bounded games instead of double-counting into the PFSP book) and the
 *    consecutive-failure abort (a persistently-dead checkpoint path must fail loud, not silently
 *    write zero checkpoints for a multi-day run). A revert that swaps the two writes, or drops the
 *    abort, would otherwise pass every other test.
 *  - `formatDoneLine` — the exact health-field set the B5 probes parse and the stderr mirror emits.
 */

import {
  makeCheckpointDumper,
  formatDoneLine,
  resumeStartEpisode,
  shouldRunEpisode,
} from '../../scripts/ppo-env-server.mjs';

/** A fake league whose toJSON pushes a marker so write order is observable. */
function fakeLeague(order) {
  return {
    toJSON: () => {
      order.push('state');
      return { version: 2, episodeCount: 7 };
    },
  };
}

/** A fake store whose flush pushes a marker (and can be made to throw). */
function fakeStore(order, { throwOnFlush = false } = {}) {
  return {
    kind: 'disk',
    flush: () => {
      order.push('flush');
      if (throwOnFlush) throw new Error('shard write failed (simulated)');
    },
  };
}

describe('makeCheckpointDumper — HOLE-B write order', () => {
  it('writes the state file FIRST, then flushes the store shard (cursor may lead the shard, never trail)', () => {
    const order = [];
    const writes = [];
    const dumper = makeCheckpointDumper({
      leagueStatePath: '/run/league-state.json',
      league: fakeLeague(order),
      store: fakeStore(order),
      writeJson: (path, obj) => {
        order.push('write');
        writes.push({ path, obj });
      },
    });
    dumper.dump();
    // `state` (toJSON) and `write` happen together, then `flush` — the state file is durable before
    // the shard. Shard-first would let a crash leave the shard ahead of the cursor → resume replays
    // and double-counts those seeds into the win-rate book.
    expect(order).toEqual(['state', 'write', 'flush']);
    expect(writes).toEqual([
      { path: '/run/league-state.json', obj: { version: 2, episodeCount: 7 } },
    ]);
    expect(dumper.getDumpFailures()).toBe(0);
  });

  it('is a no-op when persistence is off (leagueStatePath null) — never touches writeJson/store', () => {
    const order = [];
    let wrote = false;
    const dumper = makeCheckpointDumper({
      leagueStatePath: null,
      league: fakeLeague(order),
      store: fakeStore(order),
      writeJson: () => {
        wrote = true;
      },
    });
    dumper.dump();
    expect(order).toEqual([]);
    expect(wrote).toBe(false);
    expect(dumper.getDumpFailures()).toBe(0);
  });
});

describe('makeCheckpointDumper — failure accounting + abort', () => {
  it('on a flush failure, the state file is still written (state-ahead = the SAFE skew) and dump does not throw', () => {
    const order = [];
    const dumper = makeCheckpointDumper({
      leagueStatePath: '/run/league-state.json',
      league: fakeLeague(order),
      store: fakeStore(order, { throwOnFlush: true }),
      writeJson: () => order.push('write'),
    });
    expect(() => dumper.dump()).not.toThrow(); // best-effort: a transient failure never crashes the run
    expect(order).toEqual(['state', 'write', 'flush']); // state was written BEFORE the flush threw
    expect(dumper.getDumpFailures()).toBe(1);
  });

  it('aborts loud after maxConsecutiveFailures consecutive failures (a dead checkpoint path)', () => {
    const dumper = makeCheckpointDumper({
      leagueStatePath: '/run/league-state.json',
      league: { toJSON: () => ({}) },
      store: { kind: 'disk', flush: () => {} },
      writeJson: () => {
        throw new Error('ENOSPC: no space left on device');
      },
      maxConsecutiveFailures: 3,
    });
    expect(() => dumper.dump()).not.toThrow(); // 1
    expect(() => dumper.dump()).not.toThrow(); // 2
    expect(() => dumper.dump()).toThrow(/3 consecutive league-state dumps failed/); // 3 → abort
    expect(dumper.getDumpFailures()).toBe(3);
  });

  it('a success resets the consecutive-failure counter, so it takes a fresh run of failures to abort', () => {
    let failNext = true;
    const dumper = makeCheckpointDumper({
      leagueStatePath: '/run/league-state.json',
      league: { toJSON: () => ({}) },
      store: { kind: 'disk', flush: () => {} },
      writeJson: () => {
        if (failNext) throw new Error('transient EIO');
      },
      maxConsecutiveFailures: 2,
    });
    expect(() => dumper.dump()).not.toThrow(); // fail #1 (consecutive=1)
    failNext = false;
    expect(() => dumper.dump()).not.toThrow(); // success → consecutive reset to 0
    failNext = true;
    expect(() => dumper.dump()).not.toThrow(); // fail again (consecutive=1, not 2 → no abort)
    expect(dumper.getDumpFailures()).toBe(2); // total failures counted across the run
  });
});

describe('formatDoneLine', () => {
  it('emits every health field the B5 probes parse, with the dumper failure count', () => {
    const s = {
      decisiveGames: 120,
      truncatedGames: 5,
      decisiveRate: 0.96,
      poolSize: 8,
      loadedSnapshots: 30,
      bookSize: 11,
      episodeCount: 125,
      refreshSkips: 2,
      noSeatBeatGames: 0,
    };
    const line = formatDoneLine(125, s, 3);
    expect(line).toBe(
      'PPO_ENV_SERVER DONE episodes=125 decisiveGames=120 truncatedGames=5 decisiveRate=0.9600 ' +
        'poolSize=8 loadedSnapshots=30 bookSize=11 episodeCount=125 refreshSkips=2 ' +
        'noSeatBeatGames=0 dumpFailures=3'
    );
  });
});

describe('resume loop bounds (task E / PR-1, HOLE-A)', () => {
  it('resumeStartEpisode reads the league booked-episode count (0 fresh, N resumed)', () => {
    expect(resumeStartEpisode({ stats: () => ({ episodeCount: 0 }) })).toBe(0);
    expect(resumeStartEpisode({ stats: () => ({ episodeCount: 42 }) })).toBe(42);
  });

  it('shouldRunEpisode runs unbounded when episodes=0 (until client disconnect)', () => {
    expect(shouldRunEpisode(0, 0)).toBe(true);
    expect(shouldRunEpisode(1_000_000, 0)).toBe(true);
  });

  it('treats --episodes=N as a run TOTAL: stops at N regardless of where the resume cursor starts', () => {
    // Fresh run: plays ep 0..99, stops at 100.
    expect(shouldRunEpisode(99, 100)).toBe(true);
    expect(shouldRunEpisode(100, 100)).toBe(false);
    // Resumed at 99 (99 already booked): plays exactly ep 99, then stops — N is the total, not +N more.
    expect(shouldRunEpisode(99, 100)).toBe(true);
    // Resume cursor already meets/exceeds the budget → body never runs (clean no-op, not a fresh N).
    expect(shouldRunEpisode(100, 100)).toBe(false);
    expect(shouldRunEpisode(150, 100)).toBe(false);
  });
});
