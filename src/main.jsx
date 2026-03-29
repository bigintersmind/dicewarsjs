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
  const soundManager = createSoundManager({ volume: 0.5 });

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
  }

  // Sync preferences → renderer (theme and color-blind mode)
  if (gameRenderer) {
    gameRenderer.setTheme(preferencesManager.get('theme'));
    gameRenderer.setColorBlindMode(preferencesManager.get('colorBlindMode'));

    preferencesManager.subscribe(prefs => {
      gameRenderer.setTheme(prefs.theme);
      gameRenderer.setColorBlindMode(prefs.colorBlindMode);
      // Sync body background for the HTML body element
      document.body.style.background = prefs.theme === 'light' ? '#e8e8f0' : '#1a1a2e';
    });
  }

  // Create the game controller
  const controller = createGameController(store, gameRenderer, soundManager);

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

  // Enable keyboard navigation
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
