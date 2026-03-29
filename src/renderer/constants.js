/**
 * Renderer Constants
 *
 * Visual constants for PixiJS rendering — colors, sizes, layout.
 *
 * @module renderer/constants
 */

/** Player color palette (indexed 0-7), matching the legacy game exactly. */
export const PLAYER_COLORS = [
  0xb37ffe, // 0: Purple
  0xb3ff01, // 1: Lime green
  0x009302, // 2: Dark green
  0xff7ffe, // 3: Magenta/pink
  0xff7f01, // 4: Orange
  0xb3fffe, // 5: Cyan
  0xffff01, // 6: Yellow
  0xff5858, // 7: Red
];

/** Player color palette as CSS hex strings. */
export const PLAYER_COLORS_CSS = [
  '#b37ffe',
  '#b3ff01',
  '#009302',
  '#ff7ffe',
  '#ff7f01',
  '#b3fffe',
  '#ffff01',
  '#ff5858',
];

/** Territory border color. */
export const BORDER_COLOR = 0x222244;

/** Territory border line width (before scaling). */
export const BORDER_WIDTH = 4;

/** Attack highlight border color. */
export const HIGHLIGHT_COLOR = 0xff0000;

/** Attack highlight fill color. */
export const HIGHLIGHT_FILL = 0x000000;

/** Base canvas dimensions (before responsive scaling). */
export const BASE_WIDTH = 840;
export const BASE_HEIGHT = 840;

/** Hex cell pixel dimensions (before scaling). */
export const CELL_WIDTH = 27;
export const CELL_HEIGHT = 18;

/** Top margin for the map. */
export const MAP_TOP_MARGIN = 50;

/** Background color for the canvas. */
export const BG_COLOR = 0x1a1a2e;

/**
 * Small inset for hex vertex positions.
 * In the legacy code this is `3 * scale`, but since we apply scaling via
 * the container transform, we store the unscaled value here.
 */
export const HEX_INSET = 3;

/**
 * Hex vertex offsets relative to a cell's top-left corner.
 *
 * Indexed by direction (0-5, with index 6 == index 0 for wraparound).
 * These produce the pointy-side-up hex shape used in the original game.
 *
 *   ax[d], ay[d] = pixel offset of vertex at direction d
 *
 * The legacy code defines these as:
 *   ax = [w/2, w, w, w/2, 0, 0, w/2]
 *   ay = [-s, s, h-s, h+s, h-s, s, -s]
 *
 * where w = CELL_WIDTH, h = CELL_HEIGHT, s = HEX_INSET.
 */
export const HEX_VERTEX_X = [
  CELL_WIDTH / 2,
  CELL_WIDTH,
  CELL_WIDTH,
  CELL_WIDTH / 2,
  0,
  0,
  CELL_WIDTH / 2, // wrap
];

export const HEX_VERTEX_Y = [
  -HEX_INSET,
  HEX_INSET,
  CELL_HEIGHT - HEX_INSET,
  CELL_HEIGHT + HEX_INSET,
  CELL_HEIGHT - HEX_INSET,
  HEX_INSET,
  -HEX_INSET, // wrap
];
