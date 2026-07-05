/**
 * Conqueror persona bot — the balanced, win-maximizing self-play net (the player-facing
 * flagship). Conqueror ships the [D-31] encoding-v3 net (`ppo-v3-scratch`) in its own
 * weights file, so its numeric parity is covered by tests/ai/conquerorForward.test.js.
 * This file covers the wiring that makes Conqueror *playable*: legal moves on a real
 * BotState, that it runs the intended weights (not another net's), that the in-game
 * aiConfig path reverse-adapts it so runAI drives it without throwing (the "modern bot
 * on the legacy path throws every turn" trap), and that its raw arena registration runs
 * its policy.
 */
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { GAME_PHASES } from '../../src/engine/constants.js';
import { runAI } from '../../src/engine/AIAdapter.js';
import { ai_conqueror } from '../../src/ai/ai_conqueror.js';
import { ai_bc, makeBC } from '../../src/ai/ai_bc.js';
import { ai_ppo } from '../../src/ai/ai_ppo.js';
import { BC_POLICY as CONQUEROR_POLICY } from '../../src/ai/conquerorPolicyWeights.js';
import { getAIImplementation } from '../../src/ai/aiConfig.js';
import { createBotState } from '../../src/arena/botState.js';
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

/** A compact opponent field (persona + 6 heuristics) — proves arena wiring without a 12-seat match. */
function fieldWith(persona) {
  const oppNames = ['Lookahead', 'Strategist', 'Expectimax', 'Defensive', 'Default', 'Example'];
  return [persona, ...BUILT_IN_BOTS.filter(b => oppNames.includes(b.name))].map(b => ({
    name: b.name,
    fn: b.fn,
  }));
}

describe('ai_conqueror bot', () => {
  it('returns a legal move or null, deterministically', () => {
    const state = firstStateWithMoves();
    const me = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, me);

    const move = ai_conqueror(botState);
    expect(ai_conqueror(botState)).toEqual(move); // deterministic (argmax)

    if (move !== null) {
      const legal = new Set(getValidMoves(state).map(moveKey));
      expect(legal.has(moveKey(move))).toBe(true);
    }
  });

  it('plays a neural policy, not the BC clone', () => {
    /*
     * Conqueror is makeBC({ policy: CONQUEROR_POLICY }) over the encoding-v3 weights. If
     * that import were fat-fingered to bcPolicyWeights, every other test here would still
     * pass — silently shipping the BC clone under the "Conqueror" name. The v3 and BC nets
     * diverge on many boards, so assert they differ on at least one initial state.
     */
    const choiceKey = m => (m === null ? 'STOP' : moveKey(m));
    let diverged = false;
    for (let seed = 1; seed <= 60 && !diverged; seed++) {
      const state = createGame({ seed, playerCount: 7 });
      if (getValidMoves(state).length === 0) continue;
      const me = state.turnOrder[state.currentPlayerIndex];
      const botState = createBotState(state, me);
      if (choiceKey(ai_conqueror(botState)) !== choiceKey(ai_bc(botState))) diverged = true;
    }
    expect(diverged).toBe(true);
  });

  it('IS the encoding-v3 net — matches its own weights file move-for-move ([D-31] §5)', () => {
    /*
     * The not-BC divergence test above only rules out a fat-finger to bcPolicyWeights;
     * a slip to ppo/blitz/survivorPolicyWeights would produce a *different* net that
     * still diverges from BC, silently shipping the wrong weights under the flagship
     * "Conqueror" name. Pin the identity positively: a policy built here directly from
     * conquerorPolicyWeights.js must match ai_conqueror move-for-move. (The weights file
     * itself is pinned to the Python reference by conquerorForward.test.js, so together
     * these anchor the bot to the exact gated checkpoint.)
     */
    expect(CONQUEROR_POLICY.encodingVersion).toBe(3);
    const reference = makeBC({ policy: CONQUEROR_POLICY });
    const choiceKey = m => (m === null ? 'STOP' : moveKey(m));
    for (let seed = 1; seed <= 60; seed++) {
      const state = createGame({ seed, playerCount: 7 });
      if (getValidMoves(state).length === 0) continue;
      const me = state.turnOrder[state.currentPlayerIndex];
      const botState = createBotState(state, me);
      expect(choiceKey(ai_conqueror(botState))).toBe(choiceKey(reference(botState)));
    }
  });

  it('is NOT the ppo-long alias anymore — diverges from ai_ppo ([D-31] §5)', () => {
    /*
     * Until 2026-07-05 Conqueror aliased ppoPolicyWeights.js, and this suite asserted
     * move-for-move identity with ai_ppo. The v3 ship inverts that contract: ai_ppo
     * keeps the frozen v2 ppo-long weights as the gate baseline while Conqueror ships
     * the v3 net — a regression to the old shared import would make them identical
     * again, so assert they diverge on at least one initial state.
     */
    const choiceKey = m => (m === null ? 'STOP' : moveKey(m));
    let diverged = false;
    for (let seed = 1; seed <= 60 && !diverged; seed++) {
      const state = createGame({ seed, playerCount: 7 });
      if (getValidMoves(state).length === 0) continue;
      const me = state.turnOrder[state.currentPlayerIndex];
      const botState = createBotState(state, me);
      if (choiceKey(ai_conqueror(botState)) !== choiceKey(ai_ppo(botState))) diverged = true;
    }
    expect(diverged).toBe(true);
  });

  it('drives a full game as a seat without throwing', () => {
    let state = createGame({ seed: 7, playerCount: 7, recordHistory: false });
    for (let step = 0; step < 4000; step++) {
      if (state.phase === GAME_PHASES.GAME_OVER) break;
      const player = state.turnOrder[state.currentPlayerIndex];
      let move = null;
      if (player === 0) {
        move = ai_conqueror(createBotState(state, player));
      }
      if (move) {
        state = applyAction(state, { type: 'ATTACK', from: move.from, to: move.to });
      } else {
        state = applyAction(state, { type: 'END_TURN' });
      }
    }
    expect(state).toBeDefined();
  }, 30_000);
});

