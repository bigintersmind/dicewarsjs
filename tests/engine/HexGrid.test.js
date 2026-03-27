import { createHexGrid, getNeighbor } from '../../src/engine/HexGrid.js';
import { HEX_DIRECTIONS } from '../../src/engine/constants.js';

describe('getNeighbor', () => {
  const W = 4;
  const H = 4;
  /*
   * Grid layout (4x4):
   *  row 0 (even): cells 0  1  2  3
   *  row 1 (odd):  cells 4  5  6  7
   *  row 2 (even): cells 8  9  10 11
   *  row 3 (odd):  cells 12 13 14 15
   */

  it('returns correct neighbors for an interior even-row cell', () => {
    // Cell 9: row 2 (even), col 1
    expect(getNeighbor(W, H, 9, 0)).toBe(5); // upper-right: row 1, col 1
    expect(getNeighbor(W, H, 9, 1)).toBe(10); // right: row 2, col 2
    expect(getNeighbor(W, H, 9, 2)).toBe(13); // lower-right: row 3, col 1
    expect(getNeighbor(W, H, 9, 3)).toBe(12); // lower-left: row 3, col 0
    expect(getNeighbor(W, H, 9, 4)).toBe(8); // left: row 2, col 0
    expect(getNeighbor(W, H, 9, 5)).toBe(4); // upper-left: row 1, col 0
  });

  it('returns correct neighbors for an interior odd-row cell', () => {
    // Cell 5: row 1 (odd), col 1
    expect(getNeighbor(W, H, 5, 0)).toBe(2); // upper-right: row 0, col 2 (f=1, ax=1)
    expect(getNeighbor(W, H, 5, 1)).toBe(6); // right: row 1, col 2
    expect(getNeighbor(W, H, 5, 2)).toBe(10); // lower-right: row 2, col 2 (f=1, ax=1)
    expect(getNeighbor(W, H, 5, 3)).toBe(9); // lower-left: row 2, col 1 (f-1=0, ax=0)
    expect(getNeighbor(W, H, 5, 4)).toBe(4); // left: row 1, col 0
    expect(getNeighbor(W, H, 5, 5)).toBe(1); // upper-left: row 0, col 1 (f-1=0, ax=0)
  });

  it('returns -1 for out-of-bounds at top-left corner', () => {
    // Cell 0: row 0 (even), col 0
    expect(getNeighbor(W, H, 0, 0)).toBe(-1); // upper-right: row -1
    expect(getNeighbor(W, H, 0, 1)).toBe(1); // right
    expect(getNeighbor(W, H, 0, 2)).toBe(4); // lower-right: row 1, col 0
    expect(getNeighbor(W, H, 0, 3)).toBe(-1); // lower-left: col -1
    expect(getNeighbor(W, H, 0, 4)).toBe(-1); // left: col -1
    expect(getNeighbor(W, H, 0, 5)).toBe(-1); // upper-left: row -1
  });

  it('returns -1 for out-of-bounds at bottom-right corner', () => {
    // Cell 15: row 3 (odd), col 3
    expect(getNeighbor(W, H, 15, 0)).toBe(-1); // upper-right: col 4 (f=1, ax=1 → col=4, OOB)
    expect(getNeighbor(W, H, 15, 1)).toBe(-1); // right: col 4
    expect(getNeighbor(W, H, 15, 2)).toBe(-1); // lower-right: row 4
    expect(getNeighbor(W, H, 15, 3)).toBe(-1); // lower-left: row 4
    expect(getNeighbor(W, H, 15, 4)).toBe(14); // left
    expect(getNeighbor(W, H, 15, 5)).toBe(11); // upper-left: row 2, col 3
  });

  it('throws RangeError for invalid direction', () => {
    expect(() => getNeighbor(4, 4, 5, -1)).toThrow(RangeError);
    expect(() => getNeighbor(4, 4, 5, 6)).toThrow(RangeError);
    expect(() => getNeighbor(4, 4, 5, 99)).toThrow(/Invalid hex direction/);
  });

  it('returns -1 for left edge even row', () => {
    // Cell 8: row 2 (even), col 0
    expect(getNeighbor(W, H, 8, 3)).toBe(-1); // lower-left: col -1
    expect(getNeighbor(W, H, 8, 4)).toBe(-1); // left: col -1
    expect(getNeighbor(W, H, 8, 5)).toBe(-1); // upper-left: col -1
  });
});

describe('createHexGrid', () => {
  it('creates a grid with correct dimensions', () => {
    const grid = createHexGrid(28, 32);
    expect(grid.width).toBe(28);
    expect(grid.height).toBe(32);
    expect(grid.cellCount).toBe(896);
  });

  it('precomputes adjacency for every cell', () => {
    const grid = createHexGrid(4, 4);
    expect(grid.adjacency.length).toBe(16);
    for (const neighbors of grid.adjacency) {
      expect(neighbors.length).toBe(HEX_DIRECTIONS);
    }
  });

  it('precomputed adjacency matches getNeighbor', () => {
    const W = 6;
    const H = 6;
    const grid = createHexGrid(W, H);
    for (let i = 0; i < grid.cellCount; i++) {
      for (let d = 0; d < HEX_DIRECTIONS; d++) {
        expect(grid.adjacency[i][d]).toBe(getNeighbor(W, H, i, d));
      }
    }
  });

  it('adjacency is symmetric — if A neighbors B, B neighbors A', () => {
    const grid = createHexGrid(10, 10);
    for (let i = 0; i < grid.cellCount; i++) {
      for (let d = 0; d < HEX_DIRECTIONS; d++) {
        const neighbor = grid.adjacency[i][d];
        if (neighbor === -1) continue;
        // Neighbor's adjacency should contain i
        expect(grid.adjacency[neighbor]).toContain(i);
      }
    }
  });

  it('handles a 1x1 grid (all neighbors out of bounds)', () => {
    const grid = createHexGrid(1, 1);
    expect(grid.cellCount).toBe(1);
    expect(grid.adjacency[0]).toEqual([-1, -1, -1, -1, -1, -1]);
  });

  it('throws RangeError for width <= 0', () => {
    expect(() => createHexGrid(0, 5)).toThrow(RangeError);
    expect(() => createHexGrid(-1, 5)).toThrow(RangeError);
  });

  it('throws RangeError for height <= 0', () => {
    expect(() => createHexGrid(5, 0)).toThrow(RangeError);
    expect(() => createHexGrid(5, -1)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer dimensions', () => {
    expect(() => createHexGrid(2.5, 3)).toThrow(RangeError);
    expect(() => createHexGrid(3, 2.5)).toThrow(RangeError);
  });

  it('handles a 1-row grid', () => {
    const grid = createHexGrid(3, 1);
    expect(grid.cellCount).toBe(3);
    // Cell 1 (middle of row 0): left and right exist, all vertical are OOB
    expect(grid.adjacency[1][1]).toBe(2); // right
    expect(grid.adjacency[1][4]).toBe(0); // left
    expect(grid.adjacency[1][0]).toBe(-1); // upper-right
    expect(grid.adjacency[1][2]).toBe(-1); // lower-right
  });
});
