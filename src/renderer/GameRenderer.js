import { Application, Graphics } from 'pixi.js';

let app = null;

export async function initRenderer(canvas) {
  app = new Application();
  await app.init({
    canvas,
    resizeTo: window,
    backgroundColor: 0x1a1a2e,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  // Proof of life: draw a colored rectangle in the center
  const rect = new Graphics();
  rect.rect(window.innerWidth / 2 - 100, window.innerHeight / 2 - 100, 200, 200);
  rect.fill(0x16213e);
  rect.stroke({ width: 2, color: 0xe94560 });
  app.stage.addChild(rect);

  return app;
}

export function getApp() {
  return app;
}