describe('Conqueror in the in-game AI loop (aiConfig)', () => {
  it('loads pre-adapted and drives runAI without hitting the legacy path', async () => {
    /*
     * Regression: a raw modern `(BotState) => move` bot dropped into aiConfig would hit
     * runAI's LEGACY branch — handed a mutable game view, not a BotState — and throw every
     * turn (the legacy-path trap). The loader must return an `adaptModernBot`-tagged
     * function so runAI takes the modern path (sanitize engine state → BotState → call it).
     * This guards the shared persona loader pattern for all three personas.
     */
    const fn = await getAIImplementation('ai_conqueror');
    expect(fn.__modernBot).toBe(true);

    const state = firstStateWithMoves();
    const move = runAI(state, fn); // must NOT throw; returns { from, to } | null

    if (move !== null) {
      const legal = new Set(getValidMoves(state).map(moveKey));
      expect(legal.has(moveKey(move))).toBe(true);
    }
  });
});

describe('Conqueror built-in arena registration', () => {
  it('actually plays in the arena (called with a BotState), no adapter errors', () => {
    const entry = BUILT_IN_BOTS.find(b => b.name === 'Conqueror');
    expect(entry).toBeDefined();
    expect(entry.persona).toBe(true);

    /*
     * Cross-seed sum: per-seat board trajectory is not fully seeded (some opponents use
     * unseeded Math.random), so on a single seed the persona can legitimately make 0
     * attacks. errors === 0 is the seed-independent signal — any error means the modern
     * bot is being mis-called (the adapter-mismatch bug).
     */
    const field = fieldWith(entry);
    let errors = 0;
    let attacks = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const res = runMatch({ bots: field, seed });
      const stat = res.botStats.find(s => s.name === 'Conqueror');
      errors += stat.errors;
      attacks += stat.attacksMade;
    }
    expect(errors).toBe(0);
    expect(attacks).toBeGreaterThan(0);
  }, 30_000);
});
