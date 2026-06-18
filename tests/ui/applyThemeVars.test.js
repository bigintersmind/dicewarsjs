// @vitest-environment jsdom
/**
 * applyThemeVars tests
 *
 * Verifies the DOM theming bridge: the active theme's palette is written to CSS
 * custom properties (consumed by every screen via var(--ui-*)) and the page
 * background is synced. This is the single mechanism that keeps Arena,
 * Tournament, and every other screen in step with the theme preference.
 */

import { applyThemeVars, hexToRgba } from '../../src/ui/applyThemeVars.js';
import { THEMES } from '../../src/renderer/themes.js';

describe('hexToRgba', () => {
  it('converts a 6-digit hex color to rgba with the given alpha', () => {
    expect(hexToRgba('#e94560', 0.15)).toBe('rgba(233, 69, 96, 0.15)');
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
    expect(hexToRgba('#FFFFFF', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('returns the input unchanged when it is not a 6-digit hex', () => {
    expect(hexToRgba('rgba(0,0,0,0.5)', 0.2)).toBe('rgba(0,0,0,0.5)');
    expect(hexToRgba('transparent', 0.2)).toBe('transparent');
  });
});

describe('applyThemeVars', () => {
  let root;
  let body;

  beforeEach(() => {
    root = document.createElement('div');
    body = document.createElement('div');
  });

  it('writes every UI palette key to a CSS custom property for the dark theme', () => {
    applyThemeVars('dark', { root, body });
    expect(root.style.getPropertyValue('--ui-text')).toBe(THEMES.dark.uiText);
    expect(root.style.getPropertyValue('--ui-text-muted')).toBe(THEMES.dark.uiTextMuted);
    expect(root.style.getPropertyValue('--ui-accent')).toBe(THEMES.dark.uiAccent);
    expect(root.style.getPropertyValue('--ui-border')).toBe(THEMES.dark.uiBorder);
    expect(root.style.getPropertyValue('--ui-overlay-bg')).toBe(THEMES.dark.uiOverlayBg);
  });

  it('switches the variables when the light theme is applied', () => {
    applyThemeVars('light', { root, body });
    expect(root.style.getPropertyValue('--ui-text')).toBe(THEMES.light.uiText);
    expect(root.style.getPropertyValue('--ui-accent')).toBe(THEMES.light.uiAccent);
    expect(root.style.getPropertyValue('--ui-body-bg')).toBe(THEMES.light.bodyBg);
  });

  it('derives a translucent --ui-accent-soft from the accent color', () => {
    applyThemeVars('dark', { root, body });
    expect(root.style.getPropertyValue('--ui-accent-soft')).toBe('rgba(233, 69, 96, 0.15)');
  });

  it('syncs the page background to the theme bodyBg', () => {
    applyThemeVars('light', { root, body });
    /*
     * jsdom normalizes the color (e.g. #e8e8f0 -> rgb(232, 232, 240)), so
     * compare against a reference element set to the same value.
     */
    const reference = document.createElement('div');
    reference.style.background = THEMES.light.bodyBg;
    expect(body.style.background).toBe(reference.style.background);
  });

  it('falls back to the dark theme for an unknown theme name', () => {
    applyThemeVars('not-a-theme', { root, body });
    expect(root.style.getPropertyValue('--ui-text')).toBe(THEMES.dark.uiText);
  });
});
