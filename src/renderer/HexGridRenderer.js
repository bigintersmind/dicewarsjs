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
import { THEMES } from './themes.js';
import {
  PLAYER_COLORS,
  COLORBLIND_PLAYER_COLORS,
  BORDER_COLOR,
  BORDER_WIDTH,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL,
  CELL_WIDTH,
  CELL_HEIGHT,
  HEX_VERTEX_X,
  HEX_VERTEX_Y,
  BASE_WIDTH,
  BASE_HEIGHT,
  HUD_BAR_HEIGHT,
  MAP_TOP_MARGIN,
} from './constants.js';

/**
 * Compute the scale and top-left position that centers a grid of the given cell
 * dimensions inside the fixed base canvas (BASE_WIDTH × BASE_HEIGHT).
 *
 * Grids that would overflow the canvas (e.g. the Large preset, 36×40 → 972px
 * wide vs. BASE_WIDTH 840) are scaled down uniformly so they never clip; grids
 * that already fit (Small, Medium) return scale === 1 and the original column
 * positions. Pure function — exported for unit testing.
 *
 * @param {number} gridWidth  - Grid width in cells
 * @param {number} gridHeight - Grid height in cells
 * @returns {{ scale: number, x: number, y: number }}
 */
export function computeMapLayout(gridWidth, gridHeight) {
  const mapPixelWidth = gridWidth * CELL_WIDTH;
  const mapPixelHeight = gridHeight * CELL_HEIGHT;
  // Odd rows are shifted half a cell right, so the real content is wider.
  const contentWidth = mapPixelWidth + CELL_WIDTH / 2;
  const availHeight = BASE_HEIGHT - MAP_TOP_MARGIN - HUD_BAR_HEIGHT;
  const scale = Math.min(1, BASE_WIDTH / contentWidth, availHeight / mapPixelHeight);
  // Center horizontally (matching the original offset when scale === 1).
  const x = (BASE_WIDTH - mapPixelWidth * scale) / 2 - (CELL_WIDTH / 4) * scale;
  /*
   * Center vertically in the band between MAP_TOP_MARGIN and the HUD strip.
   * Top-anchoring at MAP_TOP_MARGIN piled all the slack below the map, which
   * left the top row (and its dice towers) under the fixed mode rail on the
   * hub screens. scale caps at availHeight/mapPixelHeight, so y never rises
   * above MAP_TOP_MARGIN.
   */
  const y = MAP_TOP_MARGIN + (availHeight - mapPixelHeight * scale) / 2;
  return { scale, x, y };
}

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
 * @param {number} [fillAlpha=1] - Fill opacity (0-1), used for semi-transparent highlight overlays
 */
function drawTerritoryPath(
  gfx,
  border,
  cellPos,
  fillColor,
  strokeColor,
  strokeWidth,
  fillAlpha = 1
) {
  gfx.clear();
  appendTerritoryPath(gfx, border, cellPos, fillColor, strokeColor, strokeWidth, fillAlpha);
}

/**
 * Append one territory outline to a Graphics **without clearing it first**, so
 * several territories can share a single Graphics object (the candidate-
 * highlight layer draws the whole hint set — attackers or reachable targets —
 * into one).
 *
 * Same parameters as `drawTerritoryPath`.
 */
