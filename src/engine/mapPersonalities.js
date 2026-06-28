/**
 * Map Personalities — handcrafted board shapes ("masks") for map generation.
 *
 * DiceWars territories are emergent: they grow from a hex-cell grid, and a cell
 * with no owner (`cells[i] === 0`) renders as empty sea. That `0` sentinel is a
 * built-in masking channel — to carve a recognizable board outline we simply
 * keep some cells permanently unassigned. This module produces those masks.
 *
 * A mask is a `Uint8Array` of length `width * height` where `1 = land` (a cell
 * the generator may grow a territory into) and `0 = sea` (a cell that stays
 * empty). `MapGenerator.generateMap` threads the mask through every cell-touching
 * stage so masked-out cells never get assigned, then derives territories,
 * adjacency, ownership, and dice exactly as it does for a full-rectangle map.
 *
 * SHAPE ONLY: these masks change the board outline, not who-starts-where.
 * Ownership stays the engine's existing random round-robin. Grouped per-region
 * starts (e.g. "claim an arm") are a deliberate later iteration.
 *
 * CONNECTIVITY: every shape here is a single connected landmass (arms meet at a
 * central hub, the ring is one loop, the cross bars cross at the centre). The
 * game requires all territories to be reachable from one another, so disjoint
 * shapes (archipelagos) are intentionally excluded.
 *
 * Pure geometry — no DOM, no RNG, no engine state. Keeps the engine free of any
 * renderer/UI import.
 *
 * @module engine/mapPersonalities
 */

/**
 * Vertical row step ÷ horizontal column step for the offset-hex layout.
 *
 * The renderer draws cells 27px wide on a 18px vertical row pitch, so a row is
 * 18/27 = 2/3 of a column-width tall. Working in "column-width units" (px = col +
 * 0.5·oddRow, py = row · ROW_SPACING) makes circles render round and arms render
 * symmetric instead of squashed. This constant mirrors the renderer's cell
 * aspect ratio without importing renderer code (which would invert the engine →
 * renderer dependency direction).
 */
const ROW_SPACING = 2 / 3;

/**
 * Convert a linear cell index to a continuous point in column-width units,
 * accounting for the half-column shift on odd rows.
 *
 * @param {number} cellIndex
 * @param {number} width
 * @returns {{ px: number, py: number }}
 */
function cellToPoint(cellIndex, width) {
  const col = cellIndex % width;
  const row = Math.floor(cellIndex / width);
  return { px: col + (row & 1) * 0.5, py: row * ROW_SPACING };
}

/**
 * Geometry shared by every mask: the board centre and the radius of the largest
 * circle that fits inside the (aspect-corrected) board. Shapes are sized
 * relative to `radius` so they scale across the small/medium/large presets.
 *
 * @param {number} width
 * @param {number} height
 * @returns {{ cx: number, cy: number, radius: number }}
 */
function boardGeometry(width, height) {
  // Corner-to-corner extent in column-width units (odd rows reach px = width-1+0.5).
  const maxPx = width - 1 + 0.5;
  const maxPy = (height - 1) * ROW_SPACING;
  return {
    cx: maxPx / 2,
    cy: maxPy / 2,
    radius: Math.min(maxPx, maxPy) / 2,
  };
}

/**
 * Build a Uint8Array mask from a per-cell predicate.
 *
 * @param {number} width
 * @param {number} height
 * @param {(px: number, py: number, cellIndex: number) => boolean} isLand
 * @returns {Uint8Array}
 */
function maskFromPredicate(width, height, isLand) {
  const cellCount = width * height;
  const mask = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const { px, py } = cellToPoint(i, width);
    if (isLand(px, py, i)) mask[i] = 1;
  }
  return mask;
}

/**
 * Snowflake: `max(2, playerCount)` arms radiating from a central hub.
 *
 * A cell is land if its distance from centre is within an angle-modulated limit
 * that peaks along each arm axis and shrinks toward the hub between arms — but
 * not all the way to the hub: it collapses to the `valley` floor (a thin land
 * bridge, see below) so the shape stays a single connected landmass. The
 * always-land hub forms the contested centre. Arm count tracks player count (the
 * design intent: N arms for N players, floored at 2), even though ownership is
 * not yet bound to arms.
 */
