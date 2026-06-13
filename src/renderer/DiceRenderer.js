/**
 * Dice Renderer
 *
 * Draws stacked dice on each territory, recreating the classic Dice Wars
 * look: isometric cubes in the owner's color with pips on the visible
 * faces, dark outlines, and a soft drop shadow. Stacks of 5+ dice split
 * into a second column behind the first, like the original sprite art.
 *
 * @module renderer/DiceRenderer
 */

import { Container, Graphics } from 'pixi.js';
import {
  PLAYER_COLORS,
  COLORBLIND_PLAYER_COLORS,
  PLAYER_PIP_COLORS,
  COLORBLIND_PIP_COLORS,
  BORDER_COLOR,
} from './constants.js';
import { computeCellPositions } from './HexGridRenderer.js';
import { getPipPositions } from './dicePips.js';

/** Dice display settings (before map scaling). */
const DICE_SIZE = 13;
/** Vertical rise of the top face (isometric depth). */
const DICE_DEPTH = DICE_SIZE * 0.35;
/** Horizontal skew of the top/right faces. */
const DICE_SKEW = DICE_SIZE / 2;
/** Max dice per column; counts above this start a second column. */
const COLUMN_MAX = 4;
/** Offset of the back column relative to the front one. */
const BACK_COLUMN_X = DICE_SIZE * 0.8;
const BACK_COLUMN_Y = -DICE_SIZE * 0.35;
/** Container offset from the center cell's top-left corner. */
const DICE_OFFSET_X = 4;
const DICE_OFFSET_Y = 12;

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

/**
 * Boost a color's saturation by pushing channels away from its luminance.
 * @param {number} color - Hex int color
 * @param {number} factor - 1 = unchanged, >1 = more saturated
 * @returns {number}
 */
