/**
 * Dice Renderer
 *
 * Draws stacked dice on each territory, recreating the classic Dice Wars
 * look. Every shape here is the legacy Flash vector art itself
 * (`areadice.js` lib.dice0-7, removed in the modernization; see git history
 * commit 376c7c7^): the compact-encoded CreateJS paths were decoded to
 * absolute coordinates at the on-map die scale (0.085) and are replayed
 * verbatim, so the die matches the original sprites curve for curve:
 *
 * - Each die is a corner-forward isometric cube — a plump cushion-like top
 *   face (short straight edges, huge shallow corner arcs), a mid-tone left
 *   wall, and a near-black silhouette that doubles as the right wall. No
 *   outlines; edge definition comes from face contrast.
 * - Rim wedges at the east/west corners and a bottom crescent tuck between
 *   the faces; a four-pointed glint star sits at the front corner junction.
 * - Every player has a hand-tuned face-color set (the originals were baked
 *   into the art, far more vivid than the pale territory fills).
 * - Pip positions and sizes are the measured legacy values per face and
 *   value; wall pips are narrow ellipses tilted ~55 deg into the wall plane.
 * - Dice in a column overlap deeply (14px pitch on a ~30px die); stacks of
 *   5+ split into a second column behind and to the LEFT of the first.
 * - The drop shadow is a hard-edged, near-solid black blob spilling to the
 *   lower right of the stack (four decoded variants, one per front-column
 *   count).
 *
 * All coordinates are in the unscaled 27x18 hex-cell system.
 *
 * @module renderer/DiceRenderer
 */

import { Container, Graphics, Text } from 'pixi.js';
import { COLORBLIND_PLAYER_COLORS, BORDER_COLOR } from './constants.js';
import { computeCellPositions } from './HexGridRenderer.js';

/* ------------------------------------------------------------------ *
 * Die geometry (origin = die center, y down): flat command arrays
 * decoded from the legacy art. 'M' x y | 'L' x y | 'Q' cx cy x y | 'Z'.
 * Silhouette 27.9 wide x 30.5 tall — one full hex cell wide.
 * ------------------------------------------------------------------ */

/** Silhouette: rounded corner-forward hexagon; also the right wall. */
// prettier-ignore
const CUBE_PATH = ['M', -3.05, 14.52, 'L', -10.53, 9.08, 'Q', -12.76, 6.59, -13.92, 3.3, 'L', -13.92, -3.49, 'Q', -12.46, -7.08, -10.18, -9.61, 'L', -3.73, -14.37, 'Q', -0.26, -15.67, 3.74, -14.37, 'L', 10.54, -9.27, 'Q', 12.64, -7.08, 13.93, -3.83, 'L', 13.93, 3.3, 'Q', 13.1, 6.11, 11.22, 8.4, 'L', 3.06, 14.52, 'Q', 1.52, 14.79, 0, 14.79, 'Q', -1.51, 14.79, -3.05, 14.52, 'Z'];
/** Left wall, from the silhouette's lower-left edge up to the top face. */
// prettier-ignore
const SIDE_PATH = ['M', -3.07, 14.52, 'L', -10.53, 9.08, 'Q', -12.76, 6.59, -13.92, 3.32, 'L', -13.92, -3.48, 'Q', -12.19, -4.6, -10.18, -3.82, 'L', -3.4, 1.28, 'Q', -1.05, 3.48, 0, 6.7, 'L', 0, 13.5, 'Q', -0.85, 14.54, -2.62, 14.54, 'Q', -2.84, 14.54, -3.07, 14.52, 'Z'];
/** Top face: fat rounded diamond (the legacy "cushion" face). */
// prettier-ignore
const TOP_PATH = ['M', -3.38, 1.26, 'L', -10.18, -3.84, 'Q', -12.61, -6.23, -10.18, -9.6, 'L', -3.72, -14.36, 'Q', -0.25, -15.67, 3.74, -14.36, 'L', 10.54, -9.27, 'Q', 12.21, -6.45, 10.54, -4.18, 'L', 3.4, 1.26, 'Q', 1.74, 2.14, 0.04, 2.14, 'Q', -1.64, 2.14, -3.38, 1.26, 'Z'];
/** Specular glint: four-pointed star at the front corner junction. */
// prettier-ignore
const GLINT_PATH = ['M', -3.38, 1.28, 'Q', 0, 1.96, 3.39, 1.28, 'Q', 0.88, 3.72, 0, 6.7, 'Q', -1.04, 3.48, -3.38, 1.28, 'Z'];
/** Rim wedges between top face and silhouette at the west/east corners. */
// prettier-ignore
const LEFT_RIM_PATH = ['M', -10.2, -9.6, 'Q', -11.53, -6.39, -10.2, -3.84, 'Q', -12.19, -4.61, -13.92, -3.49, 'Q', -12.46, -7.08, -10.2, -9.6, 'Z'];
// prettier-ignore
const RIGHT_RIM_PATH = ['M', 10.56, -4.17, 'Q', 11.53, -6.47, 10.56, -9.26, 'Q', 12.64, -7.08, 13.93, -3.84, 'Q', 12.3, -5.01, 10.56, -4.17, 'Z'];
/** Thin crescent hugging the silhouette's bottom vertex. */
// prettier-ignore
const BOTTOM_RIM_PATH = ['M', -3.05, 14.52, 'Q', -0.93, 14.65, 0, 13.52, 'Q', 1.07, 14.53, 3.06, 14.52, 'Q', 1.52, 14.78, 0, 14.78, 'Q', -1.51, 14.78, -3.05, 14.52, 'Z'];

