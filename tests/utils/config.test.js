/**
 * Tests for the configuration module (map-size presets).
 */
import { MAP_SIZE_PRESETS, DEFAULT_MAP_SIZE, resolveMapSize } from '../../src/utils/config.js';

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
      for (const bad of ['huge', '', undefined, null, 0, 'MEDIUM']) {
        expect(resolveMapSize(bad)).toEqual(MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE]);
      }
    });
  });
});
