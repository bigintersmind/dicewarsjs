import {
  createInitialState,
  applyAction,
  getValidMoves,
  serializeState,
  deserializeState,
} from '../../src/engine/StateManager.js';
import { generateMap } from '../../src/engine/MapGenerator.js';
import {
  createTurnOrder,
  findLargestConnectedGroup,
  calculateReinforcements,
  distributeReinforcements,
} from '../../src/engine/TurnManager.js';
import { createRng } from '../../src/engine/rng.js';
import { createGame } from '../../src/engine/GameRunner.js';

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
    expect(state.turnsTaken).toBe(0);
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

  it('increments turnsTaken by exactly 1 per END_TURN (and ATTACK leaves it alone)', () => {
    /*
     * turnsTaken counts COMPLETED player-turns — the unit matchRunner's turnCount and
     * the 500-turn truncation cap use — unlike turnNumber, which counts full-roster
     * rounds (incrementing only on turn-order wrap). This is the engine counter the
     * v3 turnClockNorm encoding normalizes.
     */
    let state = createTestState();
    expect(state.turnsTaken).toBe(0);

    const move = getValidMoves(state)[0];
    state = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
    expect(state.turnsTaken).toBe(0); // attacks are within-turn: no completed turn yet

    for (let i = 1; i <= 3; i++) {
      state = applyAction(state, { type: 'END_TURN' });
      expect(state.turnsTaken).toBe(i);
    }
    // 3 player-turns into a 7-player game, the round counter has not wrapped.
    expect(state.turnNumber).toBe(0);
  });

  it('does not mutate original state', () => {
    const state = createTestState();
    const origIdx = state.currentPlayerIndex;
    applyAction(state, { type: 'END_TURN' });
    expect(state.currentPlayerIndex).toBe(origIdx);
  });

  it('does not mutate the prior state areas (Change-1 immutability seam)', () => {
    /*
     * applyEndTurn passes state.areas straight into distributeReinforcements instead
     * of pre-cloning, so the prior state's immutability now rests entirely on that
     * function cloning internally. Pin that invariant here at the StateManager seam —
     * the previous "does not mutate original state" test only checked a frozen
     * top-level primitive (currentPlayerIndex), never the areas objects.
     */
    const state = createTestState();
    const before = JSON.parse(JSON.stringify(state.areas));

    const newState = applyAction(state, { type: 'END_TURN' });

    // The prior state's areas must be byte-identical afterward (nothing written through).
    expect(state.areas).toEqual(before);
    // The new state owns a fresh areas array, not the same reference.
    expect(newState.areas).not.toBe(state.areas);
    /*
     * Reinforcement actually placed dice — so we exercised the real cloning path, not
     * the no-op early return — and the changed area is a distinct object, not an alias.
     */
    const changed = newState.areas.findIndex((a, i) => a.dice > before[i].dice);
    expect(changed).toBeGreaterThan(0);
    expect(newState.areas[changed]).not.toBe(state.areas[changed]);
  });

  it('reinforcement dice count matches the recompute (maintained-largestGroup shortcut)', () => {
    /*
     * applyEndTurn now feeds the current player's maintained largestGroup into
     * distributeReinforcements instead of recomputing it. Pin that the dice actually
     * placed still equal calculateReinforcements — i.e. the shortcut changed nothing.
     * On a fresh map the current player has stock 0 and ample per-territory capacity, so
     * every reinforcement die lands and the board's total dice rises by exactly that count.
     */
    const state = createTestState();
    const currentPlayer = state.turnOrder[state.currentPlayerIndex];
    const expectedReinforcements = calculateReinforcements(state, currentPlayer);

    // Sanity: the maintained value the shortcut reads equals the from-scratch recompute.
    expect(state.players[currentPlayer].largestGroup).toBe(expectedReinforcements);
    expect(expectedReinforcements).toBeGreaterThan(0);

    const totalBefore = state.areas.reduce((sum, a) => sum + a.dice, 0);
    const newState = applyAction(state, { type: 'END_TURN' });
    const totalAfter = newState.areas.reduce((sum, a) => sum + a.dice, 0);

    expect(totalAfter - totalBefore).toBe(expectedReinforcements);
  });

  it('places END_TURN dice identical to the recompute path across every rotating seat', () => {
    /*
     * The test above pins the shortcut for one seat (turnOrder[0], turn 0, fresh board).
     * The largestGroup fuzz test below cannot extend that guard: it recomputes diceCount
     * from the post-action board, so a wrong END_TURN dice *count* would still match its
     * reference. So oracle each END_TURN directly — replay the same rngState through
     * distributeReinforcements' RECOMPUTE path (no 4th arg) and assert applyAction (which
     * takes the precomputed-largestGroup path) placed byte-identical dice. Pure END_TURNs
     * change no ownership, so largestGroup stays maintained and one full rotation exercises
     * all 7 seats. Per-territory equality is immune to MAX_DICE/STOCK_MAX clamping — both
     * sides clamp identically — so it holds even once stock accumulates on later passes.
     */
    let state = createTestState();
    for (let i = 0; i < state.turnOrder.length; i++) {
      const currentPlayer = state.turnOrder[state.currentPlayerIndex];

      // The maintained value the shortcut reads must equal the from-scratch recompute, so
      // both paths resolve reinforcements from the same number.
      expect(state.players[currentPlayer].largestGroup).toBe(
        calculateReinforcements(state, currentPlayer)
      );

      // Independent oracle: the recompute path fed the same RNG state applyEndTurn uses.
      const expected = distributeReinforcements(
        { areas: state.areas, players: state.players },
        currentPlayer,
        createRng(state.rngState)
      );

      const newState = applyAction(state, { type: 'END_TURN' });

      newState.areas.forEach((a, idx) => expect(a.dice).toBe(expected.areas[idx].dice));
      expect(newState.players[currentPlayer].stock).toBe(expected.playerStock);

      state = newState;
    }
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
    expect(restored.turnsTaken).toBe(state.turnsTaken);
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

    // The END_TURN above makes this a non-zero turnsTaken round-trip.
    expect(state.turnsTaken).toBeGreaterThan(0);
    expect(restored.turnsTaken).toBe(state.turnsTaken);

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

  it('defaults turnsTaken to 0 for a legacy payload without the field (not required)', () => {
    /*
     * turnsTaken postdates the serialized format — deliberately NOT in the
     * required-field validation, so an old saved game still loads (with the
     * completed-turn counter restarted at 0).
     */
    const legacy = serializeState(createTestState());
    delete legacy.turnsTaken;
    const restored = deserializeState(legacy);
    expect(restored.turnsTaken).toBe(0);
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

/**
 * Recompute every player's stats from scratch — the slow, obviously-correct
 * reference the incremental recalcPlayerStats must always agree with.
 */
function referenceStats(areas, playerCount) {
  const ref = Array.from({ length: playerCount }, (_, id) => ({
    id,
    territoryCount: 0,
    diceCount: 0,
    largestGroup: 0,
  }));
  for (let a = 1; a < areas.length; a++) {
    const ar = areas[a];
    if (ar.size > 0 && ar.owner >= 0 && ar.owner < playerCount) {
      ref[ar.owner].territoryCount++;
      ref[ar.owner].diceCount += ar.dice;
    }
  }
  for (const r of ref) r.largestGroup = findLargestConnectedGroup(areas, r.id);
  return ref;
}

describe('applyAttack — luck handicap (issue #179)', () => {
  const HANDICAP_CONFIG = { seed: 4242, playerCount: 4, maxAreas: 24 };

  /** First legal move of the opening turn, taken from an unhandicapped game. */
  function openingMove(config = HANDICAP_CONFIG) {
    const state = createGame(config);
    const moves = getValidMoves(state);
    expect(moves.length).toBeGreaterThan(0);
    return { state, move: moves[0] };
  }

  it('grants the configured seat advantage dice when it attacks', () => {
    const { state: plain, move } = openingMove();
    const attacker = plain.turnOrder[plain.currentPlayerIndex];
    expect(plain.areas[move.from].owner).toBe(attacker);

    const state = createGame({ ...HANDICAP_CONFIG, handicap: { playerId: attacker, level: 1 } });
    const after = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
    const { attackerRoll, defenderRoll } = after.history[0].result;

    expect(attackerRoll.dropped).toHaveLength(1);
    expect(attackerRoll.values).toHaveLength(state.areas[move.from].dice);
    expect(defenderRoll.dropped).toEqual([]);
    expect(attackerRoll.total).toBe(attackerRoll.values.reduce((a, b) => a + b, 0));
  });

  it('grants the configured seat advantage dice when it is attacked', () => {
    const { state: plain, move } = openingMove();
    const defender = plain.areas[move.to].owner;
    const attacker = plain.turnOrder[plain.currentPlayerIndex];
    expect(defender).not.toBe(attacker);

    const state = createGame({ ...HANDICAP_CONFIG, handicap: { playerId: defender, level: 2 } });
    const after = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
    const { attackerRoll, defenderRoll } = after.history[0].result;

    expect(defenderRoll.dropped).toHaveLength(2);
    expect(defenderRoll.values).toHaveLength(state.areas[move.to].dice);
    expect(attackerRoll.dropped).toEqual([]);
  });

  it('leaves every other seat unbiased across a whole game', () => {
    const handicapped = 1;
    const level = 1;
    let state = createGame({ ...HANDICAP_CONFIG, handicap: { playerId: handicapped, level } });

    let attacksByHandicapped = 0;
    let defensesByHandicapped = 0;
    let neutralAttacks = 0;

    for (let step = 0; step < 400 && state.phase !== 'gameOver'; step++) {
      const moves = getValidMoves(state);
      if (moves.length === 0) {
        state = applyAction(state, { type: 'END_TURN' });
        continue;
      }
      const move = moves[step % moves.length];
      const attacker = state.turnOrder[state.currentPlayerIndex];
      const defender = state.areas[move.to].owner;

      state = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
      const { attackerRoll, defenderRoll } = state.history[state.history.length - 1].result;

      expect(attackerRoll.dropped).toHaveLength(attacker === handicapped ? level : 0);
      expect(defenderRoll.dropped).toHaveLength(defender === handicapped ? level : 0);

      if (attacker === handicapped) attacksByHandicapped++;
      else if (defender === handicapped) defensesByHandicapped++;
      else neutralAttacks++;
    }

    // All three cases were actually exercised, so the assertions above mean something.
    expect(attacksByHandicapped).toBeGreaterThan(0);
    expect(defensesByHandicapped).toBeGreaterThan(0);
    expect(neutralAttacks).toBeGreaterThan(0);
  });

  /** Drive a deterministic scripted game (no bots, no Math.random) to completion. */
  function runScripted(config, steps = 300) {
    let state = createGame(config);
    for (let step = 0; step < steps && state.phase !== 'gameOver'; step++) {
      const moves = getValidMoves(state);
      state =
        moves.length > 0
          ? applyAction(state, { type: 'ATTACK', from: moves[0].from, to: moves[0].to })
          : applyAction(state, { type: 'END_TURN' });
    }
    return state;
  }

  it('handicap: null reproduces the un-handicapped game exactly', () => {
    for (const seed of [1, 42, 2026]) {
      const withoutKey = runScripted({ ...HANDICAP_CONFIG, seed });
      const explicitNull = runScripted({ ...HANDICAP_CONFIG, seed, handicap: null });
      expect(explicitNull).toEqual(withoutKey);
    }
  });

  it('a config with no handicap key at all behaves as un-handicapped (pre-#179 states)', () => {
    /*
     * createInitialState is fed raw configs by callers other than createGame (tests,
     * deserialized states), so applyAttack must tolerate a missing handicap key.
     */
    const rng = createRng(11);
    const cfg = { ...DEFAULT_CONFIG, seed: 11 };
    const mapData = generateMap(cfg, rng);
    const turnOrder = createTurnOrder(cfg.playerCount, rng);
    const state = createInitialState(cfg, mapData, turnOrder, rng.state());
    expect(state.config.handicap).toBeUndefined();

    const move = getValidMoves(state)[0];
    const after = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
    expect(after.history[0].result.attackerRoll.dropped).toEqual([]);
    expect(after.history[0].result.defenderRoll.dropped).toEqual([]);
  });

  it('a handicap changes the game (the seed alone no longer determines play)', () => {
    const plain = runScripted({ ...HANDICAP_CONFIG, seed: 7 });
    const lucky = runScripted({ ...HANDICAP_CONFIG, seed: 7, handicap: { playerId: 0, level: 2 } });
    expect(lucky.rngState).not.toBe(plain.rngState);
  });
});

describe('player-stat invariants under the per-move trims', () => {
  /*
   * The per-move allocation trims only recompute largestGroup for the players an
   * action could have changed. These tests pin that the maintained stats are
   * byte-identical to a from-scratch recompute after every single action, across
   * wins, losses, eliminations and end-turns — the safety net for the optimization.
   */
  const SEEDS = [1, 7, 42, 100, 2024];
  const config = {
    mapWidth: 20,
    mapHeight: 22,
    maxAreas: 24,
    playerCount: 4,
    dicePerArea: 3,
    seed: 0,
  };

  it.each(SEEDS)('maintained stats match a full recompute after every action (seed %i)', seed => {
    const rng = createRng(seed);
    const cfg = { ...config, seed };
    const mapData = generateMap(cfg, rng);
    const turnOrder = createTurnOrder(cfg.playerCount, rng);
    let state = createInitialState(cfg, mapData, turnOrder, rng.state());

    let captures = 0;
    let losses = 0;
    let eliminations = 0;
    let guard = 0;
    /*
     * Attack whenever possible (the current player END_TURNs only when it has no
     * legal attack) so the game drives toward eliminations rather than stalling.
     */
    while (state.phase !== 'gameOver' && guard < 6000) {
      guard++;
      const moves = getValidMoves(state);
      const wasEliminated = state.players.map(p => p.eliminated);

      if (moves.length > 0) {
        const m = moves[guard % moves.length];
        const prevOwner = state.areas[m.to].owner;
        state = applyAction(state, { type: 'ATTACK', from: m.from, to: m.to });
        if (state.areas[m.to].owner === prevOwner) losses++;
        else captures++;
      } else {
        state = applyAction(state, { type: 'END_TURN' });
      }
      eliminations += state.players.filter((p, id) => p.eliminated && !wasEliminated[id]).length;

      const ref = referenceStats(state.areas, cfg.playerCount);
      for (let id = 0; id < cfg.playerCount; id++) {
        const p = state.players[id];
        expect(p.territoryCount).toBe(ref[id].territoryCount);
        expect(p.diceCount).toBe(ref[id].diceCount);
        expect(p.largestGroup).toBe(ref[id].largestGroup);
        // eliminated is sticky and equivalent to "currently owns nothing".
        expect(p.eliminated).toBe(ref[id].territoryCount === 0);
      }
    }

    /*
     * The run exercised every branch the trims touch: successful captures (attacker
     * + former-owner dirty), failed attacks (empty dirty set) and eliminations
     * (the territoryCount === 0 path).
     */
    expect(captures).toBeGreaterThan(0);
    expect(losses).toBeGreaterThan(0);
    expect(eliminations).toBeGreaterThan(0);
  });
});
