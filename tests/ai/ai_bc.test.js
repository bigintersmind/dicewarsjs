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
import { ai_bc, makeBC } from '../../src/ai/ai_bc.js';
import { BC_POLICY } from '../../src/ai/bcPolicyWeights.js';
import { createBotState } from '../../src/arena/botState.js';
import { encodeObservationForInference } from '../../src/arena/encodeObservation.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { runMatch } from '../../src/arena/matchRunner.js';

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

describe('BC built-in arena registration', () => {
  it('actually plays in the arena (called with a BotState, not a GameState)', () => {
    /*
     * Regression: BC was registered as `adaptModernBot(ai_bc)`, whose wrapper expects a
     * GameState — but every BUILT_IN_BOTS consumer (CLI scripts, ArenaScreen,
     * TournamentScreen) runs bots via runMatch → runBotDirect, which calls `fn(botState)`.
     * So BC threw on every turn (0 attacks, all errors) and never ran its policy. It must
     * register raw, taking a BotState directly.
     */
    const bcEntry = BUILT_IN_BOTS.find(b => b.name === 'BC');
    expect(bcEntry).toBeDefined();

    /*
     * Sum across seeds on purpose — do NOT tighten this to a per-seed assertion. Three
     * opponents in the field (ai_default, ai_adaptive, ai_example) pick moves with unseeded
     * Math.random, so the engine seed fixes only the map/dice, not the board trajectory:
     * on any single seed BC can legitimately make 0 attacks (it over-predicts STOP). The
     * cross-seed sum is what keeps `bcAttacks > 0` non-flaky. (`bcErrors === 0` is
     * seed-independent — errors come only from the adapter mismatch, never legitimate play.)
     */
    const field = BUILT_IN_BOTS.map(b => ({ name: b.name, fn: b.fn }));
    let bcErrors = 0;
    let bcAttacks = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const res = runMatch({ bots: field, seed });
      const bc = res.botStats.find(s => s.name === 'BC');
      bcErrors += bc.errors;
      bcAttacks += bc.attacksMade;
    }
    expect(bcErrors).toBe(0); // the adapter-mismatch bug would make this == every BC turn
    expect(bcAttacks).toBeGreaterThan(0); // BC ran its policy and attacked at least once
  }, 30_000);
});

describe('makeBC stopBias hook', () => {
  it('makeBC() is the plain clone — identical to ai_bc', () => {
    const state = firstStateWithMoves();
    const botState = createBotState(state, state.turnOrder[state.currentPlayerIndex]);
    expect(makeBC()(botState)).toEqual(ai_bc(botState));
  });

  it('a large stopBias suppresses STOP (always attacks when an attack exists) and reports it', () => {
    const state = firstStateWithMoves(); // current player has >= 1 legal attack
    const botState = createBotState(state, state.turnOrder[state.currentPlayerIndex]);

    let lastStopped = null;
    const move = makeBC({ stopBias: 1e9, onDecision: stopped => (lastStopped = stopped) })(
      botState
    );

    expect(move).not.toBeNull(); // never ends the turn while an attack is on the board
    expect(lastStopped).toBe(false); // onDecision fires, reporting "did not STOP"
    const legal = new Set(getValidMoves(state).map(moveKey));
    expect(legal.has(moveKey(move))).toBe(true);
  });

  it('a large negative stopBias forces STOP even when an attack exists (pins sign + onDecision(true))', () => {
    const state = firstStateWithMoves(); // current player has >= 1 legal attack
    const botState = createBotState(state, state.turnOrder[state.currentPlayerIndex]);

    let lastStopped = null;
    const move = makeBC({ stopBias: -1e9, onDecision: stopped => (lastStopped = stopped) })(
      botState
    );

    /*
     * stopBias is *subtracted*, so a large negative bias adds +1e9 to the STOP logit →
     * argmax picks STOP despite a legal attack on the board. This is the converse of the
     * suppression test above: together they pin the subtraction's sign, and this one
     * exercises the onDecision(true) branch (the +1e9 suppression test only sees `false`).
     */
    expect(move).toBeNull();
    expect(lastStopped).toBe(true);
  });
});
