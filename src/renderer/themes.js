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
    uiTextMuted: '#c9c9d6',
    uiAccent: '#e94560',
    uiBorder: '#555555',
    bodyBg: '#1a1a2e',
    uiScrim: 'rgba(16, 16, 32, 0.68)',
    uiInk: 'rgba(13, 13, 26, 0.92)',
    uiInkSoft: 'rgba(0, 0, 0, 0.55)',
  },
  light: {
    bgColor: 0xe8e8f0,
    borderColor: 0x444466,
    highlightColor: 0xcc0000,
    highlightFill: 0xeeeeee,
    uiBg: 'rgba(255, 255, 255, 0.85)',
    uiOverlayBg: 'rgba(240, 240, 245, 0.9)',
    uiText: '#1a1a2e',
    uiTextMuted: '#3f3f52',
    uiAccent: '#c0283d',
    uiBorder: '#999999',
    bodyBg: '#e8e8f0',
    uiScrim: 'rgba(244, 244, 250, 0.7)',
    uiInk: 'rgba(250, 250, 253, 0.95)',
    uiInkSoft: 'rgba(255, 255, 255, 0.9)',
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
