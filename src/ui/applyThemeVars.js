/**
 * Apply Theme to the DOM
 *
 * Writes the active theme's palette to CSS custom properties on the document
 * root so every Preact screen can reference them via `var(--ui-*)`. This is the
 * single mechanism for theming the DOM/UI overlay — new screens inherit the
 * theme automatically just by using the variables, with no per-screen wiring.
 *
 * It also sets the two things a CSS variable cannot reach, because nothing in
 * our own stylesheets paints them: the root's `color-scheme` (the tone the
 * browser draws native widgets in) and `<meta name="theme-color">` (the tone
 * the browser tints its own chrome around the page with).
 *
 * The PixiJS renderer (the game board) is themed separately via
 * `GameRenderer.setTheme()`, since it draws to a canvas rather than the DOM.
 *
 * @module ui/applyThemeVars
 */

import { getTheme } from '../renderer/themes.js';

/**
 * Map of CSS custom property name → theme palette key. Note that
 * `--ui-accent-soft`, `--ui-text-halo`, `--ui-bevel-shadow` and
 * `--ui-bevel-shadow-display` are intentionally absent: they are derived from
 * palette keys at runtime (see below), not looked up directly.
 *
 * Exported so tests can iterate it and stay in lockstep with the live mapping.
 */
export const VAR_MAP = {
  '--ui-bg': 'uiBg',
  '--ui-overlay-bg': 'uiOverlayBg',
  '--ui-text': 'uiText',
  '--ui-text-muted': 'uiTextMuted',
  '--ui-accent': 'uiAccent',
  '--ui-bevel-face': 'uiBevelFace',
  '--ui-bevel-face-display': 'uiBevelFaceDisplay',
  '--ui-border': 'uiBorder',
  '--ui-body-bg': 'bodyBg',
  '--ui-danger': 'uiDanger',
  '--ui-scrim': 'uiScrim',
};

/**
 * Compose the ink-rim text shadow from a theme's ink colors: a tight
 * near-opaque rim on all four sides plus a soft under-shadow. Text set
 * directly on the scrimmed live board (e.g. menu options, eyebrows, nav tabs)
 * carries this as a portable background — the same self-carried-backing idea
 * as the logotype's bevel stack — so its contrast doesn't depend on which
 * territory drifts underneath. The ink tracks each theme's scrim tone, so the
 * light theme's "ink" is deliberately light (a pale rim behind dark text).
 *
 * @param {string} ink - Near-opaque rim color (theme `uiInk`)
 * @param {string} soft - Soft under-shadow color (theme `uiInkSoft`)
 * @returns {string} A `text-shadow` value
 */
export function composeTextHalo(ink, soft) {
  return `0 1px 2px ${ink}, 0 -1px 2px ${ink}, 1px 0 2px ${ink}, -1px 0 2px ${ink}, 0 2px 6px ${soft}`;
}

/**
 * Compose the logotype bevel at small sizes: a tight two-step extrusion
 * down-right under a soft drop shadow. Worn by the 15-17px text that letters
 * itself in the wordmark (the rail's current tab, the settings heading).
 *
 * The extrusion colors come from the theme because the light palette has to
 * step its ramp down under a darker face — reusing the dark ramp there would
 * put a #875300 shadow behind a face of about the same value, which is no
 * extrusion at all. The soft drop shadow stays a literal black: it is the
 * ground shadow the whole stack casts, and a bevel throws that on a pale
 * surface exactly as it does on a dark one.
 *
 * @param {string} shade - First extrusion step (theme `uiBevelShade`)
 * @param {string} deep - Deepest extrusion step (theme `uiBevelDeep`)
 * @returns {string} A `text-shadow` value
 */
export function composeBevelShadow(shade, deep) {
  return `1px 1px 0 ${shade}, 2px 2px 0 ${deep}, 1px 3px 6px rgba(0, 0, 0, 0.35)`;
}

