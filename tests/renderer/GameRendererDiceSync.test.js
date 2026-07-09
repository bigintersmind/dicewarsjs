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

vi.mock('pixi.js', async importOriginal => {
  const actual = await importOriginal();
  class MockContainer {
    constructor() {
      this.children = [];
      this.scale = { set: () => {} };
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
