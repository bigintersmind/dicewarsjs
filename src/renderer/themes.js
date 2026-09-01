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
 * unaffected by color-blind mode, which swaps the player and dice palettes,
 * never these. The two never appear at the same time (they belong to the
 * mutually exclusive selectFrom / selectTo phases), so hue alone doesn't have
 * to carry the distinction; the stroke weight and fill density differ as well.
 *
 * Both are drawn over a `candidateHalo` rim, because the player palette is
 * almost entirely BRIGHT (lime, cyan, yellow, lavender): a light ring alone
 * would vanish on half the board. The dark rim under the bright core is what
 * makes a hint legible on any territory in either theme — which is also why the
 * core colors barely differ between themes. It is the territory colors, not the
 * page, that these have to survive, and those are the same in both.
 *
 * Checked against COLORBLIND_PLAYER_COLORS, where the amber target ring has to
 * hold up on the two seats nearest it in hue — the Orange and Yellow seats. It
 * does: the halo separates ring from fill, so it still reads as a ring rather
 * than a shade, and at the other extreme (the Black seat, where the halo itself
 * disappears) the amber core carries it alone. No per-mode target hue is
 * needed. The white attacker rim never has to survive the Black seat — it only
 * ever marks the human's own territories, and GameController pins
 * `humanPlayerIndex` to 0, so the human never gets the Black seat (index 7).
 * Revisit if the human seat becomes selectable.
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
    /*
     * The logotype bevel: a face color plus the extrusion ramp the wordmark's
     * layer stack is built from (titleArt.jsx's exact values). Identity rather
     * than decoration — the screen headline, the rail's current tab and the
     * settings heading are all lettered in it — but tokenized rather than
     * hardcoded, because the orange face only clears WCAG over a DARK ground:
     * on the light theme's pale scrim #ff9c00 measures 1.9:1 against ~4.5:1
     * needed at 15px. Display type owes only 3:1, so it gets its own, lighter
     * face and keeps more of the orange than the small sites can.
     */
    uiBevelFace: '#ff9c00',
    uiBevelFaceDisplay: '#ff9c00',
    uiBevelRim: '#ffff33',
    uiBevelEdge: '#c57900',
    uiBevelShade: '#875300',
    uiBevelDeep: '#4a2d00',
    uiBorder: '#555555',
    bodyBg: '#1a1a2e',
    /*
     * `uiDanger` is the theme's one error/danger color, kept apart from `uiAccent` (the
     * brand hue, which error banners reuse) so a "this is broken" mark never reads as
     * chrome. It is tuned per theme rather than shared: this dark coral only reaches
     * 3.2:1 on the light theme's panels, so the light entry is a deeper red that clears
     * AA there and still separates from the light accent's crimson (#220).
     */
    uiDanger: '#e5534b',
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
    /*
     * The bevel, cast down for the pale scrim: the face drops to a deep amber
     * that measures 5.0:1 at 15px (and 4.9:1 on the settings dropdown, the
     * darker of the two surfaces it lands on), the display face to one that
     * measures 3.5:1 — the lightest steps of this ramp that clear their floor
     * with room to spare. The extrusion steps down with the face so it still
     * reads as a shadow instead of dissolving into it; the rim light stays a
     * lit edge but becomes the wordmark's own #ff9c00, since pale yellow is
     * mush on a near-white ground while the identity orange is visible on it
     * and still clearly lighter than the face it lights.
     */
    uiBevelFace: '#935a00',
    uiBevelFaceDisplay: '#b57000',
    uiBevelRim: '#ff9c00',
    uiBevelEdge: '#6f4400',
    uiBevelShade: '#4a2d00',
    uiBevelDeep: '#241600',
    uiBorder: '#999999',
    bodyBg: '#e8e8f0',
    uiDanger: '#a92d1c',
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
