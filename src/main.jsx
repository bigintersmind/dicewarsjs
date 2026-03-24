import { render } from 'preact';
import { App } from './ui/App.jsx';
import { initRenderer } from './renderer/GameRenderer.js';

const canvas = document.getElementById('pixi-canvas');
initRenderer(canvas);

render(<App />, document.getElementById('app'));
