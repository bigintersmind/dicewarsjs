/**
 * Shared fixture builder: a REAL Daily Conquest replay, produced by driving the
 * real `GameController` (real engine, real `ai_default` opponents) to the end of
 * a game, exactly as a browser would.
 *
 * Both server suites verify against this rather than a hand-written replay,
 * because the whole point of `verifyDailyReplay` is that it agrees with the
 * client bit for bit. A synthetic replay could agree with the verifier and
 * disagree with the game.
 *
 * The controller is headless here: a stub renderer whose battle animation
 * resolves immediately, reduced motion forced on (so celebrations and
 * reinforcement animations are skipped), and vitest fake timers to collapse the
 * 100 ms between turns.
 */

import { createGameController } from '../../src/controller/GameController.js';
import { createGameStore } from '../../src/store/GameStore.js';
import { getValidMoves } from '../../src/engine/StateManager.js';
import { GAME_PHASES } from '../../src/engine/constants.js';

/** Minimal `Storage` so `dailyRecords` works under the plain node environment. */
function installLocalStorage() {
  const map = new Map();
  const storage = {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    clear: () => map.clear(),
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  };
}

/** A renderer that satisfies every call the controller makes and animates nothing. */
function stubRenderer() {
  return {
    initialized: true,
    drawMap: () => {},
    update: () => {},
    getPlayerColor: () => 0,
    playParticleEffect: () => {},
    screenShake: () => {},
    playCelebration: async () => {},
    animateReinforcements: async () => {},
    hexGrid: {
      clearFocusHighlight: () => {},
      clearHighlights: () => {},
      clearSelectionHighlights: () => {},
      setCandidateHighlights: () => {},
      clearCandidateHighlights: () => {},
      setHighlight: () => {},
    },
    battle: { play: async () => {}, cancel: () => {} },
  };
}

/**
 * A deterministic human: attack whenever some move clears `margin` dice of
 * advantage, always taking the biggest edge on the board; otherwise end the
 * turn. Ties break on the lowest `from`, then `to`, so a given date and margin
 * always produce byte-identical play — which is what makes these usable as
 * fixtures at all.
 *
 * Different margins are different *players*, not different boards: raising it
 * yields a slower, more cautious game on the same seed, which is how the
 * leaderboard suite gets two winning submissions to rank against each other.
 *
 * @param {number} margin - Minimum `attackerDice - defenderDice` worth attacking
 */
export function marginHuman(margin) {
  return state => {
    const moves = getValidMoves(state).filter(m => m.attackerDice - m.defenderDice >= margin);
    if (moves.length === 0) return null;
    return moves.reduce((best, m) => {
      const gain = m.attackerDice - m.defenderDice;
      const bestGain = best.attackerDice - best.defenderDice;
      if (gain !== bestGain) return gain > bestGain ? m : best;
      if (m.from !== best.from) return m.from < best.from ? m : best;
      return m.to < best.to ? m : best;
    });
  };
}

/** Attack on any real advantage. */
export const greedyHuman = marginHuman(1);

/** Attack only on a commanding advantage — the same board, played slower. */
export const cautiousHuman = marginHuman(2);

/** Attack only when it is nearly free — usually loses. */
export const timidHuman = marginHuman(3);

/** Never attacks. */
export function passiveHuman() {
  return null;
}

/**
 * Play one daily game end to end and return everything a test needs to check
 * the verifier against the client.
 *
 * @param {Object} options
 * @param {string} options.date - Board date, `YYYY-MM-DD`
 * @param {(state: Object) => ({from: number, to: number}|null)} [options.human]
 * @param {boolean} [options.spectateToEnd=false] - After an elimination, watch
 *   the bots finish (which is what makes the browser build a replay at all for
 *   a lost game).
 * @param {number} [options.maxSteps=4000] - Drive-loop safety bound
 * @returns {Promise<{replay: Object, journal: Object, store: Object, screen: string,
 *   humanEliminated: boolean, gameOverReason: string|null, finalState: Object}>}
 */
export async function playDailyGame({
  date,
  human = greedyHuman,
  spectateToEnd = false,
  maxSteps = 4000,
}) {
  const restoreStorage = installLocalStorage();
  vi.useFakeTimers();
  try {
    const store = createGameStore({ preferences: { reducedMotion: 'on', boardHints: 'off' } });
    const controller = createGameController(store, stubRenderer(), null);

    await controller.startDailyGame(date);
    controller.acceptMap();

    let spectated = false;
    for (let step = 0; step < maxSteps; step++) {
      const snapshot = store.getState();
      if (snapshot.screen !== 'playing') {
        const canSpectate =
          spectateToEnd &&
          !spectated &&
          snapshot.humanEliminated &&
          snapshot.gameState?.phase !== GAME_PHASES.GAME_OVER;
        if (!canSpectate) break;
        spectated = true;
        await controller.startSpectate();
        continue;
      }
      if (
        snapshot.awaitingInput === 'selectFrom' &&
        snapshot.gameState.turnOrder[snapshot.gameState.currentPlayerIndex] ===
          snapshot.humanPlayerIndex
      ) {
        const move = human(snapshot.gameState);
        if (move) {
          controller.handleTerritoryClick(move.from);
          controller.handleTerritoryClick(move.to);
        } else {
          controller.endHumanTurn();
        }
      }
      await vi.advanceTimersByTimeAsync(200);
    }

    const finished = store.getState();
    return {
      replay: finished.currentReplay,
      journal: finished.matchJournal,
      screen: finished.screen,
      humanEliminated: finished.humanEliminated,
      gameOverReason: finished.gameOverReason,
      finalState: finished.gameState,
    };
  } finally {
    vi.useRealTimers();
    restoreStorage();
  }
}
