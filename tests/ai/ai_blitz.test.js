/**
 * Blitz persona bot — the fast, aggressive self-play net (docs/ml-bot/PERSONAS.md).
 *
 * Numeric JS↔Python parity is covered by tests/ai/blitzForward.test.js. This file covers
 * the wiring that makes Blitz *playable*: legal moves on a real BotState, that it runs its
 * OWN fine-tuned weights (not the BC clone and not the ppo-long net it was warm-started
 * from), that its in-game aiConfig loader is `adaptModernBot`-tagged, and that its raw
 * arena registration runs its policy.
 */
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { GAME_PHASES } from '../../src/engine/constants.js';
import { ai_blitz } from '../../src/ai/ai_blitz.js';
import { ai_bc } from '../../src/ai/ai_bc.js';
import { ai_ppo } from '../../src/ai/ai_ppo.js';
import { getAIImplementation } from '../../src/ai/aiConfig.js';
import { createBotState } from '../../src/arena/botState.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { runMatch } from '../../src/arena/matchRunner.js';

const moveKey = m => `${m.from}->${m.to}`;
const choiceKey = m => (m === null ? 'STOP' : moveKey(m));

function firstStateWithMoves() {
  for (let seed = 1; seed <= 300; seed++) {
    const state = createGame({ seed, playerCount: 7 });
    if (getValidMoves(state).length > 0) return state;
  }
  throw new Error('no initial state with moves found in 300 seeds');
}

function fieldWith(persona) {
  const oppNames = ['Lookahead', 'Strategist', 'Expectimax', 'Defensive', 'Default', 'Example'];
  return [persona, ...BUILT_IN_BOTS.filter(b => oppNames.includes(b.name))].map(b => ({
    name: b.name,
    fn: b.fn,
  }));
}

describe('ai_blitz bot', () => {
  it('returns a legal move or null, deterministically', () => {
    const state = firstStateWithMoves();
    const me = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, me);

    const move = ai_blitz(botState);
    expect(ai_blitz(botState)).toEqual(move); // deterministic (argmax)

    if (move !== null) {
      const legal = new Set(getValidMoves(state).map(moveKey));
      expect(legal.has(moveKey(move))).toBe(true);
    }
  });

  it('plays its OWN fine-tuned weights, not the BC clone or the ppo-long net', () => {
    /*
     * Blitz is makeBC({ policy: BLITZ_POLICY }) over its own checkpoint. A fat-fingered
     * import to bcPolicyWeights OR ppoPolicyWeights would silently ship the wrong net under
     * the "Blitz" name and pass every other test here. Blitz was fine-tuned 3M steps off
     * ppo-long and imitates nothing, so its argmax diverges from both — assert it differs
     * from each on at least one initial state.
     */
    let divergedBc = false;
    let divergedPpo = false;
    for (let seed = 1; seed <= 150 && !(divergedBc && divergedPpo); seed++) {
      const state = createGame({ seed, playerCount: 7 });
      if (getValidMoves(state).length === 0) continue;
      const me = state.turnOrder[state.currentPlayerIndex];
      const botState = createBotState(state, me);
      const blitz = choiceKey(ai_blitz(botState));
      if (blitz !== choiceKey(ai_bc(botState))) divergedBc = true;
      if (blitz !== choiceKey(ai_ppo(botState))) divergedPpo = true;
    }
    expect(divergedBc).toBe(true);
    expect(divergedPpo).toBe(true);
  });

  it('drives a full game as a seat without throwing', () => {
    let state = createGame({ seed: 7, playerCount: 7, recordHistory: false });
    for (let step = 0; step < 4000; step++) {
      if (state.phase === GAME_PHASES.GAME_OVER) break;
      const player = state.turnOrder[state.currentPlayerIndex];
      let move = null;
      if (player === 0) {
        move = ai_blitz(createBotState(state, player));
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

describe('Blitz in the in-game AI loop (aiConfig)', () => {
  it('loads pre-adapted (its loader is distinct from the other personas)', async () => {
    const fn = await getAIImplementation('ai_blitz');
    expect(fn.__modernBot).toBe(true);
  });
});

describe('Blitz built-in arena registration', () => {
  it('actually plays in the arena (called with a BotState), no adapter errors', () => {
    const entry = BUILT_IN_BOTS.find(b => b.name === 'Blitz');
    expect(entry).toBeDefined();
    expect(entry.persona).toBe(true);

    const field = fieldWith(entry);
    let errors = 0;
    let attacks = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const res = runMatch({ bots: field, seed });
      const stat = res.botStats.find(s => s.name === 'Blitz');
      errors += stat.errors;
      attacks += stat.attacksMade;
    }
    expect(errors).toBe(0);
    expect(attacks).toBeGreaterThan(0);
  }, 30_000);
});
