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

async function main() {
  // Create the shared store
  const store = createGameStore();

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

  // Mount Preact UI
  const appRoot = document.getElementById('app');
  if (appRoot) {
    render(<App store={store} controller={controller} />, appRoot);
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
