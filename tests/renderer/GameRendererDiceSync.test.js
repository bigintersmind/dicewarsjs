// @vitest-environment jsdom
/**
 * Regression test for PR #19 — the dice display mode must reach the child
 * DiceRenderer at startup.
 *
 * `GameRenderer._diceDisplayMode` is the single source of truth, but the child
 * `DiceRenderer` carries its own constructor default (`'dice'`). When the
 * configured mode equals the value main.jsx pushes at startup, the equality
 * guard in `setDiceDisplayMode` short-circuits — so `init()` must seed the
 * child directly. Without that seeding a fresh install (default `'number'`)
 * kept rendering stacked dice because the child stayed on its own `'dice'`
 * default.
 *
 * Only the GPU-touching PixiJS surface (`Application`, `Container`) and the
 * unrelated child renderers are stubbed; the real `DiceRenderer` is exercised
 * so the desync this guards against is reproduced faithfully.
 */

import { GameRenderer } from '../../src/renderer/GameRenderer.js';
import { BASE_WIDTH, BASE_HEIGHT, HUD_BAR_HEIGHT } from '../../src/renderer/constants.js';

vi.mock('pixi.js', async importOriginal => {
  const actual = await importOriginal();
  class MockContainer {
    constructor() {
      // Record the applied scale so _resize()'s layout math can be asserted.
      this.scale = {
        x: 1,
        y: 1,
        set: s => {
          this.scale.x = s;
          this.scale.y = s;
        },
      };
      this.children = [];
      this.x = 0;
      this.y = 0;
    }

    addChild(child) {
      this.children.push(child);
      return child;
    }
  }
  return {
    ...actual,
    Container: MockContainer,
    Application: class MockApplication {
      constructor() {
        this.stage = { addChild: () => {} };
        this.screen = { width: 800, height: 600 };
        this.ticker = { add: () => {}, remove: () => {} };
      }

      async init() {}

      /* The ResizePlugin surface: _resize() forces it before reading screen dims. */
      resize() {}

      destroy() {}
    },
  };
});

vi.mock('../../src/renderer/HexGridRenderer.js', async () => {
  const { Container } = await import('pixi.js');
  return {
    HexGridRenderer: class {
      constructor() {
        this.container = new Container();
      }
    },
  };
});

vi.mock('../../src/renderer/BattleAnimation.js', () => ({
  createBattleAnimation: () => ({ play: () => {}, destroy: () => {} }),
}));

describe('GameRenderer init() dice-display sync', () => {
  it("seeds the child renderer with the default 'number' mode (regression for #19)", async () => {
    const renderer = new GameRenderer();
    expect(renderer._diceDisplayMode).toBe('number'); // constructor default

    await renderer.init(document.createElement('canvas'));

    /*
     * Before the fix the child kept its own 'dice' constructor default, so a
     * fresh install rendered stacked dice instead of number badges.
     */
    expect(renderer.dice._displayMode).toBe('number');
  });

  it('keeps the child in sync even when a later setDiceDisplayMode no-ops on the guard', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));

    /*
     * main.jsx pushes the stored/default mode at startup; when it equals the
     * GameRenderer default the equality guard short-circuits. The child must
     * already be correct from init().
     */
    renderer.setDiceDisplayMode('number');
    expect(renderer.dice._displayMode).toBe('number');
  });

  it('still propagates an explicit change that differs from the default', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));

    renderer.setDiceDisplayMode('dice');
    expect(renderer.dice._displayMode).toBe('dice');
  });
});

describe('GameRenderer _resize()', () => {
  it('forces app.resize() before reading screen dims (regression: stale title→game scale)', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));

    /*
     * The ResizePlugin applies a window resize on the next frame, so app.screen
     * still holds the OLD dims when _resize() runs on the 'resize' event. Model
     * that: screen reads stale until app.resize() (which _resize must force
     * first) refreshes it. If _resize() read app.screen without forcing the
     * resize, the scale below would reflect the stale 400×300.
     */
    renderer.app.screen = { width: 400, height: 300 };
    renderer.app.resize = () => {
      renderer.app.screen = { width: 1200, height: 900 };
    };

    renderer._resize();

    const expected = Math.min(1200 / BASE_WIDTH, (900 - HUD_BAR_HEIGHT) / BASE_HEIGHT);
    expect(renderer.root.scale.x).toBeCloseTo(expected);
  });
});
