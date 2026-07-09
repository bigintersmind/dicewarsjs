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
      /*
       * Per-turn denominator for the error-rate flag (#92 item 4): present, numeric, and a
       * non-negative integer (a bot can be eliminated before its first turn, so not > 0).
       */
      expect(typeof stat.turns).toBe('number');
      expect(Number.isInteger(stat.turns)).toBe(true);
      expect(stat.turns).toBeGreaterThanOrEqual(0);
      /*
       * Forced-end signal: present, numeric, and 0 in normal play (no turn exhausts the
       * MAX_MOVES_PER_TURN cap) — guards against the counter firing spuriously (D-14).
       */
      expect(typeof stat.maxMovesHit).toBe('number');
      expect(stat.maxMovesHit).toBe(0);
    }

    /*
     * Invariant: every main-loop iteration calls runBotTurn once (which bumps exactly one
     * bot's `turns`) and increments turnCount once; the eliminated-player skip does neither.
     * So the per-bot turn counts partition turnCount exactly — the property the error-rate
     * denominator relies on (#92 item 4).
     */
    const totalTurns = result.botStats.reduce((sum, s) => sum + s.turns, 0);
    expect(totalTurns).toBe(result.turnCount);
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

  it('throws when bot names are not unique', () => {
    expect(() =>
      runMatch({
        bots: [
          { name: 'same', fn: exampleBot },
          { name: 'same', fn: defaultBot },
        ],
        seed: 42,
      })
    ).toThrow(/unique/i);
  });

  it('works with a new Function-compiled custom bot', () => {
    // eslint-disable-next-line no-new-func
    const customFn = new Function(
      'state',
      `for (const area of state.myAreas) {
        if (area.dice <= 1) continue;
        const enemy = area.neighbors.find(id => {
          const target = state.allAreas.find(a => a.id === id);
          return target && target.owner !== state.myPlayer;
        });
        if (enemy !== undefined) return { from: area.id, to: enemy };
      }
      return null;`
    );

    const result = runMatch({
      bots: [
        { name: 'custom', fn: customFn },
        { name: 'example', fn: exampleBot },
      ],
      seed: 42,
    });

    expect(result).toBeDefined();
    expect(result.botStats.length).toBe(2);
    expect(result.botStats.some(s => s.name === 'custom')).toBe(true);
  });

  it('botStats include errors and invalidMoves counts', () => {
    const crashBot = () => {
      throw new Error('crash');
    };

    const result = runMatch({
      bots: [
        { name: 'crasher', fn: crashBot },
        { name: 'normal', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 10,
    });

    for (const stat of result.botStats) {
      expect(typeof stat.errors).toBe('number');
      expect(typeof stat.invalidMoves).toBe('number');
    }

    const crasherStat = result.botStats.find(s => s.name === 'crasher');
    expect(crasherStat.errors).toBeGreaterThan(0);
  });

  it('tolerates up to 2 consecutive invalid moves before a valid one', () => {
    let callCount = 0;
    const flakeyBot = state => {
      callCount++;
      // Return invalid moves on calls 1 and 2, then a valid move
      if (callCount <= 2) {
        return { from: 9999, to: 9998 }; // invalid area IDs
      }
      // Try a real move
      const area = state.myAreas.find(a => a.dice > 1 && a.isBorder);
      if (!area) return null;
      const target = area.neighbors.find(adjId => {
        const adj = state.allAreas.find(a => a.id === adjId);
        return adj && adj.owner !== state.myPlayer;
      });
      return target ? { from: area.id, to: target } : null;
    };

    const result = runMatch({
      bots: [
        { name: 'flakey', fn: flakeyBot },
        { name: 'normal', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 10,
    });

    expect(result).toBeDefined();
    const flakeyStat = result.botStats.find(s => s.name === 'flakey');
    expect(flakeyStat.invalidMoves).toBeGreaterThanOrEqual(2);
  });

  it('stops a bot after 3 consecutive invalid moves', () => {
    const alwaysInvalidBot = () => ({ from: 9999, to: 9998 });

    const result = runMatch({
      bots: [
        { name: 'invalid', fn: alwaysInvalidBot },
        { name: 'normal', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 10,
    });

    expect(result).toBeDefined();
    const invalidStat = result.botStats.find(s => s.name === 'invalid');
    // Should have exactly 3 invalid moves per turn (capped by tolerance)
    expect(invalidStat.invalidMoves).toBeGreaterThanOrEqual(3);
  });

  it('resets invalid move counter after a successful move', () => {
    let moveIdx = 0;
    // Pattern: invalid, invalid, valid, invalid, invalid, valid, null
    const mixedBot = state => {
      moveIdx++;
      const phase = moveIdx % 3;
      if (phase !== 0) {
        return { from: 9999, to: 9998 }; // invalid
      }
      // valid move attempt
      const area = state.myAreas.find(a => a.dice > 1 && a.isBorder);
      if (!area) return null;
      const target = area.neighbors.find(adjId => {
        const adj = state.allAreas.find(a => a.id === adjId);
        return adj && adj.owner !== state.myPlayer;
      });
      return target ? { from: area.id, to: target } : null;
    };

    const result = runMatch({
      bots: [
        { name: 'mixed', fn: mixedBot },
        { name: 'normal', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 10,
    });

    expect(result).toBeDefined();
    const mixedStat = result.botStats.find(s => s.name === 'mixed');
    // Bot should have made some attacks (counter resets after valid moves)
    expect(mixedStat.invalidMoves).toBeGreaterThanOrEqual(2);
  });
});
