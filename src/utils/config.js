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

import { isKnownMapType } from '../engine/mapPersonalities.js';

/**
 * Map-size presets surfaced in the title-screen UI.
 *
 * Each key resolves to concrete engine dimensions: a `mapWidth × mapHeight`
 * hex grid plus `maxAreas` (the territory-count ceiling passed to the engine's
 * createGame/generateMap). Sizes are chosen so that cells-per-territory stays
 * comfortably above the engine's MIN_TERRITORY_SIZE (6) and `maxAreas` always
 * exceeds the 8-player maximum, so every preset is guaranteed to generate a
 * playable classic (full-rectangle) map for any supported player count (no
 * RangeError from pruning). Shaped map types (snowflake/ring/cross) remove board
 * area, so the tightest combos can occasionally fall short on a given seed;
 * createGame's bounded retry absorbs that, keeping shaped maps playable too.
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

/** Default map-type (personality) key — the classic full-rectangle map. */
export const DEFAULT_MAP_TYPE = 'random';

/**
 * Normalize a map-type (personality) key for the engine. Unknown keys fall back
 * to the classic random map — never throws, so a stale/bad token can't crash
 * game creation. The set of valid keys is owned by the engine's personality
 * registry (src/engine/mapPersonalities.js), so the two can't drift.
 *
 * @param {string} mapType - e.g. 'random' | 'snowflake' | 'ring' | 'cross'
 * @returns {string} a valid map-type key
 */
export function resolveMapType(mapType) {
  if (isKnownMapType(mapType)) return mapType;
  if (import.meta.env?.DEV) {
    console.warn(`resolveMapType: unknown map type "${mapType}" — falling back to "${DEFAULT_MAP_TYPE}".`);
  }
  return DEFAULT_MAP_TYPE;
}
