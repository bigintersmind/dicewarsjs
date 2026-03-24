import { render } from 'preact';
import { App } from './ui/App.jsx';
import { initRenderer } from './renderer/GameRenderer.js';

const canvas = document.getElementById('pixi-canvas');
if (canvas) {
  initRenderer(canvas).catch(err => {
    console.error('PixiJS renderer failed to initialize:', err);
  });
}

const appRoot = document.getElementById('app');
if (appRoot) {
  render(<App />, appRoot);
}
