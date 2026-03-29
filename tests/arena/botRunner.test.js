import { runBotDirect } from '../../src/arena/botRunner.js';
import { createBotState } from '../../src/arena/botState.js';
import { createGame } from '../../src/engine/GameRunner.js';

function createTestBotState(seed = 42) {
  const state = createGame({ seed, playerCount: 4 });
  const playerId = state.turnOrder[state.currentPlayerIndex];
  return createBotState(state, playerId);
}

describe('runBotDirect', () => {
  it('returns the move from a valid bot function', () => {
    const botState = createTestBotState();
    const botFn = state => {
      const area = state.myAreas.find(a => a.dice > 1);
      if (!area) return null;
      const target = area.neighbors.find(adjId => {
        const adj = state.allAreas.find(a => a.id === adjId);
        return adj && adj.owner !== state.myPlayer;
      });
      return target ? { from: area.id, to: target } : null;
    };

    const result = runBotDirect(botFn, botState);
    expect(result.error).toBeUndefined();

    if (result.move !== null) {
      expect(typeof result.move.from).toBe('number');
      expect(typeof result.move.to).toBe('number');
    }
  });

  it('returns null move when bot returns null', () => {
    const botState = createTestBotState();
    const result = runBotDirect(() => null, botState);
    expect(result.move).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('returns null move when bot returns undefined', () => {
    const botState = createTestBotState();
    const result = runBotDirect(() => {}, botState);
    expect(result.move).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('catches bot errors and returns error message', () => {
    const botState = createTestBotState();
    const result = runBotDirect(() => {
      throw new Error('bot crashed');
    }, botState);
    expect(result.move).toBeNull();
    expect(result.error).toBe('bot crashed');
  });

  it('passes botState to the bot function', () => {
    const botState = createTestBotState();
    let receivedState = null;
    runBotDirect(state => {
      receivedState = state;
      return null;
    }, botState);
    expect(receivedState).toBe(botState);
  });
});

/*
 * Note: createBotWorker and runBotMove tests require a real Worker environment
 * which jsdom doesn't support. These are tested via integration tests in the browser.
 * The Worker protocol is tested indirectly through the arena runner tests
 * which use runBotDirect for all built-in bots.
 */
