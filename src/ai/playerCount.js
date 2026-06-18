/**
 * Number of player slots an AI must account for in a legacy game view.
 *
 * Games can seat more than the usual 8 players — the online tournament runs a
 * 9-bot field — so AIs must size their per-player tables to the real count
 * rather than a hard-coded 8, or they drop the extra player(s) from their
 * census and crash when one of them takes a turn.
 *
 * Returns the largest of: the provided `player[]` length, one past the highest
 * owner index on the board, and 8 (a floor for the common case and for views
 * that under-provision `player[]`).
 *
 * @param {Object} game - Legacy mutable game view (adat[], player[], AREA_MAX).
 * @returns {number} Player count to iterate / size tables to.
 */
export function getPlayerCount(game) {
  let max = game.player?.length || 0;
  const { adat, AREA_MAX } = game;
  for (let i = 1; i < AREA_MAX; i++) {
    const area = adat[i];
    if (area && area.size !== 0 && area.arm + 1 > max) {
      max = area.arm + 1;
    }
  }
  return Math.max(max, 8);
}
