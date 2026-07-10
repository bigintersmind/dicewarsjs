/**
 * Apply Theme to the DOM
 *
 * Writes the active theme's palette to CSS custom properties on the document
 * root so every Preact screen can reference them via `var(--ui-*)`. This is the
 * single mechanism for theming the DOM/UI overlay — new screens inherit the
 * theme automatically just by using the variables, with no per-screen wiring.
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
 * Compose the ink-rim text shadow from a theme's ink colors: a tight opaque
 * rim on all four sides plus a soft under-shadow. Text floating directly on
 * the scrimmed live board (menu options, eyebrows, nav tabs) carries this as
 * a portable background — the same trick the DICE WARS logotype uses — so its
 * contrast no longer depends on which territory drifts underneath.
 *
 * @param {string} ink - Opaque rim color (theme `uiInk`)
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
 * Apply a theme's palette as CSS custom properties and sync the page
 * background. Safe to call repeatedly (e.g. on every preference change).
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
}
