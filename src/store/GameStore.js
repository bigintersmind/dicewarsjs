/**
 * Observable Game Store
 *
 * Lightweight pub/sub state container.  The GameController pushes state
 * here; the Preact UI subscribes to changes via the useGameStore hook.
 * The renderer is updated imperatively by the controller.
 *
 * @module store/GameStore
 */

import { DIFFICULTY_MODES } from '../ai/difficultyModes.js';

/** @typedef {'title' | 'mapPreview' | 'playing' | 'gameOver' | 'arena' | 'tournament' | 'replay' | 'onlineLeaderboard'} Screen */
/** @typedef {'idle' | 'battle'} AnimationPhase */
/** @typedef {'selectFrom' | 'selectTo' | null} AwaitingInput */

/**
 * @typedef {Object} StoreState
 * @property {import('../engine/types.js').GameState | null} gameState
 * @property {Screen} screen
 * @property {number | null} selectedFrom
 * @property {number | null} selectedTo
 * @property {Object | null} battleResult
 * @property {AnimationPhase} animationPhase
 * @property {AwaitingInput} awaitingInput
 * @property {number | null} humanPlayerIndex
 * @property {boolean} humanEliminated
 * @property {'turnLimit' | null} gameOverReason - Why a game ended without a conqueror.
 *   'turnLimit' when the browser turn cap (GameController MAX_GAME_TURNS) drew a stalled
 *   AI-vs-AI board; null for a normal conquest win or a still-running game.
 * @property {boolean} quitConfirmOpen - True while the in-game "Abandon this
 *   game?" dialog is up (#181). Lives in the store rather than in component
 *   state because the controller layer reads it too: KeyboardController
 *   suspends board navigation and handleTerritoryClick ignores clicks while it
 *   is open.
 * @property {number} aiSpeed
 * @property {boolean} soundEnabled
 * @property {string | null} error
 * @property {string[]} aiLoadWarnings - Per-slot notices when a chosen bot
 *   failed to load and was replaced by the default AI (shown on map preview).
 * @property {Object} config
 * @property {Object | null} currentReplay
 */

const DEFAULT_STATE = {
  gameState: null,
  screen: 'title',
  selectedFrom: null,
  selectedTo: null,
  battleResult: null,
  animationPhase: 'idle',
  awaitingInput: null,
  humanPlayerIndex: 0,
  humanEliminated: false,
  gameOverReason: null,
  quitConfirmOpen: false,
  aiSpeed: 1,
  soundEnabled: true,
  error: null,
  aiLoadWarnings: [],
  currentReplay: null,
  replayOrigin: null,
  focusedAreaId: null,
  preferences: {
    theme: 'dark',
    colorBlindMode: false,
    diceDisplayMode: 'dice',
    animationSpeed: 1,
    reducedMotion: 'system',
  },
  config: {
    playerCount: 7,
    mapSize: 'medium',
    /*
     * Difficulty ladder (#167): the shipped default is Standard — original-game
     * parity, the classic ai_default in every AI seat. The #164 persona-led
     * lineup lives on as the Hard preset (src/ai/difficultyModes.js); 'custom'
     * means the player hand-picked slots on the title screen. Copied so store
     * updates never mutate the preset.
     */
    difficulty: 'standard',
    aiAssignments: [...DIFFICULTY_MODES.standard.lineup],
  },
};

/**
 * Create an observable game store.
 *
 * @param {Partial<StoreState>} [initialOverrides] - Override default values
 * @returns {{ getState, setState, subscribe, select }}
 */
export function createGameStore(initialOverrides) {
  let state = { ...DEFAULT_STATE, ...initialOverrides };
  const listeners = new Set();

  function getState() {
    return state;
  }

  /**
   * Shallow-merge partial updates and notify subscribers.
   * @param {Partial<StoreState>} partial
   */
  function setState(partial) {
    const prev = state;
    state = { ...state, ...partial };
    for (const fn of listeners) {
      try {
        fn(state, prev);
      } catch (err) {
        console.error('[GameStore] Subscriber threw:', err);
      }
    }
  }

  /**
   * Subscribe to state changes.
   * @param {(next: StoreState, prev: StoreState) => void} listener
   * @returns {() => void} unsubscribe function
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Read a derived value without subscribing.
   * @template T
   * @param {(s: StoreState) => T} selectorFn
   * @returns {T}
   */
  function select(selectorFn) {
    return selectorFn(state);
  }

  return { getState, setState, subscribe, select };
}
