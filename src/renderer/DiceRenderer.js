/**
 * Dice Renderer
 *
 * Draws stacked dice on each territory, recreating the classic Dice Wars
 * look. Geometry, colors, stack layout, and shadow are decoded from the
 * legacy Flash vector art (`areadice.js` lib.dice0-7, removed in the
 * modernization; see git history commit 376c7c7^) so the modern renderer
 * matches the original sprites:
 *
 * - Each die is a corner-forward isometric cube — a large diamond top face,
 *   a mid-tone left wall, and a near-black silhouette that doubles as the
 *   right wall. No outlines; edge definition comes from face contrast.
 * - Every player has a hand-tuned face-color set (the originals were baked
 *   into the art, far more vivid than the pale territory fills).
 * - Dice in a column overlap deeply (14px pitch on a ~30px die); stacks of
 *   5+ split into a second column behind and to the LEFT of the first.
 * - The drop shadow is a hard-edged, near-solid black blob spilling to the
 *   lower right of the stack.
 *
 * All coordinates are in the unscaled 27x18 hex-cell system.
 *
 * @module renderer/DiceRenderer
 */

import { Container, Graphics, Text } from 'pixi.js';
import { COLORBLIND_PLAYER_COLORS, BORDER_COLOR } from './constants.js';
import { computeCellPositions } from './HexGridRenderer.js';
import { getPipPositions } from './dicePips.js';

/* ------------------------------------------------------------------ *
 * Die geometry (origin = die center, y down), from the legacy art at
 * its on-map scale: silhouette 27.8 wide x 30.4 tall — one full hex
 * cell wide, unlike the old 13px box dice.
 * ------------------------------------------------------------------ */

/** Silhouette half-width; side edges run vertically at +/- this x. */
const HALF_W = 13.9;
/** Silhouette top / bottom vertices. */
const TOP_Y = -15.6;
const BOTTOM_Y = 14.8;
/** Vertical extent of the flat side edges. */
const SIDE_Y = 3.4;
/** Top-face diamond corners (N shares the silhouette top vertex). */
const DIAMOND_E = 12.4;
const DIAMOND_S = 2.1;
/** Top-face center, midpoint of the diamond's vertical diagonal. */
const TOP_FACE_CY = (TOP_Y + DIAMOND_S) / 2;

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
 * Visible face values per player: [top, left, right]. Fixed like the
 * baked legacy art (every die in a stack shows the same faces), and each
 * triple avoids opposite-face pairs (which sum to 7) so the die is
 * physically possible.
 */
export const DIE_FACES = [
  [1, 4, 2], // lavender — giant white top pip, like the original
  [6, 2, 4], // lime
  [3, 5, 1], // dark green
  [2, 3, 1], // magenta
  [4, 2, 6], // orange
  [2, 6, 3], // cyan
  [1, 5, 3], // yellow — giant black top pip, like the original
  [5, 3, 6], // red
];

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
 * Append a rotated-ellipse polygon (PixiJS ellipse() is axis-aligned only).
 * @param {Graphics} gfx
 * @param {number} cx
 * @param {number} cy
 * @param {number} rx
 * @param {number} ry
 * @param {number} angle - Rotation in radians
 */
function tiltedEllipse(gfx, cx, cy, rx, ry, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    const ex = Math.cos(t) * rx;
    const ey = Math.sin(t) * ry;
    pts.push(cx + ex * cos - ey * sin, cy + ex * sin + ey * cos);
  }
  gfx.poly(pts, true);
}

/**
 * Append a thin quad along a segment — used for the rim edge accents.
 * @param {Graphics} gfx
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} w - Strip width
 */
function strip(gfx, x1, y1, x2, y2, w) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * (w / 2);
  const py = (dx / len) * (w / 2);
  gfx.poly([x1 + px, y1 + py, x2 + px, y2 + py, x2 - px, y2 - py, x1 - px, y1 - py], true);
}

/**
 * Draw the pips of one visible face.
 *
 * The pip grid follows the face plane: unit grid offsets from
 * getPipPositions are mapped through the face's two edge vectors, so pips
 * foreshorten like the original art.
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
    const cy = y + TOP_FACE_CY;
    if (value === 1) {
      // Signature oversized single pip on a "1" top face
      gfx.ellipse(x, cy, 5.0, 3.8);
      gfx.fill(color);
      return;
    }
    // Chunky pips like the original; slightly smaller when six must fit
    const rx = value <= 3 ? 2.35 : 2.0;
    const ry = value <= 3 ? 1.75 : 1.5;
    for (const [gx, gy] of getPipPositions(value, 1)) {
      gfx.ellipse(x + (gx - gy) * 3.45, cy + (gx + gy) * 2.6, rx, ry);
      gfx.fill(color);
    }
    return;
  }

  /*
   * Wall faces: grid axes along the wall's top edge and downward edge,
   * pips drawn as portrait ovals tilted ~34 deg into the wall plane (a
   * circle on the wall foreshortens across, not down). The right wall
   * mirrors the left.
   */
  const mirror = face === 'right' ? -1 : 1;
  const cx = x - 6.95 * mirror;
  const cy = y + 5.15;
  const angle = 0.6 * mirror;
  if (value === 1) {
    // Oversized "1" pip covering half the wall, like the original
    tiltedEllipse(gfx, cx, cy, 3.1, 4.1, angle);
    gfx.fill(color);
    return;
  }
  const rx = value <= 3 ? 1.6 : 1.45;
  const ry = value <= 3 ? 2.1 : 1.9;
  for (const [gx, gy] of getPipPositions(value, 1)) {
    const ox = gx * 2.85 + gy * -0.5;
    const oy = gx * 1.93 + gy * 3.3;
    tiltedEllipse(gfx, cx + ox * mirror, cy + oy, rx, ry, angle);
    gfx.fill(color);
  }
}

