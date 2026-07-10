/**
 * Observable Game Store
 *
 * Lightweight pub/sub state container.  The GameController pushes state
 * here; the Preact UI subscribes to changes via the useGameStore hook.
 * The renderer is updated imperatively by the controller.
 *
 * @module store/GameStore
 */

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
     * Default battle lineup, strongest first (#164): the human faces the three
     * self-play personas plus the strongest heuristics. At the default 7 players
     * slots 1-6 are used; choosing 8 players adds Default (the classic original-game
     * AI) — the full player-visible roster.
     */
    aiAssignments: [
      null,
      'ai_conqueror',
      'ai_blitz',
      'ai_survivor',
      'ai_lookahead',
      'ai_strategist',
      'ai_adaptive',
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
