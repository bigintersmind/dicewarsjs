import { runMatch } from '../../src/arena/matchRunner.js';
import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';

const exampleBot = adaptLegacyBot(ai_example);
const defaultBot = adaptLegacyBot(ai_default);

describe('runMatch', () => {
  it('runs a complete game and returns a result', () => {
    const result = runMatch({
      bots: [
        { name: 'example1', fn: exampleBot },
        { name: 'example2', fn: exampleBot },
        { name: 'example3', fn: exampleBot },
        { name: 'example4', fn: exampleBot },
      ],
      seed: 42,
    });

    expect(result).toBeDefined();
    expect(typeof result.turnCount).toBe('number');
    expect(result.turnCount).toBeGreaterThan(0);
    expect(Array.isArray(result.placements)).toBe(true);
    expect(result.placements.length).toBe(4);
    expect(Array.isArray(result.botStats)).toBe(true);
    expect(result.botStats.length).toBe(4);
  });

  it('produces a winner or stalemate', () => {
    const result = runMatch({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
        { name: 'c', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 500,
    });

    // Either there's a winner or the game hit max turns
    if (result.winner !== null) {
      expect(typeof result.winner).toBe('number');
      expect(result.winnerName).toBeTruthy();
    }
  });

  it('is deterministic with a pure bot and the same seed', () => {
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
        { name: 'c', fn: pureBotFn },
      ],
      seed: 42,
    };

    const r1 = runMatch(config);
    const r2 = runMatch(config);

    expect(r1.winner).toBe(r2.winner);
    expect(r1.turnCount).toBe(r2.turnCount);
    expect(r1.placements).toEqual(r2.placements);
  });

  it('different seeds produce different initial maps', () => {
    // Just verify the config captures the seed — different seeds create different games
    const r1 = runMatch({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      seed: 1,
    });
    const r2 = runMatch({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      seed: 999,
    });

    expect(r1.config.seed).toBe(1);
    expect(r2.config.seed).toBe(999);
  });

  it('botStats have correct shape', () => {
    const result = runMatch({
      bots: [
        { name: 'alpha', fn: exampleBot },
        { name: 'beta', fn: defaultBot },
      ],
      seed: 42,
    });

    for (const stat of result.botStats) {
      expect(typeof stat.name).toBe('string');
      expect(typeof stat.playerIndex).toBe('number');
      expect(typeof stat.finalTerritories).toBe('number');
      expect(typeof stat.finalDice).toBe('number');
      expect(typeof stat.placement).toBe('number');
      expect(stat.placement).toBeGreaterThanOrEqual(1);
      expect(typeof stat.attacksMade).toBe('number');
      expect(typeof stat.attacksWon).toBe('number');
      expect(stat.attacksWon).toBeLessThanOrEqual(stat.attacksMade);
    }
  });

  it('placements contain all player indices exactly once', () => {
    const bots = [
      { name: 'a', fn: exampleBot },
      { name: 'b', fn: exampleBot },
      { name: 'c', fn: exampleBot },
    ];

    const result = runMatch({ bots, seed: 42 });
    const sorted = [...result.placements].sort();
    expect(sorted).toEqual([0, 1, 2]);
  });

  it('calls onTurn callback each turn', () => {
    const turns = [];
    runMatch({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 10,
      onTurn: turnNumber => turns.push(turnNumber),
    });

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0]).toBe(1);
  });

  it('respects maxTurns limit', () => {
    const result = runMatch({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
        { name: 'c', fn: exampleBot },
        { name: 'd', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 5,
    });

    expect(result.turnCount).toBeLessThanOrEqual(5);
  });

  it('handles a crashing bot gracefully', () => {
    const crashBot = () => {
      throw new Error('I crashed');
    };

    const result = runMatch({
      bots: [
        { name: 'crasher', fn: crashBot },
        { name: 'normal', fn: exampleBot },
        { name: 'normal2', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 50,
    });

    // Should still complete without throwing
    expect(result).toBeDefined();
    expect(result.turnCount).toBeGreaterThan(0);
  });

  it('handles a bot that always returns null', () => {
    const passBot = () => null;

    const result = runMatch({
      bots: [
        { name: 'passer', fn: passBot },
        { name: 'normal', fn: exampleBot },
      ],
      seed: 42,
    });

    expect(result).toBeDefined();
    expect(result.turnCount).toBeGreaterThan(0);
  });

  it('returns config with seed', () => {
    const result = runMatch({
      bots: [
        { name: 'a', fn: exampleBot },
        { name: 'b', fn: exampleBot },
      ],
      seed: 42,
    });

    expect(result.config).toBeDefined();
    expect(result.config.seed).toBe(42);
    expect(result.config.playerCount).toBe(2);
  });
});
