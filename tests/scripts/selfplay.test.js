/**
 * Tests for the parallel self-play harness (scripts/selfplay.mjs + lib).
 *
 * Node environment (touches fs + child_process, no DOM). Covers the testable
 * core directly and the CLI end-to-end (both the worker-pool and the
 * single-worker inline execution paths).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FIELD,
  resolveBotsByName,
  expandFieldTokens,
  assignSeatNames,
  resolveSeats,
  toMatchBots,
  forcedEndReason,
  generateShard,
  aggregateStats,
  isUnusableRun,
  makeFileWriter,
  chunkSeeds,
  rangeToSeeds,
} from '../../scripts/lib/selfplay-core.mjs';
import { deserializeTrajectory } from '../../src/arena/trajectoryExport.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'selfplay-worker.mjs');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfplay-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A clean game's record compared for determinism must ignore the wall-clock stamp. */
const stripTimestamp = record => {
  const meta = { ...record.metadata };
  delete meta.timestamp;
  return { ...record, metadata: meta };
};

describe('forcedEndReason (D-14 quarantine predicate)', () => {
  const stat = over => ({ name: 'X', errors: 0, invalidMoves: 0, maxMovesHit: 0, ...over });

  it('returns null when every bot is clean', () => {
    expect(forcedEndReason([stat(), stat({ name: 'Y' })])).toBeNull();
  });

  it('flags errors, invalidMoves, and maxMovesHit', () => {
    expect(forcedEndReason([stat({ errors: 2 })])).toMatchObject({ signal: 'errors', count: 2 });
    expect(forcedEndReason([stat({ invalidMoves: 1 })])).toMatchObject({ signal: 'invalidMoves' });
    expect(forcedEndReason([stat({ maxMovesHit: 1 })])).toMatchObject({ signal: 'maxMovesHit' });
  });

  it('reports errors first when multiple signals are present (stable signal)', () => {
    expect(forcedEndReason([stat({ errors: 1, invalidMoves: 5, maxMovesHit: 3 })])).toMatchObject({
      signal: 'errors',
    });
  });

  it('checks every seat, not just the first', () => {
    const reason = forcedEndReason([stat(), stat({ name: 'Z', invalidMoves: 4 })]);
    expect(reason).toMatchObject({ bot: 'Z', signal: 'invalidMoves' });
  });
});

describe('resolveBotsByName', () => {
  it('resolves known names case-insensitively to { id, name, fn }', () => {
    const [bot] = resolveBotsByName(['strategist']);
    expect(bot.name).toBe('Strategist');
    expect(bot.id).toBeTruthy();
    expect(typeof bot.fn).toBe('function');
  });

  it('throws a helpful error listing the available bots for an unknown name', () => {
    expect(() => resolveBotsByName(['NotABot'])).toThrow(/Unknown bot "NotABot"/);
    // The message names the valid options so the operator can self-correct.
    expect(() => resolveBotsByName(['NotABot'])).toThrow(/Available:.*Strategist/);
  });
});

