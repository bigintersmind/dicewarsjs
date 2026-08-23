// @vitest-environment jsdom
/**
 * Theme definitions tests
 */

import { THEMES, getTheme } from '../../src/renderer/themes.js';

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
      // Coaching affordance colors: both themes must define both, or the
      // candidate layer paints `undefined` into a stroke on one of them.
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
