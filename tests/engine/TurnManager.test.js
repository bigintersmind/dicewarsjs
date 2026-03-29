import {
  createTurnOrder,
  findLargestConnectedGroup,
  isPlayerEliminated,
  getActivePlayers,
  isGameOver,
  calculateReinforcements,
  nextTurn,
  distributeReinforcements,
} from '../../src/engine/TurnManager.js';
import { createRng } from '../../src/engine/rng.js';

// Helper to create a minimal area
function area(id, owner, dice, neighborAreaIds = [], size = 10) {
  return { id, size, owner, dice, neighborAreaIds, centerCell: 0, cells: [] };
}

// Helper to create a minimal player
function player(
  id,
  { territoryCount = 0, diceCount = 0, largestGroup = 0, stock = 0, eliminated = false } = {}
) {
  return { id, territoryCount, diceCount, largestGroup, stock, eliminated };
}

// Helper to build a minimal state
function makeState(overrides = {}) {
  return {
    areas: [area(0, -1, 0, [], 0)], // index 0 unused
    players: [],
    turnOrder: [],
    currentPlayerIndex: 0,
    turnNumber: 0,
    ...overrides,
  };
}

describe('createTurnOrder', () => {
  it('is deterministic with the same seed', () => {
    const a = createTurnOrder(7, createRng(42));
    const b = createTurnOrder(7, createRng(42));
    expect(a).toEqual(b);
  });

  it('returns all player indices', () => {
    const order = createTurnOrder(5, createRng(1));
    expect(order.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('actually shuffles (not identity for non-trivial count)', () => {
    const rng = createRng(99);
    const order = createTurnOrder(7, rng);
    const sorted = [...order].sort((a, b) => a - b);
    // extremely unlikely to remain sorted
    expect(order).not.toEqual(sorted);
  });
});

describe('findLargestConnectedGroup', () => {
  it('returns 0 if player has no territories', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 2, [2]), area(2, 0, 3, [1])];
    expect(findLargestConnectedGroup(areas, 1)).toBe(0);
  });

  it('returns 1 for a single isolated territory', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 2, [])];
    expect(findLargestConnectedGroup(areas, 0)).toBe(1);
  });

  it('counts connected territories correctly', () => {
    /*
     * Player 0 owns 1,2,3 — 1↔2, 2↔3 (chain of 3)
     * Player 0 also owns 5 (isolated)
     */
    const areas = [
      area(0, -1, 0, [], 0),
      area(1, 0, 2, [2]),
      area(2, 0, 2, [1, 3]),
      area(3, 0, 2, [2]),
      area(4, 1, 2, [5]),
      area(5, 0, 2, [4]),
    ];
    expect(findLargestConnectedGroup(areas, 0)).toBe(3);
  });

  it('handles all territories connected', () => {
    const areas = [
      area(0, -1, 0, [], 0),
      area(1, 0, 2, [2, 3]),
      area(2, 0, 2, [1, 3]),
      area(3, 0, 2, [1, 2]),
    ];
    expect(findLargestConnectedGroup(areas, 0)).toBe(3);
  });
});

describe('isPlayerEliminated', () => {
  it('returns true for eliminated player', () => {
    const state = makeState({ players: [player(0, { eliminated: true })] });
    expect(isPlayerEliminated(state, 0)).toBe(true);
  });

  it('returns false for active player', () => {
    const state = makeState({ players: [player(0, { eliminated: false })] });
    expect(isPlayerEliminated(state, 0)).toBe(false);
  });
});

describe('getActivePlayers', () => {
  it('returns only non-eliminated players', () => {
    const state = makeState({
      players: [
        player(0),
        player(1, { eliminated: true }),
        player(2),
        player(3, { eliminated: true }),
      ],
    });
    expect(getActivePlayers(state)).toEqual([0, 2]);
  });
});

describe('isGameOver', () => {
  it('returns over=true with winner when one player left', () => {
    const state = makeState({
      players: [player(0, { eliminated: true }), player(1), player(2, { eliminated: true })],
    });
    expect(isGameOver(state)).toEqual({ over: true, winner: 1 });
  });

  it('returns over=false when multiple players remain', () => {
    const state = makeState({
      players: [player(0), player(1), player(2, { eliminated: true })],
    });
    expect(isGameOver(state)).toEqual({ over: false, winner: null });
  });

  it('returns over=true with no winner when zero players remain', () => {
    const state = makeState({
      players: [player(0, { eliminated: true }), player(1, { eliminated: true })],
    });
    expect(isGameOver(state)).toEqual({ over: true, winner: null });
  });
});

describe('calculateReinforcements', () => {
  it('returns 0 for eliminated player', () => {
    const state = makeState({
      areas: [area(0, -1, 0, [], 0), area(1, 0, 2, [])],
      players: [player(0, { eliminated: true, territoryCount: 0 })],
    });
    expect(calculateReinforcements(state, 0)).toBe(0);
  });

  it('returns 1 for a player with a single territory', () => {
    const state = makeState({
      areas: [area(0, -1, 0, [], 0), area(1, 0, 2, [])],
      players: [player(0, { territoryCount: 1 })],
    });
    expect(calculateReinforcements(state, 0)).toBe(1);
  });

  it('returns full largest connected group size', () => {
    // Player 0 owns 6 connected territories → reinforcements = 6
    const areas = [area(0, -1, 0, [], 0)];
    for (let i = 1; i <= 6; i++) {
      const adj = [];
      if (i > 1) adj.push(i - 1);
      if (i < 6) adj.push(i + 1);
      areas.push(area(i, 0, 2, adj));
    }
    const state = makeState({
      areas,
      players: [player(0, { territoryCount: 6 })],
    });
    expect(calculateReinforcements(state, 0)).toBe(6);
  });
});

