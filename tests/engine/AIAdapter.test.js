import { createLegacyGameView, runAI, runFullAITurn } from '../../src/engine/AIAdapter.js';
import { createInitialState, getValidMoves } from '../../src/engine/StateManager.js';
import { generateMap } from '../../src/engine/MapGenerator.js';
import { createTurnOrder } from '../../src/engine/TurnManager.js';
import { createRng } from '../../src/engine/rng.js';
import { createBotState } from '../../src/arena/botState.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { ai_default } from '../../src/ai/ai_default.js';
import { ai_defensive } from '../../src/ai/ai_defensive.js';
import { ai_adaptive } from '../../src/ai/ai_adaptive.js';
import { ai_lookahead } from '../../src/ai/ai_lookahead.js';

const DEFAULT_CONFIG = {
  mapWidth: 28,
  mapHeight: 32,
  maxAreas: 32,
  playerCount: 7,
  dicePerArea: 3,
};

function createTestState(seed = 42) {
  const rng = createRng(seed);
  const mapData = generateMap(DEFAULT_CONFIG, rng);
  const turnOrder = createTurnOrder(DEFAULT_CONFIG.playerCount, rng);
  return createInitialState(DEFAULT_CONFIG, mapData, turnOrder, rng.state());
}

describe('createLegacyGameView', () => {
  it('creates a view with the expected legacy shape', () => {
    const state = createTestState();
    const view = createLegacyGameView(state);

    expect(view.AREA_MAX).toBe(state.areas.length);
    expect(view.adat.length).toBe(state.areas.length);
    expect(view.player.length).toBe(8);
    expect(view.jun.length).toBe(8);
    expect(typeof view.ban).toBe('number');
    expect(typeof view.get_pn).toBe('function');
    expect(view.area_from).toBe(0);
    expect(view.area_to).toBe(0);
  });

  it('get_pn() returns the correct current player', () => {
    const state = createTestState();
    const view = createLegacyGameView(state);
    expect(view.get_pn()).toBe(state.turnOrder[state.currentPlayerIndex]);
  });

  it('adat contains correct area data', () => {
    const state = createTestState();
    const view = createLegacyGameView(state);

    for (let a = 1; a < state.areas.length; a++) {
      const area = state.areas[a];
      expect(view.adat[a].size).toBe(area.size);
      expect(view.adat[a].arm).toBe(area.owner);
      expect(view.adat[a].dice).toBe(area.dice);
      // Check adjacency in join[] format
      for (const adjId of area.neighborAreaIds) {
        expect(view.adat[a].join[adjId]).toBe(1);
      }
    }
  });

  it('player stats are populated', () => {
    const state = createTestState();
    const view = createLegacyGameView(state);

    for (let p = 0; p < state.players.length; p++) {
      expect(view.player[p].area_c).toBe(state.players[p].territoryCount);
      expect(view.player[p].dice_c).toBe(state.players[p].diceCount);
    }
  });
});

describe('runAI', () => {
  it('returns a valid move from ai_example', () => {
    // Try multiple seeds to find one where AI has valid moves
    for (let seed = 1; seed < 50; seed++) {
      const state = createTestState(seed);
      const validMoves = getValidMoves(state);
      if (validMoves.length === 0) continue;

      const move = runAI(state, ai_example);
      if (move !== null) {
        expect(move).toHaveProperty('from');
        expect(move).toHaveProperty('to');
        // The move should be among valid moves
        const isValid = validMoves.some(m => m.from === move.from && m.to === move.to);
        expect(isValid).toBe(true);
        return;
      }
    }
  });

  it('returns null when AI ends turn (returns 0)', () => {
    const endTurnAI = () => 0;
    const state = createTestState();
    expect(runAI(state, endTurnAI)).toBeNull();
  });

  it('returns null when AI returns undefined without setting area targets', () => {
    const undefinedAI = () => {};
    const state = createTestState();
    expect(runAI(state, undefinedAI)).toBeNull();
  });

  it('returns null and logs error when AI throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwingAI = () => {
      throw new Error('AI broke');
    };
    const state = createTestState();

    expect(runAI(state, throwingAI)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AI threw'));
    errorSpy.mockRestore();
  });

  it('re-throws TypeError from AI as adapter error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenAI = () => {
      const x = null;
      x.foo(); // TypeError
    };
    const state = createTestState();

    expect(() => runAI(state, brokenAI)).toThrow('AI adapter error');
    console.error.mockRestore();
  });

  it('warns when AI returns unexpected non-zero value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const weirdAI = () => 42;
    const state = createTestState();

    expect(runAI(state, weirdAI)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected value'));
    warnSpy.mockRestore();
  });

  it('does not mutate the engine state', () => {
    const state = createTestState();
    const originalAreas = JSON.stringify(state.areas);
    const originalPlayers = JSON.stringify(state.players);

    runAI(state, ai_example);

    expect(JSON.stringify(state.areas)).toBe(originalAreas);
    expect(JSON.stringify(state.players)).toBe(originalPlayers);
  });
});

