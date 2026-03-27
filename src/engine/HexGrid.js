/**
 * Hex Grid Geometry
 *
 * Pure functions for creating and querying an offset-coordinate hexagonal grid.
 * No game logic — only cell adjacency computation.
 *
 * The grid uses an "offset coordinates" layout where odd rows are shifted right.
 * Each cell has 6 neighbors (directions 0-5):
 *   0 = upper-right, 1 = right, 2 = lower-right,
 *   3 = lower-left,  4 = left,  5 = upper-left
 *
 * @module engine/HexGrid
 */

import { HEX_DIRECTIONS } from './constants.js';

/**
 * Compute the neighbor of a cell in a given direction.
 *
 * @param {number} width  - Grid width in cells
 * @param {number} height - Grid height in cells
 * @param {number} cellIndex - Index of the source cell
 * @param {number} direction - Direction 0-5
 * @returns {number} Neighbor cell index, or -1 if out of bounds
 */
export function getNeighbor(width, height, cellIndex, direction) {
  const ox = cellIndex % width;
  const oy = Math.floor(cellIndex / width);
  const f = oy & 1; // 1 for odd rows, 0 for even

  let ax = 0;
  let ay = 0;

  switch (direction) {
    case 0:
      ax = f;
      ay = -1;
      break; // upper-right
    case 1:
      ax = 1;
      ay = 0;
      break; // right
    case 2:
      ax = f;
      ay = 1;
      break; // lower-right
    case 3:
      ax = f - 1;
      ay = 1;
      break; // lower-left
    case 4:
      ax = -1;
      ay = 0;
      break; // left
    case 5:
      ax = f - 1;
      ay = -1;
      break; // upper-left
    default:
      throw new RangeError(`Invalid hex direction: ${direction} (must be 0-5)`);
  }

  const x = ox + ax;
  const y = oy + ay;

  if (x < 0 || y < 0 || x >= width || y >= height) return -1;

  return y * width + x;
}

/**
 * Create a hex grid with precomputed adjacency for every cell.
 *
 * @param {number} width  - Grid width in cells
 * @param {number} height - Grid height in cells
 * @returns {import('./types.js').HexGrid}
 */
export function createHexGrid(width, height) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`createHexGrid: width must be a positive integer, got ${width}`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError(`createHexGrid: height must be a positive integer, got ${height}`);
  }
  const cellCount = width * height;
  const adjacency = new Array(cellCount);

  for (let i = 0; i < cellCount; i++) {
    const neighbors = new Array(HEX_DIRECTIONS);
    for (let d = 0; d < HEX_DIRECTIONS; d++) {
      neighbors[d] = getNeighbor(width, height, i, d);
    }
    adjacency[i] = neighbors;
  }

  return { width, height, cellCount, adjacency };
}
