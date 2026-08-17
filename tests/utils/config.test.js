/**
 * Tests for the configuration module (map-size presets, luck ladder).
 */
import {
  MAP_SIZE_PRESETS,
  DEFAULT_MAP_SIZE,
  resolveMapSize,
  LUCK_LEVELS,
  DEFAULT_LUCK,
  luckToHandicap,
} from '../../src/utils/config.js';

describe('config — map size presets', () => {
  test('exposes small, medium, and large presets with engine dimensions', () => {
    for (const key of ['small', 'medium', 'large']) {
      const preset = MAP_SIZE_PRESETS[key];
      expect(preset).toBeDefined();
      expect(preset.mapWidth).toBeGreaterThan(0);
      expect(preset.mapHeight).toBeGreaterThan(0);
      expect(preset.maxAreas).toBeGreaterThan(0);
    }
  });

  test('medium reproduces the historical default (28x32, 32 territories)', () => {
    expect(MAP_SIZE_PRESETS.medium).toEqual({ mapWidth: 28, mapHeight: 32, maxAreas: 32 });
  });

  test('every preset is guaranteed to generate for up to 8 players', () => {
    /*
     * The engine prunes territories smaller than MIN_TERRITORY_SIZE (6 cells)
     * and throws if valid territories < playerCount. Keep cells-per-territory
     * well above 6 and maxAreas >= the 8-player maximum.
     */
    const MAX_PLAYERS = 8;
    for (const key of ['small', 'medium', 'large']) {
      const { mapWidth, mapHeight, maxAreas } = MAP_SIZE_PRESETS[key];
      expect(maxAreas).toBeGreaterThanOrEqual(MAX_PLAYERS);
      const cellsPerArea = (mapWidth * mapHeight) / maxAreas;
      expect(cellsPerArea).toBeGreaterThan(6);
    }
  });

  test('presets are ordered small < medium < large by cell count', () => {
    const cells = key => MAP_SIZE_PRESETS[key].mapWidth * MAP_SIZE_PRESETS[key].mapHeight;
    expect(cells('small')).toBeLessThan(cells('medium'));
    expect(cells('medium')).toBeLessThan(cells('large'));
  });

  test('DEFAULT_MAP_SIZE points at an existing preset', () => {
    expect(DEFAULT_MAP_SIZE).toBe('medium');
    expect(MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE]).toBeDefined();
  });

  describe('resolveMapSize', () => {
    test('resolves each preset key to its dimensions', () => {
      expect(resolveMapSize('small')).toEqual(MAP_SIZE_PRESETS.small);
      expect(resolveMapSize('medium')).toEqual(MAP_SIZE_PRESETS.medium);
      expect(resolveMapSize('large')).toEqual(MAP_SIZE_PRESETS.large);
    });

    test('falls back to the default preset for unknown or invalid keys', () => {
      /*
       * The fallback is dev-only-loud: it logs (so a missing preset surfaces in
       * dev) but never throws. Spy keeps the expected warnings out of test output.
       */
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const bad of ['huge', '', undefined, null, 0, 'MEDIUM']) {
        expect(resolveMapSize(bad)).toEqual(MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE]);
      }
      // import.meta.env.DEV is true under vitest, so the dev warning fires.
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe('config — luck ladder (#179)', () => {
  test('exposes the three player-facing rungs, in order, each with copy', () => {
    expect(LUCK_LEVELS.map(level => level.id)).toEqual([0, 1, 2]);
    expect(LUCK_LEVELS.map(level => level.name)).toEqual(['Normal', 'Lucky', 'Very lucky']);
    for (const level of LUCK_LEVELS) {
      expect(typeof level.blurb).toBe('string');
      expect(level.blurb.length).toBeGreaterThan(0);
    }
  });

  test('the copy stays in the "luck" register — never "cheat" or "loaded"', () => {
    const copy = LUCK_LEVELS.map(level => `${level.name} ${level.blurb}`)
      .join(' ')
      .toLowerCase();
    expect(copy).not.toMatch(/cheat|loaded|handicap/);
  });

  test('DEFAULT_LUCK is the off rung', () => {
    expect(DEFAULT_LUCK).toBe(0);
    expect(LUCK_LEVELS.find(level => level.id === DEFAULT_LUCK).name).toBe('Normal');
  });

  describe('luckToHandicap', () => {
    test('Normal is no handicap at all', () => {
      expect(luckToHandicap(0, 0)).toBeNull();
    });

    test('maps a rung onto the engine shape for the given seat', () => {
      expect(luckToHandicap(1, 0)).toEqual({ playerId: 0, level: 1 });
      expect(luckToHandicap(2, 3)).toEqual({ playerId: 3, level: 2 });
    });

    test('returns null without a seat to favour (spectator: humanPlayerIndex === null)', () => {
      expect(luckToHandicap(2, null)).toBeNull();
      expect(luckToHandicap(1, undefined)).toBeNull();
    });

    test('every level >= 1 produces a handicap the engine accepts (integer level >= 1)', () => {
      for (const level of LUCK_LEVELS.filter(entry => entry.id >= 1)) {
        const handicap = luckToHandicap(level.id, 0);
        expect(Number.isInteger(handicap.level)).toBe(true);
        expect(handicap.level).toBeGreaterThanOrEqual(1);
      }
    });

    test('throws on a rung that is not on the ladder', () => {
      for (const bad of [3, -1, 1.5, '1', null, undefined, NaN, {}]) {
        expect(() => luckToHandicap(bad, 0)).toThrow(/unknown luck level/);
      }
    });

    test('a fresh object each call — engine config can never alias the ladder', () => {
      const a = luckToHandicap(1, 0);
      const b = luckToHandicap(1, 0);
      expect(a).not.toBe(b);
    });
  });
});