/** Vertical distance between stacked dice — 46% of the die height, so each die nests deep into the one above. */
const STACK_PITCH = 14;
/** Max dice per column; counts above this start a second column. */
const COLUMN_MAX = 4;
/** Offset of the back column (dice 5-8): left of and slightly above the front column, drawn behind it. */
const BACK_COLUMN_X = -20.5;
const BACK_COLUMN_Y = -8;
/** Front-column base die center, relative to the center cell's top-left corner. */
const ANCHOR_X = 9.75;
const ANCHOR_Y = 11.9;

/** Count-badge geometry for number-only display mode (before map scaling). */
const BADGE_CENTER_X = 3.75;
const BADGE_CENTER_Y = -4;
const BADGE_RADIUS = 12.35;
const BADGE_FONT_SIZE = 16;

/* ------------------------------------------------------------------ *
 * Face colors
 * ------------------------------------------------------------------ */

/** Pip colors per visible face for dark-bodied dice (white ramp) and light-bodied dice (all black). */
const WHITE_PIPS = { top: 0xffffff, side: 0xcccccc, base: 0x999999 };
const BLACK_PIPS = { top: 0x000000, side: 0x000000, base: 0x000000 };

/**
 * Per-player die colors, decoded from the legacy sprites. `top` is the
 * bright identity color, `side` the left wall, `base` the silhouette /
 * right wall; `glint` is the specular star at the front corner and the
 * rim colors are the thin edge accents.
 */
export const DICE_COLORS = [
  // 0: Lavender territory → electric violet dice
  {
    top: 0x7502e6,
    side: 0x4a0094,
    base: 0x330067,
    glint: 0xb544ff,
    leftRim: 0x6500c9,
    rightRim: 0x330067,
    bottomRim: 0x0a0013,
    pips: WHITE_PIPS,
  },
  // 1: Lime territory → grass-green dice
  {
    top: 0x75e602,
    side: 0x4a9400,
    base: 0x1c3700,
    glint: 0xaaff39,
    leftRim: 0x69d100,
    rightRim: 0x336700,
    bottomRim: 0x172e00,
    pips: BLACK_PIPS,
  },
  // 2: Dark green territory → forest-green dice
  {
    top: 0x027502,
    side: 0x004a00,
    base: 0x001c00,
    glint: 0x48ba48,
    leftRim: 0x006600,
    rightRim: 0x003300,
    bottomRim: 0x001100,
    pips: WHITE_PIPS,
  },
  // 3: Magenta territory → hot-pink dice
  {
    top: 0xff2396,
    side: 0x97004c,
    base: 0x3c001e,
    glint: 0xff5bc5,
    leftRim: 0xcc0166,
    rightRim: 0x620031,
    bottomRim: 0x33001a,
    pips: WHITE_PIPS,
  },
  // 4: Orange territory → amber/brown dice
  {
    top: 0xe67f02,
    side: 0x945100,
    base: 0x371e00,
    glint: 0xffb132,
    leftRim: 0xd07200,
    rightRim: 0x6e3c00,
    bottomRim: 0x130b00,
    pips: BLACK_PIPS,
  },
  // 5: Cyan territory → teal dice
  {
    top: 0x02e6e6,
    side: 0x009494,
    base: 0x003737,
    glint: 0x39ffff,
    leftRim: 0x00d0d0,
    rightRim: 0x006a6a,
    bottomRim: 0x002020,
    pips: BLACK_PIPS,
  },
  // 6: Yellow territory → golden dice
  {
    top: 0xf5f50f,
    side: 0x949400,
    base: 0x373700,
    glint: 0xffff7a,
    leftRim: 0xd3d300,
    rightRim: 0x626200,
    bottomRim: 0x2e2e00,
    pips: BLACK_PIPS,
  },
  // 7: Red territory → crimson dice
  {
    top: 0xd50202,
    side: 0x890000,
    base: 0x330000,
    glint: 0xff5858,
    leftRim: 0xc30000,
    rightRim: 0x5c0000,
    bottomRim: 0x2a0000,
    pips: WHITE_PIPS,
  },
];

