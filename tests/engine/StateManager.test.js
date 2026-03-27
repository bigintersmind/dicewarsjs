import {
  createInitialState,
  applyAction,
  getValidMoves,
  serializeState,
  deserializeState,
} from '../../src/engine/StateManager.js';
import { generateMap } from '../../src/engine/MapGenerator.js';
import { createTurnOrder } from '../../src/engine/TurnManager.js';
import { createRng } from '../../src/engine/rng.js';

const DEFAULT_CONFIG = {
  mapWidth: 28,
  mapHeight: 32,
  maxAreas: 32,
  playerCount: 7,
  dicePerArea: 3,
  seed: 42,
};

function createTestState(seed = 42) {
  const rng = createRng(seed);
  const mapData = generateMap(DEFAULT_CONFIG, rng);
  const turnOrder = createTurnOrder(DEFAULT_CONFIG.playerCount, rng);
  return createInitialState(DEFAULT_CONFIG, mapData, turnOrder, rng.state());
}

describe('createInitialState', () => {
  it('creates a valid initial state', () => {
    const state = createTestState();
    expect(state.phase).toBe('playing');
    expect(state.winner).toBeNull();
    expect(state.turnNumber).toBe(0);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.history).toEqual([]);
    expect(state.players.length).toBe(7);
    expect(state.turnOrder.length).toBe(7);
  });

  it('all players start not eliminated with correct stats', () => {
    const state = createTestState();
    let totalTerritories = 0;
    for (const p of state.players) {
      expect(p.eliminated).toBe(false);
      expect(p.territoryCount).toBeGreaterThanOrEqual(1);
      expect(p.diceCount).toBeGreaterThanOrEqual(1);
      expect(p.stock).toBe(0);
      totalTerritories += p.territoryCount;
    }
    // Total player territories should equal valid areas
    const validAreas = state.areas.filter(a => a.size > 0).length;
    expect(totalTerritories).toBe(validAreas);
  });
});

