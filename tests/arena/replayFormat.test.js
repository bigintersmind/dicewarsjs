import {
  createReplayFromState,
  serializeReplay,
  deserializeReplay,
  replayToState,
  getReplayLength,
} from '../../src/arena/replayFormat.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { ACTION_TYPES } from '../../src/engine/constants.js';

function playTestGame(seed = 42) {
  let state = createGame({ seed, playerCount: 3 });

  // Play a few turns manually to generate history
  for (let turn = 0; turn < 5; turn++) {
    const moves = getValidMoves(state);
    if (moves.length > 0) {
      state = applyAction(state, {
        type: ACTION_TYPES.ATTACK,
        from: moves[0].from,
        to: moves[0].to,
      });
    }
    if (state.phase === 'gameOver') break;
    state = applyAction(state, { type: ACTION_TYPES.END_TURN });
    if (state.phase === 'gameOver') break;
  }

  return state;
}

describe('createReplayFromState', () => {
  it('creates a replay with correct structure', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, {
      bots: ['bot1', 'bot2', 'bot3'],
    });

    expect(replay.version).toBe(1);
    expect(replay.config).toBeDefined();
    expect(replay.config.seed).toBe(42);
    expect(replay.config.playerCount).toBe(3);
    expect(Array.isArray(replay.actions)).toBe(true);
    expect(replay.actions.length).toBeGreaterThan(0);
    expect(replay.metadata).toBeDefined();
    expect(replay.metadata.bots).toEqual(['bot1', 'bot2', 'bot3']);
  });

  it('compact actions only have type, from, to', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });

    for (const action of replay.actions) {
      expect(['ATTACK', 'END_TURN']).toContain(action.type);
      if (action.type === 'ATTACK') {
        expect(typeof action.from).toBe('number');
        expect(typeof action.to).toBe('number');
        // Should NOT have battle result
        expect(action.result).toBeUndefined();
      }
    }
  });

  it('includes timestamp in metadata', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });
    expect(replay.metadata.timestamp).toBeTruthy();
    expect(new Date(replay.metadata.timestamp).getTime()).toBeGreaterThan(0);
  });
});

describe('serializeReplay / deserializeReplay', () => {
  it('round-trips a replay', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, {
      bots: ['a', 'b', 'c'],
      winner: 1,
      turnCount: 5,
    });

    const encoded = serializeReplay(replay);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = deserializeReplay(encoded);
    expect(decoded.version).toBe(replay.version);
    expect(decoded.config).toEqual(replay.config);
    expect(decoded.actions).toEqual(replay.actions);
    expect(decoded.metadata.bots).toEqual(replay.metadata.bots);
    expect(decoded.metadata.winner).toBe(replay.metadata.winner);
  });

  it('throws on invalid base64', () => {
    expect(() => deserializeReplay('not-valid-base64!!!')).toThrow();
  });
});

describe('replayToState', () => {
  it('returns initial state at index 0', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });

    const initial = replayToState(replay, 0);
    expect(initial.turnNumber).toBe(0);
    expect(initial.config.seed).toBe(42);
  });

  it('deterministically reproduces state at any action index', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });
    const totalActions = getReplayLength(replay);

    // Reconstruct at the final action
    const final = replayToState(replay, totalActions);

    // Reconstruct again — should be identical
    const final2 = replayToState(replay, totalActions);
    expect(final.turnNumber).toBe(final2.turnNumber);
    expect(final.phase).toBe(final2.phase);
  });

  it('state progresses as action index increases', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });

    const s0 = replayToState(replay, 0);
    const s1 = replayToState(replay, 1);

    // After one action, history should have grown
    expect(s1.history.length).toBe(1);
    expect(s0.history.length).toBe(0);
  });
});

describe('getReplayLength', () => {
  it('returns the number of actions', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });
    expect(getReplayLength(replay)).toBe(replay.actions.length);
  });
});
