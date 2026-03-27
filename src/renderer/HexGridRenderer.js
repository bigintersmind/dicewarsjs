/**
 * Hex Grid Renderer
 *
 * Draws territories on a PixiJS stage using the engine's game state.
 * Each territory is a single Graphics object filled with the owner's color
 * and outlined with a thick dark border.
 *
 * @module renderer/HexGridRenderer
 */

import { Container, Graphics } from 'pixi.js';
import { traceBorder, buildCellToArea } from './territoryBorder.js';
import {
  PLAYER_COLORS,
  BORDER_COLOR,
  BORDER_WIDTH,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL,
  CELL_WIDTH,
  CELL_HEIGHT,
  HEX_VERTEX_X,
  HEX_VERTEX_Y,
  BASE_WIDTH,
  MAP_TOP_MARGIN,
} from './constants.js';

/**
 * Precompute pixel positions for every cell in the grid.
 *
 * @param {number} width  - Grid width in cells
 * @param {number} height - Grid height in cells
 * @returns {{ x: Float64Array, y: Float64Array }}
 */
export function computeCellPositions(width, height) {
  const count = width * height;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  let c = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      x[c] = col * CELL_WIDTH + (row % 2 ? CELL_WIDTH / 2 : 0);
      y[c] = row * CELL_HEIGHT;
      c++;
    }
  }
  return { x, y };
}

/**
 * Draw a territory border path into a Graphics object.
 *
 * Ports the rendering part of legacy `draw_areashape()` from main.js.
 *
 * @param {Graphics} gfx       - PixiJS Graphics to draw into
 * @param {{ cell: number, dir: number }[]} border - From traceBorder()
 * @param {{ x: Float64Array, y: Float64Array }} cellPos - Cell pixel positions
 * @param {number} fillColor   - Fill color (hex int)
 * @param {number} strokeColor - Stroke color (hex int)
 * @param {number} strokeWidth - Stroke width in pixels
 */
function drawTerritoryPath(gfx, border, cellPos, fillColor, strokeColor, strokeWidth) {
  if (border.length < 2) return;

  gfx.clear();

  /*
   * Build polygon points from the border segments
   * Each segment's vertex is at cellPos + HEX_VERTEX[dir+1] (the "end" vertex of that edge)
   * The first segment provides the moveTo point at HEX_VERTEX[dir]
   */
  const first = border[0];
  const startX = cellPos.x[first.cell] + HEX_VERTEX_X[first.dir];
  const startY = cellPos.y[first.cell] + HEX_VERTEX_Y[first.dir];

  const points = [startX, startY];

  for (let i = 0; i < border.length - 1; i++) {
    const seg = border[i];
    const px = cellPos.x[seg.cell] + HEX_VERTEX_X[seg.dir + 1];
    const py = cellPos.y[seg.cell] + HEX_VERTEX_Y[seg.dir + 1];
    points.push(px, py);
  }

  gfx.poly(points, true);
  gfx.fill(fillColor);
  gfx.stroke({ width: strokeWidth, color: strokeColor, join: 'round', cap: 'round' });
}

export class HexGridRenderer {
  /**
   * @param {Container} parent - Parent container to add the map into
   */
  constructor(parent) {
    /** @type {Container} */
    this.container = new Container();
    parent.addChild(this.container);

    /** @type {Graphics[]} Territory Graphics indexed by areaId */
    this._territoryGfx = [];

    /** @type {Graphics} Highlight overlay for selectedFrom */
    this._highlightFrom = new Graphics();
    this._highlightFrom.visible = false;
    this.container.addChild(this._highlightFrom);

    /** @type {Graphics} Highlight overlay for selectedTo */
    this._highlightTo = new Graphics();
    this._highlightTo.visible = false;
    this.container.addChild(this._highlightTo);

    /** @type {{ x: Float64Array, y: Float64Array } | null} */
    this._cellPos = null;

    /** @type {number[] | null} cellIndex → areaId */
    this._cellToArea = null;

    /** @type {{ cell: number, dir: number }[][]} Cached borders per area */
    this._borders = [];

    /** @type {import('../engine/types.js').GameState | null} */
    this._lastState = null;
  }

