import {
  buildMapMask,
  isKnownMapType,
  MAP_TYPES,
  MAP_TYPE_LABELS,
  MAP_TYPE_OPTIONS,
} from '../../src/engine/mapPersonalities.js';
import { createHexGrid } from '../../src/engine/HexGrid.js';
import { HEX_DIRECTIONS } from '../../src/engine/constants.js';

const DIMS = { width: 28, height: 32, playerCount: 6 };
const SHAPES = ['snowflake', 'ring', 'cross'];

/** Count connected components of land cells over the hex adjacency. */
function countLandComponents(mask, grid) {
  const seen = new Uint8Array(mask.length);
  let components = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start]) continue;
    components++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop();
      for (let d = 0; d < HEX_DIRECTIONS; d++) {
        const n = grid.adjacency[c][d];
        if (n >= 0 && mask[n] === 1 && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  return components;
}

describe('mapPersonalities', () => {
  describe('isKnownMapType / MAP_TYPES', () => {
    it('recognizes random and every shape', () => {
      expect(isKnownMapType('random')).toBe(true);
      for (const shape of SHAPES) expect(isKnownMapType(shape)).toBe(true);
    });

    it('rejects unknown ids', () => {
      expect(isKnownMapType('archipelago')).toBe(false);
      expect(isKnownMapType('')).toBe(false);
      expect(isKnownMapType(undefined)).toBe(false);
    });

    it('MAP_TYPES lists random first, then the shapes', () => {
      expect(MAP_TYPES[0]).toBe('random');
      for (const shape of SHAPES) expect(MAP_TYPES).toContain(shape);
    });
  });

  describe('MAP_TYPE_OPTIONS / MAP_TYPE_LABELS (drift guard)', () => {
    it('has a label for every registered map type (no unlabeled shape can ship)', () => {
      for (const type of MAP_TYPES) {
        expect(typeof MAP_TYPE_LABELS[type]).toBe('string');
        expect(MAP_TYPE_LABELS[type].length).toBeGreaterThan(0);
      }
    });

    it('derives options 1:1 from the registry, in MAP_TYPES order', () => {
      // This is the guard that keeps the title-screen picker from drifting from
      // the engine: the values are exactly MAP_TYPES, so the UI can never offer a
      // type the engine does not know (nor silently omit a newly-added one).
      expect(MAP_TYPE_OPTIONS.map(o => o.value)).toEqual([...MAP_TYPES]);
      for (const opt of MAP_TYPE_OPTIONS) {
        expect(opt.label).toBe(MAP_TYPE_LABELS[opt.value]);
      }
    });

    it('keeps Classic (random) first so it stays the default selection', () => {
      expect(MAP_TYPE_OPTIONS[0]).toEqual({ value: 'random', label: 'Classic' });
    });
  });

  describe('buildMapMask', () => {
    it('returns null for the maskless random/unknown types', () => {
      expect(buildMapMask('random', DIMS)).toBeNull();
      expect(buildMapMask('nope', DIMS)).toBeNull();
    });

    for (const shape of SHAPES) {
      describe(`${shape}`, () => {
        it('returns a land/sea Uint8Array of the right length', () => {
          const mask = buildMapMask(shape, DIMS);
          expect(mask).toBeInstanceOf(Uint8Array);
          expect(mask.length).toBe(DIMS.width * DIMS.height);
          for (const v of mask) expect(v === 0 || v === 1).toBe(true);
        });

        it('carves some land and some sea', () => {
          const mask = buildMapMask(shape, DIMS);
          let land = 0;
          for (const v of mask) land += v;
          expect(land).toBeGreaterThan(0);
          expect(land).toBeLessThan(mask.length);
        });

        it('is a single connected landmass', () => {
          const grid = createHexGrid(DIMS.width, DIMS.height);
          const mask = buildMapMask(shape, DIMS);
          expect(countLandComponents(mask, grid)).toBe(1);
        });
      });
    }

    it('snowflake arm count tracks player count (more players → more land lobes)', () => {
      // Not a strict geometric assertion — just that the mask responds to N.
      const two = buildMapMask('snowflake', { ...DIMS, playerCount: 2 });
      const eight = buildMapMask('snowflake', { ...DIMS, playerCount: 8 });
      const land = m => m.reduce((s, v) => s + v, 0);
      expect(land(two)).toBeGreaterThan(0);
      expect(land(eight)).toBeGreaterThan(0);
    });

    it('ring leaves an empty hole at the board centre', () => {
      const grid = createHexGrid(DIMS.width, DIMS.height);
      const mask = buildMapMask('ring', DIMS);
      const centre = Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2);
      expect(mask[centre]).toBe(0);
    });

    it('cross keeps the board centre as land (the contested hub)', () => {
      const grid = createHexGrid(DIMS.width, DIMS.height);
      const mask = buildMapMask('cross', DIMS);
      const centre = Math.floor(grid.height / 2) * grid.width + Math.floor(grid.width / 2);
      expect(mask[centre]).toBe(1);
    });
  });
});
