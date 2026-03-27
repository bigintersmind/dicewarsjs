/**
 * Observable Game Store
 *
 * Lightweight pub/sub state container shared by the PixiJS renderer
 * and Preact UI.  The GameController pushes state here; subscribers
 * react to changes.
 *
 * @module store/GameStore
 */

/** @typedef {'title' | 'mapPreview' | 'playing' | 'gameOver'} Screen */
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
 * @property {number} aiSpeed
 * @property {boolean} soundEnabled
 * @property {Object} config
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
  aiSpeed: 1,
  soundEnabled: true,
  config: {
    playerCount: 7,
    aiAssignments: [
      null,
      'ai_defensive',
      'ai_defensive',
      'ai_adaptive',
      'ai_default',
      'ai_default',
      'ai_default',
      'ai_default',
    ],
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
        console.error('[GameStore] Subscriber threw (removing it):', err);
        listeners.delete(fn);
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
