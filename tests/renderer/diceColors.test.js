/**
 * Tests for the dice face-color tables and face-value assignments in
 * DiceRenderer — the data decoded from the legacy sprite art plus the
 * derived color-blind palette. Pure data/functions, no PixiJS surface.
 */

import {
  DICE_COLORS,
  COLORBLIND_DICE_COLORS,
  DIE_FACES,
  TOP_PIPS,
  LEFT_PIPS,
  RIGHT_PIPS,
  deriveDieColors,
  luminance,
} from '../../src/renderer/DiceRenderer.js';
import { PLAYER_COLORS, COLORBLIND_PLAYER_COLORS } from '../../src/renderer/constants.js';

describe('DICE_COLORS', () => {
  it('has one entry per player color', () => {
    expect(DICE_COLORS).toHaveLength(PLAYER_COLORS.length);
  });

  it.each(DICE_COLORS.map((c, i) => [i, c]))(
    'player %i faces shade darker from top to side to base',
    (i, c) => {
      expect(luminance(c.top)).toBeGreaterThan(luminance(c.side));
      expect(luminance(c.side)).toBeGreaterThan(luminance(c.base));
    }
  );

  it('every entry defines all face, accent, and pip colors', () => {
    for (const c of DICE_COLORS) {
      for (const key of ['top', 'side', 'base', 'glint', 'leftRim', 'rightRim', 'bottomRim']) {
        expect(typeof c[key]).toBe('number');
      }
      for (const key of ['top', 'side', 'base']) {
        expect(typeof c.pips[key]).toBe('number');
      }
    }
  });

  it('dice bodies are far more vivid than the pale territory fills they sit on', () => {
    /*
     * The old derived formula left only a ~45-65 luminance gap, which read
     * as washed out; the legacy art sits at 58-113. Dark green (index 2)
     * gets a looser bound — its territory is already dark, so the gap is
     * smaller — but its side must still read as darker than the fill (a
     * regression that brightened it back toward the fill is what this
     * guards), so it's checked, not skipped.
     */
    DICE_COLORS.forEach((c, i) => {
      const minGap = i === 2 ? 30 : 55;
      expect(luminance(PLAYER_COLORS[i]) - luminance(c.side)).toBeGreaterThan(minGap);
    });
  });
});

describe('DIE_FACES', () => {
  it('has one [top, left, right] triple per player', () => {
    expect(DIE_FACES).toHaveLength(PLAYER_COLORS.length);
    for (const faces of DIE_FACES) {
      expect(faces).toHaveLength(3);
      for (const v of faces) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
      }
    }
  });

  it('never shows opposite faces together (they sum to 7 on a real die)', () => {
    for (const [top, left, right] of DIE_FACES) {
      expect(top + left).not.toBe(7);
      expect(top + right).not.toBe(7);
      expect(left + right).not.toBe(7);
    }
  });

  it('shows three distinct faces on every die', () => {
    for (const faces of DIE_FACES) {
      expect(new Set(faces).size).toBe(3);
    }
  });
});

describe('pip tables cover every face DIE_FACES can request', () => {
  /*
   * drawFacePips looks each face value up in TOP_PIPS / LEFT_PIPS / RIGHT_PIPS.
   * A value missing from every table silently falls back to a DIFFERENT
   * value's layout (a 5-face rendered with one pip) with no error. This locks
   * the hand-maintained invariant that keeps those fallbacks dead: every value
   * any shipped die actually shows has a real table entry, so the fallback
   * never fires and the pip count is always correct.
   */
  it.each(DIE_FACES.map((f, i) => [i, f]))(
    'player %i faces all resolve to a real pip-table entry',
    (_i, [top, left, right]) => {
      expect(TOP_PIPS[top]).toBeDefined();
      // Walls may legitimately borrow the other wall's shape (mirrored), so a
      // value only needs to exist in SOME wall table — never the wrong-count terminal.
      expect(LEFT_PIPS[left] || RIGHT_PIPS[left]).toBeDefined();
      expect(RIGHT_PIPS[right] || LEFT_PIPS[right]).toBeDefined();
    }
  );

  const pipEntries = [
    ['TOP', TOP_PIPS],
    ['LEFT', LEFT_PIPS],
    ['RIGHT', RIGHT_PIPS],
  ].flatMap(([name, table]) =>
    Object.entries(table).map(([value, entry]) => [`${name}_PIPS[${value}]`, Number(value), entry])
  );

  it.each(pipEntries)('%s holds exactly N pip points for value N', (_label, value, entry) => {
    expect(entry.pts).toHaveLength(value);
  });
});

describe('deriveDieColors (color-blind palette)', () => {
  it('derives one entry per color-blind player color', () => {
    expect(COLORBLIND_DICE_COLORS).toHaveLength(COLORBLIND_PLAYER_COLORS.length);
  });

  it('keeps the top-side-base shading order', () => {
    for (const c of COLORBLIND_DICE_COLORS) {
      expect(luminance(c.top)).toBeGreaterThan(luminance(c.side));
      expect(luminance(c.side)).toBeGreaterThan(luminance(c.base));
    }
  });

  it('gives the black player white dice with black pips instead of invisible black-on-black', () => {
    const black = deriveDieColors(0x000000);
    expect(luminance(black.top)).toBeGreaterThan(200);
    expect(black.pips.top).toBe(0x000000);
  });

  it('picks white pips for dark bodies and black pips for light bodies', () => {
    const dark = deriveDieColors(0x0072b2); // Wong blue
    expect(dark.pips.top).toBe(0xffffff);
    const light = deriveDieColors(0xf0e442); // Wong yellow
    expect(light.pips.top).toBe(0x000000);
  });

  it('normalizes a mid-brightness fill so its brightest channel lands on 224', () => {
    // The boost is f = min(2, 224 / max), so for any fill whose brightest
    // channel is >= 112 the top face's brightest channel lands exactly on
    // 224 — the legacy "brilliant top". Guards the 224 constant itself.
    const channels = c => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
    expect(Math.max(...channels(deriveDieColors(0x009302).top))).toBe(224);
    expect(Math.max(...channels(deriveDieColors(0x808080).top))).toBe(224);
  });

  it('caps the boost at 2x for dark (but non-black) fills instead of over-brightening', () => {
    // max = 8 < 112, so 224 / max would exceed 2; the min(2, ...) cap doubles
    // the channels instead of blowing them out, and never leaves them black.
    expect(deriveDieColors(0x080808).top).toBe(0x101010);
    expect(luminance(deriveDieColors(0x100810).top)).toBeGreaterThan(0);
  });
});