describe('nextTurn', () => {
  it('advances to the next player', () => {
    const state = makeState({
      turnOrder: [3, 1, 0, 2],
      currentPlayerIndex: 0,
      turnNumber: 0,
      players: [player(0), player(1), player(2), player(3)],
    });
    const result = nextTurn(state);
    expect(result.currentPlayerIndex).toBe(1);
    expect(result.turnNumber).toBe(0);
  });

  it('wraps around and increments turnNumber', () => {
    const state = makeState({
      turnOrder: [0, 1],
      currentPlayerIndex: 1,
      turnNumber: 0,
      players: [player(0), player(1)],
    });
    const result = nextTurn(state);
    expect(result.currentPlayerIndex).toBe(0);
    expect(result.turnNumber).toBe(1);
  });

  it('skips eliminated players', () => {
    const state = makeState({
      turnOrder: [0, 1, 2],
      currentPlayerIndex: 0,
      turnNumber: 0,
      players: [player(0), player(1, { eliminated: true }), player(2)],
    });
    const result = nextTurn(state);
    expect(result.currentPlayerIndex).toBe(2);
  });

  it('throws when all players are eliminated', () => {
    const state = makeState({
      turnOrder: [0, 1, 2],
      currentPlayerIndex: 0,
      turnNumber: 0,
      players: [
        player(0, { eliminated: true }),
        player(1, { eliminated: true }),
        player(2, { eliminated: true }),
      ],
    });
    expect(() => nextTurn(state)).toThrow(/all players are eliminated/);
  });
});

describe('distributeReinforcements', () => {
  it('does not mutate the original state', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 3, [2]), area(2, 0, 2, [1])];
    const state = makeState({
      areas,
      players: [player(0, { territoryCount: 2, stock: 5 })],
    });
    const originalDice1 = areas[1].dice;
    const originalDice2 = areas[2].dice;

    distributeReinforcements(state, 0, createRng(42));

    expect(areas[1].dice).toBe(originalDice1);
    expect(areas[2].dice).toBe(originalDice2);
  });

  it('adds dice to player territories', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 2, [2]), area(2, 0, 2, [1])];
    const state = makeState({
      areas,
      players: [player(0, { territoryCount: 2, stock: 3 })],
    });
    const { areas: newAreas, playerStock } = distributeReinforcements(state, 0, createRng(42));

    // Should have placed dice
    const totalNewDice = newAreas[1].dice + newAreas[2].dice;
    const totalOldDice = areas[1].dice + areas[2].dice;
    expect(totalNewDice).toBeGreaterThan(totalOldDice);
    // Stock should have decreased
    expect(playerStock).toBeLessThan(3 + calculateReinforcements(state, 0));
  });

  it('does not exceed MAX_DICE per territory', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 7, [])];
    const state = makeState({
      areas,
      players: [player(0, { territoryCount: 1, stock: 10 })],
    });
    const { areas: newAreas } = distributeReinforcements(state, 0, createRng(42));
    expect(newAreas[1].dice).toBeLessThanOrEqual(8);
  });

  it('caps stock at STOCK_MAX (64)', () => {
    const areas = [
      area(0, -1, 0, [], 0),
      area(1, 0, 3, [2, 3, 4, 5, 6, 7]),
      area(2, 0, 3, [1]),
      area(3, 0, 3, [1]),
      area(4, 0, 3, [1]),
      area(5, 0, 3, [1]),
      area(6, 0, 3, [1]),
      area(7, 1, 3, [1]),
    ];
    const state = makeState({
      areas,
      players: [
        player(0, { territoryCount: 6, diceCount: 18, largestGroup: 6, stock: 63 }),
        player(1, { territoryCount: 1, diceCount: 3, largestGroup: 1, stock: 0 }),
      ],
    });
    /*
     * Player 0 has largestGroup=6, so reinforcements = 6
     * stock = min(63 + 6, 64) = 64, capped at STOCK_MAX
     */
    const { playerStock } = distributeReinforcements(state, 0, createRng(42));
    expect(playerStock).toBeLessThanOrEqual(64);
  });

  it('returns early without adding dice when eliminated player has 0 stock', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 3, [2]), area(2, 0, 2, [1])];
    const state = makeState({
      areas,
      players: [player(0, { territoryCount: 0, stock: 0, eliminated: true })],
    });
    const { areas: newAreas, playerStock } = distributeReinforcements(state, 0, createRng(42));

    expect(playerStock).toBe(0);
    expect(newAreas[1].dice).toBe(3);
    expect(newAreas[2].dice).toBe(2);
  });

  it('is deterministic with the same seed', () => {
    const areas = [area(0, -1, 0, [], 0), area(1, 0, 2, [2]), area(2, 0, 2, [1])];
    const mkState = () =>
      makeState({
        areas: areas.map(a => ({
          ...a,
          neighborAreaIds: [...a.neighborAreaIds],
          cells: [...a.cells],
        })),
        players: [player(0, { territoryCount: 2, stock: 5 })],
      });

    const result1 = distributeReinforcements(mkState(), 0, createRng(99));
    const result2 = distributeReinforcements(mkState(), 0, createRng(99));

    expect(result1.areas[1].dice).toBe(result2.areas[1].dice);
    expect(result1.areas[2].dice).toBe(result2.areas[2].dice);
    expect(result1.playerStock).toBe(result2.playerStock);
  });
});
