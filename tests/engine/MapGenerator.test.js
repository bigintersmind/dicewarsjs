import { generateMap } from '../../src/engine/MapGenerator.js';
import { createRng } from '../../src/engine/rng.js';
import { buildMapMask } from '../../src/engine/mapPersonalities.js';
import { MAX_DICE, DEFAULT_AREA_MAX } from '../../src/engine/constants.js';

const DEFAULT_CONFIG = {
  mapWidth: 28,
  mapHeight: 32,
  maxAreas: 32,
  playerCount: 7,
  dicePerArea: 3,
};

/** Count connected components of valid areas, walking neighborAreaIds. */
function countAreaComponents(areas) {
  const valid = areas.filter(a => a.size > 0).map(a => a.id);
  if (valid.length === 0) return 0;
  const seen = new Set();
  let components = 0;
  for (const start of valid) {
    if (seen.has(start)) continue;
    components++;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const a = stack.pop();
      for (const n of areas[a].neighborAreaIds) {
        if (areas[n] && areas[n].size > 0 && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
  }
  return components;
}

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

describe('generateMap personality maps', () => {
  const SHAPES = ['snowflake', 'ring', 'cross'];
  const SIZES = {
    small: { mapWidth: 20, mapHeight: 24, maxAreas: 20 },
    medium: { mapWidth: 28, mapHeight: 32, maxAreas: 32 },
    large: { mapWidth: 36, mapHeight: 40, maxAreas: 48 },
  };

  it("'random' (or omitted) mapType is byte-identical to the classic generator", () => {
    // The shaped path must not perturb the default map: same seed, same cells.
    const classic = generateMap(DEFAULT_CONFIG, createRng(7));
    const explicit = generateMap({ ...DEFAULT_CONFIG, mapType: 'random' }, createRng(7));
    expect(explicit.cells).toEqual(classic.cells);
    for (let i = 1; i < classic.areas.length; i++) {
      expect(explicit.areas[i].owner).toBe(classic.areas[i].owner);
      expect(explicit.areas[i].dice).toBe(classic.areas[i].dice);
      expect(explicit.areas[i].size).toBe(classic.areas[i].size);
    }
  });

  it('an unknown mapType falls back to the classic full-board map', () => {
    const classic = generateMap(DEFAULT_CONFIG, createRng(3));
    const bogus = generateMap(
      { ...DEFAULT_CONFIG, mapType: 'definitely-not-a-shape' },
      createRng(3)
    );
    expect(bogus.cells).toEqual(classic.cells);
  });

  for (const shape of SHAPES) {
    describe(`${shape}`, () => {
      const config = { ...DEFAULT_CONFIG, mapType: shape };

      it('is deterministic for a given seed', () => {
        const a = generateMap(config, createRng(42));
        const b = generateMap(config, createRng(42));
        expect(a.cells).toEqual(b.cells);
      });

      it('carves sea: only masked land cells are ever assigned', () => {
        const { cells, grid } = generateMap(config, createRng(11));
        const mask = buildMapMask(shape, {
          width: grid.width,
          height: grid.height,
          playerCount: config.playerCount,
        });
        let land = 0;
        for (let i = 0; i < cells.length; i++) {
          if (cells[i] !== 0) {
            expect(mask[i]).toBe(1); // never leak onto sea cells
            land++;
          }
        }
        // The shape must actually remove board area (it is not a full rectangle).
        expect(land).toBeLessThan(grid.cellCount);
      });

      it('forms a single connected landmass', () => {
        for (const seed of [1, 2, 3, 7, 19]) {
          const { areas } = generateMap(config, createRng(seed));
          expect(countAreaComponents(areas)).toBe(1);
        }
      });

      it('keeps all valid areas >= 6 cells with symmetric, self-free adjacency', () => {
        const { areas } = generateMap(config, createRng(5));
        for (let i = 1; i < areas.length; i++) {
          if (areas[i].size === 0) continue;
          expect(areas[i].size).toBeGreaterThanOrEqual(6);
          expect(areas[i].neighborAreaIds).not.toContain(i);
          for (const adjId of areas[i].neighborAreaIds) {
            expect(areas[adjId].neighborAreaIds).toContain(i);
          }
        }
      });

      it('places valid dice (1..MAX_DICE) on every territory of the shaped board', () => {
        const { areas } = generateMap(config, createRng(8));
        for (let i = 1; i < areas.length; i++) {
          if (areas[i].size === 0) continue;
          expect(areas[i].dice).toBeGreaterThanOrEqual(1);
          expect(areas[i].dice).toBeLessThanOrEqual(MAX_DICE);
        }
      });

      it('seats every player across all player counts and sizes', () => {
        for (const dims of Object.values(SIZES)) {
          for (let playerCount = 2; playerCount <= 8; playerCount++) {
            const { areas } = generateMap(
              { ...dims, dicePerArea: 3, playerCount, mapType: shape },
              createRng(playerCount * 13 + 1)
            );
            const valid = areas.filter(a => a.size > 0);
            expect(valid.length).toBeGreaterThanOrEqual(playerCount);
            const owners = new Set(valid.map(a => a.owner));
            for (let p = 0; p < playerCount; p++) {
              expect(owners.has(p)).toBe(true);
            }
          }
        }
      });

      it('caps area ids below DEFAULT_AREA_MAX even on the large preset', () => {
        // ai_bc/ai_ppo bake maxAreas=32 and throw at inference on any id >= 32.
        const { areas } = generateMap(
          { ...SIZES.large, dicePerArea: 3, playerCount: 8, mapType: shape },
          createRng(99)
        );
        expect(areas.length).toBeLessThanOrEqual(DEFAULT_AREA_MAX);
        for (const a of areas) {
          if (a.size > 0) expect(a.id).toBeLessThan(DEFAULT_AREA_MAX);
        }
      });
    });
  }
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