describe('applyAction — ATTACK', () => {
  // Helper: build a minimal hand-crafted state for validation tests
  function craftedState() {
    const sentinel = {
      id: 0,
      size: 0,
      owner: -1,
      dice: 0,
      neighborAreaIds: [],
      centerCell: -1,
      cells: [],
    };
    const area1 = {
      id: 1,
      size: 5,
      owner: 0,
      dice: 3,
      neighborAreaIds: [2],
      centerCell: 0,
      cells: [0, 1, 2, 3, 4],
    };
    const area2 = {
      id: 2,
      size: 5,
      owner: 1,
      dice: 2,
      neighborAreaIds: [1, 3],
      centerCell: 5,
      cells: [5, 6, 7, 8, 9],
    };
    const area3 = {
      id: 3,
      size: 5,
      owner: 0,
      dice: 1,
      neighborAreaIds: [2],
      centerCell: 10,
      cells: [10, 11, 12, 13, 14],
    };
    return {
      config: DEFAULT_CONFIG,
      grid: { width: 5, height: 4, cellCount: 20, adjacency: [] },
      areas: [sentinel, area1, area2, area3],
      players: [
        { id: 0, territoryCount: 2, diceCount: 4, largestGroup: 1, stock: 0, eliminated: false },
        { id: 1, territoryCount: 1, diceCount: 2, largestGroup: 1, stock: 0, eliminated: false },
      ],
      turnOrder: [0, 1],
      currentPlayerIndex: 0,
      turnNumber: 0,
      phase: 'playing',
      history: [],
      rngState: 42,
      winner: null,
    };
  }

  it('resolves a valid attack without mutating original state', () => {
    const state = createTestState();
    const moves = getValidMoves(state);
    expect(moves.length).toBeGreaterThan(0);

    const move = moves[0];
    const originalDice = state.areas[move.from].dice;
    const newState = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });

    // Original state unchanged
    expect(state.areas[move.from].dice).toBe(originalDice);
    expect(state.history.length).toBe(0);

    // New state has history entry
    expect(newState.history.length).toBe(1);
    expect(newState.history[0].type).toBe('ATTACK');

    // Attacker always ends up with 1 die
    expect(newState.areas[move.from].dice).toBe(1);
  });

  it('throws on attack against own territory', () => {
    const state = craftedState();
    // Make areas 1 and 3 (both owned by player 0) adjacent for this test
    state.areas[1].neighborAreaIds = [2, 3];
    state.areas[3].neighborAreaIds = [2, 1];
    state.areas[3].dice = 3; // needs > 1 to even try
    expect(() => applyAction(state, { type: 'ATTACK', from: 1, to: 3 })).toThrow(/own territory/);
  });

  it('throws on attack from territory not owned by current player', () => {
    const state = craftedState();
    // Player 0's turn, but trying to attack from area 2 (owned by player 1)
    expect(() => applyAction(state, { type: 'ATTACK', from: 2, to: 1 })).toThrow(
      /not owned by current player/
    );
  });

  it('throws on attack with only 1 die', () => {
    const state = craftedState();
    // Area 3 owned by player 0 but has only 1 die, adjacent to area 2
    expect(() => applyAction(state, { type: 'ATTACK', from: 3, to: 2 })).toThrow(/needs > 1 dice/);
  });

  it('throws on non-adjacent attack', () => {
    const state = craftedState();
    // Add area 4 owned by player 1, not adjacent to area 1
    state.areas.push({
      id: 4,
      size: 5,
      owner: 1,
      dice: 2,
      neighborAreaIds: [3],
      centerCell: 15,
      cells: [15, 16, 17, 18, 19],
    });
    state.areas[1].neighborAreaIds = [2]; // area 1 only adjacent to 2, not 4
    expect(() => applyAction(state, { type: 'ATTACK', from: 1, to: 4 })).toThrow(/not adjacent/);
  });

  it('throws on invalid territory ID (zero-size)', () => {
    const state = craftedState();
    expect(() => applyAction(state, { type: 'ATTACK', from: 0, to: 1 })).toThrow(
      /Invalid attacking territory/
    );
  });

  it('throws on out-of-range attacking territory ID', () => {
    const state = craftedState();
    expect(() => applyAction(state, { type: 'ATTACK', from: 999, to: 1 })).toThrow(
      /Invalid attacking territory/
    );
  });

  it('throws on out-of-range defending territory ID', () => {
    const state = craftedState();
    expect(() => applyAction(state, { type: 'ATTACK', from: 1, to: 999 })).toThrow(
      /Invalid defending territory/
    );
  });

  it('throws on unknown action type', () => {
    const state = craftedState();
    expect(() => applyAction(state, { type: 'INVALID' })).toThrow(/Unknown action type/);
  });

  it('throws when applying action to a finished game', () => {
    const state = craftedState();
    state.phase = 'gameOver';
    expect(() => applyAction(state, { type: 'END_TURN' })).toThrow(/finished game/);
  });

  it('attack result is deterministic', () => {
    const state = createTestState();
    const moves = getValidMoves(state);
    const move = moves[0];

    const result1 = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
    const result2 = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });

    expect(result1.history[0].result.success).toBe(result2.history[0].result.success);
    expect(result1.areas[move.from].dice).toBe(result2.areas[move.from].dice);
    expect(result1.areas[move.to].dice).toBe(result2.areas[move.to].dice);
    expect(result1.areas[move.to].owner).toBe(result2.areas[move.to].owner);
  });

  it('successful attack transfers territory ownership', () => {
    // Run multiple attacks with different seeds to find a successful one
    for (let seed = 1; seed < 100; seed++) {
      const state = createTestState(seed);
      const moves = getValidMoves(state);
      if (moves.length === 0) continue;

      const move = moves[0];
      const newState = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
      const result = newState.history[0].result;

      if (result.success) {
        const currentPlayer = state.turnOrder[state.currentPlayerIndex];
        expect(newState.areas[move.to].owner).toBe(currentPlayer);
        expect(newState.areas[move.to].dice).toBe(move.attackerDice - 1);
        return; // Test passed
      }
    }
    // If we never found a success in 100 seeds, the test is vacuous — fail explicitly
    throw new Error('No successful attack found in 100 seeds — test is vacuous');
  });

  it('successful attack eliminates player and triggers game over', () => {
    // Crafted 2-player state: player 1 owns only area 2, adjacent to player 0's area 1
    const sentinel = {
      id: 0,
      size: 0,
      owner: -1,
      dice: 0,
      neighborAreaIds: [],
      centerCell: -1,
      cells: [],
    };
    const area1 = {
      id: 1,
      size: 5,
      owner: 0,
      dice: 8,
      neighborAreaIds: [2],
      centerCell: 0,
      cells: [0, 1, 2, 3, 4],
    };
    const area2 = {
      id: 2,
      size: 5,
      owner: 1,
      dice: 1,
      neighborAreaIds: [1],
      centerCell: 5,
      cells: [5, 6, 7, 8, 9],
    };
    // Try seeds until we get a successful attack (8 vs 1 is near-certain)
    for (let seed = 1; seed < 50; seed++) {
      const state = {
        config: DEFAULT_CONFIG,
        grid: { width: 5, height: 4, cellCount: 20, adjacency: [] },
        areas: [
          sentinel,
          { ...area1, neighborAreaIds: [...area1.neighborAreaIds], cells: [...area1.cells] },
          { ...area2, neighborAreaIds: [...area2.neighborAreaIds], cells: [...area2.cells] },
        ],
        players: [
          { id: 0, territoryCount: 1, diceCount: 8, largestGroup: 1, stock: 0, eliminated: false },
          { id: 1, territoryCount: 1, diceCount: 1, largestGroup: 1, stock: 0, eliminated: false },
        ],
        turnOrder: [0, 1],
        currentPlayerIndex: 0,
        turnNumber: 0,
        phase: 'playing',
        history: [],
        rngState: seed,
        winner: null,
      };

      const newState = applyAction(state, { type: 'ATTACK', from: 1, to: 2 });
      if (newState.history[0].result.success) {
        expect(newState.players[1].eliminated).toBe(true);
        expect(newState.phase).toBe('gameOver');
        expect(newState.winner).toBe(0);
        return;
      }
    }
    throw new Error('No successful attack found — test is vacuous');
  });
});

