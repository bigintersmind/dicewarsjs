import { createGame, simulateGame, replayGame } from '../../src/engine/GameRunner.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';
import { ai_defensive } from '../../src/ai/ai_defensive.js';
import { ai_adaptive } from '../../src/ai/ai_adaptive.js';

describe('createGame', () => {
  it('creates a valid initial game state', () => {
    const state = createGame({ seed: 42 });
    expect(state.phase).toBe('playing');
    expect(state.winner).toBeNull();
    expect(state.players.length).toBe(7);
    expect(state.areas.length).toBe(32);
  });

  it('is deterministic with the same seed', () => {
    const a = createGame({ seed: 123 });
    const b = createGame({ seed: 123 });
    expect(a.turnOrder).toEqual(b.turnOrder);
    expect(a.rngState).toBe(b.rngState);
    for (let i = 1; i < a.areas.length; i++) {
      expect(a.areas[i].owner).toBe(b.areas[i].owner);
      expect(a.areas[i].dice).toBe(b.areas[i].dice);
    }
  });
});

describe('createGame — luck handicap config (issue #179)', () => {
  it('defaults to null when the key is absent', () => {
    expect(createGame({ seed: 1 }).config.handicap).toBeNull();
  });

  it('accepts an explicit null', () => {
    expect(createGame({ seed: 1, handicap: null }).config.handicap).toBeNull();
  });

  it('stores a valid handicap on state.config', () => {
    const state = createGame({ seed: 1, playerCount: 4, handicap: { playerId: 2, level: 1 } });
    expect(state.config.handicap).toEqual({ playerId: 2, level: 1 });
  });

  it('copies the handicap so the caller cannot mutate engine config mid-game', () => {
    const handicap = { playerId: 0, level: 1 };
    const state = createGame({ seed: 1, playerCount: 4, handicap });
    handicap.level = 99;
    handicap.playerId = 3;
    expect(state.config.handicap).toEqual({ playerId: 0, level: 1 });
  });

  it('ignores extra keys on the handicap object (whitelist, not passthrough)', () => {
    const state = createGame({
      seed: 1,
      playerCount: 4,
      handicap: { playerId: 1, level: 2, cheat: true },
    });
    expect(state.config.handicap).toEqual({ playerId: 1, level: 2 });
  });

  it('throws on a non-object handicap', () => {
    expect(() => createGame({ seed: 1, handicap: 1 })).toThrow(/handicap/);
    expect(() => createGame({ seed: 1, handicap: 'lucky' })).toThrow(/handicap/);
    expect(() => createGame({ seed: 1, handicap: true })).toThrow(/handicap/);
    expect(() => createGame({ seed: 1, handicap: [] })).toThrow(/handicap/);
  });

  it('throws on an out-of-range or non-integer playerId', () => {
    expect(() =>
      createGame({ seed: 1, playerCount: 4, handicap: { playerId: 4, level: 1 } })
    ).toThrow(/playerId/);
    expect(() =>
      createGame({ seed: 1, playerCount: 4, handicap: { playerId: -1, level: 1 } })
    ).toThrow(/playerId/);
    expect(() =>
      createGame({ seed: 1, playerCount: 4, handicap: { playerId: 1.5, level: 1 } })
    ).toThrow(/playerId/);
    expect(() => createGame({ seed: 1, playerCount: 4, handicap: { level: 1 } })).toThrow(
      /playerId/
    );
  });

  it('throws on a level below 1 or non-integer (null is the way to turn it off)', () => {
    expect(() =>
      createGame({ seed: 1, playerCount: 4, handicap: { playerId: 0, level: 0 } })
    ).toThrow(/level/);
    expect(() =>
      createGame({ seed: 1, playerCount: 4, handicap: { playerId: 0, level: -1 } })
    ).toThrow(/level/);
    expect(() =>
      createGame({ seed: 1, playerCount: 4, handicap: { playerId: 0, level: 1.5 } })
    ).toThrow(/level/);
    expect(() => createGame({ seed: 1, playerCount: 4, handicap: { playerId: 0 } })).toThrow(
      /level/
    );
  });

  it('validates playerId against the resolved (defaulted) player count', () => {
    // Default playerCount is 7, so seat 6 is valid and seat 7 is not.
    expect(createGame({ seed: 1, handicap: { playerId: 6, level: 1 } }).config.handicap).toEqual({
      playerId: 6,
      level: 1,
    });
    expect(() => createGame({ seed: 1, handicap: { playerId: 7, level: 1 } })).toThrow(/playerId/);
  });

  it('does not change map generation (the handicap only affects battles)', () => {
    const plain = createGame({ seed: 5, playerCount: 4 });
    const lucky = createGame({ seed: 5, playerCount: 4, handicap: { playerId: 0, level: 2 } });
    expect(lucky.rngState).toBe(plain.rngState);
    expect(lucky.turnOrder).toEqual(plain.turnOrder);
    expect(lucky.areas.map(a => [a.owner, a.dice])).toEqual(
      plain.areas.map(a => [a.owner, a.dice])
    );
  });
});

