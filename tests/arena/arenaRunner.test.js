import { runArena } from '../../src/arena/arenaRunner.js';
import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';
import { OBSERVATION_SCHEMA_VERSION } from '../../src/arena/trajectoryExport.js';

const exampleBot = adaptLegacyBot(ai_example);
const defaultBot = adaptLegacyBot(ai_default);

describe('runArena', () => {
  it('runs multiple games and returns aggregated results', () => {
    const result = runArena({
      bots: [
        { name: 'example', fn: exampleBot },
        { name: 'default', fn: defaultBot },
      ],
      gameCount: 3,
      baseSeed: 1,
    });

    expect(result.totalGames).toBe(3);
    expect(result.bots.length).toBe(2);
    expect(result.matches.length).toBe(3);
    expect(typeof result.avgTurns).toBe('number');
  });

  it('bot stats have correct shape', () => {
    const result = runArena({
      bots: [
        { name: 'alpha', fn: exampleBot },
        { name: 'beta', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
    });

    for (const bot of result.bots) {
      expect(typeof bot.name).toBe('string');
      expect(typeof bot.wins).toBe('number');
      expect(typeof bot.gamesPlayed).toBe('number');
      expect(bot.gamesPlayed).toBe(2);
      expect(typeof bot.avgPlacement).toBe('number');
      expect(typeof bot.avgTerritories).toBe('number');
      expect(typeof bot.avgAttacks).toBe('number');
      expect(typeof bot.attackWinRate).toBe('number');
      expect(typeof bot.elo).toBe('number');
    }
  });

  it('total wins across all bots do not exceed total games', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 5,
      baseSeed: 1,
    });

    const totalWins = result.bots.reduce((sum, b) => sum + b.wins, 0);
    expect(totalWins).toBeLessThanOrEqual(result.totalGames);
  });

  it('is deterministic with pure bots and the same baseSeed', () => {
    // Pure bot (no Math.random) ensures determinism
    const pureBotFn = state => {
      const area = state.myAreas.find(a => a.dice > 1 && a.isBorder);
      if (!area) return null;
      const target = area.neighbors.find(adjId => {
        const adj = state.allAreas.find(a => a.id === adjId);
        return adj && adj.owner !== state.myPlayer;
      });
      return target ? { from: area.id, to: target } : null;
    };

    const config = {
      bots: [
        { name: 'a', fn: pureBotFn },
        { name: 'b', fn: pureBotFn },
      ],
      gameCount: 3,
      baseSeed: 42,
    };

    const r1 = runArena(config);
    const r2 = runArena(config);

    expect(r1.bots.map(b => b.wins)).toEqual(r2.bots.map(b => b.wins));
    expect(r1.avgTurns).toBe(r2.avgTurns);
  });

  it('calls onGameComplete callback', () => {
    const completed = [];
    runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      gameCount: 3,
      baseSeed: 1,
      onGameComplete: (index, result) => completed.push({ index, winner: result.winner }),
    });

    expect(completed.length).toBe(3);
    expect(completed[0].index).toBe(0);
    expect(completed[1].index).toBe(1);
    expect(completed[2].index).toBe(2);
  });

  it('bots are sorted by ELO descending', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 5,
      baseSeed: 1,
    });

    for (let i = 1; i < result.bots.length; i++) {
      expect(result.bots[i - 1].elo).toBeGreaterThanOrEqual(result.bots[i].elo);
    }
  });

  it('handles more than 2 bots', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
        { name: 'c', fn: exampleBot },
        { name: 'd', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
    });

    expect(result.bots.length).toBe(4);
    expect(result.totalGames).toBe(2);
    for (const bot of result.bots) {
      expect(bot.gamesPlayed).toBe(2);
    }
  });

  it('attack win rate is between 0 and 1', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 3,
      baseSeed: 1,
    });

    for (const bot of result.bots) {
      expect(bot.attackWinRate).toBeGreaterThanOrEqual(0);
      expect(bot.attackWinRate).toBeLessThanOrEqual(1);
    }
  });

  it('reports failedGames in the result', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      gameCount: 3,
      baseSeed: 1,
    });

    expect(typeof result.failedGames).toBe('number');
    expect(result.failedGames).toBe(0);
  });

  it('throws when bot names are not unique', () => {
    expect(() =>
      runArena({
        bots: [
          { name: 'same', fn: exampleBot },
          { name: 'same', fn: defaultBot },
        ],
        gameCount: 1,
      })
    ).toThrow(/unique/i);
  });

  it('aborts early when failure rate exceeds 50% after 5+ games', async () => {
    // Dynamically mock runMatch to always throw
    const { runArena: runArenaWithMock } = await import('../../src/arena/arenaRunner.js');
    const matchRunner = await import('../../src/arena/matchRunner.js');

    vi.spyOn(matchRunner, 'runMatch').mockImplementation(() => {
      throw new Error('Simulated engine failure');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = runArenaWithMock({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      gameCount: 20,
      baseSeed: 1,
    });

    // Should have aborted before running all 20 games
    expect(result.totalGames).toBe(0);
    expect(result.aborted).toBe(true);
    expect(result.failedGames).toBeGreaterThanOrEqual(5);
    expect(result.failedGames).toBeLessThan(20);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Aborting'));

    matchRunner.runMatch.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('does not abort before minimum games attempted', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      gameCount: 3,
      baseSeed: 1,
    });

    // With valid bots and only 3 games, should complete all
    expect(result.totalGames).toBe(3);
    expect(result.failedGames).toBe(0);
    expect(result.aborted).toBe(false);
  });

  it('uses initialRatings when provided', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
      initialRatings: { a: 1500, b: 900 },
    });

    // ELO should have shifted from seeded values, not from default 1200
    const botA = result.bots.find(b => b.name === 'a');
    const botB = result.bots.find(b => b.name === 'b');
    /*
     * With only 2 games, ELO won't shift far from initial values
     * Both should differ from 1200 (the default) since they started at 1500/900
     */
    expect(botA.elo).not.toBe(1200);
    expect(botB.elo).not.toBe(1200);
  });

  it('falls back to DEFAULT_RATING for bots missing from initialRatings', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 1,
      baseSeed: 1,
      initialRatings: { a: 1500 }, // 'b' not specified — should get 1200
    });

    const botA = result.bots.find(b => b.name === 'a');
    const botB = result.bots.find(b => b.name === 'b');
    expect(typeof botA.elo).toBe('number');
    expect(typeof botB.elo).toBe('number');
    /*
     * After 1 game, both will have shifted, but the combined ELO should be
     * conserved around the initial sum (1500 + 1200 = 2700)
     */
    expect(botA.elo + botB.elo).toBeCloseTo(2700, -1);
  });

  it('forwards recordTrajectory so each match result carries a trajectory record', () => {
    const result = runArena({
      bots: [
        { name: 'example', fn: exampleBot },
        { name: 'default', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
      recordTrajectory: true,
    });

    expect(result.matches.length).toBe(2);
    for (const m of result.matches) {
      expect(m.trajectory).toBeDefined();
      expect(m.trajectory.observationSchemaVersion).toBe(OBSERVATION_SCHEMA_VERSION);
      expect(m.trajectory.actions.length).toBeGreaterThan(0);
    }
  });

  it('forwards onStep to each match', () => {
    let calls = 0;
    const result = runArena({
      bots: [
        { name: 'example', fn: exampleBot },
        { name: 'default', fn: defaultBot },
      ],
      gameCount: 1,
      baseSeed: 1,
      onStep: () => {
        calls++;
      },
    });

    expect(result.totalGames).toBe(1);
    expect(calls).toBeGreaterThan(0);
  });

  it('attaches no trajectory when recordTrajectory is unset', () => {
    const result = runArena({
      bots: [
        { name: 'example', fn: exampleBot },
        { name: 'default', fn: defaultBot },
      ],
      gameCount: 1,
      baseSeed: 1,
    });

    expect(result.matches[0].trajectory).toBeUndefined();
  });

  it('exposes errors/invalidMoves/maxMovesHit on each bot (zero for healthy bots)', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
    });

    for (const bot of result.bots) {
      expect(typeof bot.errors).toBe('number');
      expect(typeof bot.invalidMoves).toBe('number');
      expect(typeof bot.maxMovesHit).toBe('number');
      expect(bot.errors).toBe(0);
    }
  });

  it('accumulates errors and warns when a bot errors on every turn (#53)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const throwingBot = () => {
      throw new Error('boom');
    };

    const result = runArena({
      bots: [
        { name: 'broken', fn: throwingBot },
        { name: 'default', fn: defaultBot },
      ],
      gameCount: 3,
      baseSeed: 1,
    });

    const broken = result.bots.find(b => b.name === 'broken');
    expect(broken.errors).toBeGreaterThan(0);
    expect(broken.avgAttacks).toBe(0);

    // A broken bot must not silently masquerade as a clean low-ELO result.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/bot "broken".*error fraction 100\.0%/s)
    );

    warnSpy.mockRestore();
  });

  it('does not warn when all bots are healthy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
    });

    // The only console.warn runArena emits in a clean run would be an error-rate warning.
    const errorWarnings = warnSpy.mock.calls.filter(call => /error fraction/.test(String(call[0])));
    expect(errorWarnings).toEqual([]);

    warnSpy.mockRestore();
  });

  it('returns an empty flagged list for a healthy run (#92)', () => {
    const result = runArena({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: defaultBot },
      ],
      gameCount: 2,
      baseSeed: 1,
    });

    expect(Array.isArray(result.flagged)).toBe(true);
    expect(result.flagged).toEqual([]);
  });

  it('surfaces a broken bot in result.flagged so callers can route it onward (#92)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const throwingBot = () => {
      throw new Error('boom');
    };

    const result = runArena({
      bots: [
        { name: 'broken', fn: throwingBot },
        { name: 'default', fn: defaultBot },
      ],
      gameCount: 3,
      baseSeed: 1,
    });

    expect(result.flagged.map(f => f.name)).toContain('broken');
    const broken = result.flagged.find(f => f.name === 'broken');
    expect(broken.errorFraction).toBe(1);

    warnSpy.mockRestore();
  });
});
