// @vitest-environment jsdom
/**
 * Theme definitions tests
 */

import { THEMES, getTheme } from '../../src/renderer/themes.js';
import { PLAYER_COLORS, COLORBLIND_PLAYER_COLORS } from '../../src/renderer/constants.js';

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
