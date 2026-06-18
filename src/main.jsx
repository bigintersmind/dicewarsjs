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

  // Wire canvas clicks to the controller
  if (canvas) {
    canvas.addEventListener('pointerdown', e => {
      if (!gameRenderer) return;
      const areaId = gameRenderer.hitTest(e.clientX, e.clientY);
      if (areaId > 0) {
        controller.handleTerritoryClick(areaId);
      }
    });
  }

  /*
   * Only show PixiJS canvas on screens that render the game board.
   * Update this list when adding new screens that need the canvas.
   */
  if (canvas) {
    const gameScreens = ['playing', 'gameOver', 'mapPreview', 'replay'];
    store.subscribe((state, prev) => {
      const shouldShow = gameScreens.includes(state.screen);
      canvas.style.display = shouldShow ? 'block' : 'none';
      // Canvas reports 0 dimensions while display:none; force PixiJS to recalculate on transition
      if (shouldShow && !gameScreens.includes(prev.screen)) {
        window.dispatchEvent(new Event('resize'));
      }
    });
  }

  // Enable keyboard navigation (return value has destroy() for cleanup, not needed in SPA)
  createKeyboardController(store, controller, gameRenderer);

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
