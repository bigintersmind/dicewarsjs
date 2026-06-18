/**
 * Theme Definitions
 *
 * Dark and light theme color palettes for both the PixiJS renderer
 * and the Preact UI overlay.
 *
 * @module renderer/themes
 */

export const THEMES = {
  dark: {
    bgColor: 0x1a1a2e,
    borderColor: 0x222244,
    highlightColor: 0xff0000,
    highlightFill: 0x000000,
    uiBg: 'rgba(0, 0, 0, 0.5)',
    uiOverlayBg: 'rgba(0, 0, 0, 0.75)',
    uiText: '#ffffff',
    uiTextMuted: '#aaaaaa',
    uiAccent: '#e94560',
    uiBorder: '#555555',
    bodyBg: '#1a1a2e',
  },
  light: {
    bgColor: 0xe8e8f0,
    borderColor: 0x444466,
    highlightColor: 0xcc0000,
    highlightFill: 0xeeeeee,
    uiBg: 'rgba(255, 255, 255, 0.85)',
    uiOverlayBg: 'rgba(240, 240, 245, 0.9)',
    uiText: '#1a1a2e',
    uiTextMuted: '#555566',
    uiAccent: '#c0283d',
    uiBorder: '#999999',
    bodyBg: '#e8e8f0',
  },
};

/**
 * Get theme object by name, falling back to dark.
 * @param {string} name
 * @returns {typeof THEMES.dark}
 */
export function getTheme(name) {
  return THEMES[name] || THEMES.dark;
}
