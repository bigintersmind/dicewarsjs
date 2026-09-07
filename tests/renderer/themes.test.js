// @vitest-environment jsdom
/**
 * Theme definitions tests
 */

import { THEMES, getTheme } from '../../src/renderer/themes.js';
import {
  PLAYER_COLORS,
  PLAYER_COLORS_CSS,
  COLORBLIND_PLAYER_COLORS,
  COLORBLIND_PLAYER_COLORS_CSS,
} from '../../src/renderer/constants.js';
import { contrast, parseColor, relativeLuminance, surface, WCAG } from '../helpers/contrast.js';

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
      // Not a color: the keyword that themes the browser's own native widgets,
      // so it has to be one the browser actually understands.
      expect(['dark', 'light']).toContain(theme.colorScheme);
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

/*
 * The opaque panel token (Daily Conquest v2).
 *
 * The in-game supply panel, the daily card and the match report all paint a box
 * of dense small text straight over the live board, and all three used to do it
 * on `uiBg` / `uiOverlayBg`. Those are translucent, so what they really carry
 * is the territory underneath — and the territories are a palette of bright
 * seats. Measured over the worst of them, in the dark theme:
 *
 *   supply panel text        4.22:1   (needs 4.5)
 *   supply panel labels      2.58:1   (needs 4.5)
 *   daily / result eyebrow   2.82:1   (needs 4.5, and it was the accent)
 *   campaign chart stroke    2.82:1   (needs 3, a graphic)
 *
 * None of it shows on a page-colored mock, which is why it shipped. `uiPanelBg`
 * is opaque, so those panels stop depending on the board at all — which is what
 * the last test in here says in so many words, over both seat palettes.
 */
describe('the opaque panel token (--ui-panel-bg)', () => {
  const seats = [...PLAYER_COLORS_CSS, ...COLORBLIND_PLAYER_COLORS_CSS];

  it.each(['dark', 'light'])('is opaque in the %s theme', name => {
    // An alpha anywhere in here would put the board back under the text.
    expect(THEMES[name].uiPanelBg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(parseColor(THEMES[name].uiPanelBg).a).toBe(1);
  });

  it.each(['dark', 'light'])('carries body and label text at 4.5:1 in the %s theme', name => {
    const t = THEMES[name];
    expect(contrast(t.uiText, t.uiPanelBg)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
    expect(contrast(t.uiTextMuted, t.uiPanelBg)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
  });

  /* The campaign chart's line and fill are drawn in the accent: a graphic, so
     3:1 — which it misses over the translucent overlay it used to sit on. */
  it.each(['dark', 'light'])('carries the chart stroke at 3:1 in the %s theme', name => {
    const t = THEMES[name];
    expect(contrast(t.uiAccent, t.uiPanelBg)).toBeGreaterThanOrEqual(WCAG.AA_NON_TEXT);
  });

  /*
   * The point of the token, stated as the property that actually holds: because
   * it is opaque, the ratio is the same over every seat color in BOTH palettes —
   * the panel measures identically on a board of lavender and on a board of
   * black. That is what the translucent tokens could not promise.
   */
  it.each(['dark', 'light'])('measures the same over every seat in the %s theme', name => {
    const t = THEMES[name];
    const onPage = contrast(t.uiText, t.uiPanelBg);
    for (const seat of seats) {
      const overBoard = surface(seat, t.uiPanelBg);
      expect(contrast(t.uiText, overBoard)).toBeCloseTo(onPage, 10);
      expect(contrast(t.uiTextMuted, overBoard)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
      expect(contrast(t.uiAccent, overBoard)).toBeGreaterThanOrEqual(WCAG.AA_NON_TEXT);
    }
  });

  /*
   * The eyebrows over the game-over overlay do not get a panel — they are lines
   * of text on the screen's own scrim, not boxes — so they were moved off the
   * accent (2.82:1 in the dark theme over the worst board pixel) onto the ink.
   * Measured where they actually sit: the overlay, flattened over each seat.
   */
  it.each(['dark', 'light'])('reads the result eyebrow on the %s overlay', name => {
    const t = THEMES[name];
    const overlays = seats.map(seat => surface(seat, t.uiOverlayBg));
    for (const overlay of overlays) {
      expect(contrast(t.uiText, overlay)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
    }
    // ...and the accent it used to be set in does not, over the seats that are
    // nearest it in value. It clears the bar on some territories and misses it
    // on others, which is exactly the property that makes it the wrong token
    // for text: legibility that depends on which territory drifts underneath.
    const worstAccent = Math.min(...overlays.map(overlay => contrast(t.uiAccent, overlay)));
    expect(worstAccent).toBeLessThan(WCAG.AA_TEXT);
  });
});