/**
 * Visible face values per player: [top, left, right], counted straight off
 * the legacy sprites (every die in a stack shows the same faces). The art
 * reuses triples — violet and yellow share [1, 4, 2], orange and red share
 * [5, 3, 6] — and each triple avoids opposite-face pairs (which sum to 7)
 * so the die is physically possible.
 */
export const DIE_FACES = [
  [1, 4, 2], // lavender — giant white top pip
  [4, 6, 2], // lime
  [3, 5, 1], // dark green
  [2, 3, 1], // magenta
  [5, 3, 6], // orange
  [6, 2, 4], // cyan
  [1, 4, 2], // yellow — giant black top pip
  [5, 3, 6], // red
];

/* ------------------------------------------------------------------ *
 * Pip tables, decoded from the legacy sprites. Positions are
 * die-center-relative; the art hand-places each face's pips (bigger pips
 * and tighter spacing on low values), so a parametric grid can't match.
 * Top pips are axis-aligned ellipses; wall pips replay a canonical
 * decoded pip path (centered on its bounds) at each position.
 * ------------------------------------------------------------------ */

// prettier-ignore
const TOP_PIPS = {
  1: { rx: 6.07, ry: 4.63, pts: [[0.05, -6.7]] },
  2: { rx: 2.93, ry: 2.21, pts: [[0.02, -2.46], [0.06, -10.57]] },
  3: { rx: 2.23, ry: 1.62, pts: [[-7.06, -6.78], [-0.14, -6.75], [6.83, -6.79]] },
  4: { rx: 1.96, ry: 1.42, pts: [[-0.17, -1.44], [6.8, -6.58], [-7.17, -6.58], [-0.17, -11.71]] },
  5: { rx: 1.95, ry: 1.44, pts: [[-0.02, -1.38], [6.87, -6.61], [-0.02, -6.61], [-6.95, -6.61], [-0.06, -11.73]] },
  6: { rx: 1.96, ry: 1.47, pts: [[-0.83, -1.11], [3.35, -4.23], [-7.72, -6.23], [7.57, -7.28], [-3.57, -9.29], [0.54, -12.32]] },
};

