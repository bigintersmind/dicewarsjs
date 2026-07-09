import { createBotState } from '../../src/arena/botState.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';

function createTestState(seed = 42) {
  return createGame({ seed, playerCount: 4 });
}

describe('createBotState', () => {
  it('returns a frozen object', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(Object.isFrozen(botState)).toBe(true);
    expect(Object.isFrozen(botState.allAreas)).toBe(true);
    expect(Object.isFrozen(botState.myAreas)).toBe(true);
    expect(Object.isFrozen(botState.players)).toBe(true);
  });

  it('sets myPlayer to the given player ID', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.myPlayer).toBe(playerId);
  });

  it('includes correct turn metadata', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.turnNumber).toBe(state.turnNumber);
    expect(botState.turnsTaken).toBe(state.turnsTaken);
    expect(botState.totalPlayers).toBe(state.players.length);
    expect(botState.activePlayers).toBe(state.players.filter(p => !p.eliminated).length);
    expect(['early', 'mid', 'late']).toContain(botState.gamePhase);
  });

  it('carries the engine turnsTaken counter verbatim (the v3 turn-clock source)', () => {
    let state = createTestState();
    state = applyAction(state, { type: 'END_TURN' });
    state = applyAction(state, { type: 'END_TURN' });
    expect(state.turnsTaken).toBe(2);

    const playerId = state.turnOrder[state.currentPlayerIndex];
    expect(createBotState(state, playerId).turnsTaken).toBe(2);
  });

  it('excludes zero-size areas from allAreas', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    for (const area of botState.allAreas) {
      expect(area.id).toBeGreaterThan(0);
    }
  });

  it('allAreas have correct shape', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.allAreas.length).toBeGreaterThan(0);
    for (const area of botState.allAreas) {
      expect(typeof area.id).toBe('number');
      expect(typeof area.owner).toBe('number');
      expect(typeof area.dice).toBe('number');
      expect(Array.isArray(area.neighbors)).toBe(true);
      expect(typeof area.isBorder).toBe('boolean');
      // Should NOT have internal engine fields
      expect(area.cells).toBeUndefined();
      expect(area.centerCell).toBeUndefined();
      expect(area.size).toBeUndefined();
      expect(area.neighborAreaIds).toBeUndefined();
    }
  });

  it('myAreas contains only territories owned by the player', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.myAreas.length).toBeGreaterThan(0);
    for (const area of botState.myAreas) {
      expect(area.owner).toBe(playerId);
    }
  });

  it('myAreas is a subset of allAreas', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    const allIds = new Set(botState.allAreas.map(a => a.id));
    for (const area of botState.myAreas) {
      expect(allIds.has(area.id)).toBe(true);
    }
  });

  it('players have correct shape', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.players.length).toBe(state.players.length);
    for (const p of botState.players) {
      expect(typeof p.id).toBe('number');
      expect(typeof p.territories).toBe('number');
      expect(typeof p.totalDice).toBe('number');
      expect(typeof p.connectedTerritories).toBe('number');
      expect(typeof p.reinforcements).toBe('number');
      expect(typeof p.eliminated).toBe('boolean');
      expect(typeof p.turnsUntilActs).toBe('number');
      // Should NOT have internal engine field names
      expect(p.territoryCount).toBeUndefined();
      expect(p.diceCount).toBeUndefined();
      expect(p.largestGroup).toBeUndefined();
      expect(p.stock).toBeUndefined();
    }
  });

  it('turnsUntilActs is 0 for the acting player and ranks the rest by turn order', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.players[playerId].turnsUntilActs).toBe(0);

    // No eliminations at game start: walking turnOrder from the acting player's
    // position must yield ranks 0, 1, 2, ... in order.
    const myPos = state.turnOrder.indexOf(playerId);
    for (let step = 0; step < state.turnOrder.length; step++) {
      const pid = state.turnOrder[(myPos + step) % state.turnOrder.length];
      expect(botState.players[pid].turnsUntilActs).toBe(step);
    }
  });

  it('turnsUntilActs skips eliminated seats and is 0 for them', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];

    // Eliminate the seat that would act right after the acting player.
    const myPos = state.turnOrder.indexOf(playerId);
    const nextPid = state.turnOrder[(myPos + 1) % state.turnOrder.length];
    const withElim = {
      ...state,
      players: state.players.map(p => (p.id === nextPid ? { ...p, eliminated: true } : p)),
    };
    const botState = createBotState(withElim, playerId);

    expect(botState.players[nextPid].turnsUntilActs).toBe(0);
    expect(botState.players[nextPid].eliminated).toBe(true);

    // Active ranks are 0..activePlayers-1, each exactly once.
    const activeRanks = botState.players
      .filter(p => !p.eliminated)
      .map(p => p.turnsUntilActs)
      .sort((a, b) => a - b);
    expect(activeRanks).toEqual([0, 1, 2]);

    // The seat two steps down the order is now the next actor.
    const afterNext = state.turnOrder[(myPos + 2) % state.turnOrder.length];
    expect(botState.players[afterNext].turnsUntilActs).toBe(1);
  });

  it('turnsUntilActs wraps around turnOrder when the actor sits late in the order', () => {
    /*
     * Both tests above rank from an actor at turn-order position 0, so the modulo
     * walk never wraps. Rank from position 2 of a 4-player order: the two seats
     * BEFORE the actor must come back as the wrapped ranks 2 and 3.
     */
    const state = createTestState();
    const actor = state.turnOrder[2];
    const botState = createBotState(state, actor);

    expect(botState.players[actor].turnsUntilActs).toBe(0);
    expect(botState.players[state.turnOrder[3]].turnsUntilActs).toBe(1);
    expect(botState.players[state.turnOrder[0]].turnsUntilActs).toBe(2); // wrapped
    expect(botState.players[state.turnOrder[1]].turnsUntilActs).toBe(3); // wrapped
  });

  it('throws when turnOrder is missing or the player has no seat in it', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];

    // Hand-built state without the engine's shuffled seat order.
    const noOrder = { ...state, turnOrder: undefined };
    expect(() => createBotState(noOrder, playerId)).toThrow(/turnOrder must be an array/);

    // A playerId with no seat: indexOf -1 must fail loud, not TypeError on players[undefined].
    expect(() => createBotState(state, 99)).toThrow(/not in turnOrder/);
  });

  it('player stats match engine state', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    for (let i = 0; i < state.players.length; i++) {
      const eng = state.players[i];
      const bot = botState.players[i];
      expect(bot.id).toBe(eng.id);
      expect(bot.territories).toBe(eng.territoryCount);
      expect(bot.totalDice).toBe(eng.diceCount);
      expect(bot.connectedTerritories).toBe(eng.largestGroup);
      expect(bot.reinforcements).toBe(eng.stock);
      expect(bot.eliminated).toBe(eng.eliminated);
    }
  });

  it('isBorder is true when area has a neighbor with different owner', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    for (const area of botState.allAreas) {
      const hasEnemyNeighbor = area.neighbors.some(adjId => {
        const adj = botState.allAreas.find(a => a.id === adjId);
        return adj && adj.owner !== area.owner;
      });
      expect(area.isBorder).toBe(hasEnemyNeighbor);
    }
  });

  it('does not expose rngState, history, or grid', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.rngState).toBeUndefined();
    expect(botState.history).toBeUndefined();
    expect(botState.grid).toBeUndefined();
    expect(botState.config).toBeUndefined();
  });

  it('gamePhase is early at start of game', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(botState.gamePhase).toBe('early');
  });

  it('produces consistent output for same input', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];

    const bs1 = createBotState(state, playerId);
    const bs2 = createBotState(state, playerId);

    // random is a fresh closure per call, so compare it behaviorally and the
    // data fields structurally.
    const { random: rand1, ...data1 } = bs1;
    const { random: rand2, ...data2 } = bs2;
    expect(data1).toEqual(data2);
    expect(Array.from({ length: 5 }, () => rand1())).toEqual(
      Array.from({ length: 5 }, () => rand2())
    );
  });

  it('does not mutate the original engine state', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const originalAreas = JSON.parse(JSON.stringify(state.areas));

    createBotState(state, playerId);

    expect(state.areas).toEqual(originalAreas);
  });

  it('neighbors reference valid territory IDs', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    const validIds = new Set(botState.allAreas.map(a => a.id));
    for (const area of botState.allAreas) {
      for (const adjId of area.neighbors) {
        expect(validIds.has(adjId)).toBe(true);
      }
    }
  });

  it('gamePhase is mid after early game with 1 of 4 players eliminated', () => {
    /*
     * computeGamePhase returns 'mid' when: turnNumber > 3 OR eliminated > 0,
     * AND activePlayers > 2 AND eliminated < totalPlayers/2.
     */
    const state = createTestState();

    // Craft a state where 1 of 4 players is eliminated and turn > 3
    const midState = {
      ...state,
      turnNumber: 10,
      players: state.players.map((p, i) => (i === 3 ? { ...p, eliminated: true } : p)),
    };

    const playerId = midState.turnOrder[midState.currentPlayerIndex];
    const botState = createBotState(midState, playerId);
    expect(botState.gamePhase).toBe('mid');
  });

  it('gamePhase is late when half or more players are eliminated', () => {
    // computeGamePhase returns 'late' when activePlayers <= 2 OR eliminated >= totalPlayers/2
    const state = createTestState();

    // Craft a state where 2 of 4 players are eliminated (half)
    const lateState = {
      ...state,
      turnNumber: 50,
      players: state.players.map((p, i) => (i >= 2 ? { ...p, eliminated: true } : p)),
    };

    const playerId = lateState.turnOrder[lateState.currentPlayerIndex];
    const botState = createBotState(lateState, playerId);
    expect(botState.gamePhase).toBe('late');
  });
});

describe('createBotState random()', () => {
  it('exposes a seeded random function on the frozen BotState', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, playerId);

    expect(typeof botState.random).toBe('function');
    const v = botState.random();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('yields the same sequence for the same engine state and player', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const a = createBotState(state, playerId);
    const b = createBotState(state, playerId);

    const seqA = Array.from({ length: 10 }, () => a.random());
    const seqB = Array.from({ length: 10 }, () => b.random());
    expect(seqA).toEqual(seqB);
  });

  it('yields different sequences for different players on the same state', () => {
    const state = createTestState();
    const seqs = [0, 1].map(playerId => {
      const botState = createBotState(state, playerId);
      return Array.from({ length: 10 }, () => botState.random());
    });
    expect(seqs[0]).not.toEqual(seqs[1]);
  });

  it('yields a fresh stream after an action advances the engine rngState', () => {
    const state = createTestState();
    const playerId = state.turnOrder[state.currentPlayerIndex];
    const before = createBotState(state, playerId).random();

    const [move] = getValidMoves(state);
    const attacked = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
    expect(attacked.rngState).not.toBe(state.rngState);

    const after = createBotState(attacked, playerId).random();
    expect(after).not.toBe(before);
  });
});
