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
import {
  BASE_WIDTH,
  BASE_HEIGHT,
  HUD_BAR_HEIGHT,
  HUD_BAR_HEIGHT_VAR,
} from '../../src/renderer/constants.js';

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
 * under 560px the bar goes to two rows so all eight seats fit (#222), and the
 * mounted GameHUD measures its own bar and publishes the result as
 * --dw-hud-bar-height on the document root. HUD_BAR_HEIGHT is the fallback
 * wherever no HUD is mounted — the title screen, a headless render, most of
 * this suite.
 *
 * The read is deliberately strict about units, because the value goes straight
 * into arithmetic: '5rem' is not 5 pixels and a calc() is not a number at all.
 * Anything non-empty that does not parse is a bug in the writer, so it warns —
 * once per renderer, the same idiom as the pre-init warnings above — rather
 * than silently running the board's bottom 30px under the bar (falling back to
 * 50 under an 80px bar reserves 30px too LITTLE, so the board is drawn that
 * much bigger and the bar covers the difference).
 */
describe('GameRenderer _resize() — the HUD bar reservation (#222)', () => {
  const setScreen = (renderer, width, height) => {
    renderer.app.screen = { width, height };
    renderer.app.resize = () => {};
  };
  const expectedScale = (width, height, bar) =>
    Math.min(width / BASE_WIDTH, Math.max(height - bar, 1) / BASE_HEIGHT);
  /** Where _resize() centers the board: inside the band the reservation leaves. */
  const expectedY = (width, height, bar) =>
    (Math.max(height - bar, 1) - BASE_HEIGHT * expectedScale(width, height, bar)) / 2;
  /** A renderer on a SHORT window, where the reservation is what decides the scale. */
  const shortWindow = async (declared, { width = 390, height = 400 } = {}) => {
    const renderer = new GameRenderer();
    await renderer.init(document.createElement('canvas'));
    if (declared !== null) document.documentElement.style.setProperty(HUD_BAR_HEIGHT_VAR, declared);
    setScreen(renderer, width, height);
    return renderer;
  };

  let warn;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    document.documentElement.style.removeProperty(HUD_BAR_HEIGHT_VAR);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /*
   * Measured on a SHORT window, where the board is height-bound and the
   * reservation is what decides the scale. On a phone in portrait the board is
   * width-bound with room to spare, so the difference only shows up here.
   */
  it('reserves the height the HUD published', async () => {
    // The two-row phone bar, as GameHUD measures it at a default font size.
    const renderer = await shortWindow('80px');

    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 400, 80));
    // ...and that is not what the constant alone would have given.
    expect(renderer.root.scale.x).not.toBeCloseTo(expectedScale(390, 400, HUD_BAR_HEIGHT));
    // The board is placed inside the band the reservation leaves, not inside
    // the window. Height-bound here, so that band is exactly the board and it
    // comes out flush at 0; the tall window below is where centering moves.
    expect(renderer.root.y).toBeCloseTo(expectedY(390, 400, 80));
    expect(warn).not.toHaveBeenCalled();
  });

  /*
   * ...and on a TALL window it is the centering that carries the reservation:
   * the board is width-bound there, so the scale is the same whatever the bar
   * costs and only `root.y` moves. That is the phone in portrait — the case
   * #222 is actually about — so both halves of the layout are pinned.
   */
  it('centers the board in the band the reservation leaves', async () => {
    const renderer = await shortWindow('80px', { height: 844 });

    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 844, 80));
    expect(renderer.root.y).toBeCloseTo(expectedY(390, 844, 80));
    // 15px lower than the fallback would have put it — half of the 30px the
    // reservation differs by, because the band is centered.
    expect(renderer.root.y).not.toBeCloseTo(expectedY(390, 844, HUD_BAR_HEIGHT));
    expect(warn).not.toHaveBeenCalled();
  });

  /*
   * Two shapes the px regex deliberately allows. Whitespace because
   * getPropertyValue hands back the declared text on some engines, padding and
   * all; a decimal because a bar measured against a fractional device-pixel
   * ratio is not a whole number. Neither is a writer bug, so neither warns.
   *
   * The padded form has to come from a stubbed getComputedStyle: jsdom trims
   * the value on the way in through setProperty, so declaring ' 80px ' would
   * quietly put the trimmed one under test.
   */
  it.each([
    ['surrounding whitespace', ' 80px ', 80],
    ['a fractional px length', '79.5px', 79.5],
  ])('accepts %s', async (_label, declared, bar) => {
    const renderer = await shortWindow(null);
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => declared }));

    renderer._resize();

    // Precision 6: 79.5 and 80 are only ~0.0006 apart in scale, and the point
    // of the row is that the decimal is read as itself.
    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 400, bar), 6);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to HUD_BAR_HEIGHT, quietly, when no HUD has published one', async () => {
    // The ordinary no-HUD case (the title screen), not an error: no warning.
    const renderer = await shortWindow('', { height: 844 });

    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 844, HUD_BAR_HEIGHT));
    expect(warn).not.toHaveBeenCalled();
  });

  /*
   * The unit-blind reads parseFloat used to let through. '5rem' came back as
   * the number 5 — a bar 75px shorter than the one on screen — and a calc()
   * came back NaN, which the old Number.isNaN guard turned into a silent
   * fallback. Both now fall back AND say so, once, naming the property.
   */
  it.each([
    ['a unit that is not px', '5rem'],
    ['an expression rather than a length', 'calc(80px + 0px)'],
    ['a keyword', 'auto'],
  ])('falls back and warns on %s', async (_label, declared) => {
    const renderer = await shortWindow(declared, { height: 844 });

    renderer._resize();
    renderer._resize();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 844, HUD_BAR_HEIGHT));
    // Once per renderer, however many resizes follow — a resize storm must not
    // become a console storm.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(HUD_BAR_HEIGHT_VAR);
    expect(warn.mock.calls[0][0]).toContain(declared);
  });

  /*
   * No DOM at all (a headless or SSR render): the guard has to come before the
   * read, and this is the ordinary case rather than a bug, so it is silent too.
   */
  it('falls back without throwing when there is no getComputedStyle', async () => {
    const renderer = await shortWindow('80px', { height: 844 });
    vi.stubGlobal('getComputedStyle', undefined);

    expect(() => renderer._resize()).not.toThrow();

    expect(renderer.root.scale.x).toBeCloseTo(expectedScale(390, 844, HUD_BAR_HEIGHT));
    expect(warn).not.toHaveBeenCalled();
  });
});
