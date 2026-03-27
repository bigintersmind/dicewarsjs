/**
 * Territory Border Tracer
 *
 * Ports the legacy `set_area_line` algorithm from game.js.
 * Given an area's cells and the grid adjacency data, traces the outer
 * perimeter of the territory, producing a list of (cell, direction) pairs
 * that the renderer converts to pixel coordinates.
 *
 * This is a pure function — no PixiJS, no DOM.
 *
 * @module renderer/territoryBorder
 */

/**
 * Find a starting (cell, direction) pair on the border of a territory.
 *
 * Scans cells until it finds one that has a neighbor in some direction
 * that belongs to a different territory (or is out-of-bounds).
 *
 * @param {number[]} cells       - Cell indices belonging to the territory
 * @param {number[]} cellToArea  - Flat map: cellIndex → areaId
 * @param {number[][]} adjacency - Grid adjacency from HexGrid
 * @param {number} areaId        - The territory's ID
 * @returns {{ cell: number, dir: number } | null} Starting point, or null if none found
 */
export function findBorderStart(cells, cellToArea, adjacency, areaId) {
  for (const cell of cells) {
    for (let d = 0; d < 6; d++) {
      const n = adjacency[cell][d];
      if (n < 0 || cellToArea[n] !== areaId) {
        return { cell, dir: d };
      }
    }
  }
  return null;
}

/**
 * Trace the outer boundary of a territory.
 *
 * This is a direct port of `game.js:set_area_line()`.  The algorithm
 * walks the perimeter of the territory by:
 *   1. Starting at a border cell/direction
 *   2. Rotating clockwise (d++) looking for the next edge
 *   3. If the neighbor in direction d is the same territory, stepping
 *      into that cell and rotating back 120° (d -= 2)
 *   4. Recording each (cell, direction) along the way
 *   5. Stopping when we return to the start
 *
 * @param {number[]} cells       - Cell indices belonging to the territory
 * @param {number[]} cellToArea  - Flat map: cellIndex → areaId
 * @param {number[][]} adjacency - Grid adjacency from HexGrid
 * @param {number} areaId        - The territory's ID
 * @returns {{ cell: number, dir: number }[]} Ordered boundary segments
 */
export function traceBorder(cells, cellToArea, adjacency, areaId) {
  const start = findBorderStart(cells, cellToArea, adjacency, areaId);
  if (!start) return [];

  const segments = [{ cell: start.cell, dir: start.dir }];
  let c = start.cell;
  let d = start.dir;

  for (let i = 0; i < 200; i++) {
    // Advance direction clockwise
    d = (d + 1) % 6;

    // Check the neighbor in this direction
    const n = adjacency[c][d];
    if (n >= 0 && cellToArea[n] === areaId) {
      // Neighbor is same territory — step into it and turn back 120°
      c = n;
      d = (d - 2 + 6) % 6;
    }

    segments.push({ cell: c, dir: d });

    // Check if we've returned to the start
    if (c === start.cell && d === start.dir) break;
  }

  return segments;
}

/**
 * Build a flat cellIndex → areaId lookup array.
 *
 * @param {import('../engine/types.js').Area[]} areas - Areas array (index 0 unused)
 * @param {number} cellCount - Total cells in the grid
 * @returns {number[]} Flat array where cellToArea[cellIndex] = areaId (0 = unowned)
 */
export function buildCellToArea(areas, cellCount) {
  const map = new Array(cellCount).fill(0);
  for (let a = 1; a < areas.length; a++) {
    const area = areas[a];
    if (!area || !area.cells) continue;
    for (const cell of area.cells) {
      map[cell] = a;
    }
  }
  return map;
}
