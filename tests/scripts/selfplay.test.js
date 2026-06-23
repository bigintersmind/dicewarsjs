/**
 * Tests for the parallel self-play harness (scripts/selfplay.mjs + lib).
 *
 * Node environment (touches fs + child_process, no DOM). Covers the testable
 * core directly and the worker-pool CLI end-to-end.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FIELD,
  resolveBotsByName,
  forcedEndReason,
  generateShard,
  aggregateStats,
  makeFileWriter,
  chunkSeeds,
  rangeToSeeds,
} from '../../scripts/lib/selfplay-core.mjs';
import { deserializeTrajectory } from '../../src/arena/trajectoryExport.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
});
