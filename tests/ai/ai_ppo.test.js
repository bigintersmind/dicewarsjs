/**
 * PPO bot — the in-browser self-play RL net (ml-bot Phase 3).
 *
 * PPO reuses ai_bc's machinery (forward pass + encoder), so the numeric parity is
 * already covered by tests/ai/ppoForward.test.js. This file covers the wiring that
 * makes PPO *playable*: that it returns legal moves on a real BotState, that the
 * in-game aiConfig path reverse-adapts it so runAI drives it without throwing (the
 * "modern bot on the legacy path throws every turn" trap), and that its raw arena
 * registration actually runs its policy.
 */
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { GAME_PHASES } from '../../src/engine/constants.js';
import { runAI } from '../../src/engine/AIAdapter.js';
import { ai_ppo } from '../../src/ai/ai_ppo.js';
import { ai_bc } from '../../src/ai/ai_bc.js';
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

describe('ai_ppo bot', () => {
  it('returns a legal move or null, deterministically', () => {
    const state = firstStateWithMoves();
    const me = state.turnOrder[state.currentPlayerIndex];
    const botState = createBotState(state, me);

    const move = ai_ppo(botState);
    expect(ai_ppo(botState)).toEqual(move); // deterministic (argmax)

    if (move !== null) {
      const legal = new Set(getValidMoves(state).map(moveKey));
      expect(legal.has(moveKey(move))).toBe(true);
    }
  });

  it('plays its own PPO weights, not the BC clone', () => {
    /*
     * ai_ppo is a 2-line alias: makeBC({ policy: PPO_POLICY }). If that import were
     * fat-fingered to bcPolicyWeights, every OTHER test here would still pass — same
     * legal moves, same determinism, same arena wiring — silently shipping BC under
     * the "PPO" name. The PPO and BC nets were trained differently (RL self-play vs
     * imitating ai_lookahead), so their argmax edges diverge on many boards. Assert
     * they differ on at least one initial state — the seed-independent signal that
     * ai_ppo is backed by its OWN weights. (Empirically ~2/3 of initial states
     * diverge, so scanning a handful of seeds is not flaky.)
     */
    const choiceKey = m => (m === null ? 'STOP' : moveKey(m));
    let diverged = false;
    for (let seed = 1; seed <= 60 && !diverged; seed++) {
      const state = createGame({ seed, playerCount: 7 });
      if (getValidMoves(state).length === 0) continue;
      const me = state.turnOrder[state.currentPlayerIndex];
      const botState = createBotState(state, me);
      if (choiceKey(ai_ppo(botState)) !== choiceKey(ai_bc(botState))) diverged = true;
    }
    expect(diverged).toBe(true);
  });

  it('drives a full game as a seat without throwing', () => {
    let state = createGame({ seed: 7, playerCount: 7, recordHistory: false });
    for (let step = 0; step < 4000; step++) {
      // Engine game-over is `phase === GAME_OVER` (there is no `state.gameOver`
      // field); applyAction throws on a finished game. A strong enough seat-0 bot
      // conquers this unopposed board inside 4000 steps, so the guard must use the
      // real signal or the next END_TURN throws.
      if (state.phase === GAME_PHASES.GAME_OVER) break;
      const player = state.turnOrder[state.currentPlayerIndex];
      let move = null;
      if (player === 0) {
        move = ai_ppo(createBotState(state, player));
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

describe('PPO in the in-game AI loop (aiConfig)', () => {
  it('loads pre-adapted and drives runAI without hitting the legacy path', async () => {
    /*
     * Regression: a raw modern `(BotState) => move` bot dropped into aiConfig would
     * hit runAI's LEGACY branch — handed a mutable game view, not a BotState — and
     * throw every turn (the legacy-path trap). The loader must return an
     * `adaptModernBot`-tagged function so runAI takes the modern path (sanitize
     * engine state → BotState → call the bot).
     */
    const fn = await getAIImplementation('ai_ppo');
    expect(fn.__modernBot).toBe(true);

    const state = firstStateWithMoves();
    const move = runAI(state, fn); // must NOT throw; returns { from, to } | null

    if (move !== null) {
      const legal = new Set(getValidMoves(state).map(moveKey));
      expect(legal.has(moveKey(move))).toBe(true);
    }
  });
});

describe('PPO built-in arena registration', () => {
  it('actually plays in the arena (called with a BotState), no adapter errors', () => {
    const ppoEntry = BUILT_IN_BOTS.find(b => b.name === 'PPO');
    expect(ppoEntry).toBeDefined();

    /*
     * Cross-seed sum, mirroring the BC arena test: per-seat board trajectory is not
     * fully seeded (some opponents use unseeded Math.random), so on a single seed PPO
     * can legitimately make 0 attacks. ppoErrors === 0 is the seed-independent signal —
     * any error here means the modern bot is being mis-called (the adapter-mismatch bug).
     */
    const field = BUILT_IN_BOTS.map(b => ({ name: b.name, fn: b.fn }));
    let ppoErrors = 0;
    let ppoAttacks = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const res = runMatch({ bots: field, seed });
      const ppo = res.botStats.find(s => s.name === 'PPO');
      ppoErrors += ppo.errors;
      ppoAttacks += ppo.attacksMade;
    }
    expect(ppoErrors).toBe(0);
    expect(ppoAttacks).toBeGreaterThan(0);
  }, 30_000);
});
