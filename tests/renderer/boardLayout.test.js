// @vitest-environment jsdom
/**
 * The board's responsive layout, and the two bands the chrome reserves.
 *
 * `computeBoardLayout` is the whole of it: fit the fixed base canvas into the
 * window minus a reservation at each end, and center it in what is left. The
 * bottom band is the HUD bar (#222); the top one is the supply panel, added
 * with Daily Conquest — without it a Large map on a short window is height-
 * bound, scaled to the FULL window, and its top rows are drawn underneath the
 * panel that is sitting on them.
 *
 * Pure math; the GameRenderer half (reading the published custom properties,
 * and falling back when they are absent) is in GameRendererDiceSync.test.js.
 */

import { computeBoardLayout, GameRenderer } from '../../src/renderer/GameRenderer.js';
import {
  BASE_WIDTH,
  BASE_HEIGHT,
  HUD_BAR_HEIGHT,
  HUD_BAR_HEIGHT_VAR,
  SUPPLY_PANEL_HEIGHT_VAR,
} from '../../src/renderer/constants.js';

vi.mock('pixi.js', async importOriginal => {
  const actual = await importOriginal();
  class MockContainer {
    constructor() {
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

    removeChild() {}
    destroy() {}
  }
  class MockApplication {
    constructor() {
      this.stage = new MockContainer();
      this.screen = { width: BASE_WIDTH, height: BASE_HEIGHT };
      this.canvas = null;
      this.ticker = { add() {}, remove() {} };
    }

    async init() {}
    resize() {}
    destroy() {}
  }
  return { ...actual, Application: MockApplication, Container: MockContainer };
});

/** A short window, where the board is height-bound and a reservation decides the scale. */
const SHORT = { screenWidth: 390, screenHeight: 400 };
/** A phone in portrait: width-bound, so only the centering can carry a reservation. */
const TALL = { screenWidth: 390, screenHeight: 844 };

describe('computeBoardLayout', () => {
  it('fills the window when nothing is reserved', () => {
    const layout = computeBoardLayout(SHORT);
    expect(layout.scale).toBeCloseTo(Math.min(390 / BASE_WIDTH, 400 / BASE_HEIGHT));
    expect(layout.y).toBeCloseTo((400 - BASE_HEIGHT * layout.scale) / 2);
  });

  /*
   * The case the reservation exists for: a height-bound board and a panel above
   * it. Without the top band the board is scaled to the whole window and its
   * top edge is drawn under the panel.
   */
  it('shrinks a height-bound board by the band above it', () => {
    const reserved = computeBoardLayout({ ...SHORT, topReserve: 92, bottomReserve: 50 });
    const unreserved = computeBoardLayout({ ...SHORT, bottomReserve: 50 });

    expect(reserved.scale).toBeLessThan(unreserved.scale);
    expect(reserved.scale).toBeCloseTo((400 - 92 - 50) / BASE_HEIGHT);
  });

  it('starts the board below the band above it, never under it', () => {
    for (const window of [SHORT, TALL]) {
      const layout = computeBoardLayout({ ...window, topReserve: 92, bottomReserve: 50 });
      expect(layout.y).toBeGreaterThanOrEqual(92);
      // ...and stops above the band below it.
      expect(layout.y + BASE_HEIGHT * layout.scale).toBeLessThanOrEqual(
        window.screenHeight - 50 + 0.5
      );
    }
  });

  /* On a portrait phone the board is width-bound, so the scale is the same
     whatever the panel costs and the reservation shows up as centering alone. */
  it('centers a width-bound board inside the band the reservations leave', () => {
    const layout = computeBoardLayout({ ...TALL, topReserve: 92, bottomReserve: 50 });
    const band = 844 - 92 - 50;

    expect(layout.scale).toBeCloseTo(390 / BASE_WIDTH);
    expect(layout.y).toBeCloseTo(92 + (band - BASE_HEIGHT * layout.scale) / 2);
    expect(layout.x).toBeCloseTo(0);
  });

  /* A window shorter than its own chrome still has to produce a drawable board. */
  it('keeps the scale positive when the chrome is taller than the window', () => {
    const layout = computeBoardLayout({
      screenWidth: 390,
      screenHeight: 100,
      topReserve: 92,
      bottomReserve: 80,
    });
    expect(layout.scale).toBeGreaterThan(0);
    expect(Number.isFinite(layout.y)).toBe(true);
  });
});

describe('GameRenderer._resize() — the supply panel reservation', () => {
  const root = () => document.documentElement;

  afterEach(() => {
    root().style.removeProperty(HUD_BAR_HEIGHT_VAR);
    root().style.removeProperty(SUPPLY_PANEL_HEIGHT_VAR);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderer = async ({ width = 390, height = 400 } = {}) => {
    const instance = new GameRenderer();
    await instance.init(document.createElement('canvas'));
    instance.app.screen = { width, height };
    instance.app.resize = () => {};
    return instance;
  };

  it('reserves the band SupplyStatus published', async () => {
    const instance = await renderer();
    root().style.setProperty(SUPPLY_PANEL_HEIGHT_VAR, '92px');

    instance._resize();

    expect(instance.root.scale.x).toBeCloseTo(
      computeBoardLayout({ ...SHORT, topReserve: 92, bottomReserve: HUD_BAR_HEIGHT }).scale
    );
    expect(instance.root.y).toBeGreaterThanOrEqual(92);
  });

  /* No panel on screen is the ordinary case (the title board, the game-over
     screen), and it reserves nothing — not a default height. */
  it('reserves nothing at the top when no panel has published one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instance = await renderer();

    instance._resize();

    expect(instance.root.scale.x).toBeCloseTo(
      computeBoardLayout({ ...SHORT, bottomReserve: HUD_BAR_HEIGHT }).scale
    );
    expect(warn).not.toHaveBeenCalled();
  });

  /* Same loud fallback as the bar height: a value that is not a px length is a
     writer bug, and reserving `parseFloat('5rem')` would be a silent 5px band. */
  it('falls back to nothing and warns once on a value that is not a px length', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instance = await renderer();
    root().style.setProperty(SUPPLY_PANEL_HEIGHT_VAR, '5rem');

    instance._resize();
    instance._resize();

    expect(instance.root.scale.x).toBeCloseTo(
      computeBoardLayout({ ...SHORT, bottomReserve: HUD_BAR_HEIGHT }).scale
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(SUPPLY_PANEL_HEIGHT_VAR);
    expect(warn.mock.calls[0][0]).toContain('SupplyStatus');
  });

  /* Both bands at once — the real playing screen. */
  it('reserves both ends together', async () => {
    const instance = await renderer({ height: 844 });
    root().style.setProperty(HUD_BAR_HEIGHT_VAR, '80px');
    root().style.setProperty(SUPPLY_PANEL_HEIGHT_VAR, '92px');

    instance._resize();

    const expected = computeBoardLayout({ ...TALL, topReserve: 92, bottomReserve: 80 });
    expect(instance.root.scale.x).toBeCloseTo(expected.scale);
    expect(instance.root.y).toBeCloseTo(expected.y);
  });
});
