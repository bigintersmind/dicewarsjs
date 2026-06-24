/**
 * BC bot + inference encoder, against real engine game states.
 *
 * Covers the two halves the parity test (bcForward.test.js) doesn't: that the
 * label-free encoder reconstructs exactly `getValidMoves` + STOP from a BotState,
 * and that the bot returns a legal move (or null) deterministically and survives a
 * full game (including no-move turns → STOP).
 */
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { ai_bc } from '../../src/ai/ai_bc.js';
import { BC_POLICY } from '../../src/ai/bcPolicyWeights.js';
import { createBotState } from '../../src/arena/botState.js';
import { encodeObservationForInference } from '../../src/arena/encodeObservation.js';

const moveKey = m => `${m.from}->${m.to}`;

/** A real engine state whose current player has at least one legal attack. */
function firstStateWithMoves() {
  for (let seed = 1; seed <= 300; seed++) {
    const state = createGame({ seed, playerCount: 7 });
    if (getValidMoves(state).length > 0) return state;
  }
  throw new Error('no initial state with moves found in 300 seeds');
}

describe('encodeObservationForInference', () => {
  const state = firstStateWithMoves();
  const me = state.turnOrder[state.currentPlayerIndex];
  const botState = createBotState(state, me);
  const enc = encodeObservationForInference(botState, { maxAreas: BC_POLICY.config.maxAreas });

  it('produces tensors matching the model contract shapes', () => {
    expect(enc.nodes.length).toBe(BC_POLICY.config.maxAreas);
    expect(enc.nodes[0].length).toBe(BC_POLICY.config.nodeFeatures);
    expect(enc.players.length).toBe(botState.players.length);
    expect(enc.board.length).toBe(BC_POLICY.config.boardFeatures);
    expect(enc.edges[0].length).toBe(BC_POLICY.config.edgeFeatures);
    expect(enc.edges.length).toBe(enc.edgeIndex.length);
    expect(enc.edges.length).toBe(enc.moves.length);
  });

  it('reconstructs exactly getValidMoves + a trailing STOP', () => {
    expect(enc.moves[enc.moves.length - 1]).toBeNull(); // STOP
    expect(enc.edges[enc.edges.length - 1]).toEqual([0, 0, 0, 1]);
    expect(enc.edgeIndex[enc.edgeIndex.length - 1]).toEqual([0, 0]);

    const attacks = enc.moves.slice(0, -1);
    const legal = getValidMoves(state);
    expect(attacks.length).toBe(legal.length);
    expect(new Set(attacks.map(moveKey))).toEqual(new Set(legal.map(moveKey)));
  });
});

describe('ai_bc bot', () => {
  it('returns a legal move or null, deterministically', () => {
    const state = firstStateWithMoves();
    const me = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, me);

    const move = ai_bc(botState);
    expect(ai_bc(botState)).toEqual(move); // deterministic (argmax)

    if (move !== null) {
      const legal = new Set(getValidMoves(state).map(moveKey));
      expect(legal.has(moveKey(move))).toBe(true);
    }
  });

  it('returns null (STOP) when the player has no legal attack', () => {
    // A 2-player board where my single area has 1 die → no attack possible.
    const botState = {
      myPlayer: 0,
      turnNumber: 1,
      totalPlayers: 2,
      activePlayers: 2,
      gamePhase: 'early',
      myAreas: [{ id: 1, owner: 0, dice: 1, neighbors: [2], isBorder: true }],
      allAreas: [
        { id: 1, owner: 0, dice: 1, neighbors: [2], isBorder: true },
        { id: 2, owner: 1, dice: 3, neighbors: [1], isBorder: true },
      ],
      players: [
        {
          id: 0,
          territories: 1,
          totalDice: 1,
          connectedTerritories: 1,
          reinforcements: 0,
          eliminated: false,
        },
        {
          id: 1,
          territories: 1,
          totalDice: 3,
          connectedTerritories: 1,
          reinforcements: 0,
          eliminated: false,
        },
      ],
    };
    expect(ai_bc(botState)).toBeNull();
  });

  it('drives a full game as a seat without throwing', () => {
    /*
     * Manual loop: BC plays seat 0, everyone else ends their turn immediately, so
     * BC is exercised across many real boards (including no-move → STOP) end-to-end.
     */
    let state = createGame({ seed: 7, playerCount: 7, recordHistory: false });
    for (let step = 0; step < 4000; step++) {
      if (state.gameOver) break;
      const player = state.turnOrder[state.currentPlayerIndex];
      let move = null;
      if (player === 0) {
        move = ai_bc(createBotState(state, player));
      }
      if (move) {
        state = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
      } else {
        state = applyAction(state, { type: 'END_TURN' });
      }
    }
    expect(state).toBeDefined();
    /*
     * A full-game forward-pass drive runs ~10x slower under CI coverage (v8)
     * instrumentation, exceeding vitest's 5s default — hence the explicit timeout.
     */
  }, 30_000);
});