describe('applyAction — END_TURN', () => {
  it('advances the turn', () => {
    const state = createTestState();
    const newState = applyAction(state, { type: 'END_TURN' });

    expect(newState.currentPlayerIndex).not.toBe(state.currentPlayerIndex);
    expect(newState.history.length).toBe(1);
    expect(newState.history[0].type).toBe('END_TURN');
  });

  it('does not mutate original state', () => {
    const state = createTestState();
    const origIdx = state.currentPlayerIndex;
    applyAction(state, { type: 'END_TURN' });
    expect(state.currentPlayerIndex).toBe(origIdx);
  });
});

describe('getValidMoves', () => {
  it('returns moves only from current player territories', () => {
    const state = createTestState();
    const currentPlayer = state.turnOrder[state.currentPlayerIndex];
    const moves = getValidMoves(state);

    for (const m of moves) {
      expect(state.areas[m.from].owner).toBe(currentPlayer);
      expect(state.areas[m.to].owner).not.toBe(currentPlayer);
      expect(m.attackerDice).toBeGreaterThan(1);
      expect(state.areas[m.from].neighborAreaIds).toContain(m.to);
    }
  });

  it('returns empty array when player has no valid attacks', () => {
    // Create a state where current player only has 1-dice territories
    const state = createTestState();
    const currentPlayer = state.turnOrder[state.currentPlayerIndex];
    // Force all of current player's territories to have 1 die
    const modifiedAreas = state.areas.map(a => {
      if (a.owner === currentPlayer)
        return { ...a, neighborAreaIds: [...a.neighborAreaIds], cells: [...a.cells], dice: 1 };
      return { ...a, neighborAreaIds: [...a.neighborAreaIds], cells: [...a.cells] };
    });
    const modifiedState = { ...state, areas: modifiedAreas };
    expect(getValidMoves(modifiedState)).toEqual([]);
  });
});

