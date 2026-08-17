/**
 * Title Attract Mode
 *
 * Plays a slow, fully-AI game on the PixiJS board behind the menu screens —
 * the modern take on the original title's pale background map. Purely
 * decorative: it owns a private engine state (never written to the GameStore)
 * and steps it on a timer, so it can't interfere with the GameController's
 * game flow. It runs only while `store.screen` is one of ATTRACT_SCREENS
 * (title plus the arena/tournament/leaderboard hub screens, which float their
 * chrome over the same scrimmed board) and the controller's own rendering
 * only happens on other screens, so the two never draw over each other. The
 * board persists across hops between attract screens — navigation doesn't
 * reset the background war.
 *
 * Deliberately uses only lightweight hand-written bots: importing a neural
 * persona here would pull its ~0.5 MB weight chunk into every page load,
 * defeating the code-splitting that keeps the title screen light (issue #51).
 *
 * @module controller/TitleAttractMode
 */

import {
  createGame,
  applyAction,
  getValidMoves,
  runAI,
  ACTION_TYPES,
  GAME_PHASES,
} from '../engine/index.js';
import { resolveMapSize } from '../utils/config.js';
import { AI_STRATEGIES } from '../ai/aiConfig.js';

/** Heuristic-only cast (see module note about persona weight chunks). */
export const ATTRACT_BOT_IDS = ['ai_default', 'ai_defensive', 'ai_adaptive', 'ai_strategist'];

/**
 * Screens that show the background game. main.jsx spreads this array into its
 * canvas-visibility list, so every attract screen automatically shows the
 * canvas — the mode must never step a board nobody can see. The mode rail's
 * NAV_TABS (ui/menuChrome.jsx) mirrors this list — the hub chrome (the rail,
 * or the title's footer row) belongs exactly where the live board runs behind
 * it (a test pins the two equal).
 */
export const ATTRACT_SCREENS = ['title', 'arena', 'tournament', 'onlineLeaderboard'];

/** Board shape for the background game. */
const ATTRACT_PLAYER_COUNT = 7;
const ATTRACT_MAP_SIZE = 'medium';

/** Delay after an attack — the visible "beat" of the background battle. */
export const ATTACK_STEP_MS = 700;
/** Delay after an end-turn (reinforcements pop); quicker so lulls stay short. */
export const END_TURN_STEP_MS = 250;
/** How long a finished board lingers before a fresh map is generated. */
export const ROUND_RESTART_MS = 6000;
/** Safety cap on actions per round; a stalled game gets a fresh board. */
const DEFAULT_MAX_ACTIONS = 1500;

/**
 * Create the attract-mode driver.
 *
 * @param {Object} deps
 * @param {Object} deps.store - GameStore (read-only: screen transitions)
 * @param {Object | null} deps.renderer - GameRenderer (may be null if WebGL failed)
 * @param {Object} [deps.preferencesManager] - For effectiveReducedMotion()
 * @param {number} [deps.maxActionsPerRound] - Test hook: cap actions per round
 * @param {() => Promise<Array<Function>>} [deps.botLoader] - Test hook: resolve
 *   the bot cast (defaults to loading ATTRACT_BOT_IDS from AI_STRATEGIES). Lets
 *   tests inject deterministic/throwing bots and control the load timing.
 * @returns {{ start: () => Promise<void>, stop: () => void, attach: () => void,
 *   destroy: () => void, isRunning: () => boolean }}
 */