/* Canonical wall pip shapes (one per face value; the art stamps copies). */
// prettier-ignore
const PIP_L2 = ['M', 0.42, 2.35, 'Q', -0.44, 1.94, -1.16, 0.99, 'Q', -1.89, 0.03, -2.07, -0.91, 'Q', -2.24, -1.84, -1.76, -2.21, 'Q', -1.28, -2.58, -0.43, -2.16, 'Q', 0.43, -1.74, 1.16, -0.78, 'Q', 1.88, 0.17, 2.06, 1.11, 'Q', 2.24, 2.04, 1.76, 2.41, 'Q', 1.53, 2.58, 1.23, 2.58, 'Q', 0.88, 2.58, 0.42, 2.35, 'Z'];
// prettier-ignore
const PIP_L3 = ['M', 0.28, 1.71, 'Q', -0.34, 1.39, -0.86, 0.7, 'Q', -1.38, -0.01, -1.5, -0.67, 'Q', -1.61, -1.35, -1.26, -1.62, 'Q', -0.91, -1.88, -0.28, -1.57, 'Q', 0.34, -1.26, 0.85, -0.58, 'Q', 1.37, 0.13, 1.49, 0.81, 'Q', 1.61, 1.5, 1.25, 1.76, 'Q', 1.09, 1.88, 0.87, 1.88, 'Q', 0.62, 1.88, 0.28, 1.71, 'Z'];
// prettier-ignore
const PIP_L4 = ['M', 0.23, 1.6, 'Q', -0.37, 1.36, -0.86, 0.74, 'Q', -1.35, 0.11, -1.44, -0.52, 'Q', -1.54, -1.17, -1.18, -1.44, 'Q', -0.83, -1.72, -0.23, -1.48, 'Q', 0.37, -1.24, 0.86, -0.61, 'Q', 1.35, 0.01, 1.44, 0.65, 'Q', 1.54, 1.3, 1.18, 1.58, 'Q', 0.99, 1.72, 0.74, 1.72, 'Q', 0.51, 1.72, 0.23, 1.6, 'Z'];
// prettier-ignore
const PIP_L5 = ['M', 0.29, 1.57, 'Q', -0.28, 1.28, -0.77, 0.64, 'Q', -1.26, 0, -1.39, -0.62, 'Q', -1.5, -1.24, -1.19, -1.48, 'Q', -0.87, -1.72, -0.3, -1.44, 'Q', 0.27, -1.15, 0.77, -0.53, 'Q', 1.26, 0.11, 1.38, 0.74, 'Q', 1.5, 1.36, 1.18, 1.61, 'Q', 1.04, 1.72, 0.83, 1.72, 'Q', 0.6, 1.72, 0.29, 1.57, 'Z'];
// prettier-ignore
const PIP_L6 = ['M', 0.23, 1.52, 'Q', -0.32, 1.25, -0.77, 0.64, 'Q', -1.23, 0.03, -1.33, -0.58, 'Q', -1.42, -1.18, -1.1, -1.42, 'Q', -0.79, -1.66, -0.23, -1.39, 'Q', 0.32, -1.12, 0.77, -0.51, 'Q', 1.23, 0.1, 1.32, 0.71, 'Q', 1.42, 1.31, 1.1, 1.55, 'Q', 0.96, 1.66, 0.75, 1.66, 'Q', 0.52, 1.66, 0.23, 1.52, 'Z'];
// prettier-ignore
const PIP_R1 = ['M', -3.59, 5.13, 'Q', -4.59, 4.41, -4.23, 2.45, 'Q', -3.87, 0.49, -2.38, -1.53, 'Q', -0.89, -3.57, 0.85, -4.51, 'Q', 2.6, -5.44, 3.59, -4.72, 'Q', 4.59, -4, 4.23, -2.04, 'Q', 3.88, -0.08, 2.38, 1.94, 'Q', 0.9, 3.98, -0.85, 4.92, 'Q', -1.83, 5.44, -2.58, 5.44, 'Q', -3.16, 5.44, -3.59, 5.13, 'Z'];
// prettier-ignore
const PIP_R2 = ['M', -1.65, 2.5, 'Q', -2.15, 2.16, -2.01, 1.22, 'Q', -1.87, 0.27, -1.19, -0.72, 'Q', -0.5, -1.72, 0.33, -2.18, 'Q', 1.16, -2.64, 1.65, -2.3, 'Q', 2.15, -1.96, 2.01, -1.02, 'Q', 1.87, -0.08, 1.19, 0.92, 'Q', 0.51, 1.91, -0.33, 2.37, 'Q', -0.81, 2.64, -1.18, 2.64, 'Q', -1.44, 2.64, -1.65, 2.5, 'Z'];
// prettier-ignore
const PIP_R4 = ['M', -1.16, 1.72, 'Q', -1.48, 1.5, -1.36, 0.86, 'Q', -1.25, 0.21, -0.77, -0.48, 'Q', -0.28, -1.16, 0.28, -1.49, 'Q', 0.85, -1.81, 1.16, -1.59, 'Q', 1.48, -1.36, 1.36, -0.72, 'Q', 1.25, -0.08, 0.77, 0.6, 'Q', 0.28, 1.29, -0.28, 1.61, 'Q', -0.62, 1.81, -0.86, 1.81, 'Q', -1.03, 1.81, -1.16, 1.72, 'Z'];
// prettier-ignore
const PIP_R6 = ['M', -1.23, 1.66, 'Q', -1.54, 1.42, -1.41, 0.78, 'Q', -1.27, 0.15, -0.76, -0.51, 'Q', -0.25, -1.18, 0.34, -1.48, 'Q', 0.91, -1.77, 1.23, -1.53, 'Q', 1.54, -1.29, 1.41, -0.65, 'Q', 1.27, 0, 0.76, 0.65, 'Q', 0.25, 1.31, -0.33, 1.61, 'Q', -0.65, 1.77, -0.89, 1.77, 'Q', -1.08, 1.77, -1.23, 1.66, 'Z'];

