/**
 * Game configuration — the title screen's per-game setup axes.
 *
 * Two tables live here, both picked on the title screen and both resolved by
 * the controller into engine config: the map-size presets (`resolveMapSize`)
 * and the luck ladder (`luckToHandicap`, issue #179).
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

/**
 * "Your luck" ladder (issue #179) — the second, orthogonal difficulty axis
 * beside the Easy/Standard/Hard bot lineups.
 *
 * At level `k` the player's seat rolls `k` extra dice and drops the `k` lowest,
 * attacking *and* defending (see docs/GAME_RULES.md, "Luck handicap").
 *
 * Rung ids >= 1 are also the engine's `handicap.level` values (capped by
 * MAX_HANDICAP_LEVEL); rung 0 is UI-only — it means "no handicap", which the
 * engine spells `handicap: null` and rejects as a level. `luckToHandicap` owns
 * that translation.
 *
 * This table is the ladder itself, but it is not the only place a rung is
 * named: README.md, CLAUDE.md and docs/GAME_RULES.md enumerate the rungs too,
 * so adding one means updating them alongside this entry and its blurb.
 */
export const LUCK_LEVELS = [
  { id: 0, name: 'Normal', blurb: 'Fair dice — everyone rolls the same.' },
  {
    id: 1,
    name: 'Lucky',
    blurb: 'You roll one extra die and drop the lowest — attacking and defending.',
  },
  {
    id: 2,
    name: 'Very lucky',
    blurb: 'You roll two extra dice and drop the two lowest — attacking and defending.',
  },
];

/** Default luck rung: no handicap. */
export const DEFAULT_LUCK = 0;

/**
 * Turn the UI's luck rung into the engine's handicap config — the single place
 * the player-facing axis becomes `{ playerId, level }`.
 *
 * Returns `null` (handicap off) for the Normal rung and for a seatless game:
 * `playerId` is the store's `humanPlayerIndex`, and `null` is its documented
 * spectator (AI vs AI) sentinel — there is no human seat to favour.
 *
 * Unlike `resolveMapSize`, bad input throws rather than falling back. An unknown
 * rung changes how battles resolve and is recorded in the replay, so silently
 * substituting a different one would ship a game that isn't the one the player
 * picked. A `playerId` that is neither `null` nor a seat index is a caller bug:
 * treating it as "no seat" would quietly play an unhandicapped game after the
 * player asked for luck, and passing it through would surface far away, inside
 * `createGame`. (`createGame` rejects a malformed handicap for the same reason.)
 *
 * @param {number} luck - Rung id from LUCK_LEVELS
 * @param {number | null} playerId - Seat to favour (the human's), or null for none
 * @returns {{ playerId: number, level: number } | null}
 * @throws {Error} On a rung off the ladder, or a playerId that is not null or a seat index
 */
export function luckToHandicap(luck, playerId) {
  if (!LUCK_LEVELS.some(level => level.id === luck)) {
    const ids = LUCK_LEVELS.map(level => level.id).join(', ');
    throw new Error(`luckToHandicap: unknown luck level ${JSON.stringify(luck)} (expected ${ids})`);
  }
  if (playerId === null) return null;
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new Error(
      `luckToHandicap: playerId must be null (no human seat) or a non-negative integer seat index, got ${JSON.stringify(playerId)}`
    );
  }
  if (luck < 1) return null;
  return { playerId, level: luck };
}