describe('runAI modern-bot routing', () => {
  it('calls a __modernBot function with engine state and returns its move', () => {
    const state = createTestState();
    let receivedState = null;
    const modernBot = s => {
      receivedState = s;
      return { from: 4, to: 5 };
    };
    modernBot.__modernBot = true;

    const move = runAI(state, modernBot);
    // Modern bots receive the engine state directly (not a legacy view).
    expect(receivedState).toBe(state);
    expect(move).toEqual({ from: 4, to: 5 });
  });

  it('treats a null / non-positive modern move as end-of-turn', () => {
    const state = createTestState();
    const endTurn = () => null;
    endTurn.__modernBot = true;
    expect(runAI(state, endTurn)).toBeNull();

    const zeroMove = () => ({ from: 0, to: 0 });
    zeroMove.__modernBot = true;
    expect(runAI(state, zeroMove)).toBeNull();
  });

  it('re-throws a modern adapter failure as an adapter error', () => {
    const state = createTestState();
    const broken = () => {
      throw new Error('sanitize failed');
    };
    broken.__modernBot = true;
    expect(() => runAI(state, broken)).toThrow('Modern bot adapter error');
  });
});

describe('runFullAITurn', () => {
  it('completes a full turn and advances to next player', () => {
    const state = createTestState();
    const newState = runFullAITurn(state, ai_example);

    // Turn should have advanced
    expect(newState.currentPlayerIndex).not.toBe(state.currentPlayerIndex);
    // History should have at least the END_TURN
    expect(newState.history.length).toBeGreaterThanOrEqual(1);
  });

  it('does not mutate the original state', () => {
    const state = createTestState();
    const origIdx = state.currentPlayerIndex;
    const origHistLen = state.history.length;

    runFullAITurn(state, ai_example);

    expect(state.currentPlayerIndex).toBe(origIdx);
    expect(state.history.length).toBe(origHistLen);
  });

  it('ends turn gracefully when AI proposes invalid move', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = createTestState();

    const invalidMoveAI = game => {
      game.area_from = 999;
      game.area_to = 998;
    };

    const newState = runFullAITurn(state, invalidMoveAI);

    // Should have ended the turn (not crashed)
    expect(newState.currentPlayerIndex).not.toBe(state.currentPlayerIndex);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid move'));
    warnSpy.mockRestore();
  });

  it('respects maxMoves safety cap', () => {
    // AI that always wants to attack
    const aggressiveAI = game => {
      const pn = game.get_pn();
      for (let i = 1; i < game.AREA_MAX; i++) {
        if (game.adat[i].size === 0 || game.adat[i].arm !== pn || game.adat[i].dice <= 1) continue;
        for (let j = 1; j < game.AREA_MAX; j++) {
          if (game.adat[j].size === 0 || game.adat[j].arm === pn || game.adat[i].join[j] === 0)
            continue;
          game.area_from = i;
          game.area_to = j;
          return;
        }
      }
      return 0;
    };

    const state = createTestState();
    const newState = runFullAITurn(state, aggressiveAI, { maxMoves: 3 });
    // Should complete without hanging
    expect(newState).toBeDefined();
  });
});

describe('AI strategy compatibility', () => {
  const strategies = [
    { name: 'ai_example', fn: ai_example },
    { name: 'ai_default', fn: ai_default },
    { name: 'ai_defensive', fn: ai_defensive },
    { name: 'ai_adaptive', fn: ai_adaptive },
    { name: 'ai_lookahead', fn: ai_lookahead },
  ];

  for (const { name, fn } of strategies) {
    it(`${name} produces valid moves through adapter`, () => {
      // Try multiple seeds — some configurations may not give the current player valid moves
      let testedAtLeastOne = false;
      for (let seed = 1; seed < 30; seed++) {
        const state = createTestState(seed);
        const validMoves = getValidMoves(state);
        if (validMoves.length === 0) continue;

        const move = runAI(state, fn);
        if (move !== null) {
          const isValid = validMoves.some(m => m.from === move.from && m.to === move.to);
          expect(isValid).toBe(true);
          testedAtLeastOne = true;
          break;
        }
      }
      /*
       * If no seed produced a valid move, that's acceptable (AI chose to end turn)
       * but we should have found at least one valid scenario
       */
      if (!testedAtLeastOne) {
        // Just verify it doesn't crash
        const state = createTestState(42);
        expect(() => runAI(state, fn)).not.toThrow();
      }
    });

    it(`${name} completes a full turn without error`, () => {
      const state = createTestState(42);
      expect(() => runFullAITurn(state, fn)).not.toThrow();
    });
  }
});

describe('createLegacyGameView random()', () => {
  it('exposes a seeded random function for the acting player', () => {
    const state = createTestState();
    const view = createLegacyGameView(state);

    expect(typeof view.random).toBe('function');
    const v = view.random();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('yields the same sequence for the same engine state', () => {
    const state = createTestState();
    const a = createLegacyGameView(state);
    const b = createLegacyGameView(state);

    const seqA = Array.from({ length: 10 }, () => a.random());
    const seqB = Array.from({ length: 10 }, () => b.random());
    expect(seqA).toEqual(seqB);
  });

  it('derives the same stream as the arena BotState path (Node↔browser parity)', () => {
    // The in-browser path (createLegacyGameView) and the arena path
    // (createBotState) must produce IDENTICAL draws for the same seat, or a
    // seed would play out differently in-browser vs. arena/replay (issue #151).
    const state = createTestState();
    const actingId = state.turnOrder[state.currentPlayerIndex];
    const browserView = createLegacyGameView(state);
    const arenaState = createBotState(state, actingId);

    const browserSeq = Array.from({ length: 10 }, () => browserView.random());
    const arenaSeq = Array.from({ length: 10 }, () => arenaState.random());
    expect(browserSeq).toEqual(arenaSeq);
  });
});