function appendTerritoryPath(
  gfx,
  border,
  cellPos,
  fillColor,
  strokeColor,
  strokeWidth,
  fillAlpha = 1
) {
  if (border.length < 2) return;

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
  gfx.fill({ color: fillColor, alpha: fillAlpha });
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

    /*
     * Board-hint layer: every territory the player can act on right now, drawn
     * into ONE Graphics. Added FIRST of the four overlays and never re-pinned,
     * so it is the LOWEST of them: it paints above the territories themselves
     * (drawMap's addChildAt(gfx, 0) puts each territory below every overlay)
     * but beneath the keyboard focus ring, the dice, and the from/to selection.
     * A hint is an offer; the committed selection has to stay dominant.
     */
    /** @type {Graphics} Board-hint overlay for attack candidates */
    this._highlightCandidates = new Graphics();
    this._highlightCandidates.visible = false;
    this.container.addChild(this._highlightCandidates);

    /** @type {Graphics} Highlight overlay for selectedFrom */
    this._highlightFrom = new Graphics();
    this._highlightFrom.visible = false;
    this.container.addChild(this._highlightFrom);

    /** @type {Graphics} Highlight overlay for selectedTo */
    this._highlightTo = new Graphics();
    this._highlightTo.visible = false;
    this.container.addChild(this._highlightTo);

    /** @type {Graphics} Focus highlight for keyboard navigation */
    this._highlightFocus = new Graphics();
    this._highlightFocus.visible = false;
    this.container.addChild(this._highlightFocus);

    /** @type {{ x: Float64Array, y: Float64Array } | null} */
    this._cellPos = null;

    /** @type {number[] | null} cellIndex → areaId */
    this._cellToArea = null;

    /** @type {{ cell: number, dir: number }[][]} Cached borders per area */
    this._borders = [];

    /** @type {import('../engine/types.js').GameState | null} */
    this._lastState = null;

    /** @type {number} Current border color (theme-dependent) */
    this._borderColor = BORDER_COLOR;
    /** @type {number} Current highlight stroke color */
    this._highlightColor = HIGHLIGHT_COLOR;
    /** @type {number} Current highlight fill color */
    this._highlightFill = HIGHLIGHT_FILL;
    /** @type {number} Current attack-candidate highlight color */
    this._candidateAttackerColor = THEMES.dark.candidateAttacker;
    /** @type {number} Current attack-target highlight color */
    this._candidateTargetColor = THEMES.dark.candidateTarget;
    /** @type {number} Rim drawn under a candidate ring so it reads on any territory */
    this._candidateHaloColor = THEMES.dark.candidateHalo;
    /** @type {boolean} Color-blind mode */
    this._colorBlindMode = false;

    /**
     * @type {Set<string>} Methods that have already reported a missing border
     * for the current map — see `_warnMissingBorder`. Cleared by `drawMap`.
     */
    this._missingBorderWarned = new Set();

    /** @type {number[]} Territories currently marked by the board-hint layer */
    this._candidateIds = [];
    /** @type {'attacker' | 'target'} Treatment the board-hint layer is painting */
    this._candidateKind = 'attacker';
  }

  /**
   * Get the player color for a given owner index, respecting color-blind mode.
   * @param {number} owner
   * @returns {number}
   */
  _getPlayerColor(owner) {
    const palette = this._colorBlindMode ? COLORBLIND_PLAYER_COLORS : PLAYER_COLORS;
    return owner >= 0 ? palette[owner % palette.length] : 0x888888;
  }

  /**
   * Apply a theme to the renderer.
   *
   * Every key is required — `themes.test.js` pins that on each entry of THEMES,
   * so a missing one is a bug in the theme, not a case to paper over here.
   *
   * @param {{ borderColor: number, highlightColor: number, highlightFill: number,
   *   candidateAttacker: number, candidateTarget: number, candidateHalo: number }} theme
   */
  setTheme(theme) {
    this._borderColor = theme.borderColor;
    this._highlightColor = theme.highlightColor;
    this._highlightFill = theme.highlightFill;
    this._candidateAttackerColor = theme.candidateAttacker;
    this._candidateTargetColor = theme.candidateTarget;
    this._candidateHaloColor = theme.candidateHalo;
    this._redrawCandidates();
  }

  /**
   * Toggle color-blind mode.
   * @param {boolean} enabled
   */
  setColorBlindMode(enabled) {
    this._colorBlindMode = enabled;
  }

  /**
   * Redraw all territories using the current theme and palette.
   */
  redrawAll() {
    if (!this._lastState) return;
    const { areas } = this._lastState;
    for (let a = 1; a < areas.length; a++) {
      this.redrawTerritory(a, this._lastState);
    }
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

    // Remove old territory graphics — destroy() them with context:true (like
    // every other destroy in this file), or their GraphicsContext GPU geometry
    // leaks each time drawMap rebuilds the board (game start, every replay load)
    for (const gfx of this._territoryGfx) {
      if (gfx) {
        this.container.removeChild(gfx);
        gfx.destroy({ context: true });
      }
    }
    this._territoryGfx = new Array(areas.length).fill(null);
    this._borders = new Array(areas.length).fill(null);
    // ...and a new set of borders is a new chance to be pointed at the wrong
    // game, so each overlay gets its missing-border report back (#211 item 4).
    this._missingBorderWarned.clear();

    // Borders are being retraced from scratch: anything the board-hint layer
    // drew against the previous map's outlines is now stale geometry.
    this.clearCandidateHighlights();

    // Trace borders and draw each territory
    for (let a = 1; a < areas.length; a++) {
      const area = areas[a];
      if (!area || area.size === 0) continue;

      // Trace boundary
      const border = traceBorder(area.cells, this._cellToArea, grid.adjacency, a);
      this._borders[a] = border;

      // Create Graphics and draw
      const gfx = new Graphics();
      const color = this._getPlayerColor(area.owner);
      drawTerritoryPath(gfx, border, this._cellPos, color, this._borderColor, BORDER_WIDTH);

      this._territoryGfx[a] = gfx;
      // Insert behind highlights
      this.container.addChildAt(gfx, 0);
    }

    /*
     * Scale + position the container so any preset size fits the base canvas.
     * Dice live inside this same container, so they scale/move with it. The
     * matching inverse lives in GameRenderer.screenToMap (divide by this scale).
     */
    const layout = computeMapLayout(grid.width, grid.height);
    this.container.scale.set(layout.scale);
    this.container.x = layout.x;
    this.container.y = layout.y;

    /*
     * Ensure highlights are on top. This re-pins the from/to selection above
     * everything added since — the keyboard focus ring included — while the
     * board-hint layer keeps the index it was constructed at and stays the
     * lowest overlay.
     */
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
    const color = this._getPlayerColor(area.owner);
    drawTerritoryPath(gfx, border, this._cellPos, color, this._borderColor, BORDER_WIDTH);
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
   * Report an overlay asked to paint a territory this renderer has no traced
   * border for — the caller is drawing against a board we aren't showing, the
   * same store/renderer map mismatch `setCandidateHighlights` has warned about
   * all along (#211 item 4). Both callers still return without painting: this
   * runs from a focus listener and from click handling, where throwing over a
   * cosmetic overlay would be far worse than a missing ring.
   *
   * Once per method per map, not once per call, because these overlays are
   * called once per *hop*: an arrow burst across a mismatched board would
   * otherwise print a line per keypress and bury the first report. (The sibling
   * can afford a line per call — each of its calls is one whole hint set.)
   * `drawMap` clears the record along with `_borders`, since a freshly traced
   * map is a fresh chance to be wired against the wrong game.
   *
   * @param {string} method - Name of the calling method, for the message
   * @param {number} areaId - The id with no border
   */
  _warnMissingBorder(method, areaId) {
    if (this._missingBorderWarned.has(method)) return;
    this._missingBorderWarned.add(method);
    console.warn(
      `[HexGridRenderer] ${method}: no border for area`,
      areaId,
      '— renderer map may not match the store game'
    );
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
    if (!border) {
      this._warnMissingBorder('setHighlight', areaId);
      return;
    }

    gfx.visible = true;
    drawTerritoryPath(
      gfx,
      border,
      this._cellPos,
      this._highlightFill,
      this._highlightColor,
      BORDER_WIDTH,
      0.3
    );
  }

  /**
   * Show a focus highlight on a territory (keyboard navigation).
   * Uses a thin white semi-transparent border distinct from selection highlights.
   *
   * Its own Graphics, stacked above the board hints, so its darkened fill
   * separates the focused territory from the thin attacker rims around it. The
   * two layers are independent: moving focus never disturbs the hints, and
   * repainting the hints never disturbs focus.
   *
   * @param {number} areaId
   */
  setFocusHighlight(areaId) {
    const border = this._borders[areaId];
    if (!border) {
      this._warnMissingBorder('setFocusHighlight', areaId);
      return;
    }
    this._highlightFocus.visible = true;
    drawTerritoryPath(this._highlightFocus, border, this._cellPos, 0x000000, 0xffffff, 3);
    this._highlightFocus.alpha = 0.7;
  }

  /**
   * Board hints: outline a set of territories as "you can act on these right
   * now". Replaces whatever the layer held before — one call paints the whole
   * set.
   *
   * The treatments are deliberately quieter than `setHighlight`'s selection
   * ring, and differ from each other in weight as well as hue so they don't
   * rely on color alone:
   *   'attacker' — your territories that could start an attack (thin ring)
   *   'target'   — the enemies the selected territory can reach (denser ring)
   *
   * Both arguments are programmer-supplied, not runtime data, so a bad one is a
   * wiring bug and throws. Coercing them instead would paint the wrong
   * treatment (or nothing) with no way to notice.
   *
   * @param {number[]} areaIds - Territories to mark (empty clears the layer)
   * @param {'attacker' | 'target'} [kind='attacker']
   * @throws {TypeError} if `areaIds` is not an array or `kind` is not one of the two treatments
   */
  setCandidateHighlights(areaIds, kind = 'attacker') {
    if (!Array.isArray(areaIds)) {
      throw new TypeError(
        `setCandidateHighlights: areaIds must be an array, got ${typeof areaIds}`
      );
    }
    if (kind !== 'attacker' && kind !== 'target') {
      throw new TypeError(
        `setCandidateHighlights: kind must be 'attacker' or 'target', got ${JSON.stringify(kind)}`
      );
    }
    this._candidateIds = [...areaIds];
    this._candidateKind = kind;
    this._redrawCandidates();
  }

  /** Clear the board-hint layer. Leaves the selection and focus rings alone. */
  clearCandidateHighlights() {
    this._candidateIds = [];
    this._highlightCandidates.visible = false;
    this._highlightCandidates.clear();
  }

  /**
   * Repaint the board-hint layer from `_candidateIds`. Its only two callers are
   * `setCandidateHighlights` (the set changed) and `setTheme` (the colors did) —
   * territory redraws never touch this Graphics, so they need no hook here.
   */
  _redrawCandidates() {
    const gfx = this._highlightCandidates;
    gfx.clear();

    const ids = this._candidateIds;
    if (ids.length === 0) {
      gfx.visible = false;
      return;
    }

    /*
     * A target is the louder mark of the two: a fat warm ring over a warm wash,
     * against the attack candidate's thin white outline. Halo first, bright core
     * on top — see the `candidateHalo` note in themes.js for why.
     */
    const isTarget = this._candidateKind === 'target';
    const color = isTarget ? this._candidateTargetColor : this._candidateAttackerColor;
    const coreWidth = isTarget ? 5 : 2;
    const haloWidth = coreWidth + 4;
    const fillAlpha = isTarget ? 0.25 : 0.1;

    let drew = false;
    const skipped = [];
    for (const id of ids) {
      const border = this._borders[id];
      if (!border) {
        skipped.push(id);
        continue;
      }
      // A degenerate outline draws nothing (appendTerritoryPath bails under two
      // segments), so it must not be what makes the layer visible.
      if (border.length < 2) continue;
      const pos = this._cellPos;
      appendTerritoryPath(gfx, border, pos, color, this._candidateHaloColor, haloWidth, 0);
      appendTerritoryPath(gfx, border, pos, color, color, coreWidth, fillAlpha);
      drew = true;
    }

    /*
     * An id with no traced border means the caller is hinting against a board
     * this renderer isn't showing. Warn once for the whole set rather than
     * throwing: this runs inside startTurn, and taking the turn down over a
     * cosmetic layer would be far worse than a missing outline.
     */
    if (skipped.length > 0) {
      console.warn(
        '[HexGridRenderer] setCandidateHighlights: no border for area ids',
        skipped,
        '— renderer map may not match the store game'
      );
    }

    gfx.alpha = isTarget ? 1 : 0.85;
    gfx.visible = drew;
  }

  /** Clear the keyboard focus highlight. Leaves the board hints alone. */
  clearFocusHighlight() {
    this._highlightFocus.visible = false;
    this._highlightFocus.clear();
  }

  /**
   * Clear the selection rings and the board hints; leaves the keyboard focus
   * ring — the cursor — alone. The mid-game clear: nothing about where the
   * keyboard is has changed (#211).
   */
  clearSelectionHighlights() {
    this.clearCandidateHighlights();
    this._highlightFrom.visible = false;
    this._highlightFrom.clear();
    this._highlightTo.visible = false;
    this._highlightTo.clear();
  }

  /**
   * Clear every overlay, keyboard focus included. Reserved for the seams that
   * leave the playing screen and null the store's `focusedAreaId` in the same
   * breath (quit to title, the end-turn error bounce); anywhere else use
   * clearSelectionHighlights() (#211).
   */
  clearHighlights() {
    this.clearFocusHighlight();
    this.clearSelectionHighlights();
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
    this.container.destroy({ children: true, context: true });
  }
}
