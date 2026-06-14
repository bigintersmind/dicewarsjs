// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createHexGrid } from '../../src/engine/HexGrid.js';
import {
  findBorderStart,
  traceBorder,
  buildCellToArea,
} from '../../src/renderer/territoryBorder.js';

/**
 * Helper: create a minimal area-like structure and cellToArea map
 * for a small grid with a known territory.
 */
function setupGrid(width, height, territoryCells, areaId) {
  const grid = createHexGrid(width, height);
  const cellToArea = new Array(grid.cellCount).fill(0);
  for (const c of territoryCells) {
    cellToArea[c] = areaId;
  }
  return { grid, cellToArea };
}

describe('buildCellToArea', () => {
  it('maps cell indices to area IDs', () => {
    const areas = [
      null, // index 0 unused
      { id: 1, cells: [0, 1, 2] },
      { id: 2, cells: [5, 6] },
    ];
    const map = buildCellToArea(areas, 10);
    expect(map[0]).toBe(1);
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(1);
    expect(map[3]).toBe(0);
    expect(map[5]).toBe(2);
    expect(map[6]).toBe(2);
  });

  it('handles empty areas', () => {
    const areas = [null, { id: 1, cells: [] }];
    const map = buildCellToArea(areas, 5);
    expect(map.every(v => v === 0)).toBe(true);
  });
});

describe('findBorderStart', () => {
  it('finds a border cell/direction for a single-cell territory', () => {
    // 4x4 grid, single cell at index 5 (row 1, col 1)
    const { grid, cellToArea } = setupGrid(4, 4, [5], 1);
    const start = findBorderStart([5], cellToArea, grid.adjacency, 1);
    expect(start).not.toBeNull();
    expect(start.cell).toBe(5);
    // Any direction should be a border since all neighbors are different territory
    expect(start.dir).toBeGreaterThanOrEqual(0);
    expect(start.dir).toBeLessThan(6);
  });

  it('returns null for an interior-only territory (impossible in practice)', () => {
    /*
     * Create a territory that completely fills the grid — no borders.
     * Actually this still has edges at the grid boundary, so it will find a border.
     */
    const { grid, cellToArea } = setupGrid(2, 2, [0, 1, 2, 3], 1);
    const start = findBorderStart([0, 1, 2, 3], cellToArea, grid.adjacency, 1);
    // 2x2 grid cells all have out-of-bounds neighbors, so a border exists
    expect(start).not.toBeNull();
  });
});

describe('traceBorder', () => {
  it('traces a single-cell territory', () => {
    const { grid, cellToArea } = setupGrid(4, 4, [5], 1);
    const border = traceBorder([5], cellToArea, grid.adjacency, 1);
    // A single hex cell should trace 6 border segments + return to start
    expect(border.length).toBeGreaterThanOrEqual(6);
    // Should form a closed loop: first and last have same cell/dir
    const first = border[0];
    const last = border[border.length - 1];
    expect(last.cell).toBe(first.cell);
    expect(last.dir).toBe(first.dir);
  });

  it('traces a two-cell territory (adjacent horizontally)', () => {
    /* Cells 1 and 2 in row 0 of a 4x4 grid (adjacent via direction 1/4) */
    const { grid, cellToArea } = setupGrid(4, 4, [1, 2], 1);
    const border = traceBorder([1, 2], cellToArea, grid.adjacency, 1);
    // Should form a closed loop
    const first = border[0];
    const last = border[border.length - 1];
    expect(last.cell).toBe(first.cell);
    expect(last.dir).toBe(first.dir);
    /*
     * Two cells share an edge, so the total perimeter should be 10 segments + start
     * (6+6 - 2 shared edges = 10 boundary edges)
     * The segments array includes the start repeated at the end
     */
    expect(border.length).toBe(11);
  });

  it('traces an L-shaped territory', () => {
    // 6x6 grid, L-shape: cells [7, 8, 13] (row1:col1, row1:col2, row2:col1)
    const { grid, cellToArea } = setupGrid(6, 6, [7, 8, 13], 1);
    const border = traceBorder([7, 8, 13], cellToArea, grid.adjacency, 1);
    expect(border.length).toBeGreaterThan(0);
    // Closed loop
    const first = border[0];
    const last = border[border.length - 1];
    expect(last.cell).toBe(first.cell);
    expect(last.dir).toBe(first.dir);
  });

  it('all segments reference cells within the territory', () => {
    const cells = [10, 11, 12, 18, 19, 20];
    const { grid, cellToArea } = setupGrid(8, 8, cells, 2);
    const border = traceBorder(cells, cellToArea, grid.adjacency, 2);
    const cellSet = new Set(cells);
    for (const seg of border) {
      expect(cellSet.has(seg.cell)).toBe(true);
    }
  });

  it('returns empty for territory with no cells', () => {
    const { grid, cellToArea } = setupGrid(4, 4, [], 1);
    const border = traceBorder([], cellToArea, grid.adjacency, 1);
    expect(border).toEqual([]);
  });
});
