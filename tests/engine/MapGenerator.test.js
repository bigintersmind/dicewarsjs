import { generateMap } from '../../src/engine/MapGenerator.js';
import { createRng } from '../../src/engine/rng.js';
import { MAX_DICE } from '../../src/engine/constants.js';

const DEFAULT_CONFIG = {
  mapWidth: 28,
  mapHeight: 32,
  maxAreas: 32,
  playerCount: 7,
  dicePerArea: 3,
};

describe('generateMap', () => {
  describe('determinism', () => {
    it('produces identical maps from the same seed', () => {
      const map1 = generateMap(DEFAULT_CONFIG, createRng(42));
      const map2 = generateMap(DEFAULT_CONFIG, createRng(42));

      // Same cells
      expect(map1.cells).toEqual(map2.cells);

      // Same area ownership, dice, adjacency
      for (let i = 1; i < map1.areas.length; i++) {
        expect(map1.areas[i].owner).toBe(map2.areas[i].owner);
        expect(map1.areas[i].dice).toBe(map2.areas[i].dice);
        expect(map1.areas[i].size).toBe(map2.areas[i].size);
        expect(map1.areas[i].neighborAreaIds.sort()).toEqual(map2.areas[i].neighborAreaIds.sort());
      }
    });

    it('produces different maps from different seeds', () => {
      const map1 = generateMap(DEFAULT_CONFIG, createRng(1));
      const map2 = generateMap(DEFAULT_CONFIG, createRng(2));
      expect(map1.cells).not.toEqual(map2.cells);
    });
  });

  describe('grid', () => {
    it('returns a grid with correct dimensions', () => {
      const { grid } = generateMap(DEFAULT_CONFIG, createRng(10));
      expect(grid.width).toBe(28);
      expect(grid.height).toBe(32);
      expect(grid.cellCount).toBe(896);
    });
  });

  describe('areas', () => {
    it('all valid areas have size >= 6', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].size > 0) {
          expect(areas[i].size).toBeGreaterThanOrEqual(6);
        }
      }
    });

    it('creates a reasonable number of territories', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      const validCount = areas.filter(a => a.size > 0).length;
      // With maxAreas=32, we expect at least 15 territories
      expect(validCount).toBeGreaterThanOrEqual(15);
    });

    it('index 0 is unused sentinel', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      expect(areas[0].size).toBe(0);
      expect(areas[0].owner).toBe(-1);
    });
  });

  describe('adjacency', () => {
    it('is bidirectional — if A adj to B, then B adj to A', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].size === 0) continue;
        for (const adjId of areas[i].neighborAreaIds) {
          expect(areas[adjId].neighborAreaIds).toContain(i);
        }
      }
    });

    it('areas are not adjacent to themselves', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let i = 1; i < areas.length; i++) {
        expect(areas[i].neighborAreaIds).not.toContain(i);
      }
    });
  });

  describe('player distribution', () => {
    it('distributes territories across all players', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      const playerCounts = new Array(7).fill(0);
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].size > 0) {
          expect(areas[i].owner).toBeGreaterThanOrEqual(0);
          expect(areas[i].owner).toBeLessThan(7);
          playerCounts[areas[i].owner]++;
        }
      }
      // Every player should have at least 1 territory
      for (let p = 0; p < 7; p++) {
        expect(playerCounts[p]).toBeGreaterThanOrEqual(1);
      }
    });

    it('distributes territories roughly evenly', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      const playerCounts = new Array(7).fill(0);
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].size > 0) playerCounts[areas[i].owner]++;
      }
      const min = Math.min(...playerCounts);
      const max = Math.max(...playerCounts);
      // Difference should be at most 1 (round-robin)
      expect(max - min).toBeLessThanOrEqual(1);
    });
  });

  describe('dice distribution', () => {
    it('every valid territory has at least 1 die', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].size > 0) {
          expect(areas[i].dice).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it('no territory exceeds MAX_DICE', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].size > 0) {
          expect(areas[i].dice).toBeLessThanOrEqual(MAX_DICE);
        }
      }
    });

    it('total dice roughly matches expectedCount * dicePerArea', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      const validCount = areas.filter(a => a.size > 0).length;
      const totalDice = areas.reduce((sum, a) => sum + (a.size > 0 ? a.dice : 0), 0);
      const expectedTotal = validCount * DEFAULT_CONFIG.dicePerArea;
      // Allow some tolerance due to MAX_DICE cap
      expect(totalDice).toBeGreaterThanOrEqual(expectedTotal * 0.7);
      expect(totalDice).toBeLessThanOrEqual(expectedTotal * 1.3);
    });
  });

  describe('cells array', () => {
    it('cells assigned to valid areas match area.cells', () => {
      const { areas, cells } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let a = 1; a < areas.length; a++) {
        if (areas[a].size === 0) continue;
        for (const c of areas[a].cells) {
          expect(cells[c]).toBe(a);
        }
      }
    });
  });

  describe('center cells', () => {
    it('every valid area has a center cell within its own cells', () => {
      const { areas } = generateMap(DEFAULT_CONFIG, createRng(10));
      for (let a = 1; a < areas.length; a++) {
        if (areas[a].size === 0) continue;
        expect(areas[a].centerCell).toBeGreaterThanOrEqual(0);
        expect(areas[a].cells).toContain(areas[a].centerCell);
      }
    });
  });

  describe('smaller map config', () => {
    it('works with non-standard dimensions', () => {
      const config = {
        mapWidth: 10,
        mapHeight: 10,
        maxAreas: 10,
        playerCount: 3,
        dicePerArea: 2,
      };
      const { areas, grid } = generateMap(config, createRng(55));
      expect(grid.width).toBe(10);
      expect(grid.height).toBe(10);
      const validCount = areas.filter(a => a.size > 0).length;
      expect(validCount).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('generateMap validation', () => {
  const rng = () => createRng(1);

  it('throws RangeError for playerCount < 1', () => {
    expect(() => generateMap({ ...DEFAULT_CONFIG, playerCount: 0 }, rng())).toThrow(RangeError);
  });

  it('throws RangeError for zero-dimension grid', () => {
    expect(() => generateMap({ ...DEFAULT_CONFIG, mapWidth: 0 }, rng())).toThrow(RangeError);
    expect(() => generateMap({ ...DEFAULT_CONFIG, mapHeight: 0 }, rng())).toThrow(RangeError);
  });

  it('throws RangeError for maxAreas < 2', () => {
    expect(() => generateMap({ ...DEFAULT_CONFIG, maxAreas: 1 }, rng())).toThrow(RangeError);
  });
});
