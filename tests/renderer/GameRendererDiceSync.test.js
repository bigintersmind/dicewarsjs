// @vitest-environment jsdom
/**
 * Regression test for PR #19 — the dice display mode must reach the child
 * DiceRenderer at startup.
 *
 * `GameRenderer._diceDisplayMode` is the single source of truth, but the child
 * `DiceRenderer` carries its own constructor default (`'dice'`). When the
 * configured mode equals the value main.jsx pushes at startup, the equality
 * guard in `setDiceDisplayMode` short-circuits — so `init()` must seed the
 * child directly, or the child keeps its own default and the two fall out of
 * sync (the original #19 desync).
 *
 * Because the app default is now itself `'dice'` (it matches the child's own
 * constructor default), these tests deliberately apply the *divergent* mode
 * (`'number'`) before `init()`. Otherwise the child would read `'dice'` by
 * coincidence of its own default and a missing seed would go undetected.
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
  it('seeds the child from the pre-init mode, not the child default (regression for #19)', async () => {
    const renderer = new GameRenderer();

    /*
     * Apply a mode that diverges from the child DiceRenderer's own 'dice'
     * constructor default *before* the child exists. Pre-init, setDiceDisplayMode
     * only updates the field — it returns at the !initialized guard.
     */
    renderer.setDiceDisplayMode('number');
    expect(renderer._diceDisplayMode).toBe('number');

    await renderer.init(document.createElement('canvas'));

    /*
     * The child's own default is 'dice', so it can only read 'number' if init()
     * seeded it from GameRenderer._diceDisplayMode. Drop that seed and #19 regresses.
     */
    expect(renderer.dice._displayMode).toBe('number');
  });

  it('keeps the child in sync even when a later setDiceDisplayMode no-ops on the guard', async () => {
    const renderer = new GameRenderer();
    renderer.setDiceDisplayMode('number'); // diverge from the child's 'dice' default pre-init
    await renderer.init(document.createElement('canvas'));

    /*
     * A later push of the *same* mode short-circuits on the equality guard, so it
     * cannot fix the child — the child must already be correct from init()'s seed.
     * (This is the exact startup interaction #19 was filed for.)
     */
    renderer.setDiceDisplayMode('number');
    expect(renderer.dice._displayMode).toBe('number');
  });

  it('still propagates an explicit change that differs from the default', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));

    renderer.setDiceDisplayMode('number');
    expect(renderer.dice._displayMode).toBe('number');
  });
});

describe('GameRenderer init() completion flag', () => {
  // The start guard reads this flag — GameController.startNewGame refuses to
  // start on `!renderer.initialized` (#211 item 14), so it is a contract now.
  it('reports itself initialized once init() has succeeded', async () => {
    const renderer = new GameRenderer();
    expect(renderer.initialized).toBe(false);

    await renderer.init(document.createElement('canvas'));

    expect(renderer.initialized).toBe(true);
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

/*
 * How much room to leave under the board is the HUD's call, not a constant:
 * under 560px the bar goes to two rows so all eight seats fit (#222), and
 * GameHUD publishes the height it needs as --hud-bar-height. HUD_BAR_HEIGHT is
 * the declared default and the fallback wherever no HUD is mounted — the title
 * screen, a headless render, most of this suite.
 */
describe('GameRenderer _resize() — the HUD bar reservation (#222)', () => {
  const setScreen = (renderer, width, height) => {
    renderer.app.screen = { width, height };
    renderer.app.resize = () => {};
  };
  const expectedScale = (width, height, bar) =>
    Math.min(width / BASE_WIDTH, Math.max(height - bar, 1) / BASE_HEIGHT);

  afterEach(() => {
    document.documentElement.style.removeProperty('--hud-bar-height');
  });

  /*
   * Measured on a SHORT window, where the board is height-bound and the
   * reservation is what decides the scale. On a phone in portrait the board is
   * width-bound with room to spare, which is exactly why the stale-value gap
   * documented in _resize costs nothing there.
   */
  it('reserves the height the HUD declares', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));
    // The two-row phone bar, as GameHUD's media query declares it.
    document.documentElement.style.setProperty('--hud-bar-height', '80px');
    setScreen(renderer, 390, 400);

    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 400, 80));
    // ...and that is not what the constant alone would have given.
    expect(renderer.root.scale.x).not.toBeCloseTo(expectedScale(390, 400, HUD_BAR_HEIGHT));
  });

  it('falls back to HUD_BAR_HEIGHT when no HUD has declared one', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));
    setScreen(renderer, 390, 844);

    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 844, HUD_BAR_HEIGHT));
  });

  it('falls back rather than collapsing on a junk value', async () => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));
    document.documentElement.style.setProperty('--hud-bar-height', 'auto');
    setScreen(renderer, 390, 844);

    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 844, HUD_BAR_HEIGHT));
  });
});
