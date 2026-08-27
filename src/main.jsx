/**
 * Application Entry Point
 *
 * Initializes PixiJS renderer, GameStore, GameController, and Preact UI.
 */

import { render } from 'preact';
import { App } from './ui/App.jsx';
import { GameRenderer } from './renderer/GameRenderer.js';
import { createGameStore } from './store/GameStore.js';
import { createGameController } from './controller/GameController.js';
import { createTitleAttractMode, ATTRACT_SCREENS } from './controller/TitleAttractMode.js';
import { createSoundManager } from './audio/SoundManager.js';
import { createPreferencesManager } from './store/PreferencesManager.js';
import { createKeyboardController } from './controller/KeyboardController.js';
import { applyThemeVars } from './ui/applyThemeVars.js';

async function main() {
  // Create the shared store
  const preferencesManager = createPreferencesManager();
  const store = createGameStore({
    preferences: preferencesManager.getAll(),
  });

  // Sync preferences → store
  preferencesManager.subscribe(prefs => {
    store.setState({ preferences: { ...prefs } });
  });

  // Initialize sound manager (loadAll deferred to first user interaction)
  const soundManager = createSoundManager({
    volume: 0.5,
    enabled: !preferencesManager.get('muted'),
  });

  // Sync muted preference → sound manager
  preferencesManager.subscribe(prefs => {
    soundManager.setEnabled(!prefs.muted);
  });

  /*
   * Apply the DOM theme as CSS variables (+ page background) up front and on
   * every change. Done independently of the renderer so the UI overlay stays
   * themed even if WebGL initialization fails, and so the saved theme is
   * honored on first paint rather than only after the first toggle.
   */
  applyThemeVars(preferencesManager.get('theme'));
  preferencesManager.subscribe(prefs => applyThemeVars(prefs.theme));

  // Initialize PixiJS renderer
  let gameRenderer = null;
  const canvas = document.getElementById('pixi-canvas');
  if (canvas) {
    try {
      gameRenderer = new GameRenderer();
      await gameRenderer.init(canvas);
    } catch (err) {
      console.error('PixiJS renderer failed to initialize:', err);
      store.setState({
        error: 'Graphics failed to initialize. Your browser may not support WebGL.',
      });
    }
  } else {
    console.error('[DiceWars] Canvas element #pixi-canvas not found in DOM');
    store.setState({
      error: 'Game canvas not found. Please refresh the page.',
    });
  }

  // Sync preferences → renderer (theme and color-blind mode)
  if (gameRenderer) {
    gameRenderer.setTheme(preferencesManager.get('theme'));
    gameRenderer.setColorBlindMode(preferencesManager.get('colorBlindMode'));
    gameRenderer.setDiceDisplayMode(preferencesManager.get('diceDisplayMode'));

    preferencesManager.subscribe(prefs => {
      gameRenderer.setTheme(prefs.theme);
      gameRenderer.setColorBlindMode(prefs.colorBlindMode);
      gameRenderer.setDiceDisplayMode(prefs.diceDisplayMode);
    });
  }

  // Create the game controller
  const controller = createGameController(store, gameRenderer, soundManager, preferencesManager);

  /*
   * Board hints are gated on a preference, so toggling it mid-game has to reach
   * the board immediately — the controller only recomputes at its own game-loop
   * seams, none of which a settings click passes through. Gated on the key
   * actually changing, since every theme/sound/speed click notifies here too.
   * The refresh is idempotent, so calling it at any moment is safe.
   */
  let lastBoardHints = preferencesManager.get('boardHints');
  preferencesManager.subscribe(prefs => {
    if (prefs.boardHints === lastBoardHints) return;
    lastBoardHints = prefs.boardHints;
    controller.refreshCandidateHighlights();
  });

  /*
   * Background AI game behind the title and bot-hub screens (ATTRACT_SCREENS).
   * Owns a private engine state (never touches store.gameState) and runs only
   * on those screens, so it can't fight the controller for the renderer.
   */
  createTitleAttractMode({ store, renderer: gameRenderer, preferencesManager }).attach();

  /*
   * Enable keyboard navigation (the returned destroy() is for cleanup, not
   * needed in an SPA). Created before the canvas listener below, which asks it
   * to keep the keyboard's position on a clicked territory.
   */
  const keyboard = createKeyboardController(store, controller, gameRenderer);

  // Wire canvas clicks to the controller
  if (canvas) {
    canvas.addEventListener('pointerdown', e => {
      if (!gameRenderer) return;
      const areaId = gameRenderer.hitTest(e.clientX, e.clientY);
      if (areaId > 0) {
        /*
         * Carry the keyboard's position to the clicked territory (#211). Taken
         * only when the board already held DOM focus — focusFromPointer says so
         * by returning true — so a mouse-only player never acquires a focus ring
         * by clicking. preventDefault() on the pointerdown suppresses the
         * compatibility mousedown, and with it the browser's focus fixup, which
         * would otherwise have blurred the button we just focused to `<body>`;
         * the `click` still fires and nothing on the canvas listens for it.
         *
         * A click on WATER (areaId === 0) is left to the default even with a
         * territory focused: focus drops to `<body>` and the ring comes down,
         * because a click on nothing is as good a way as any to say "done with
         * the keyboard position".
         *
         * The primary button only (`button === 0`, which is also what touch and
         * pen report): the cursor follows a click because a click is the player
         * pointing, and a right- or middle-click is not that. (A preventDefault()
         * on a secondary pointerdown would not have stopped the context menu
         * anyway — that is the `contextmenu` event's to cancel — it would only
         * have suppressed a default nobody asked about.) Note the CLICK below has
         * never been filtered by button — a right-click plays the move — but that
         * is its own question and this line does not settle it.
         */
        if (e.button === 0 && keyboard.focusFromPointer(areaId)) e.preventDefault();
        controller.handleTerritoryClick(areaId);
      }
    });
  }

  /*
   * Only show PixiJS canvas on screens that render the game board.
   * Update this list when adding new screens that need the canvas.
   * ATTRACT_SCREENS (title + the bot-hub screens) show the board too: the
   * attract-mode background game runs behind their scrimmed chrome.
   */
  if (canvas) {
    const gameScreens = [...ATTRACT_SCREENS, 'playing', 'gameOver', 'mapPreview', 'replay'];
    store.subscribe((state, prev) => {
      const shouldShow = gameScreens.includes(state.screen);
      canvas.style.display = shouldShow ? 'block' : 'none';
      // Canvas reports 0 dimensions while display:none; force PixiJS to recalculate on transition
      if (shouldShow && !gameScreens.includes(prev.screen)) {
        window.dispatchEvent(new Event('resize'));
      }
    });
  }

  // Mount Preact UI
  const appRoot = document.getElementById('app');
  if (appRoot) {
    render(
      <App store={store} controller={controller} preferencesManager={preferencesManager} />,
      appRoot
    );
  }
}

main().catch(err => {
  console.error('[DiceWars] Fatal initialization error:', err);
  const appRoot = document.getElementById('app');
  if (appRoot) {
    appRoot.style.pointerEvents = 'auto';
    appRoot.innerHTML =
      '<div style="color:#e94560;padding:2rem;font-family:sans-serif;text-align:center;">' +
      '<h1>Failed to start DiceWars</h1>' +
      '<p>Please refresh the page. Check the browser console for details.</p>' +
      '</div>';
  }
});