describe('duplicate-seat support (D-Encoding: N×Lookahead mirror self-play)', () => {
  describe('expandFieldTokens', () => {
    it('expands an <count>x<Bot> multiplier into N seats', () => {
      expect(expandFieldTokens(['7xLookahead'])).toEqual(Array(7).fill('Lookahead'));
    });

    it('mixes multipliers with plain tokens, preserving seat order', () => {
      expect(expandFieldTokens(['Lookahead', '3xStrategist'])).toEqual([
        'Lookahead',
        'Strategist',
        'Strategist',
        'Strategist',
      ]);
    });

    it('passes plain tokens through unchanged (including names containing "x")', () => {
      // "Expectimax" has no LEADING <digits>x, so it is never mistaken for a multiplier.
      expect(expandFieldTokens(['Expectimax', 'Defensive'])).toEqual(['Expectimax', 'Defensive']);
    });

    it('accepts a case-insensitive multiplier marker', () => {
      expect(expandFieldTokens(['2XLookahead'])).toEqual(['Lookahead', 'Lookahead']);
    });

    it('rejects a zero-count multiplier', () => {
      expect(() => expandFieldTokens(['0xLookahead'])).toThrow(/count must be >= 1/);
    });
  });

  describe('assignSeatNames', () => {
    it('suffixes only the names that occupy more than one seat', () => {
      expect(assignSeatNames(['Lookahead', 'Lookahead', 'Strategist'])).toEqual([
        'Lookahead#1',
        'Lookahead#2',
        'Strategist',
      ]);
    });

    it('leaves an all-distinct field unchanged', () => {
      expect(assignSeatNames(['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
    });

    it('numbers every seat of a pure mirror and stays distinct', () => {
      const names = assignSeatNames(Array(7).fill('Lookahead'));
      expect(names).toEqual(['#1', '#2', '#3', '#4', '#5', '#6', '#7'].map(s => `Lookahead${s}`));
      expect(new Set(names).size).toBe(7);
    });
  });

  describe('resolveSeats', () => {
    it('resolves a mirror field to distinct display names sharing one policy fn', () => {
      const bots = resolveSeats(['Lookahead', 'Lookahead']);
      expect(bots.map(b => b.displayName)).toEqual(['Lookahead#1', 'Lookahead#2']);
      expect(bots.map(b => b.baseName)).toEqual(['Lookahead', 'Lookahead']);
      // `id` looks unused but feeds the CLI's non-deterministic-bot warning filter
      // (NON_DETERMINISTIC_BOT_IDS) — currently unreachable with an empty set, so this
      // pin is the only thing keeping the field from being silently dropped.
      expect(bots.map(b => b.id)).toEqual(['ai_lookahead', 'ai_lookahead']);
      // Same policy in both seats — the whole point of mirror self-play.
      expect(bots[0].fn).toBe(bots[1].fn);
      expect(typeof bots[0].fn).toBe('function');
    });

    it('produces names aggregateStats accepts (the matchRunner unique-name contract)', () => {
      const bots = resolveSeats(expandFieldTokens(['7xLookahead']));
      // Distinct names → aggregateStats does not throw its duplicate-name guard.
      expect(() =>
        aggregateStats(
          [],
          bots.map(b => b.displayName)
        )
      ).not.toThrow();
    });

    it('throws on an unknown name (validation via resolveBotsByName)', () => {
      expect(() => resolveSeats(['Lookahead', 'NotABot'])).toThrow(/Unknown bot "NotABot"/);
    });
  });

  it('runs a real mirror field through generateShard and tags seats #1.. in the trajectory', () => {
    /*
     * The seam this whole feature exists for: a duplicate-policy field must NOT trip
     * matchRunner's "Bot names must be unique" guard, and the lean record must carry the
     * per-seat display names.
     */
    const bots = toMatchBots(resolveSeats(expandFieldTokens(['3xLookahead'])));
    const lines = [];
    const { summaries, written } = generateShard({
      bots,
      seeds: [1, 2],
      write: l => lines.push(l),
    });

    expect(summaries).toHaveLength(2);
    expect(written).toBeGreaterThan(0); // Lookahead is decisive — games resolve, none quarantined
    const record = deserializeTrajectory(lines[0]);
    expect(record.metadata.bots).toEqual(['Lookahead#1', 'Lookahead#2', 'Lookahead#3']);
    expect(record.config.playerCount).toBe(3);
  }, 30_000);
});

describe('chunkSeeds / rangeToSeeds (D-13 seed-range sharding)', () => {
  it('builds a contiguous ascending seed range', () => {
    expect(rangeToSeeds(5, 4)).toEqual([5, 6, 7, 8]);
    expect(rangeToSeeds(1, 1)).toEqual([1]);
    expect(rangeToSeeds(10, 0)).toEqual([]);
  });

  it('splits evenly when the count divides by the worker count', () => {
    expect(chunkSeeds(1, 6, 3)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('spreads the remainder over the first blocks, staying contiguous and ascending', () => {
    expect(chunkSeeds(1, 10, 3)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
      [8, 9, 10],
    ]);
  });

  it('concatenates back to the original strict-ascending range (lossless merge)', () => {
    const flat = chunkSeeds(100, 17, 4).flat();
    expect(flat).toEqual(rangeToSeeds(100, 17));
  });

  it('skips zero-size blocks when workers exceed the seed count (no empty chunks)', () => {
    expect(chunkSeeds(1, 2, 5)).toEqual([[1], [2]]);
  });
});

describe('generateShard', () => {
  const field = () => resolveBotsByName(DEFAULT_FIELD).map(b => ({ name: b.name, fn: b.fn }));

  it('streams one round-trippable trajectory per clean game', () => {
    const lines = [];
    const { summaries, written } = generateShard({
      bots: field(),
      seeds: [1, 2, 3],
      write: l => lines.push(l),
    });

    expect(summaries).toHaveLength(3);
    expect(written).toBe(lines.length);
    expect(written).toBe(summaries.filter(s => !s.quarantined).length);

    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      const record = deserializeTrajectory(line); // throws if malformed/poisoned
      expect(record.config.seed).toBeGreaterThanOrEqual(1);
      // The summary's actionCount matches the serialized lean action list.
      const summary = summaries.find(s => s.seed === record.config.seed);
      expect(summary.actionCount).toBe(record.actions.length);
    }
  });

  it('is deterministic: same seeds reproduce the same games (modulo timestamp)', () => {
    const run = () => {
      const lines = [];
      generateShard({ bots: field(), seeds: [10, 11, 12], write: l => lines.push(l) });
      return lines.map(l => stripTimestamp(JSON.parse(l)));
    };
    expect(run()).toEqual(run());
  });

  it('never retains heavy match objects — summaries stay tiny', () => {
    const { summaries } = generateShard({ bots: field(), seeds: [1], write: () => {} });
    // A summary carries only scalars + the placements array — no finalState/trajectory.
    expect(Object.keys(summaries[0]).sort()).toEqual(
      [
        'actionCount',
        'placements',
        'quarantineSignal',
        'quarantined',
        'seed',
        'turnCount',
        'winner',
      ].sort()
    );
  });

  describe('D-14 quarantine drops dirty games but counts them', () => {
    const strategist = resolveBotsByName(['Strategist'])[0];

    it('quarantines a game where a bot throws (errors signal)', () => {
      const lines = [];
      const thrower = {
        name: 'Thrower',
        fn: () => {
          throw new Error('boom');
        },
      };
      const { summaries, written, quarantined } = generateShard({
        bots: [thrower, { name: strategist.name, fn: strategist.fn }],
        seeds: [1, 2],
        write: l => lines.push(l),
      });

      expect(written).toBe(0);
      expect(lines).toHaveLength(0);
      expect(quarantined).toBe(2);
      expect(summaries.every(s => s.quarantined && s.quarantineSignal === 'errors')).toBe(true);
    });

    it('quarantines a game with repeated invalid moves (invalidMoves signal)', () => {
      const lines = [];
      const invalidBot = { name: 'BadMover', fn: () => ({ from: 0, to: 0 }) }; // illegal every time
      const { summaries, written } = generateShard({
        bots: [invalidBot, { name: strategist.name, fn: strategist.fn }],
        seeds: [3],
        write: l => lines.push(l),
      });

      expect(written).toBe(0);
      expect(summaries[0].quarantined).toBe(true);
      expect(summaries[0].quarantineSignal).toBe('invalidMoves');
    });

    /*
     * maxMovesHit (a turn force-ended by the MAX_MOVES_PER_TURN cap) and a runMatch
     * throw can't be triggered deterministically with real games (<0.1% — PLAN/D-14),
     * so these drive generateShard through its injectable runMatch seam.
     */
    const fakeResult = (overrides = {}) => ({
      winner: 0,
      placements: [0, 1],
      turnCount: 5,
      trajectory: { actions: [] },
      botStats: [
        { name: 'A', errors: 0, invalidMoves: 0, maxMovesHit: 0 },
        { name: 'B', errors: 0, invalidMoves: 0, maxMovesHit: 0 },
      ],
      ...overrides,
    });

    it('quarantines a game force-ended by the move cap (maxMovesHit signal)', () => {
      const lines = [];
      const { summaries, written } = generateShard({
        bots: [
          { name: 'A', fn: () => null },
          { name: 'B', fn: () => null },
        ],
        seeds: [1],
        write: l => lines.push(l),
        runMatchFn: () =>
          fakeResult({
            botStats: [
              { name: 'A', errors: 0, invalidMoves: 0, maxMovesHit: 1 },
              { name: 'B', errors: 0, invalidMoves: 0, maxMovesHit: 0 },
            ],
          }),
      });

      expect(written).toBe(0);
      expect(lines).toHaveLength(0);
      expect(summaries[0].quarantined).toBe(true);
      expect(summaries[0].quarantineSignal).toBe('maxMovesHit');
    });

    it('aborts when the failure rate exceeds the threshold after the minimum games', () => {
      const { summaries, failed, aborted } = generateShard({
        bots: [
          { name: 'A', fn: () => null },
          { name: 'B', fn: () => null },
        ],
        seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        runMatchFn: () => {
          throw new Error('match exploded');
        },
      });

      // 100% failure trips the >50%-after-5 guard, so it bails early (does not run all 10).
      expect(aborted).toBe(true);
      expect(failed).toBe(5);
      expect(summaries).toHaveLength(5);
      expect(summaries.every(s => s.quarantined && s.failed)).toBe(true);
    });
  });
});

describe('aggregateStats (deterministic ELO/stats post-pass)', () => {
  const botNames = ['A', 'B', 'C'];
  // A wins every clean game; one quarantined game must be excluded from ELO/win%.
  const summaries = [
    {
      seed: 3,
      placements: [0, 1, 2],
      winner: 0,
      turnCount: 20,
      actionCount: 100,
      quarantined: false,
    },
    {
      seed: 1,
      placements: [0, 2, 1],
      winner: 0,
      turnCount: 30,
      actionCount: 200,
      quarantined: false,
    },
    {
      seed: 2,
      placements: [0, 1, 2],
      winner: 0,
      turnCount: 25,
      actionCount: 150,
      quarantined: false,
    },
    { seed: 4, quarantined: true, quarantineSignal: 'errors' },
    { seed: 5, quarantined: true, failed: true, error: 'boom' },
  ];

  it('separates clean from quarantined/failed games', () => {
    const stats = aggregateStats(summaries, botNames);
    expect(stats.totalGames).toBe(5);
    expect(stats.cleanGames).toBe(3);
    expect(stats.quarantinedGames).toBe(2);
    expect(stats.failedGames).toBe(1);
    expect(stats.cleanRate).toBeCloseTo(0.6, 5);
    expect(stats.quarantineBySignal).toEqual({
      errors: 1,
      invalidMoves: 0,
      maxMovesHit: 0,
      failed: 1,
    });
    // The failed game's message is surfaced (not just counted) for diagnosability.
    expect(stats.failureSamples).toEqual([{ error: 'boom', count: 1, firstSeed: 5 }]);
  });

  it('aggregates failures by message (count + lowest seed), most frequent first', () => {
    const withFailures = [
      { seed: 7, quarantined: true, failed: true, error: 'boom' },
      { seed: 2, quarantined: true, failed: true, error: 'boom' },
      { seed: 9, quarantined: true, failed: true, error: 'kaboom' },
    ];
    const stats = aggregateStats(withFailures, botNames);
    expect(stats.failedGames).toBe(3);
    // 'boom' collapses to one group (count 2, lowest seed 2) and outranks the rarer 'kaboom'.
    expect(stats.failureSamples).toEqual([
      { error: 'boom', count: 2, firstSeed: 2 },
      { error: 'kaboom', count: 1, firstSeed: 9 },
    ]);
  });

  it('ranks the consistent winner first by ELO and reports win rate over clean games', () => {
    const stats = aggregateStats(summaries, botNames);
    expect(stats.bots[0].name).toBe('A');
    expect(stats.bots[0].wins).toBe(3);
    expect(stats.bots[0].winRate).toBe(1);
    expect(stats.bots[0].gamesPlayed).toBe(3);
    // Loser ELO sits below the default; winner above.
    expect(stats.bots[0].elo).toBeGreaterThan(stats.bots[stats.bots.length - 1].elo);
  });

  it('computes the action-count distribution over clean games', () => {
    const stats = aggregateStats(summaries, botNames);
    expect(stats.actionCounts.min).toBe(100);
    expect(stats.actionCounts.max).toBe(200);
    expect(stats.actionCounts.p50).toBe(150);
    expect(stats.actionCounts.mean).toBe(150);
  });

  it('is independent of summary order (path-dependent ELO replayed by seed)', () => {
    const shuffled = [summaries[2], summaries[0], summaries[4], summaries[1], summaries[3]];
    expect(aggregateStats(shuffled, botNames)).toEqual(aggregateStats(summaries, botNames));
  });

  it('throws on duplicate bot names rather than silently collapsing two seats', () => {
    // ELO/wins are keyed by name; a duplicate would skew the ranking. Fail loud.
    expect(() => aggregateStats([], ['A', 'B', 'A'])).toThrow(/distinct bot names/);
  });

  it('keeps a stalemate (winner null) as a clean game that credits no win but still moves ELO', () => {
    /*
     * A maxTurns stalemate is clean (not a forced-end quarantine) and a real engine outcome;
     * it must rank by placement without crediting anyone a win.
     */
    const withStalemate = [
      {
        seed: 1,
        placements: [0, 1, 2],
        winner: 0,
        turnCount: 10,
        actionCount: 50,
        quarantined: false,
      },
      {
        seed: 2,
        placements: [1, 0, 2],
        winner: null,
        turnCount: 500,
        actionCount: 999,
        quarantined: false,
      },
    ];
    const stats = aggregateStats(withStalemate, botNames);
    expect(stats.cleanGames).toBe(2);
    // Only the decisive game (seed 1, winner A) credits a win.
    expect(stats.bots.reduce((n, b) => n + b.wins, 0)).toBe(1);
    // The stalemate still updated ratings by placement, so not everyone sits at the default.
    expect(stats.bots.some(b => b.elo !== 1200)).toBe(true);
  });

  it('labels a blank runMatch-throw message as "unknown error" instead of grouping on ""', () => {
    /*
     * `new Error()` yields an empty message; `??` keeps '' (only null/undefined fall through),
     * so the report must use `||` to surface a usable label.
     */
    const stats = aggregateStats(
      [{ seed: 4, quarantined: true, failed: true, error: '' }],
      botNames
    );
    expect(stats.failedGames).toBe(1);
    expect(stats.failureSamples).toEqual([{ error: 'unknown error', count: 1, firstSeed: 4 }]);
  });

  it('reports an all-zero action-count distribution when no games are clean (no NaN/throw)', () => {
    const allDirty = [
      { seed: 1, quarantined: true, quarantineSignal: 'errors' },
      { seed: 2, quarantined: true, failed: true, error: 'boom' },
    ];
    const stats = aggregateStats(allDirty, botNames);
    expect(stats.cleanGames).toBe(0);
    expect(stats.cleanRate).toBe(0);
    expect(stats.actionCounts).toEqual({ min: 0, p50: 0, mean: 0, p95: 0, max: 0 });
    // Every bot is reported at the default rating with a zero win rate.
    expect(stats.bots.every(b => b.elo === 1200 && b.winRate === 0)).toBe(true);
  });

  it('interpolates the p95 action-count over clean games', () => {
    // actionCounts 0..100 (101 values): p95 rank = 0.95 * 100 = 95 → value 95.
    const many = Array.from({ length: 101 }, (_, i) => ({
      seed: i,
      placements: [0, 1, 2],
      winner: 0,
      turnCount: 1,
      actionCount: i,
      quarantined: false,
    }));
    const stats = aggregateStats(many, botNames);
    expect(stats.actionCounts.min).toBe(0);
    expect(stats.actionCounts.max).toBe(100);
    expect(stats.actionCounts.p95).toBe(95);
  });
});

describe('isUnusableRun (CLI non-zero-exit policy)', () => {
  it('flags an aborted run regardless of output mode or clean count', () => {
    expect(isUnusableRun({ aborted: true, wroteOutput: true, cleanGames: 100 })).toBe(true);
    expect(isUnusableRun({ aborted: true, wroteOutput: false, cleanGames: 0 })).toBe(true);
  });

  it('flags a write run that produced zero clean games', () => {
    expect(isUnusableRun({ aborted: false, wroteOutput: true, cleanGames: 0 })).toBe(true);
  });

  it('passes a write run with at least one clean game', () => {
    expect(isUnusableRun({ aborted: false, wroteOutput: true, cleanGames: 1 })).toBe(false);
  });

  it('does not flag a --no-write throughput run on clean-count alone', () => {
    expect(isUnusableRun({ aborted: false, wroteOutput: false, cleanGames: 0 })).toBe(false);
  });
});

describe('makeFileWriter', () => {
  it('writes batched lines across the flush boundary and closes cleanly', () => {
    const out = path.join(tmpDir, 'w.jsonl');
    const writer = makeFileWriter(out);
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}\n`);
    lines.forEach(writer.write);
    writer.close();

    const contents = fs.readFileSync(out, 'utf-8');
    expect(contents).toBe(lines.join(''));
    expect(contents.trimEnd().split('\n')).toHaveLength(300);
  });

  it('is a no-op when given a null path (--no-write)', () => {
    const writer = makeFileWriter(null);
    expect(() => {
      writer.write('ignored\n');
      writer.close();
    }).not.toThrow();
  });
});

describe('selfplay CLI end-to-end (worker pool)', () => {
  it('runs a sharded pool and writes seed-ordered, round-trippable JSONL', () => {
    const out = path.join(tmpDir, 'e2e.jsonl');
    execFileSync(
      'node',
      [
        'scripts/selfplay.mjs',
        '--workers',
        '2',
        '--seed-count',
        '6',
        '--out',
        out,
        '--bots',
        DEFAULT_FIELD.join(','),
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );

    expect(fs.existsSync(out)).toBe(true);
    const records = fs
      .readFileSync(out, 'utf-8')
      .trim()
      .split('\n')
      .map(line => deserializeTrajectory(line));

    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(6);

    // Concatenation preserves strict seed order across the two shard part-files.
    const seeds = records.map(r => r.config.seed);
    expect(seeds).toEqual([...seeds].sort((a, b) => a - b));
    expect(seeds.every(s => s >= 1 && s <= 6)).toBe(true);

    // Shard part-files are cleaned up after a successful merge (none orphaned).
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.part'))).toHaveLength(0);
  }, 60_000);

  it('runs a duplicate-policy mirror field (--bots 3xLookahead) end-to-end through workers', () => {
    /*
     * Proves the worker boundary derives the same #n display names as the main thread,
     * so a mirror field neither trips the unique-name guard nor collides ELO seats.
     */
    const out = path.join(tmpDir, 'mirror.jsonl');
    execFileSync(
      'node',
      [
        'scripts/selfplay.mjs',
        '--workers',
        '2',
        '--seed-count',
        '2',
        '--out',
        out,
        '--bots',
        '3xLookahead',
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );

    const records = fs
      .readFileSync(out, 'utf-8')
      .trim()
      .split('\n')
      .map(line => deserializeTrajectory(line));

    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.config.playerCount).toBe(3);
      expect(r.metadata.bots).toEqual(['Lookahead#1', 'Lookahead#2', 'Lookahead#3']);
    }
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.part'))).toHaveLength(0);
  }, 60_000);

  it('cleans up shard part-files when the merge fails (no orphans on error)', () => {
    /*
     * Point --out at an existing *directory* so the final concat
     * (createWriteStream) fails with EISDIR *after* the workers have written
     * their part-files — exercising the runPool finally cleanup + concatParts
     * error path, which the success-path e2e above can't reach.
     */
    const outDir = path.join(tmpDir, 'out-is-a-dir');
    fs.mkdirSync(outDir);

    let threw = false;
    let stderr = '';
    try {
      execFileSync(
        'node',
        [
          'scripts/selfplay.mjs',
          '--workers',
          '2',
          '--seed-count',
          '4',
          '--out',
          outDir,
          '--bots',
          DEFAULT_FIELD.join(','),
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' }
      );
    } catch (err) {
      threw = true;
      stderr = String(err.stderr ?? '');
    }

    expect(threw).toBe(true); // non-zero exit
    expect(stderr).toMatch(/Self-play run failed/);
    // The finally removed both .part files even though the merge threw — no orphans.
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.part'))).toHaveLength(0);
  }, 60_000);
});

describe('selfplay worker error plumbing', () => {
  it('posts {type:error} carrying the message and in-worker stack on a failure', async () => {
    /*
     * Drive the worker's catch → postMessage({type:error}) path directly: an
     * unknown bot name makes resolveBotsByName throw inside the worker. This
     * verifies the worker reports the failure as a message (not a crash) and
     * forwards the stack the main thread now surfaces.
     */
    const msg = await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_PATH, {
        workerData: {
          workerId: 3,
          baseSeats: ['NotARealBot'],
          seeds: [1],
          maxTurns: 500,
          outPath: null,
        },
      });
      worker.on('message', resolve);
      worker.on('error', reject); // a real crash (not the expected error message) fails the test
    });

    expect(msg.type).toBe('error');
    expect(msg.workerId).toBe(3);
    expect(msg.message).toMatch(/Unknown bot "NotARealBot"/);
    expect(typeof msg.stack).toBe('string');
    expect(msg.stack.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('selfplay CLI argument validation', () => {
  /** Run the CLI and capture exit code + stderr (execFileSync throws on non-zero exit). */
  const runCli = args => {
    try {
      execFileSync('node', ['scripts/selfplay.mjs', ...args], { cwd: REPO_ROOT, stdio: 'pipe' });
      return { code: 0, stderr: '' };
    } catch (err) {
      return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
    }
  };

  it('rejects a non-positive --seed-count with a helpful message', () => {
    const { code, stderr } = runCli(['--seed-count', '0']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--seed-count .* must be a positive integer/);
  }, 30_000);

  it('rejects a non-positive --workers', () => {
    const { code, stderr } = runCli(['--workers', '0', '--seed-count', '2']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--workers must be a positive integer/);
  }, 30_000);

  it('rejects a field of fewer than two bots', () => {
    const { code, stderr } = runCli(['--bots', 'Strategist', '--seed-count', '2']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Need at least 2 bots/);
  }, 30_000);

  it('rejects an unknown bot name and lists the available bots', () => {
    const { code, stderr } = runCli(['--bots', 'NotABot,Strategist', '--seed-count', '2']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/Unknown bot "NotABot"/);
    expect(stderr).toMatch(/Available:.*Strategist/);
  }, 30_000);
});

describe('selfplay CLI end-to-end (single-core inline path)', () => {
  it('runs the --workers 1 inline path and writes seed-ordered JSONL with no part-files', () => {
    const out = path.join(tmpDir, 'inline.jsonl');
    execFileSync(
      'node',
      [
        'scripts/selfplay.mjs',
        '--workers',
        '1',
        '--seed-count',
        '4',
        '--out',
        out,
        '--bots',
        DEFAULT_FIELD.join(','),
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );

    expect(fs.existsSync(out)).toBe(true);
    const records = fs
      .readFileSync(out, 'utf-8')
      .trim()
      .split('\n')
      .map(line => deserializeTrajectory(line));

    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(4);

    // Inline output is strictly seed-ordered over the requested range.
    const seeds = records.map(r => r.config.seed);
    expect(seeds).toEqual([...seeds].sort((a, b) => a - b));
    expect(seeds.every(s => s >= 1 && s <= 4)).toBe(true);

    // The inline path writes outPath directly — it must NOT create any .part shard files.
    expect(fs.readdirSync(tmpDir).filter(f => f.includes('.part'))).toHaveLength(0);
  }, 60_000);

  it('runs a mirror field (--bots 3xLookahead) inline with the same #n display names', () => {
    /*
     * The inline path projects seats for generateShard at its own call site (no
     * worker boundary), so pin that it, too, hands over *display* names — a
     * projection that passed base names would pass the distinct-name test above
     * and only break on a mirror field (issue #47's rename seam).
     */
    const out = path.join(tmpDir, 'inline-mirror.jsonl');
    execFileSync(
      'node',
      [
        'scripts/selfplay.mjs',
        '--workers',
        '1',
        '--seed-count',
        '2',
        '--out',
        out,
        '--bots',
        '3xLookahead',
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    );

    const records = fs
      .readFileSync(out, 'utf-8')
      .trim()
      .split('\n')
      .map(line => deserializeTrajectory(line));

    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.config.playerCount).toBe(3);
      expect(r.metadata.bots).toEqual(['Lookahead#1', 'Lookahead#2', 'Lookahead#3']);
    }
  }, 60_000);
});
