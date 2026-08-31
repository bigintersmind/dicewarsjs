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
 * `--ui-accent-soft` and `--ui-text-halo` are intentionally absent: they are
 * derived from palette keys at runtime (see below), not looked up directly.
 *
 * Exported so tests can iterate it and stay in lockstep with the live mapping.
 */
export const VAR_MAP = {
  '--ui-bg': 'uiBg',
  '--ui-overlay-bg': 'uiOverlayBg',
  '--ui-text': 'uiText',
  '--ui-text-muted': 'uiTextMuted',
  '--ui-accent': 'uiAccent',
  '--ui-border': 'uiBorder',
  '--ui-body-bg': 'bodyBg',
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
  // Ink-rim shadow for text that floats directly on the scrimmed board.
  el.style.setProperty('--ui-text-halo', composeTextHalo(theme.uiInk, theme.uiInkSoft));

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
   * surround stays dark around the light theme. Resolved from the root's own
   * document, since tests hand us a detached element whose real `<head>` is
   * still reachable that way; a page without the meta just keeps its default.
   */
  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const themeColorMeta = doc && doc.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', theme.bodyBg);
}
