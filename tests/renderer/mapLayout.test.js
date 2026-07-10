// @vitest-environment jsdom
/**
 * Map fit-to-canvas layout tests.
 *
 * Locks the geometry that keeps every map-size preset inside the fixed base
 * canvas. Regression guard for the bug where the Large preset (36×40 → 972px)
 * overflowed BASE_WIDTH (840) and clipped on both edges. Pure math — no PixiJS.
 */

import { computeMapLayout } from '../../src/renderer/HexGridRenderer.js';
import {
  BASE_WIDTH,
  BASE_HEIGHT,
  CELL_WIDTH,
  CELL_HEIGHT,
  MAP_TOP_MARGIN,
  HUD_BAR_HEIGHT,
} from '../../src/renderer/constants.js';

// Mirror MAP_SIZE_PRESETS (src/utils/config.js) — the dimensions that ship.
const PRESETS = {
  small: { width: 20, height: 24 },
  medium: { width: 28, height: 32 },
  large: { width: 36, height: 40 },
};

describe('computeMapLayout', () => {
  for (const [name, { width, height }] of Object.entries(PRESETS)) {
    describe(`${name} preset (${width}×${height})`, () => {
      const layout = computeMapLayout(width, height);

      it('produces a scale in (0, 1]', () => {
        expect(layout.scale).toBeGreaterThan(0);
        expect(layout.scale).toBeLessThanOrEqual(1);
      });

      it('never clips the left edge (x >= 0)', () => {
        expect(layout.x).toBeGreaterThanOrEqual(0);
      });

      it('fits within BASE_WIDTH on the right edge (incl. odd-row overhang)', () => {
        const renderedWidth = (width * CELL_WIDTH + CELL_WIDTH / 2) * layout.scale;
        // Allow a hair of float slack.
        expect(layout.x + renderedWidth).toBeLessThanOrEqual(BASE_WIDTH + 0.5);
      });

      it('never overlaps the HUD strip at the bottom', () => {
        const renderedHeight = height * CELL_HEIGHT * layout.scale;
        expect(layout.y + renderedHeight).toBeLessThanOrEqual(BASE_HEIGHT - HUD_BAR_HEIGHT + 0.5);
      });

      it('never rises above MAP_TOP_MARGIN', () => {
        expect(layout.y).toBeGreaterThanOrEqual(MAP_TOP_MARGIN);
      });

      it('centers vertically between MAP_TOP_MARGIN and the HUD strip', () => {
        // Regression: top-anchoring piled all slack below the map, pushing the
        // top row under the fixed mode rail on the hub screens (~55px) while
        // leaving a large empty band at the bottom.
        const renderedHeight = height * CELL_HEIGHT * layout.scale;
        const bandBottom = BASE_HEIGHT - HUD_BAR_HEIGHT;
        const topGap = layout.y - MAP_TOP_MARGIN;
        const bottomGap = bandBottom - (layout.y + renderedHeight);
        expect(topGap).toBeCloseTo(bottomGap, 6);
      });
    });
  }

  it('does not scale Small or Medium (scale === 1, original layout preserved)', () => {
    expect(computeMapLayout(20, 24).scale).toBe(1);
    expect(computeMapLayout(28, 32).scale).toBe(1);
  });

  it('scales the Large preset down below 1 so it fits', () => {
    expect(computeMapLayout(36, 40).scale).toBeLessThan(1);
  });

  it('matches the original centering formula when scale === 1', () => {
    // Medium fits without scaling, so x must equal the pre-fix formula.
    const mapPixelWidth = 28 * CELL_WIDTH;
    const expectedX = BASE_WIDTH / 2 - mapPixelWidth / 2 - CELL_WIDTH / 4;
    expect(computeMapLayout(28, 32).x).toBeCloseTo(expectedX, 6);
  });

  it('caps scale on height for tall grids and pins them to MAP_TOP_MARGIN', () => {
    // No shipping preset is height-bound (Large is width-bound), so without
    // this synthetic grid the availHeight/mapPixelHeight term in the scale
    // Math.min could be deleted with every other test still passing.
    const bandHeight = BASE_HEIGHT - MAP_TOP_MARGIN - HUD_BAR_HEIGHT;
    const layout = computeMapLayout(20, 50); // 900px tall > the 740px band
    expect(layout.scale).toBeCloseTo(bandHeight / (50 * CELL_HEIGHT), 6);
    // Fully height-capped → zero slack to split, so y sits at the margin.
    expect(layout.y).toBeCloseTo(MAP_TOP_MARGIN, 6);
  });
});