describe('serializeState / deserializeState', () => {
  it('round-trips correctly', () => {
    const state = createTestState();
    const serialized = serializeState(state);
    const restored = deserializeState(serialized);

    expect(restored.phase).toBe(state.phase);
    expect(restored.turnNumber).toBe(state.turnNumber);
    expect(restored.currentPlayerIndex).toBe(state.currentPlayerIndex);
    expect(restored.rngState).toBe(state.rngState);
    expect(restored.turnOrder).toEqual(state.turnOrder);
    expect(restored.players.length).toBe(state.players.length);
    expect(restored.areas.length).toBe(state.areas.length);

    // Grid was reconstructed
    expect(restored.grid.width).toBe(state.grid.width);
    expect(restored.grid.height).toBe(state.grid.height);
    expect(restored.grid.cellCount).toBe(state.grid.cellCount);
  });

  it('deserialized state produces same moves as original', () => {
    const state = createTestState();
    const restored = deserializeState(serializeState(state));
    expect(getValidMoves(restored)).toEqual(getValidMoves(state));
  });

  it('deserialized state is frozen', () => {
    const state = createTestState();
    const restored = deserializeState(serializeState(state));
    expect(Object.isFrozen(restored)).toBe(true);
  });

  it('round-trips correctly with non-empty history', () => {
    let state = createTestState();
    // Make some moves to build up history
    const moves = getValidMoves(state);
    if (moves.length > 0) {
      state = applyAction(state, { type: 'ATTACK', from: moves[0].from, to: moves[0].to });
    }
    if (state.phase !== 'gameOver') {
      state = applyAction(state, { type: 'END_TURN' });
    }

    expect(state.history.length).toBeGreaterThan(0);

    const serialized = serializeState(state);
    const restored = deserializeState(serialized);

    expect(restored.history.length).toBe(state.history.length);
    // Verify attack history entries preserve result data
    for (let i = 0; i < state.history.length; i++) {
      expect(restored.history[i].type).toBe(state.history[i].type);
      if (state.history[i].type === 'ATTACK') {
        expect(restored.history[i].result.success).toBe(state.history[i].result.success);
        expect(restored.history[i].result.attackerRoll.total).toBe(
          state.history[i].result.attackerRoll.total
        );
      }
    }
  });
});

describe('deserializeState validation', () => {
  it('throws TypeError for null data', () => {
    expect(() => deserializeState(null)).toThrow(TypeError);
  });

  it('throws TypeError for missing required fields', () => {
    expect(() => deserializeState({ grid: { width: 4, height: 4 } })).toThrow(
      /missing required field/
    );
  });

  it('throws TypeError for missing config field', () => {
    expect(() =>
      deserializeState({
        grid: { width: 4, height: 4 },
        areas: [],
        players: [],
        turnOrder: [],
        currentPlayerIndex: 0,
        turnNumber: 0,
        phase: 'playing',
        rngState: 42,
      })
    ).toThrow(/missing required field.*config/);
  });

  it('throws TypeError for invalid grid shape', () => {
    expect(() =>
      deserializeState({
        config: {},
        grid: {},
        areas: [],
        players: [],
        turnOrder: [],
        currentPlayerIndex: 0,
        turnNumber: 0,
        phase: 'playing',
        rngState: 42,
      })
    ).toThrow(/grid must have numeric/);
  });
});

describe('full game lifecycle', () => {
  it('can play a sequence of attacks and end turns', () => {
    let state = createTestState();

    // Play 10 turns
    for (let turn = 0; turn < 10; turn++) {
      const moves = getValidMoves(state);
      if (moves.length > 0) {
        state = applyAction(state, { type: 'ATTACK', from: moves[0].from, to: moves[0].to });
      }
      if (state.phase === 'gameOver') break;
      state = applyAction(state, { type: 'END_TURN' });
      if (state.phase === 'gameOver') break;
    }

    expect(state.history.length).toBeGreaterThan(0);
  });
});
