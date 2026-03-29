import { createBotState } from '../../src/arena/botState.js';
import { createGame } from '../../src/engine/GameRunner.js';

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
    expect(botState.totalPlayers).toBe(state.players.length);
    expect(botState.activePlayers).toBe(state.players.filter(p => !p.eliminated).length);
    expect(['early', 'mid', 'late']).toContain(botState.gamePhase);
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
      // Should NOT have internal engine field names
      expect(p.territoryCount).toBeUndefined();
      expect(p.diceCount).toBeUndefined();
      expect(p.largestGroup).toBeUndefined();
      expect(p.stock).toBeUndefined();
    }
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

    expect(bs1).toEqual(bs2);
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
