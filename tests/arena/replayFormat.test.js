import {
  REPLAY_VERSION,
  SUPPORTED_REPLAY_VERSIONS,
  createReplay,
  createReplayFromState,
  serializeReplay,
  deserializeReplay,
  replayToState,
  getReplayLength,
} from '../../src/arena/replayFormat.js';
import { runMatch } from '../../src/arena/matchRunner.js';
import { adaptLegacyBot } from '../../src/arena/legacyBotAdapter.js';
import { ai_example } from '../../src/ai/ai_example.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { ACTION_TYPES } from '../../src/engine/constants.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

    expect(replay.version).toBe(REPLAY_VERSION);
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

  it('throws on valid base64 but malformed JSON', () => {
    const encoded = btoa('not json at all');
    expect(() => deserializeReplay(encoded)).toThrow(/malformed JSON/);
  });

  it('throws on wrong replay version', () => {
    const replay = { version: 99, config: {}, actions: [], metadata: {} };
    const encoded = btoa(JSON.stringify(replay));
    expect(() => deserializeReplay(encoded)).toThrow(/Unsupported replay version/);
  });

  it('throws on missing required fields', () => {
    const replay = { version: 1 };
    const encoded = btoa(JSON.stringify(replay));
    expect(() => deserializeReplay(encoded)).toThrow(/missing required fields/);
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

describe('createReplay (from MatchResult)', () => {
  const exampleBot = adaptLegacyBot(ai_example);

  it('creates a valid replay from a match result', () => {
    const result = runMatch({
      bots: [
        { name: 'bot1', fn: exampleBot },
        { name: 'bot2', fn: exampleBot },
      ],
      seed: 42,
      maxTurns: 20,
    });

    const replay = createReplay(result, ['bot1', 'bot2']);

    expect(replay.version).toBe(REPLAY_VERSION);
    expect(replay.config.seed).toBe(result.config.seed);
    expect(replay.config.playerCount).toBe(2);
    expect(replay.config.mapWidth).toBeDefined();
    expect(replay.config.mapHeight).toBeDefined();
    expect(Array.isArray(replay.actions)).toBe(true);
    expect(replay.actions.length).toBeGreaterThan(0);
    expect(replay.metadata.bots).toEqual(['bot1', 'bot2']);
    expect(replay.metadata.winner).toBe(result.winner);
  });

  it('throws when finalState is missing', () => {
    const fakeResult = {
      config: { seed: 1, playerCount: 2 },
      finalState: null,
      winner: null,
      turnCount: 0,
    };

    expect(() => createReplay(fakeResult, ['a', 'b'])).toThrow(/finalState/);
  });
});

describe('getReplayLength', () => {
  it('returns the number of actions', () => {
    const state = playTestGame();
    const replay = createReplayFromState(state, { bots: [] });
    expect(getReplayLength(replay)).toBe(replay.actions.length);
  });
});

describe('replay version + luck handicap (issue #179)', () => {
  /*
   * The one tripwire that spells the numbers out: everything else below derives
   * from these constants, so a bump is a deliberate edit here (plus the docblock
   * in replayFormat.js) rather than a silent sweep through the suite.
   */
  it('writes version 2 and reads versions 1 and 2', () => {
    expect(REPLAY_VERSION).toBe(2);
    expect([...SUPPORTED_REPLAY_VERSIONS]).toEqual([1, 2]);
  });

  it('carries handicap: null through the whitelist for an un-handicapped game', () => {
    const replay = createReplayFromState(playTestGame(), { bots: [] });
    expect(replay.config.handicap).toBeNull();
  });

  it('carries a handicap through the whitelist and the base64 round-trip', () => {
    const handicap = { playerId: 1, level: 2 };
    let state = createGame({ seed: 42, playerCount: 3, handicap });
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

    const replay = createReplayFromState(state, { bots: ['a', 'b', 'c'] });
    expect(replay.config.handicap).toEqual(handicap);

    const decoded = deserializeReplay(serializeReplay(replay));
    expect(decoded.version).toBe(REPLAY_VERSION);
    expect(decoded.config.handicap).toEqual(handicap);

    // ...and the rehydrated game actually rolls with the handicap again.
    const reconstructed = replayToState(decoded, decoded.actions.length);
    expect(reconstructed.config.handicap).toEqual(handicap);
    expect(reconstructed.rngState).toBe(state.rngState);
  });

  it('createReplay (from a MatchResult) records the finalState handicap', () => {
    const result = runMatch({
      bots: [
        { name: 'bot1', fn: adaptLegacyBot(ai_example) },
        { name: 'bot2', fn: adaptLegacyBot(ai_example) },
      ],
      seed: 42,
      maxTurns: 20,
    });
    expect(createReplay(result, ['bot1', 'bot2']).config.handicap).toBeNull();
  });

  it('accepts a version-1 payload and replays it as un-handicapped', () => {
    const v1 = {
      version: 1,
      config: {
        seed: 42,
        playerCount: 3,
        mapWidth: 28,
        mapHeight: 32,
        maxAreas: 32,
        dicePerArea: 3,
      },
      actions: [{ type: 'END_TURN' }],
      metadata: { bots: [], winner: null, turnCount: 0, timestamp: new Date().toISOString() },
    };

    const decoded = deserializeReplay(serializeReplay(v1));
    expect(decoded.version).toBe(1);
    expect(decoded.config.handicap).toBeUndefined();

    const state = replayToState(decoded, decoded.actions.length);
    expect(state.config.handicap).toBeNull();
  });

  it('replays a shipped v1 leaderboard replay end to end', () => {
    /*
     * public/data/replays/replay-*.json are the real v1 artifacts the online
     * leaderboard's replay viewer fetches — the backward-compatibility case the
     * REPLAY_VERSION bump must not break.
     */
    const path = fileURLToPath(new URL('../../public/data/replays/replay-1.json', import.meta.url));
    const shipped = JSON.parse(readFileSync(path, 'utf8'));
    expect(shipped.version).toBe(1);
    expect(shipped.config.handicap).toBeUndefined();

    const decoded = deserializeReplay(serializeReplay(shipped));
    expect(decoded.version).toBe(1);

    const initial = replayToState(decoded, 0);
    expect(initial.config.handicap).toBeNull();

    const final = replayToState(decoded, getReplayLength(decoded));
    expect(final.winner).toBe(decoded.metadata.winner);
  });

  it('rejects a version beyond the supported set', () => {
    const replay = {
      version: Math.max(...SUPPORTED_REPLAY_VERSIONS) + 1,
      config: {},
      actions: [],
      metadata: {},
    };
    expect(() => deserializeReplay(btoa(JSON.stringify(replay)))).toThrow(
      /Unsupported replay version/
    );
  });

  // The check is `includes`, so a stringified version fails it — and the message says so.
  it('names a string version as a string, not a number that would have passed', () => {
    const replay = { version: String(REPLAY_VERSION), config: {}, actions: [], metadata: {} };
    expect(() => deserializeReplay(btoa(JSON.stringify(replay)))).toThrow(
      new RegExp(`Unsupported replay version: "${REPLAY_VERSION}"`)
    );
  });
});
