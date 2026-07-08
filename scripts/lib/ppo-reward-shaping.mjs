/**
 * Per-step dense-reward measurement tracker for the persona roster ("bite G").
 *
 * The env-server emits two RAW per-step signals on the shaped obs-frame wire (see
 * `obs-frame.mjs`); the Python trainer applies the persona reward WEIGHTS
 * (`--territory-reward-coef`/`--elim-bounty`). This module owns the JS measurement so it
 * is unit-testable without a live socket/engine, and keeps the env-server loop thin.
 *
 * Two signals, both measured as the change since the learner's PREVIOUS decision frame
 * (Gym's `step(a)` returns the reward for the prior action, realized at the next obs):
 *
 *   - **deltaTerritory** (Expansionist): net change in the learner's owned-territory count.
 *     NET, not gross — a border tile captured then lost nets 0, defeating the ping-pong
 *     reward-hack PERSONAS §6 warns about. Read straight off the board each frame.
 *   - **elimsByLearner** (Predator): players the learner eliminated, ATTRIBUTED. Only the
 *     learner attacks on its own turn, so any player that becomes eliminated during a turn
 *     where `currentPlayerId === learnerSeat` was eliminated BY the learner. An opponent
 *     eliminating a third player is not credited. Tracked via the `onTurn` hook, which fires
 *     after every turn (incl. the game-ending one) with the post-turn state.
 *
 * Episode model: `reset()` at each episode start, `recordTurn(...)` from the match's `onTurn`,
 * and `frameSignals(...)` at every emitted frame (each obs decision AND the terminal). The
 * first `frameSignals` of an episode returns zeros (no preceding action/interval).
 *
 * @module scripts/lib/ppo-reward-shaping
 */

/**
 * @param {number} learnerSeat - the seat (player id) the learner occupies.
 * @returns {{
 *   reset: (initialState: {players: Array<{id:number, eliminated:boolean}>}) => void,
 *   recordTurn: (state: {players: Array<{id:number, eliminated:boolean}>}, currentPlayerId: number) => void,
 *   frameSignals: (currentTerritories: number) => {deltaTerritory: number, elimsByLearner: number},
 * }}
 */
export function createRewardShapingTracker(learnerSeat) {
  // Learner's owned-territory count at the last emitted frame (null before the first frame so
  // that frame's delta is 0 rather than a spurious jump from an assumed-0 baseline).
  let prevTerritories = null;
  // Cumulative learner-attributed eliminations this episode, and its value at the last frame.
  let killsTotal = 0;
  let prevKills = 0;
  // Players already known eliminated — so `recordTurn` credits each elimination exactly once.
  const eliminated = new Set();

  return {
    reset(initialState) {
      prevTerritories = null;
      killsTotal = 0;
      prevKills = 0;
      eliminated.clear();

      if (initialState?.players) {
        for (const player of initialState.players) {
          if (player.eliminated) {
            eliminated.add(player.id);
          }
        }
      }
    },

    /**
     * Fold one completed turn's eliminations into the running kill count. Call from the match's
     * `onTurn(turnCount, state, currentPlayerId)` hook. A player newly eliminated this turn is
     * credited to the learner iff the learner was the acting seat (the only attacker that turn).
     */
    recordTurn(state, currentPlayerId) {
      const byLearner = currentPlayerId === learnerSeat;
      for (const p of state.players) {
        if (p.eliminated && !eliminated.has(p.id)) {
          eliminated.add(p.id);
          if (byLearner) killsTotal += 1;
        }
      }
    },

    /**
     * The two raw signals for the frame being emitted NOW, then advance the cursors so the next
     * frame measures the next interval. First call of an episode returns zeros.
     */
    frameSignals(currentTerritories) {
      const deltaTerritory = prevTerritories === null ? 0 : currentTerritories - prevTerritories;
      const elimsByLearner = killsTotal - prevKills;
      prevTerritories = currentTerritories;
      prevKills = killsTotal;
      return { deltaTerritory, elimsByLearner };
    },
  };
}