function saturate(color, factor) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const clamp = v => Math.max(0, Math.min(255, Math.round(lum + (v - lum) * factor)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}

/**
 * Die body color for a player. The territory fill uses the raw player
 * color, so dice use a darker, more saturated tone to stand out against
 * it — matching the legacy sprite art.
 * @param {number} color - Player color
 * @returns {number}
 */
function dieBaseColor(color) {
  return darken(saturate(color, 1.6), 0.75);
}

/**
 * Draw a single isometric die with pips on its three visible faces.
 *
 * @param {Graphics} gfx
 * @param {number} x - Left edge of the front face
 * @param {number} y - Top edge of the front face
 * @param {number} color - Die body color (see dieBaseColor)
 * @param {number} pipColor - Pip dot color
 * @param {number} value - Front face value (1-6); top/right faces derive from it
 */
function drawDie(gfx, x, y, color, pipColor, value) {
  const size = DICE_SIZE;
  const skew = DICE_SKEW;
  const depth = DICE_DEPTH;
  const outline = { width: 1, color: BORDER_COLOR, join: 'round' };

  // Front face
  gfx.rect(x, y, size, size);
  gfx.fill(color);
  gfx.stroke(outline);

  // Top face (parallelogram) — lit face
  gfx.poly([x, y, x + skew, y - depth, x + size + skew, y - depth, x + size, y], true);
  gfx.fill(lighten(color, 0.35));
  gfx.stroke(outline);

  // Right face (parallelogram) — shaded face
  gfx.poly(
    [
      x + size,
      y,
      x + size + skew,
      y - depth,
      x + size + skew,
      y + size - depth,
      x + size,
      y + size,
    ],
    true
  );
  gfx.fill(darken(color, 0.62));
  gfx.stroke(outline);

  // Adjacent faces show different values, like a real die
  const topValue = (value % 6) + 1;
  const rightValue = ((value + 1) % 6) + 1;
  const spacing = size * 0.26;

  // Front face pips
  const cx = x + size / 2;
  const cy = y + size / 2;
  for (const [px, py] of getPipPositions(value, spacing)) {
    gfx.circle(cx + px, cy + py, size * 0.1);
    gfx.fill(pipColor);
  }

  // Top face pips — foreshortened onto the parallelogram
  for (const [px, py] of getPipPositions(topValue, spacing)) {
    const v = 0.5 - py / size; // 0 = front edge, 1 = back edge
    gfx.ellipse(x + size / 2 + px + skew * v, y - depth * v, size * 0.09, size * 0.05);
    gfx.fill(pipColor);
  }

  // Right face pips — foreshortened onto the parallelogram
  for (const [px, py] of getPipPositions(rightValue, spacing)) {
    const u = 0.5 + px / size; // 0 = front edge, 1 = back edge
    gfx.ellipse(x + size + skew * u, y + size / 2 + py - depth * u, size * 0.05, size * 0.09);
    gfx.fill(pipColor);
  }
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
  }

  /**
   * Toggle color-blind mode.
   * @param {boolean} enabled
   */
  setColorBlindMode(enabled) {
    this._colorBlindMode = enabled;
  }

  /**
   * Get the player color, respecting color-blind mode.
   * @param {number} owner
   * @returns {number}
   */
  _getPlayerColor(owner) {
    const palette = this._colorBlindMode ? COLORBLIND_PLAYER_COLORS : PLAYER_COLORS;
    return palette[owner % palette.length];
  }

  /**
   * Get the pip color for a player's dice, respecting color-blind mode.
   * @param {number} owner
   * @returns {number}
   */
  _getPipColor(owner) {
    const palette = this._colorBlindMode ? COLORBLIND_PIP_COLORS : PLAYER_PIP_COLORS;
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

    // Sort areas by Y position for correct z-ordering (back to front)
    const sortedAreas = [];
    for (let a = 1; a < areas.length; a++) {
      const area = areas[a];
      if (!area || area.size === 0) continue;
      sortedAreas.push(a);
    }
    sortedAreas.sort((a, b) => {
      const centerA = areas[a].centerCell;
      const centerB = areas[b].centerCell;
      return this._cellPos.y[centerA] - this._cellPos.y[centerB];
    });

    // Remove all existing dice containers from parent
    this.container.removeChildren();

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
    diceContainer.x = this._cellPos.x[centerCell] + DICE_OFFSET_X;
    diceContainer.y = this._cellPos.y[centerCell] + DICE_OFFSET_Y;

    const color = dieBaseColor(this._getPlayerColor(area.owner));
    const pipColor = this._getPipColor(area.owner);
    const gfx = new Graphics();

    const frontCount = Math.min(area.dice, COLUMN_MAX);
    const backCount = area.dice - frontCount;

    // Drop shadow under the stack (origin y=0 is the front column's base line)
    const shadowRx = backCount > 0 ? DICE_SIZE * 1.6 : DICE_SIZE * 1.05;
    gfx.ellipse(DICE_SIZE * 0.9, DICE_SIZE * 0.3, shadowRx, DICE_SIZE * 0.38);
    gfx.fill({ color: 0x000000, alpha: 0.3 });

    // Deterministic pseudo-value so pips vary per die but rendering stays pure
    const dieValue = i => ((areaId * 5 + i * 3) % 6) + 1;

    /*
     * Back column first (dice 5-8), then front column paints over it.
     * Within a column, draw bottom die first so upper dice overlap correctly.
     */
    for (let i = 0; i < backCount; i++) {
      const y = BACK_COLUMN_Y - (i + 1) * DICE_SIZE;
      drawDie(gfx, BACK_COLUMN_X, y, color, pipColor, dieValue(COLUMN_MAX + i));
    }
    for (let i = 0; i < frontCount; i++) {
      const y = -(i + 1) * DICE_SIZE;
      drawDie(gfx, 0, y, color, pipColor, dieValue(i));
    }

    diceContainer.addChild(gfx);

    this._diceContainers[areaId] = diceContainer;
    this.container.addChild(diceContainer);
  }

  /** Clean up. */
  destroy() {
    this.container.destroy({ children: true });
  }
}