// prettier-ignore
const LEFT_PIPS = {
  2: { path: PIP_L2, pts: [[-9.84, 5.42], [-4.23, 4.34]] },
  3: { path: PIP_L3, pts: [[-10.43, 5.83], [-6.99, 5.08], [-3.46, 4.36]] },
  4: { path: PIP_L4, pts: [[-3.42, 10.81], [-10.29, 5.59], [-3.5, 4.27], [-10.33, -0.95]] },
  5: { path: PIP_L5, pts: [[-3.63, 10.72], [-10.55, 5.64], [-7.1, 4.93], [-3.6, 4.18], [-10.52, -0.86]] },
  6: { path: PIP_L6, pts: [[-3.01, 11.45], [-7.21, 8.37], [-11.34, 5.29], [-3.01, 4.93], [-7.17, 1.85], [-11.34, -1.33]] },
};

// prettier-ignore
const RIGHT_PIPS = {
  1: { path: PIP_R1, pts: [[6.85, 5.04]] },
  2: { path: PIP_R2, pts: [[4.31, 9.5], [9.73, 0.15]] },
  4: { path: PIP_R4, pts: [[3.39, 10.86], [10.33, 5.59], [3.36, 4.29], [10.26, -0.91]] },
  6: { path: PIP_R6, pts: [[3.47, 11.5], [3.42, 7.59], [10.47, 6.37], [3.47, 3.65], [10.47, 2.43], [10.43, -1.39]] },
};

/**
 * Darken a color by a factor (0-1).
 * @param {number} color - Hex int color
 * @param {number} factor - 0 = black, 1 = original
 * @returns {number}
 */
