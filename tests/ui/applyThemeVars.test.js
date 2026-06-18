// @vitest-environment jsdom
/**
 * applyThemeVars tests
 *
 * Verifies the DOM theming bridge: the active theme's palette is written to CSS
 * custom properties (consumed by every screen via var(--ui-*)) and the page
 * background is synced. This is the single mechanism that keeps Arena,
 * Tournament, and every other screen in step with the theme preference.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyThemeVars, hexToRgba, VAR_MAP } from '../../src/ui/applyThemeVars.js';
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
    // 3-digit shorthand and missing-# are not 6-digit hex → passthrough.
    expect(hexToRgba('#fff', 0.2)).toBe('#fff');
    expect(hexToRgba('e94560', 0.2)).toBe('e94560');
  });
});

describe('applyThemeVars', () => {
  let root;
  let body;

  beforeEach(() => {
    root = document.createElement('div');
    body = document.createElement('div');
  });

  /*
   * Iterate VAR_MAP so the test stays in lockstep with the live mapping: a key
   * added to (or dropped from) VAR_MAP is automatically covered or flagged.
   */
  it.each(Object.entries(VAR_MAP))(
    'writes %s from the matching palette key for the dark theme',
    (cssVar, paletteKey) => {
      applyThemeVars('dark', { root, body });
      expect(root.style.getPropertyValue(cssVar)).toBe(THEMES.dark[paletteKey]);
    }
  );

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

  it('is a no-op (does not throw) when there is no root element', () => {
    /*
     * No `root` override and document.documentElement exists, so this still
     * applies; the guard only short-circuits in a truly DOM-less context.
     */
    expect(() => applyThemeVars('dark', {})).not.toThrow();
  });
});

describe('index.html first-paint :root defaults', () => {
  /*
   * Resolve from the repo root (vitest's cwd); import.meta.url is not a file:
   * URL under the jsdom environment, so fileURLToPath can't be used here.
   */
  const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  /*
   * index.html hardcodes the dark palette in a :root block so the first paint
   * (before main.jsx runs) is themed. That duplicates THEMES.dark with only a
   * "keep in sync" prose comment to guard it, so assert the values actually
   * agree — a future edit to themes.js that forgets index.html now fails CI
   * instead of silently shipping a stale first paint.
   */
  it.each(Object.entries(VAR_MAP))('seeds %s with the dark-theme value', (cssVar, paletteKey) => {
    expect(indexHtml).toContain(`${cssVar}: ${THEMES.dark[paletteKey]};`);
  });

  it('seeds the derived --ui-accent-soft to match hexToRgba(uiAccent, 0.15)', () => {
    expect(indexHtml).toContain(`--ui-accent-soft: ${hexToRgba(THEMES.dark.uiAccent, 0.15)};`);
  });
});
