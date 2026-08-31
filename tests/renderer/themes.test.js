// @vitest-environment jsdom
/**
 * Theme definitions tests
 */

import { THEMES, getTheme } from '../../src/renderer/themes.js';
import { PLAYER_COLORS, COLORBLIND_PLAYER_COLORS } from '../../src/renderer/constants.js';
import { contrast, relativeLuminance, surface, WCAG } from '../helpers/contrast.js';

describe('themes', () => {
  /*
   * -----------------------------------------------------------------------
   * THEMES constant
   * -----------------------------------------------------------------------
   */

  it('exports dark and light themes', () => {
    expect(THEMES.dark).toBeDefined();
    expect(THEMES.light).toBeDefined();
  });

  it('dark and light themes have identical key sets', () => {
    const darkKeys = Object.keys(THEMES.dark).sort();
    const lightKeys = Object.keys(THEMES.light).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  it('themes contain required renderer properties', () => {
    for (const name of ['dark', 'light']) {
      const theme = THEMES[name];
      expect(typeof theme.bgColor).toBe('number');
      expect(typeof theme.borderColor).toBe('number');
      expect(typeof theme.highlightColor).toBe('number');
      expect(typeof theme.highlightFill).toBe('number');
      // Board-hint colors: both themes must define all three, or the hint
      // layer paints `undefined` into a stroke on one of them.
      expect(typeof theme.candidateAttacker).toBe('number');
      expect(typeof theme.candidateTarget).toBe('number');
      expect(typeof theme.candidateHalo).toBe('number');
      // ...and they must be distinguishable from each other and from the
      // selection ring they sit under.
      expect(theme.candidateAttacker).not.toBe(theme.candidateTarget);
      expect(theme.candidateAttacker).not.toBe(theme.highlightColor);
      expect(theme.candidateTarget).not.toBe(theme.highlightColor);
    }
  });

  it('board-hint colors are not seat colors in either palette', () => {
    /*
     * A hint outline must never be mistakable for a territory's owner. The
     * halo is exempt: it is a rim under the bright core, never a mark of its
     * own, and black is both a color-blind seat and the only rim dark enough
     * to work on the dark theme.
     */
    const seats = [...PLAYER_COLORS, ...COLORBLIND_PLAYER_COLORS];
    for (const name of ['dark', 'light']) {
      const theme = THEMES[name];
      expect(seats).not.toContain(theme.candidateAttacker);
      expect(seats).not.toContain(theme.candidateTarget);
    }
  });

  it('themes contain required UI properties', () => {
    for (const name of ['dark', 'light']) {
      const theme = THEMES[name];
      expect(typeof theme.uiBg).toBe('string');
      expect(typeof theme.uiText).toBe('string');
      expect(typeof theme.uiAccent).toBe('string');
      expect(typeof theme.bodyBg).toBe('string');
    }
  });

  /*
   * -----------------------------------------------------------------------
   * getTheme
   * -----------------------------------------------------------------------
   */

  it('returns dark theme for "dark"', () => {
    expect(getTheme('dark')).toBe(THEMES.dark);
  });

  it('returns light theme for "light"', () => {
    expect(getTheme('light')).toBe(THEMES.light);
  });

  it('falls back to dark theme for unknown name', () => {
    expect(getTheme('nonexistent')).toBe(THEMES.dark);
  });

  it('falls back to dark theme for undefined', () => {
    expect(getTheme(undefined)).toBe(THEMES.dark);
  });
});

describe('bevel tokens (#220)', () => {
  /*
   * The logotype bevel used to be hardcoded at three CSS sites, which meant the
   * wordmark's orange face over the light theme's near-white scrim: 1.83:1 at
   * the two small sites (the rail's current tab, the settings heading) against
   * 4.5:1, and 1.85:1 for the headline against 3:1. The brown extrusion under
   * the glyphs adds edge contrast but WCAG measures glyph against ground, so
   * the light palette darkens the face; these pin both halves of the deal —
   * the dark theme is unchanged, the light theme actually clears its floor.
   */
  const scrim = name => surface(THEMES[name].bodyBg, THEMES[name].uiScrim);
  const overlay = name => surface(THEMES[name].bodyBg, THEMES[name].uiOverlayBg);

  it('the dark ramp is still the wordmark palette, value for value', () => {
    expect(THEMES.dark.uiBevelFace).toBe('#ff9c00');
    expect(THEMES.dark.uiBevelFaceDisplay).toBe('#ff9c00');
    expect(THEMES.dark.uiBevelRim).toBe('#ffff33');
    expect(THEMES.dark.uiBevelEdge).toBe('#c57900');
    expect(THEMES.dark.uiBevelShade).toBe('#875300');
    expect(THEMES.dark.uiBevelDeep).toBe('#4a2d00');
  });

  /*
   * 15-17px Anton is normal-size text by WCAG's reckoning (the large-text
   * allowance starts at 18.66px bold), so the small face owes the full 4.5:1 —
   * on the scrim under the rail and on the settings dropdown alike.
   */
  it.each(['dark', 'light'])('the %s small face clears 4.5:1 on scrim and dropdown', name => {
    expect(contrast(THEMES[name].uiBevelFace, scrim(name))).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
    expect(contrast(THEMES[name].uiBevelFace, overlay(name))).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
  });

  /* The headline is clamp(2.3rem, 6vw, 3rem) — large text, so 3:1. */
  it.each(['dark', 'light'])('the %s display face clears 3:1 on the scrim', name => {
    expect(contrast(THEMES[name].uiBevelFaceDisplay, scrim(name))).toBeGreaterThanOrEqual(
      WCAG.AA_LARGE
    );
  });

  /*
   * An extrusion is only an extrusion while each step is darker than the one
   * above it. The light theme's darker face is what forces the ramp down: left
   * at the dark values, its first step (#875300) would land on a face of about
   * the same luminance and the bevel would read as a blur.
   */
  it.each(['dark', 'light'])('the %s ramp darkens monotonically under the face', name => {
    const t = THEMES[name];
    const ramp = [t.uiBevelFaceDisplay, t.uiBevelEdge, t.uiBevelShade, t.uiBevelDeep];
    const luminances = ramp.map(relativeLuminance);
    for (let i = 1; i < luminances.length; i += 1) {
      expect(luminances[i]).toBeLessThan(luminances[i - 1]);
    }
    // The small face skips the edge step, so it too must sit above the shade.
    expect(relativeLuminance(t.uiBevelFace)).toBeGreaterThan(relativeLuminance(t.uiBevelShade));
    // ...and the rim light must read as light against the face it lights.
    expect(relativeLuminance(t.uiBevelRim)).toBeGreaterThan(
      relativeLuminance(t.uiBevelFaceDisplay)
    );
  });

  /*
   * Acceptance measurements from the same audit, for the menu text that shares
   * these surfaces: the option idiom (.dw-opt, unpressed and pressed) and the
   * rail's non-current tabs. All three already clear 4.5:1 in both themes, so
   * they are pinned here rather than changed — the separate question of whether
   * the pressed cue reads as *selected* belongs to #221.
   */
  it.each(['dark', 'light'])('the %s menu-option colors clear 4.5:1 on the scrim', name => {
    const t = THEMES[name];
    expect(contrast(t.uiTextMuted, scrim(name))).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
    expect(contrast(t.uiAccent, scrim(name))).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
  });
});