function darken(color, factor) {
  const r = Math.floor(((color >> 16) & 0xff) * factor);
  const g = Math.floor(((color >> 8) & 0xff) * factor);
  const b = Math.floor((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/**
 * Lighten a color toward white by an amount (0-1).
 * @param {number} color - Hex int color
 * @param {number} amount - 0 = original, 1 = white
 * @returns {number}
 */
function lighten(color, amount) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return (lr << 16) | (lg << 8) | lb;
}

/** Rec.601 luminance of a hex int color (0-255). */
function luminance(color) {
  return 0.299 * ((color >> 16) & 0xff) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff);
}

/**
 * Derive a die color set for palettes without hand-tuned art (color-blind
 * mode), using the shading ratios measured from the legacy dice: brilliant
 * top, side = 0.63x top, base = 0.24x top.
 * @param {number} fill - Player territory color
 * @returns {typeof DICE_COLORS[0]}
 */
export function deriveDieColors(fill) {
  const max = Math.max((fill >> 16) & 0xff, (fill >> 8) & 0xff, fill & 0xff);
  if (max === 0) {
    // A pure black fill can't be brightened — give the black player classic white dice
    return {
      top: 0xf2f2f2,
      side: 0xbfbfbf,
      base: 0x4d4d4d,
      glint: 0xffffff,
      leftRim: 0xd9d9d9,
      rightRim: 0x808080,
      bottomRim: 0x1a1a1a,
      pips: BLACK_PIPS,
    };
  }
  const f = Math.min(2, 224 / max);
  const top =
    (Math.min(255, Math.round(((fill >> 16) & 0xff) * f)) << 16) |
    (Math.min(255, Math.round(((fill >> 8) & 0xff) * f)) << 8) |
    Math.min(255, Math.round((fill & 0xff) * f));
  return {
    top,
    side: darken(top, 0.63),
    base: darken(top, 0.24),
    glint: lighten(top, 0.5),
    leftRim: darken(top, 0.8),
    rightRim: darken(top, 0.42),
    bottomRim: darken(top, 0.1),
    pips: luminance(top) < 145 ? WHITE_PIPS : BLACK_PIPS,
  };
}

export const COLORBLIND_DICE_COLORS = COLORBLIND_PLAYER_COLORS.map(deriveDieColors);

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/**
 * Replay a decoded path command array into a Graphics, offset by (dx, dy).
 * @param {Graphics} gfx
 * @param {Array<string | number>} path - Flat 'M'/'L'/'Q'/'Z' command array
 * @param {number} dx
 * @param {number} dy
 * @param {number} sx - X sign/scale (-1 mirrors the path across x = 0)
 */
function drawPath(gfx, path, dx = 0, dy = 0, sx = 1) {
  let i = 0;
  const X = () => path[i++] * sx + dx;
  const Y = () => path[i++] + dy;
  while (i < path.length) {
    const op = path[i++];
    if (op === 'M') gfx.moveTo(X(), Y());
    else if (op === 'L') gfx.lineTo(X(), Y());
    else if (op === 'Q') gfx.quadraticCurveTo(X(), Y(), X(), Y());
    else gfx.closePath();
  }
}

/**
 * Draw the pips of one visible face from the measured legacy tables.
 *
 * @param {Graphics} gfx
 * @param {number} value - Face value (1-6)
 * @param {number} x - Die center x
 * @param {number} y - Die center y
 * @param {'top' | 'left' | 'right'} face
 * @param {number} color - Pip color
 */
function drawFacePips(gfx, value, x, y, face, color) {
  if (face === 'top') {
    const t = TOP_PIPS[value] || TOP_PIPS[1];
    for (const [px, py] of t.pts) {
      gfx.ellipse(x + px, y + py, t.rx, t.ry);
      gfx.fill(color);
    }
    return;
  }

  /*
   * Wall faces. The art composes each wall's pips by hand (the two walls
   * are NOT mirror images — e.g. a 6 runs 3x2 on the left wall but 2x3 on
   * the right), so each wall has its own table; values the art never put
   * on a wall fall back to the other wall's layout, mirrored.
   */
  const own = face === 'left' ? LEFT_PIPS : RIGHT_PIPS;
  const other = face === 'left' ? RIGHT_PIPS : LEFT_PIPS;
  const src = own[value] ? { ...own[value], m: 1 } : { ...(other[value] || other[1]), m: -1 };
  for (const [px, py] of src.pts) {
    drawPath(gfx, src.path, x + px * src.m, y + py, src.m);
    gfx.fill(color);
  }
}

/**
 * Draw a single die (corner-forward isometric cube) centered at (x, y),
 * replaying the decoded legacy paths in the original layer order:
 * silhouette, left wall, top face, rim accents, glint, pips.
 *
 * @param {Graphics} gfx
 * @param {number} x - Die center x
 * @param {number} y - Die center y
 * @param {typeof DICE_COLORS[0]} c - Face color set
 * @param {number[]} faces - [top, left, right] face values
 */
function drawDie(gfx, x, y, c, faces) {
  drawPath(gfx, CUBE_PATH, x, y);
  gfx.fill(c.base);
  drawPath(gfx, SIDE_PATH, x, y);
  gfx.fill(c.side);
  drawPath(gfx, TOP_PATH, x, y);
  gfx.fill(c.top);
  drawPath(gfx, LEFT_RIM_PATH, x, y);
  gfx.fill(c.leftRim);
  drawPath(gfx, RIGHT_RIM_PATH, x, y);
  gfx.fill(c.rightRim);
  drawPath(gfx, BOTTOM_RIM_PATH, x, y);
  gfx.fill(c.bottomRim);
  drawPath(gfx, GLINT_PATH, x, y);
  gfx.fill(c.glint);

  drawFacePips(gfx, faces[0], x, y, 'top', c.pips.top);
  drawFacePips(gfx, faces[1], x, y, 'left', c.pips.side);
  drawFacePips(gfx, faces[2], x, y, 'right', c.pips.base);
}

/**
 * Cast shadows decoded from the legacy stage: a hard-edged, near-solid
 * black blob (legacy fill rgba(0,0,0,0.914)) spilling to the lower right
 * of the front column, one variant per front-column count. Coordinates
 * are relative to the front column's base die center. The back column
 * casts no shadow, matching the original sprites.
 */
// prettier-ignore
const SHADOW_PATHS = [
  ['M', 2.6, 16.8, 'L', 2.4, 16.8, 'L', -3.6, 14.7, 'L', -3.7, 14.6, 'L', -10.7, 9.7, 'L', -10.8, 9.6, 'L', -11.8, 8.6, 'L', -11.9, 8.3, 'L', -11.6, 7.8, 'L', 3.1, 0.7, 'L', 3.1, -2.4, 'L', 4.4, -3, 'L', 4.6, -3.1, 'L', 14.9, -3.1, 'L', 14.9, -2.9, 'Q', 17.6, -2.6, 20.8, -1.1, 'Q', 24, 1.6, 26.6, 4.7, 'Q', 27.5, 6.7, 26.6, 8.6, 'Q', 24.4, 11.4, 21.4, 13.8, 'Q', 19.2, 15.6, 14.9, 16.6, 'L', 14.9, 16.8, 'Z'],
  ['M', 2.6, 16.8, 'L', 2.4, 16.8, 'L', -3.6, 14.7, 'L', -3.7, 14.6, 'L', -10.7, 9.7, 'L', -10.8, 9.6, 'L', -11.8, 8.6, 'L', -11.9, 8.3, 'L', -11.6, 7.8, 'L', 10.2, -3, 'L', 10.4, -3.1, 'L', 20.9, -3.1, 'L', 20.9, -2.3, 'Q', 22.3, -1.8, 23.8, -1.1, 'Q', 27, 1.6, 29.6, 4.7, 'Q', 30.5, 6.7, 29.6, 8.6, 'Q', 27.4, 11.4, 24.4, 13.8, 'Q', 23, 14.9, 20.9, 15.7, 'L', 20.9, 16.8, 'Z'],
  ['M', 2.6, 16.8, 'L', 2.4, 16.8, 'L', -3.6, 14.7, 'L', -3.7, 14.6, 'L', -10.7, 9.7, 'L', -10.8, 9.6, 'L', -11.8, 8.6, 'L', -11.9, 8.3, 'L', -11.6, 7.8, 'L', 10.4, -3, 'L', 10.5, -3.1, 'L', 20.9, -3.1, 'L', 20.9, -2.9, 'Q', 23.6, -2.6, 26.8, -1.1, 'Q', 30, 1.6, 32.6, 4.7, 'Q', 33.5, 6.7, 32.6, 8.6, 'Q', 30.4, 11.4, 27.4, 13.8, 'Q', 25.2, 15.6, 20.9, 16.6, 'L', 20.9, 16.8, 'Z'],
  ['M', 2.6, 16.8, 'L', 2.4, 16.8, 'L', -3.6, 14.7, 'L', -3.7, 14.6, 'L', -10.7, 9.7, 'L', -10.8, 9.6, 'L', -11.8, 8.6, 'L', -11.9, 8.3, 'L', -11.6, 7.8, 'L', 10.4, -3, 'L', 10.6, -3.1, 'L', 22.7, -3.1, 'Q', 26, -2.9, 29.8, -1.1, 'Q', 33, 1.6, 35.6, 4.7, 'Q', 36.5, 6.7, 35.6, 8.6, 'Q', 33.4, 11.4, 30.4, 13.8, 'Q', 28, 15.7, 23, 16.8, 'Z'],
];

/**
 * Draw the stack's cast shadow.
 * @param {Graphics} gfx
 * @param {number} frontCount - Dice in the front column (1-4)
 */
function drawShadow(gfx, frontCount) {
  drawPath(gfx, SHADOW_PATHS[Math.min(Math.max(frontCount, 1), 4) - 1]);
  gfx.fill({ color: 0x000000, alpha: 0.914 });
}

export class DiceRenderer {
  /**
   * @param {Container} parent - Container to add dice into (typically the hex grid container)
   */
  constructor(parent) {
    this._parent = parent;
    /** @type {Container} */
    this.container = new Container();
    parent.addChild(this.container);

    /** @type {Container[]} One container per area (indexed by areaId) */
    this._diceContainers = [];
    /** @type {boolean} Color-blind mode */
    this._colorBlindMode = false;
    /** @type {'dice' | 'number'} How dice counts are shown */
    this._displayMode = 'dice';
  }

  /**
   * Toggle color-blind mode.
   * @param {boolean} enabled
   */
  setColorBlindMode(enabled) {
    this._colorBlindMode = enabled;
  }

  /**
   * Set how dice counts are shown: stacked dice or a single count badge.
   * @param {'dice' | 'number'} mode
   */
  setDiceDisplayMode(mode) {
    this._displayMode = mode === 'number' ? 'number' : 'dice';
  }

  /**
   * Get the die color set for a player, respecting color-blind mode.
   * @param {number} owner
   * @returns {typeof DICE_COLORS[0]}
   */
  _getDieColors(owner) {
    const palette = this._colorBlindMode ? COLORBLIND_DICE_COLORS : DICE_COLORS;
    return palette[owner % palette.length];
  }

  /**
   * Draw dice on all territories.
   * @param {import('../engine/types.js').GameState} state
   */
  drawAll(state) {
    const { grid, areas } = state;

    // Recompute cell positions each draw to handle map size changes between games
    this._cellPos = computeCellPositions(grid.width, grid.height);

    // Ensure we have enough containers
    while (this._diceContainers.length < areas.length) {
      this._diceContainers.push(null);
    }

    /*
     * Sort by center cell index (row-major) for z-ordering like the legacy
     * game: southern stacks paint over northern ones, and within a row
     * east over west — the back column leans left over the west neighbor.
     */
    const sortedAreas = [];
    for (let a = 1; a < areas.length; a++) {
      const area = areas[a];
      if (!area || area.size === 0) continue;
      sortedAreas.push(a);
    }
    sortedAreas.sort((a, b) => areas[a].centerCell - areas[b].centerCell);

    // Remove and dispose existing dice containers (Graphics + Text) to avoid GPU leaks
    for (const child of this.container.removeChildren()) {
      child.destroy({ children: true });
    }

    for (const areaId of sortedAreas) {
      const area = areas[areaId];
      this._drawAreaDice(areaId, area);
    }
  }

  /**
   * Draw dice for a single area.
   * @param {number} areaId
   * @param {import('../engine/types.js').Area} area
   */
  _drawAreaDice(areaId, area) {
    if (area.owner < 0 || area.dice <= 0) return;

    const diceContainer = new Container();
    const centerCell = area.centerCell;
    // Pixel-snapped like the legacy draw_areadice
    diceContainer.x = Math.floor(this._cellPos.x[centerCell] + ANCHOR_X);
    diceContainer.y = Math.floor(this._cellPos.y[centerCell] + ANCHOR_Y);

    if (this._displayMode === 'number') {
      this._drawCountBadge(diceContainer, area);
    } else {
      this._drawDiceStack(diceContainer, area);
    }

    this._diceContainers[areaId] = diceContainer;
    this.container.addChild(diceContainer);
  }

  /**
   * Draw the classic stacked-dice representation into an area container.
   * The container origin is the front column's base die center.
   * @param {Container} container
   * @param {import('../engine/types.js').Area} area
   */
  _drawDiceStack(container, area) {
    const colors = this._getDieColors(area.owner);
    const faces = DIE_FACES[area.owner % DIE_FACES.length];
    const gfx = new Graphics();

    const frontCount = Math.min(area.dice, COLUMN_MAX);
    const backCount = area.dice - frontCount;

    drawShadow(gfx, frontCount);

    /*
     * Back column first, then the front column paints over it. Within a
     * column, draw bottom die first so upper dice nest over lower ones.
     */
    for (let i = 0; i < backCount; i++) {
      drawDie(gfx, BACK_COLUMN_X, BACK_COLUMN_Y - i * STACK_PITCH, colors, faces);
    }
    for (let i = 0; i < frontCount; i++) {
      drawDie(gfx, 0, -i * STACK_PITCH, colors, faces);
    }

    container.addChild(gfx);
  }

  /**
   * Draw a compact owner-colored badge showing the dice count, used when the
   * display mode is 'number'. Reuses the dice palette and dark outline so the
   * owner stays identifiable at a glance.
   * @param {Container} container
   * @param {import('../engine/types.js').Area} area
   */
  _drawCountBadge(container, area) {
    const colors = this._getDieColors(area.owner);
    const gfx = new Graphics();

    // Soft drop shadow — the badge floats, unlike the seated dice stacks
    gfx.ellipse(BADGE_CENTER_X, 6, 13.65, 4.94);
    gfx.fill({ color: 0x000000, alpha: 0.3 });

    // Owner-colored chip with a dark outline
    gfx.circle(BADGE_CENTER_X, BADGE_CENTER_Y, BADGE_RADIUS);
    gfx.fill(colors.top);
    gfx.stroke({ width: 1.5, color: BORDER_COLOR, join: 'round' });
    container.addChild(gfx);

    // White, dark-outlined numeral reads on every owner color
    const label = new Text({
      text: String(area.dice),
      style: {
        fontFamily: 'Anton, sans-serif',
        fontSize: BADGE_FONT_SIZE,
        fill: 0xffffff,
        stroke: { color: BORDER_COLOR, width: 3 },
      },
      x: BADGE_CENTER_X,
      y: BADGE_CENTER_Y,
      anchor: { x: 0.5, y: 0.5 },
    });
    container.addChild(label);
  }

  /** Clean up. */
  destroy() {
    this.container.destroy({ children: true });
  }
}
