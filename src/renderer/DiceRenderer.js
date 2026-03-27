/**
 * Dice Renderer
 *
 * Draws stacked dice on each territory. Each territory gets a small
 * container positioned at its center cell showing the dice count as
 * isometric stacked cubes with the owner's color.
 *
 * @module renderer/DiceRenderer
 */

import { Container, Graphics, Text } from 'pixi.js';
import { PLAYER_COLORS } from './constants.js';
import { computeCellPositions } from './HexGridRenderer.js';

/** Dice display settings (before map scaling). */
const DICE_SIZE = 12;
const DICE_STACK_OFFSET = 5;
const DICE_OFFSET_X = 6;
const DICE_OFFSET_Y = -10;

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
 * Draw a single isometric die face.
 * @param {Graphics} gfx
 * @param {number} x - Left edge
 * @param {number} y - Top of the die stack position
 * @param {number} size - Die size
 * @param {number} color - Player color
 */
function drawDie(gfx, x, y, size, color) {
  const half = size / 2;
  const depth = size * 0.3;

  // Front face
  gfx.rect(x, y, size, size);
  gfx.fill(color);
  gfx.stroke({ width: 1, color: darken(color, 0.5) });

  // Top face (parallelogram) — slightly lighter for isometric shading
  gfx.poly([x, y, x + half, y - depth, x + size + half, y - depth, x + size, y], true);
  gfx.fill(darken(color, 0.85));
  gfx.stroke({ width: 1, color: darken(color, 0.5) });

  // Right face (parallelogram)
  gfx.poly(
    [
      x + size,
      y,
      x + size + half,
      y - depth,
      x + size + half,
      y + size - depth,
      x + size,
      y + size,
    ],
    true
  );
  gfx.fill(darken(color, 0.65));
  gfx.stroke({ width: 1, color: darken(color, 0.5) });
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
  }

  /**
   * Draw dice on all territories.
   * @param {import('../engine/types.js').GameState} state
   */
  drawAll(state) {
    const { grid, areas } = state;

    // Compute cell positions if needed
    if (!this._cellPos) {
      this._cellPos = computeCellPositions(grid.width, grid.height);
    }

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

    const color = PLAYER_COLORS[area.owner % PLAYER_COLORS.length];
    const gfx = new Graphics();

    // Draw stacked dice from bottom to top
    for (let i = 0; i < area.dice; i++) {
      const dy = (area.dice - 1 - i) * DICE_STACK_OFFSET;
      drawDie(gfx, 0, -dy, DICE_SIZE, color);
    }

    diceContainer.addChild(gfx);

    // Add count label
    const label = new Text({
      text: String(area.dice),
      style: {
        fontFamily: 'Anton',
        fontSize: 11,
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 2 },
      },
    });
    label.x = DICE_SIZE / 2 + 3;
    label.y = -(area.dice - 1) * DICE_STACK_OFFSET - 2;
    label.anchor.set(0.5, 1);
    diceContainer.addChild(label);

    this._diceContainers[areaId] = diceContainer;
    this.container.addChild(diceContainer);
  }

  /** Clean up. */
  destroy() {
    this.container.destroy({ children: true });
  }
}
