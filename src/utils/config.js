/**
 * Game configuration — map-size presets.
 *
 * The live game uses only the map-size presets below: the title screen lets the
 * player pick a size, and the controller resolves it to concrete engine
 * dimensions via `resolveMapSize`. The earlier CreateJS/Webpack-era config
 * plumbing (DEFAULT_CONFIG, getConfig/updateConfig/loadConfig/resetConfig/
 * applyConfigToGame, and the `window.*` globals) has been removed — it had no
 * remaining consumers.
 */

/**
 * Map-size presets surfaced in the title-screen UI.
 *
 * Each key resolves to concrete engine dimensions: a `mapWidth × mapHeight`
 * hex grid plus `maxAreas` (the territory-count ceiling passed to the engine's
 * createGame/generateMap). Sizes are chosen so that cells-per-territory stays
 * comfortably above the engine's MIN_TERRITORY_SIZE (6) and `maxAreas` always
 * exceeds the 8-player maximum, so every preset is guaranteed to generate a
 * playable map for any supported player count (no RangeError from pruning).
 *
 * `medium` reproduces the historical default (28×32, 32 territories) so the
 * default selection preserves the original behaviour.
 */
export const MAP_SIZE_PRESETS = {
  small: { mapWidth: 20, mapHeight: 24, maxAreas: 20 },
  medium: { mapWidth: 28, mapHeight: 32, maxAreas: 32 },
  large: { mapWidth: 36, mapHeight: 40, maxAreas: 48 },
};

/** Default map-size preset key. */
export const DEFAULT_MAP_SIZE = 'medium';

/**
 * Resolve a map-size preset key to concrete engine dimensions.
 * Unknown/invalid keys fall back to the default (medium) preset — never throws,
 * so a bad size token can't crash game creation. In dev builds the fallback is
 * also logged, to surface a missing-preset mistake (see below).
 *
 * @param {string} size - Preset key ('small' | 'medium' | 'large')
 * @returns {{ mapWidth: number, mapHeight: number, maxAreas: number }}
 */
export function resolveMapSize(size) {
  const preset = MAP_SIZE_PRESETS[size];
  if (!preset && import.meta.env?.DEV) {
    /*
     * Dev-only signal. Selectable sizes (MAP_SIZE_OPTIONS in the title screen)
     * must each have a matching preset key here; adding an option without its
     * preset would otherwise silently ship a medium map with no indication.
     * Guarded by `import.meta.env?.DEV` so production builds stay silent and the
     * `?.` keeps it safe under plain Node (arena/CLI), where env is undefined.
     */
    console.warn(`resolveMapSize: unknown map size "${size}" — falling back to "${DEFAULT_MAP_SIZE}".`);
  }
  return preset ?? MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE];
}