/**
 * Compose the bevel at display size: the wordmark's full stack — rim light
 * up-left, three extrusion steps down-right, soft drop shadow — for the screen
 * headline. Same division as `composeBevelShadow`: the ramp tracks the theme,
 * the drop shadow is literal.
 *
 * @param {string} rim - Rim light up-left (theme `uiBevelRim`)
 * @param {string} edge - First extrusion step (theme `uiBevelEdge`)
 * @param {string} shade - Second extrusion step (theme `uiBevelShade`)
 * @param {string} deep - Deepest extrusion step (theme `uiBevelDeep`)
 * @returns {string} A `text-shadow` value
 */
export function composeBevelShadowDisplay(rim, edge, shade, deep) {
  return `-2px -2px 0 ${rim}, 2px 2px 0 ${edge}, 3px 3px 0 ${shade}, 5px 5px 0 ${deep}, 4px 9px 16px rgba(0, 0, 0, 0.4)`;
}

/**
 * Convert a `#rrggbb` hex color to an `rgba()` string with the given alpha.
 * Returns the input unchanged if it isn't a 6-digit hex.
 *
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
export function hexToRgba(hex, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Apply a theme's palette as CSS custom properties, set the root's
 * `color-scheme`, and sync the page background and the browser-chrome tint.
 * Safe to call repeatedly (e.g. on every preference change).
 *
 * @param {string} themeName - 'dark' | 'light' (falls back to dark)
 * @param {{ root?: HTMLElement, body?: HTMLElement }} [targets] - Override the
 *   target elements (defaults to document root + body); used by tests.
 */
export function applyThemeVars(themeName, { root, body } = {}) {
  const theme = getTheme(themeName);
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!el) return;

  for (const [cssVar, key] of Object.entries(VAR_MAP)) {
    el.style.setProperty(cssVar, theme[key]);
  }
  // Soft, translucent accent for error-banner fills and subtle highlights.
  el.style.setProperty('--ui-accent-soft', hexToRgba(theme.uiAccent, 0.15));
  // The flagged-row wash on the leaderboard: the danger red at 10%, derived here so the
  // tint follows the token per theme instead of freezing one theme's red into a literal.
  el.style.setProperty('--ui-danger-soft', hexToRgba(theme.uiDanger, 0.1));
  // Ink-rim shadow for text that floats directly on the scrimmed board.
  el.style.setProperty('--ui-text-halo', composeTextHalo(theme.uiInk, theme.uiInkSoft));
  // Logotype bevel stacks; their face colors are plain VAR_MAP lookups above.
  el.style.setProperty(
    '--ui-bevel-shadow',
    composeBevelShadow(theme.uiBevelShade, theme.uiBevelDeep)
  );
  el.style.setProperty(
    '--ui-bevel-shadow-display',
    composeBevelShadowDisplay(
      theme.uiBevelRim,
      theme.uiBevelEdge,
      theme.uiBevelShade,
      theme.uiBevelDeep
    )
  );

  const bodyEl = body || (typeof document !== 'undefined' ? document.body : null);
  if (bodyEl) bodyEl.style.background = theme.bodyBg;

  /*
   * Not a custom property but a real one, so it is set directly and stays out
   * of VAR_MAP: it is what tells the browser to draw the native widgets we
   * don't style ourselves — the Custom-difficulty `<select>` popup on the title
   * screen, scrollbars — in the theme's tone instead of always-light defaults.
   */
  el.style.setProperty('color-scheme', theme.colorScheme);

  /*
   * Mobile browsers tint their own chrome (address bar, task switcher) from
   * `<meta name="theme-color">`, so it has to follow the theme too or the
   * surround stays dark around the light theme. Looked up in the root's own
   * document, so a fake root can never retint the real page. A missing meta is
   * skipped rather than treated as a failure: index.html's tag is pinned by
   * this module's test (tests/ui/applyThemeVars.test.js), so its absence means
   * a test fixture, not a regression.
   */
  const doc = el.ownerDocument;
  const themeColorMeta = doc.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', theme.bodyBg);
}
