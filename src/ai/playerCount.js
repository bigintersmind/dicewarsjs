/**
 * Player-slot sizing for legacy game views — the single source of truth.
 *
 * Games can seat more than the usual 8 players (the online tournament runs a
 * larger field), so a legacy view's per-player tables — `player[]`, plus the
 * census arrays AIs build — must be sized to the real player count rather than
 * a hard-coded 8. Get it wrong and an AI drops the extra player(s) from its
 * census and crashes when one of them takes a turn.
 *
 * Both the view builders (engine/AIAdapter, arena/legacyBotAdapter) and the AIs
 * that read those views derive their size from this one module. The builders
 * call playerSlotCount to size `player[]`; the AIs call getPlayerCount on the
 * finished view. Because both fold in the same board scan, a built `player[]`
 * and a later getPlayerCount(view) can never disagree.
 *
 * @module ai/playerCount
 */

/** Floor on player slots: the common case, and a net for views that under-provision `player[]`. */
const PLAYER_FLOOR = 8;

/**
 * One past the highest owner index among occupied legacy `adat` areas (0 if the
 * board is empty or absent). Empty/sentinel areas (size 0, arm -1) are skipped,
 * and a missing `adat` is tolerated so partial views don't throw.
 *
 * @param {Array|undefined} adat - Legacy area table, 1-indexed; each `{ size, arm }`.
 * @param {number} areaMax - One past the highest area id (adat length).
 * @returns {number}
 */
function highestOwnerSlot(adat, areaMax) {
  let slot = 0;
  for (let i = 1; adat && i < areaMax; i++) {
    const area = adat[i];
    if (area && area.size !== 0 && area.arm + 1 > slot) {
      slot = area.arm + 1;
    }
  }
  return slot;
}

/**
 * Number of player slots a legacy view must allocate: the largest of the seated
 * player count, one past the highest board owner index, and a floor of 8.
 *
 * View builders call this to size `player[]` up front. Sizing from the same
 * board scan the AIs use guarantees `player.length` covers every owner index,
 * so the per-player loops in the AIs can index `player[]` without going out of
 * bounds.
 *
 * @param {number} playerLength - Number of seated players (0 if unknown).
 * @param {Array|undefined} adat - Legacy area table (see highestOwnerSlot).
 * @param {number} areaMax - One past the highest area id.
 * @returns {number}
 */
export function playerSlotCount(playerLength, adat, areaMax) {
  return Math.max(playerLength || 0, highestOwnerSlot(adat, areaMax), PLAYER_FLOOR);
}

/**
 * Number of player slots an AI must account for in a legacy game view. Sized
 * from the view's own `player[]` length and board, so it matches the count the
 * view was built with (see playerSlotCount).
 *
 * @param {Object} game - Legacy mutable game view (player[], adat[], AREA_MAX).
 * @returns {number} Player count to iterate / size tables to.
 */
export function getPlayerCount(game) {
  return playerSlotCount(game.player?.length || 0, game.adat, game.AREA_MAX);
}