/**
 * Draw a single die (corner-forward isometric cube) centered at (x, y).
 *
 * @param {Graphics} gfx
 * @param {number} x - Die center x
 * @param {number} y - Die center y
 * @param {typeof DICE_COLORS[0]} c - Face color set
 * @param {number[]} faces - [top, left, right] face values
 */
function drawDie(gfx, x, y, c, faces) {
  // Silhouette: rounded hexagon in the darkest color — also the right wall
  gfx.roundShape(
    [
      { x, y: y + TOP_Y },
      { x: x + HALF_W, y: y - SIDE_Y },
      { x: x + HALF_W, y: y + SIDE_Y },
      { x, y: y + BOTTOM_Y },
      { x: x - HALF_W, y: y + SIDE_Y },
      { x: x - HALF_W, y: y - SIDE_Y },
    ],
    3
  );
  gfx.fill(c.base);

  // Left wall (mid tone), inset a touch so it stays inside the rounded silhouette
  gfx.poly(
    [
      x - DIAMOND_E,
      y - 6.3,
      x,
      y + DIAMOND_S,
      x,
      y + BOTTOM_Y - 0.6,
      x - HALF_W + 0.2,
      y + SIDE_Y,
      x - HALF_W + 0.2,
      y - SIDE_Y + 0.2,
    ],
    true
  );
  gfx.fill(c.side);

  // Top face: rounded diamond in the bright identity color
  gfx.roundShape(
    [
      { x, y: y + TOP_Y },
      { x: x + DIAMOND_E, y: y - 6.3 },
      { x, y: y + DIAMOND_S },
      { x: x - DIAMOND_E, y: y - 6.3 },
    ],
    2.5
  );
  gfx.fill(c.top);

  // Rim accents along the upper silhouette slopes and the bottom vertex
  strip(gfx, x - 13.3, y - 4.1, x - 10.9, y - 9.2, 1.4);
  gfx.fill(c.leftRim);
  strip(gfx, x + 13.3, y - 4.1, x + 10.9, y - 9.2, 1.4);
  gfx.fill(c.rightRim);
  strip(gfx, x - 3, y + 14, x + 3, y + 14, 1.3);
  gfx.fill(c.bottomRim);

  // Specular glint: three-pointed star at the front corner junction
  gfx
    .moveTo(x - 3.3, y + 2.0)
    .quadraticCurveTo(x, y + 4.4, x + 3.3, y + 2.0)
    .quadraticCurveTo(x + 0.6, y + 4.1, x, y + 6.8)
    .quadraticCurveTo(x - 0.6, y + 4.1, x - 3.3, y + 2.0)
    .closePath();
  gfx.fill(c.glint);

  drawFacePips(gfx, faces[0], x, y, 'top', c.pips.top);
  drawFacePips(gfx, faces[1], x, y, 'left', c.pips.side);
  drawFacePips(gfx, faces[2], x, y, 'right', c.pips.base);
}

/**
 * Draw the stack's cast shadow: a hard-edged, near-solid black lozenge
 * spilling to the lower right of the front column (legacy fill was
 * rgba(0,0,0,0.914)). Grows a little with the front-column count; the
 * back column casts no shadow, matching the original sprites.
 *
 * @param {Graphics} gfx
 * @param {number} frontCount - Dice in the front column (1-4)
 */
function drawShadow(gfx, frontCount) {
  const w = 39.4 + 3 * (frontCount - 1);
  const cx = 7.5 + 1.5 * (frontCount - 1);
  const cy = 6.9;
  const h = 9.95;
  const l = cx - w / 2;
  const r = cx + w / 2;
  gfx
    .moveTo(l, cy + 3)
    .lineTo(l + w * 0.3, cy - h)
    .quadraticCurveTo(r + 2, cy - h, r - w * 0.1, cy + h * 0.55)
    .quadraticCurveTo(r - w * 0.3, cy + h, l + w * 0.22, cy + h * 0.5)
    .closePath();
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