  /**
   * Draw the full map from scratch.
   *
   * Called once when a new game starts. Computes cell positions, traces
   * borders, and creates a Graphics object per territory.
   *
   * @param {import('../engine/types.js').GameState} state
   */
  drawMap(state) {
    this._lastState = state;
    const { grid, areas } = state;

    // Compute cell pixel positions
    this._cellPos = computeCellPositions(grid.width, grid.height);

    // Build cellToArea lookup
    this._cellToArea = buildCellToArea(areas, grid.cellCount);

    // Remove old territory graphics
    for (const gfx of this._territoryGfx) {
      if (gfx) this.container.removeChild(gfx);
    }
    this._territoryGfx = new Array(areas.length).fill(null);
    this._borders = new Array(areas.length).fill(null);

    // Trace borders and draw each territory
    for (let a = 1; a < areas.length; a++) {
      const area = areas[a];
      if (!area || area.size === 0) continue;

      // Trace boundary
      const border = traceBorder(area.cells, this._cellToArea, grid.adjacency, a);
      this._borders[a] = border;

      // Create Graphics and draw
      const gfx = new Graphics();
      const color = area.owner >= 0 ? PLAYER_COLORS[area.owner % PLAYER_COLORS.length] : 0x888888;
      drawTerritoryPath(gfx, border, this._cellPos, color, BORDER_COLOR, BORDER_WIDTH);

      this._territoryGfx[a] = gfx;
      // Insert behind highlights
      this.container.addChildAt(gfx, 0);
    }

    // Position the map container to center it
    const mapPixelWidth = grid.width * CELL_WIDTH;
    this.container.x = BASE_WIDTH / 2 - mapPixelWidth / 2 - CELL_WIDTH / 4;
    this.container.y = MAP_TOP_MARGIN;

    // Ensure highlights are on top
    this.container.setChildIndex(this._highlightFrom, this.container.children.length - 1);
    this.container.setChildIndex(this._highlightTo, this.container.children.length - 2);
  }

  /**
   * Redraw a single territory (e.g. after ownership changes).
   *
   * @param {number} areaId
   * @param {import('../engine/types.js').GameState} state
   */
  redrawTerritory(areaId, state) {
    this._lastState = state;
    const gfx = this._territoryGfx[areaId];
    const border = this._borders[areaId];
    if (!gfx || !border) return;

    const area = state.areas[areaId];
    const color = area.owner >= 0 ? PLAYER_COLORS[area.owner % PLAYER_COLORS.length] : 0x888888;
    drawTerritoryPath(gfx, border, this._cellPos, color, BORDER_COLOR, BORDER_WIDTH);
  }

  /**
   * Redraw all territories that changed ownership between two states.
   *
   * @param {import('../engine/types.js').GameState} prevState
   * @param {import('../engine/types.js').GameState} nextState
   */
  updateFromState(prevState, nextState) {
    this._lastState = nextState;
    for (let a = 1; a < nextState.areas.length; a++) {
      if (!prevState.areas[a] || prevState.areas[a].owner !== nextState.areas[a].owner) {
        this.redrawTerritory(a, nextState);
      }
    }
  }

  /**
   * Show a selection highlight on a territory.
   *
   * @param {'from' | 'to'} which
   * @param {number} areaId
   */
  setHighlight(which, areaId) {
    const gfx = which === 'from' ? this._highlightFrom : this._highlightTo;
    const border = this._borders[areaId];
    if (!border) return;

    gfx.visible = true;
    drawTerritoryPath(gfx, border, this._cellPos, HIGHLIGHT_FILL, HIGHLIGHT_COLOR, BORDER_WIDTH);
  }

  /** Clear all selection highlights. */
  clearHighlights() {
    this._highlightFrom.visible = false;
    this._highlightFrom.clear();
    this._highlightTo.visible = false;
    this._highlightTo.clear();
  }

  /**
   * Hit test: convert pixel coordinates (relative to the container) to an area ID.
   *
   * Uses a cell lookup — finds the closest cell center to the click point,
   * then returns the area owning that cell.
   *
   * @param {number} localX - X relative to the map container
   * @param {number} localY - Y relative to the map container
   * @returns {number} areaId, or 0 if no territory
   */
  hitTest(localX, localY) {
    if (!this._cellPos || !this._cellToArea || !this._lastState) return 0;

    const { grid } = this._lastState;

    // Convert pixel to approximate cell row/col
    const row = Math.round(localY / CELL_HEIGHT);
    const offset = row % 2 ? CELL_WIDTH / 2 : 0;
    const col = Math.round((localX - offset) / CELL_WIDTH);

    // Check the candidate cell and its immediate neighbors for closest match
    const candidates = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < grid.height && c >= 0 && c < grid.width) {
          candidates.push(r * grid.width + c);
        }
      }
    }

    let bestDist = Infinity;
    let bestArea = 0;
    for (const ci of candidates) {
      // Cell center is at (cellPos.x + CELL_WIDTH/2, cellPos.y + CELL_HEIGHT/2)
      const cx = this._cellPos.x[ci] + CELL_WIDTH / 2;
      const cy = this._cellPos.y[ci] + CELL_HEIGHT / 2;
      const dx = localX - cx;
      const dy = localY - cy;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestArea = this._cellToArea[ci];
      }
    }

    return bestArea;
  }

  /** Dispose of all graphics. */
  destroy() {
    this.container.destroy({ children: true });
  }
}