export function createTitleAttractMode({
  store,
  renderer,
  preferencesManager,
  maxActionsPerRound = DEFAULT_MAX_ACTIONS,
  botLoader,
}) {
  let running = false;
  let token = 0; // invalidates async bot loading + pending ticks across stop()
  let timer = null;
  let state = null;
  let actionCount = 0;
  let botFns = null;
  let unsubscribeStore = null;
  let unsubscribePrefs = null;

  const reducedMotion = () =>
    Boolean(preferencesManager && preferencesManager.effectiveReducedMotion());

  async function loadBots() {
    if (botFns) return botFns;
    botFns = botLoader
      ? await botLoader()
      : await Promise.all(ATTRACT_BOT_IDS.map(id => AI_STRATEGIES[id].loader()));
    return botFns;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }

  function newRound() {
    state = createGame({ playerCount: ATTRACT_PLAYER_COUNT, ...resolveMapSize(ATTRACT_MAP_SIZE) });
    actionCount = 0;
    renderer.drawMap(state);
  }

  /** Advance the background game by one attack or end-turn. */
  function tick() {
    // Bail if the cast isn't loaded yet: an external schedule() (a visibility
    // or reduced-motion change) can fire a tick during start()'s async
    // loadBots() window, when `running` is already true but `botFns` is still
    // null. Dropping the tick is safe — start() reschedules once the load lands.
    if (!running || !botFns) return;
    if (!state) {
      // A finished round lingered; start a fresh board.
      try {
        newRound();
      } catch (err) {
        console.error('[TitleAttractMode] map generation failed:', err);
        stop();
        return;
      }
      schedule(ATTACK_STEP_MS);
      return;
    }

    const prevState = state;
    const currentPlayerId = state.turnOrder[state.currentPlayerIndex];
    const botFn = botFns[currentPlayerId % botFns.length];

    let move = null;
    try {
      move = runAI(state, botFn);
    } catch (err) {
      console.error('[TitleAttractMode] bot move failed:', err);
      move = null; // fall through to END_TURN
    }

    let delayMs = END_TURN_STEP_MS;
    try {
      const isValid =
        move && getValidMoves(state).some(m => m.from === move.from && m.to === move.to);
      if (isValid) {
        state = applyAction(state, { type: ACTION_TYPES.ATTACK, from: move.from, to: move.to });
        delayMs = ATTACK_STEP_MS;
      } else {
        // No move (or an invalid one) ends the bot's turn, like the real loop.
        state = applyAction(state, { type: ACTION_TYPES.END_TURN });
      }
    } catch (err) {
      console.error('[TitleAttractMode] action failed, regenerating board:', err);
      state = null;
      schedule(ROUND_RESTART_MS);
      return;
    }

    actionCount++;
    try {
      renderer.update(prevState, state);
    } catch (err) {
      // A render throw must not leave the loop dead-but-running: degrade like
      // the action path and roll a fresh board rather than freeze mid-round.
      console.error('[TitleAttractMode] render update failed, regenerating board:', err);
      state = null;
      schedule(ROUND_RESTART_MS);
      return;
    }

    if (state.phase === GAME_PHASES.GAME_OVER || actionCount >= maxActionsPerRound) {
      // Let the conquered (or stalled) board linger, then regenerate.
      state = null;
      schedule(ROUND_RESTART_MS);
      return;
    }
    schedule(delayMs);
  }

  /** Begin the background game. Safe to call when already running (no-op). */
  async function start() {
    if (running) return;
    if (!renderer || !renderer.initialized) return;
    running = true;
    const myToken = ++token;

    try {
      await loadBots();
    } catch (err) {
      console.error('[TitleAttractMode] failed to load bots:', err);
      running = false;
      return;
    }
    if (!running || myToken !== token) return; // stopped while loading

    try {
      newRound();
    } catch (err) {
      console.error('[TitleAttractMode] map generation failed:', err);
      running = false;
      return;
    }
    // Under reduced motion the freshly drawn board stays static — no stepping.
    if (!reducedMotion()) schedule(ATTACK_STEP_MS);
  }

  /** Halt stepping and drop the private game state. */
  function stop() {
    running = false;
    token++;
    clearTimeout(timer);
    timer = null;
    state = null;
  }

  function handleVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      clearTimeout(timer); // pause: no background CPU while tabbed away
    } else if (running && !reducedMotion()) {
      schedule(ATTACK_STEP_MS);
    }
  }

  /**
   * Wire lifecycle to the store: run exactly while an attract screen is up.
   * start() is a no-op when already running, so moving between attract
   * screens keeps the same board going rather than regenerating it. Also
   * honors live changes to the reduced-motion preference.
   */
  function attach() {
    if (unsubscribeStore) return;
    unsubscribeStore = store.subscribe((s, prev) => {
      if (s.screen === prev.screen) return;
      if (ATTRACT_SCREENS.includes(s.screen)) start();
      else stop();
    });
    if (preferencesManager) {
      unsubscribePrefs = preferencesManager.subscribe(() => {
        if (!running) return;
        if (reducedMotion()) clearTimeout(timer);
        else schedule(ATTACK_STEP_MS);
      });
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (ATTRACT_SCREENS.includes(store.getState().screen)) start();
  }

  function destroy() {
    stop();
    if (unsubscribeStore) unsubscribeStore();
    unsubscribeStore = null;
    if (unsubscribePrefs) unsubscribePrefs();
    unsubscribePrefs = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  }

  return { start, stop, attach, destroy, isRunning: () => running };
}
