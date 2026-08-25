/**
 * Theme Definitions
 *
 * Dark and light theme color palettes for both the PixiJS renderer
 * and the Preact UI overlay.
 *
 * @module renderer/themes
 */

/*
 * `candidateAttacker` / `candidateTarget` are the board-hint colors: the
 * outlines that show which of your territories can start an attack right now,
 * and which enemies the selected one can reach. They are deliberately NOT
 * player colors and NOT the selection red — a hint outline must never be
 * mistaken for a seat or for the committed from/to selection — and they are
 * unaffected by color-blind mode, which only swaps the player palette. The two
 * never appear at the same time (they belong to the mutually exclusive
 * selectFrom / selectTo phases), so hue alone doesn't have to carry the
 * distinction; the stroke weight and fill density differ as well.
 *
 * Both are drawn over a `candidateHalo` rim, because the player palette is
 * almost entirely BRIGHT (lime, cyan, yellow, lavender): a light ring alone
 * would vanish on half the board. The dark rim under the bright core is what
 * makes a hint legible on any territory in either theme — which is also why the
 * core colors barely differ between themes. It is the territory colors, not the
 * page, that these have to survive, and those are the same in both.
 *
 * Checked against COLORBLIND_PLAYER_COLORS, where the amber target ring has to
 * hold up on the two seats nearest it in hue — orange 0xe69f00 and yellow
 * 0xf0e442. It does: the halo separates ring from fill, so it still reads as a
 * ring rather than a shade, and at the other extreme (the black 0x000000 seat,
 * where the halo itself disappears) the amber core carries it alone. No
 * per-mode target hue is needed. The white attacker rim never has to survive
 * that black seat — it only ever marks the human's own territories, and the
 * human is always seat 0.
 */
export const THEMES = {
  dark: {
    bgColor: 0x1a1a2e,
    borderColor: 0x222244,
    highlightColor: 0xff0000,
    highlightFill: 0x000000,
    candidateAttacker: 0xffffff,
    candidateTarget: 0xffc233,
    candidateHalo: 0x000000,
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
    candidateAttacker: 0xffffff,
    candidateTarget: 0xffb300,
    candidateHalo: 0x1a1a2e,
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
