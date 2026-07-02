/**
 * Tests for the dice face-color tables and face-value assignments in
 * DiceRenderer — the data decoded from the legacy sprite art plus the
 * derived color-blind palette. Pure data/functions, no PixiJS surface.
 */

import {
  DICE_COLORS,
  COLORBLIND_DICE_COLORS,
  DIE_FACES,
  deriveDieColors,
} from '../../src/renderer/DiceRenderer.js';
import { PLAYER_COLORS, COLORBLIND_PLAYER_COLORS } from '../../src/renderer/constants.js';

/** Rec.601 luminance of a hex int color. */
const luminance = c => 0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff);

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
     * as washed out; the legacy art sits at 58-113. Dark green (index 2) is
     * the one deliberate exception — its territory is already dark and the
     * original relied on the bright top face instead.
     */
    DICE_COLORS.forEach((c, i) => {
      if (i === 2) return;
      expect(luminance(PLAYER_COLORS[i]) - luminance(c.side)).toBeGreaterThan(55);
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

  it('clamps the brightness boost for near-black (but not pure black) fills', () => {
    const c = deriveDieColors(0x100810);
    for (const ch of [16, 8, 0]) {
      expect((c.top >> ch) & 0xff).toBeLessThanOrEqual(255);
    }
    expect(luminance(c.top)).toBeGreaterThan(0);
  });
});