describe('simulateGame', () => {
  it('runs a full game with all ai_example players', () => {
    const aiAssignments = new Array(7).fill(ai_example);
    const { finalState, turnCount } = simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 500,
    });

    expect(turnCount).toBeGreaterThan(0);
    // Game should either finish or hit max turns
    expect(finalState).toBeDefined();
  });

  it('runs a game with mixed AI strategies', () => {
    const aiAssignments = [
      ai_default,
      ai_defensive,
      ai_adaptive,
      ai_example,
      ai_default,
      ai_defensive,
      ai_example,
    ];

    const { finalState, turnCount } = simulateGame({
      config: { seed: 99 },
      aiAssignments,
      maxTurns: 300,
    });

    expect(turnCount).toBeGreaterThan(0);
    expect(finalState).toBeDefined();
  });

  it('calls onTurn callback', () => {
    const aiAssignments = new Array(7).fill(ai_example);
    let callCount = 0;

    simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 5,
      onTurn: () => {
        callCount++;
      },
    });

    expect(callCount).toBe(5);
  });

  it('throws when aiAssignments is missing', () => {
    expect(() => simulateGame({ config: { seed: 42 } })).toThrow(/aiAssignments/);
  });

  it('throws when aiAssignments has too few entries', () => {
    expect(() =>
      simulateGame({
        config: { seed: 42 },
        aiAssignments: [ai_example, ai_example],
      })
    ).toThrow(/aiAssignments has 2 entries/);
  });

  it('throws when a player has no AI function', () => {
    const aiAssignments = new Array(7).fill(null);
    aiAssignments[0] = ai_example;
    expect(() =>
      simulateGame({
        config: { seed: 42 },
        aiAssignments,
        maxTurns: 5,
      })
    ).toThrow(/No AI function/);
  });

  it('respects maxTurns limit', () => {
    const aiAssignments = new Array(7).fill(ai_example);
    const { turnCount } = simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 10,
    });

    expect(turnCount).toBeLessThanOrEqual(10);
  });

  it('returns completed: false when stopped by maxTurns', () => {
    const aiAssignments = new Array(7).fill(ai_example);
    const { completed } = simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 2,
    });

    expect(completed).toBe(false);
  });

  it('returns completed: true when game ends naturally', () => {
    const aiAssignments = new Array(7).fill(ai_example);
    const { completed, finalState } = simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 5000,
    });

    if (finalState.phase === 'gameOver') {
      expect(completed).toBe(true);
    }
  });

  it('deterministic: same seed + same AIs = same result when Math.random is seeded', () => {
    const aiAssignments = new Array(7).fill(ai_example);

    /*
     * Legacy AIs use Math.random() internally, so we must seed it for determinism.
     * In production, full determinism requires rewriting AIs to use seeded RNG (Phase 4).
     */
    const originalRandom = Math.random;

    function seedMathRandom(seed) {
      let s = seed >>> 0;
      Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
      };
    }

    try {
      seedMathRandom(42);
      const result1 = simulateGame({
        config: { seed: 42 },
        aiAssignments,
        maxTurns: 20,
      });

      seedMathRandom(42);
      const result2 = simulateGame({
        config: { seed: 42 },
        aiAssignments,
        maxTurns: 20,
      });

      expect(result1.turnCount).toBe(result2.turnCount);
      expect(result1.winner).toBe(result2.winner);
      expect(result1.finalState.rngState).toBe(result2.finalState.rngState);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('completes within 5 seconds for a full game', () => {
    const aiAssignments = new Array(7).fill(ai_example);
    const start = Date.now();

    simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 500,
    });

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('replayGame', () => {
  it('throws on unknown action type', () => {
    const state = createGame({ seed: 42 });
    const badHistory = [{ type: 'BOGUS_ACTION' }];
    expect(() => replayGame(state, badHistory)).toThrow(
      /unknown action type.*BOGUS_ACTION.*index 0/
    );
  });

  it('deterministic replay produces identical state', () => {
    const aiAssignments = new Array(7).fill(ai_example);

    // Run a game and capture its history
    const { finalState, history } = simulateGame({
      config: { seed: 42 },
      aiAssignments,
      maxTurns: 15,
    });

    // Create a fresh game with the same seed
    const freshState = createGame({ seed: 42 });

    // Replay the captured history
    const replayed = replayGame(freshState, history);

    // The replayed state should match the original final state
    expect(replayed.rngState).toBe(finalState.rngState);
    expect(replayed.currentPlayerIndex).toBe(finalState.currentPlayerIndex);
    expect(replayed.turnNumber).toBe(finalState.turnNumber);
    expect(replayed.phase).toBe(finalState.phase);
    expect(replayed.winner).toBe(finalState.winner);

    // Areas should match
    for (let i = 1; i < replayed.areas.length; i++) {
      expect(replayed.areas[i].owner).toBe(finalState.areas[i].owner);
      expect(replayed.areas[i].dice).toBe(finalState.areas[i].dice);
    }
  });
});
