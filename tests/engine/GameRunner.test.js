import { createGame, simulateGame, replayGame } from '../../src/engine/GameRunner.js';
import { generateMap, MapInfeasibleError } from '../../src/engine/MapGenerator.js';
import { createRng } from '../../src/engine/rng.js';
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

  describe('personality (shaped) maps', () => {
    const LARGE = { mapWidth: 36, mapHeight: 40, maxAreas: 48 };

    it('does NOT cap the classic large preset (keeps its 48 ceiling)', () => {
      const state = createGame({ ...LARGE, mapType: 'random', seed: 1 });
      expect(state.config.maxAreas).toBe(48);
      expect(state.areas.length).toBe(48);
    });

    it('caps shaped maps at 32 and records the honest ceiling in config', () => {
      for (const mapType of ['snowflake', 'ring', 'cross']) {
        const state = createGame({ ...LARGE, mapType, playerCount: 6, seed: 2 });
        expect(state.config.maxAreas).toBe(32); // honest: matches the board built
        expect(state.areas.length).toBe(32);
        for (const a of state.areas) {
          if (a.size > 0) expect(a.id).toBeLessThan(32);
        }
      }
    });

    it('generates a playable board for small + 8 players across seeds (retry absorbs infeasible seeds)', () => {
      const SMALL = { mapWidth: 20, mapHeight: 24, maxAreas: 20 };
      for (let seed = 1; seed <= 50; seed++) {
        expect(() =>
          createGame({ ...SMALL, mapType: 'snowflake', playerCount: 8, seed })
        ).not.toThrow();
      }
    });

    /*
     * A config whose FIRST attempt is genuinely infeasible, so these tests
     * actually exercise the retry loop (not just attempt 0). `ring 16x20 / 16
     * areas / 8 players, seed 1` throws MapInfeasibleError on attempt 0 (too few
     * territories survive pruning) but createGame rescues it on a later seed.
     */
    const RETRY_CFG = {
      mapWidth: 16,
      mapHeight: 20,
      maxAreas: 16,
      mapType: 'ring',
      playerCount: 8,
      seed: 1,
    };

    it('bounded retry rescues a seed that is infeasible on the first attempt', () => {
      // Prove the precondition: attempt 0 (the requested seed) really does throw,
      // so this test can only pass via the retry path — guarding the seed-advance
      // arithmetic the rescue depends on.
      expect(() =>
        generateMap({ ...RETRY_CFG, dicePerArea: 3 }, createRng(RETRY_CFG.seed))
      ).toThrow(MapInfeasibleError);
      // createGame absorbs it: no user-facing failure.
      expect(() => createGame(RETRY_CFG)).not.toThrow();
    });

    it('is deterministic for a given requested seed, including the retried board', () => {
      const a = createGame(RETRY_CFG);
      const b = createGame(RETRY_CFG);
      expect(a.rngState).toBe(b.rngState);
      expect(a.areas.map(x => x.size)).toEqual(b.areas.map(x => x.size));
      // The rescued board seats all 8 players (the original requested seed could not).
      expect(new Set(a.areas.filter(x => x.size > 0).map(x => x.owner)).size).toBe(8);
    });

    it('throws MapInfeasibleError when every retry attempt is exhausted', () => {
      // A board too small to ever seat 8 players: all 8 attempts fail, so createGame
      // surfaces the final MapInfeasibleError rather than a silent undefined.
      expect(() =>
        createGame({
          mapWidth: 14,
          mapHeight: 16,
          maxAreas: 14,
          mapType: 'ring',
          playerCount: 8,
          seed: 1,
        })
      ).toThrow(MapInfeasibleError);
    });

    it('rethrows a non-retryable config error immediately (does not spin)', () => {
      // Bad dimensions are a plain RangeError (not MapInfeasibleError) and fail
      // identically on every seed, so the retry guard must NOT swallow them.
      expect(() =>
        createGame({ mapWidth: 0, mapHeight: 0, mapType: 'snowflake', playerCount: 4, seed: 1 })
      ).toThrow(/grid dimensions must be/);
    });
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
