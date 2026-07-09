/**
 * Reward-shaping tracker (ml-bot "bite G", docs/ml-bot/PERSONAS.md §4) — the env-server's
 * per-step dense-signal measurement, unit-tested without a live socket/engine.
 *
 * Two signals, both measured as the change since the learner's PREVIOUS emitted frame:
 *   - deltaTerritory: net change in the learner's owned-territory count (Expansionist).
 *   - elimsByLearner: players eliminated DURING the learner's own turns (Predator), attributed
 *     because the learner is the only attacker on its turn.
 */

import { createRewardShapingTracker } from '../../scripts/lib/ppo-reward-shaping.mjs';

const LEARNER = 0;

/** A minimal engine-state stub: only `players[].{id,eliminated}` is read by recordTurn. */
function stateWith(eliminatedIds) {
  return {
    players: [0, 1, 2, 3].map(id => ({ id, eliminated: eliminatedIds.includes(id) })),
  };
}

describe('createRewardShapingTracker — territory delta', () => {
  it('first frame of an episode reports 0 (no preceding interval)', () => {
    const t = createRewardShapingTracker(LEARNER);
    expect(t.frameSignals(7)).toEqual({ deltaTerritory: 0, elimsByLearner: 0 });
  });

  it('reports the net change between consecutive frames (gains and losses)', () => {
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(7); // baseline
    expect(t.frameSignals(10).deltaTerritory).toBe(3); // +3
    expect(t.frameSignals(8).deltaTerritory).toBe(-2); // -2 (net loss is honest, not floored)
    expect(t.frameSignals(8).deltaTerritory).toBe(0); // unchanged
  });

  it('reset() clears the baseline so the next episode starts fresh', () => {
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(5);
    t.frameSignals(9);
    t.reset(stateWith([]));
    // First frame after reset is a fresh baseline → 0, not 9→2.
    expect(t.frameSignals(2)).toEqual({ deltaTerritory: 0, elimsByLearner: 0 });
  });
});

describe('createRewardShapingTracker — attributed eliminations', () => {
  it('does not credit players already eliminated at episode start', () => {
    const t = createRewardShapingTracker(LEARNER);

    // Player 2 starts the episode already eliminated.
    t.reset(stateWith([2]));

    // First emitted frame establishes the baseline.
    t.frameSignals(10);

    // Learner takes the first turn, but nobody new is eliminated.
    t.recordTurn(stateWith([2]), LEARNER);

    const signals = t.frameSignals(10);

    expect(signals.elimsByLearner).toBe(0);
  });

  it('credits a kill only when it happens during the learner’s own turn', () => {
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(10); // baseline frame

    // An opponent (seat 1) eliminates player 3 on ITS turn → NOT the learner's kill.
    t.recordTurn(stateWith([3]), /* currentPlayerId */ 1);
    expect(t.frameSignals(10).elimsByLearner).toBe(0);

    // The learner (seat 0) eliminates player 2 on its turn → credited at the next frame.
    t.recordTurn(stateWith([3, 2]), /* currentPlayerId */ LEARNER);
    expect(t.frameSignals(10).elimsByLearner).toBe(1);
  });

  it('counts multiple eliminations in one learner turn (capture chain)', () => {
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(10);
    // Two players newly eliminated during a single learner turn → bounty for both.
    t.recordTurn(stateWith([1, 2]), LEARNER);
    expect(t.frameSignals(10).elimsByLearner).toBe(2);
  });

  it('credits each elimination exactly once even if it persists across turns', () => {
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(10);
    t.recordTurn(stateWith([1]), LEARNER); // learner kills player 1
    expect(t.frameSignals(10).elimsByLearner).toBe(1);
    // Player 1 stays eliminated on later turns — must not be re-counted.
    t.recordTurn(stateWith([1]), 2);
    t.recordTurn(stateWith([1]), LEARNER);
    expect(t.frameSignals(10).elimsByLearner).toBe(0);
  });

  it('a kill on the learner’s final (game-ending) turn surfaces on the terminal frame', () => {
    // Models the env-server flow: recordTurn fires from onTurn for the game-ending learner turn,
    // BEFORE the terminal frame's frameSignals is read — so Predator's winning kill is paid.
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(8); // the learner's last decision frame
    t.recordTurn(stateWith([1, 2, 3]), LEARNER); // learner eliminates the last opponents → win
    const terminal = t.frameSignals(31); // terminal frame (learner now owns the board)
    expect(terminal.elimsByLearner).toBe(3);
    expect(terminal.deltaTerritory).toBe(23); // 31 - 8
  });

  it('reset() clears the kill count and the seen-eliminated set', () => {
    const t = createRewardShapingTracker(LEARNER);
    t.frameSignals(10);
    t.recordTurn(stateWith([1]), LEARNER);
    t.reset(stateWith([]));
    t.frameSignals(10);
    // Player 1 "eliminated" again in a new episode is a fresh kill, not a deduped no-op.
    t.recordTurn(stateWith([1]), LEARNER);
    expect(t.frameSignals(10).elimsByLearner).toBe(1);
  });
});