function snowflakeMask(width, height, playerCount) {
  const { cx, cy, radius } = boardGeometry(width, height);
  const arms = Math.max(2, playerCount);
  const rMax = radius * 0.98;
  const rHub = rMax * 0.42; // central hub: always land, connects every arm
  /*
   * Minimum arm radius (as a fraction of the arm length) in the valleys between
   * arms. A non-zero floor keeps a thin land bridge all the way around, which
   * guarantees a single connected landmass even at high arm counts while staying
   * small enough that the arms still read as a star. (Playability for the
   * tightest combo — smallest board, most players — is guaranteed by createGame's
   * bounded retry, not by inflating this floor into a blob.)
   */
  const valley = 0.16;
  const sharpness = 1.1; // higher = thinner, pointier arms

  return maskFromPredicate(width, height, (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    const r = Math.hypot(dx, dy);
    if (r <= rHub) return true;
    const theta = Math.atan2(dy, dx);
    // (cos(arms·θ)+1)/2 is 1 along each arm axis and 0 exactly between arms.
    const lobe = (Math.cos(arms * theta) + 1) / 2;
    const profile = valley + (1 - valley) * Math.pow(lobe, sharpness);
    const rLimit = rHub + (rMax - rHub) * profile;
    return r <= rLimit;
  });
}

/**
 * Ring (donut): an annular landmass with a sea hole in the middle, so combat is
 * forced around the loop with no central retreat.
 */
function ringMask(width, height) {
  const { cx, cy, radius } = boardGeometry(width, height);
  const rOuter = radius * 0.96;
  const rInner = radius * 0.46;

  return maskFromPredicate(width, height, (px, py) => {
    const r = Math.hypot(px - cx, py - cy);
    return r >= rInner && r <= rOuter;
  });
}

/**
 * Cross (plus): a horizontal and a vertical bar spanning the board and meeting
 * at a single heavily-contested central hub.
 */
function crossMask(width, height) {
  const { cx, cy, radius } = boardGeometry(width, height);
  const halfWidth = radius * 0.3; // half-thickness of each bar

  return maskFromPredicate(
    width,
    height,
    (px, py) => Math.abs(py - cy) <= halfWidth || Math.abs(px - cx) <= halfWidth
  );
}

/**
 * Registry of shape builders keyed by map-type id. Each builder takes
 * `(width, height, playerCount)` and returns a land/sea Uint8Array mask.
 *
 * `random` is intentionally absent: it has no mask (full rectangle) and routes
 * through the generator's original percolation path unchanged.
 *
 * @type {Record<string, (width: number, height: number, playerCount: number) => Uint8Array>}
 */
const MASK_BUILDERS = Object.freeze({
  snowflake: snowflakeMask,
  ring: ringMask,
  cross: crossMask,
});

/** The full set of valid map-type ids, including the maskless default. */
export const MAP_TYPES = Object.freeze(['random', ...Object.keys(MASK_BUILDERS)]);

/**
 * Human-readable label for each map-type id. The classic maskless map is shown as
 * "Classic"; shapes use their capitalized id. This is the single source of truth
 * for the title-screen picker labels (see {@link MAP_TYPE_OPTIONS}); any id in
 * MAP_TYPES without an entry here falls back to the raw id at build time, and a
 * test asserts full coverage so a newly-registered shape can't ship unlabeled.
 *
 * @type {Record<string, string>}
 */
export const MAP_TYPE_LABELS = Object.freeze({
  random: 'Classic',
  snowflake: 'Snowflake',
  ring: 'Ring',
  cross: 'Cross',
});

/**
 * Title-screen picker options, DERIVED from the engine registry so the UI can
 * never offer a map type the engine doesn't know (and a newly-registered shape
 * appears automatically). Keeping this in the engine — where the registry lives —
 * is what makes the value list drift-proof; the labels are plain presentation
 * strings, not engine logic.
 *
 * @type {ReadonlyArray<{ value: string, label: string }>}
 */
export const MAP_TYPE_OPTIONS = Object.freeze(
  MAP_TYPES.map(value => Object.freeze({ value, label: MAP_TYPE_LABELS[value] ?? value }))
);

/**
 * @param {string} mapType
 * @returns {boolean} true if `mapType` is a recognized map-type id.
 */
export function isKnownMapType(mapType) {
  return mapType === 'random' || Object.prototype.hasOwnProperty.call(MASK_BUILDERS, mapType);
}

/**
 * @param {string} mapType
 * @returns {boolean} true if `mapType` carves a shaped (masked) board — i.e. any
 *   personality other than the classic maskless 'random'. Unknown ids are false
 *   (they degrade to the maskless map). Used by createGame to apply the
 *   shaped-map territory cap and the bounded generation retry.
 */
export function isMaskedMapType(mapType) {
  return Object.prototype.hasOwnProperty.call(MASK_BUILDERS, mapType);
}

/**
 * Build the land/sea mask for a map type.
 *
 * @param {string} mapType - e.g. 'random' | 'snowflake' | 'ring' | 'cross'
 * @param {{ width: number, height: number, playerCount: number }} dims
 * @returns {Uint8Array | null} land/sea mask, or `null` for the maskless
 *   full-rectangle default ('random' or any unrecognized id).
 */
export function buildMapMask(mapType, { width, height, playerCount }) {
  const builder = MASK_BUILDERS[mapType];
  if (!builder) return null;
  return builder(width, height, playerCount);
}
