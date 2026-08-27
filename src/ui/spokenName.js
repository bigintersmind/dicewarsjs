/**
 * Spoken Seat Name
 *
 * Shared by the live-region announcer (useAnnouncer) and the board's focus
 * targets (BoardFocus), which speak the same seats through different channels
 * — a live region and a button's accessible name. One rule, one file (#211).
 *
 * @module ui/spokenName
 */

import { playerName } from '../store/GameStore.js';

/**
 * Spoken name for a seat. The visual labels lean on the seat color to tell two
 * seats running the same bot apart; speech has no color, so when the lineup
 * repeats a name the seat number is spoken too — "Balanced AI, player 3" (the
 * whole Standard lineup is Balanced AI). A name unique in the lineup is spoken
 * bare.
 *
 * @param {string[] | undefined} playerNames - StoreState.playerNames
 * @param {number} playerId
 * @returns {string}
 */
export function spokenName(playerNames, playerId) {
  const name = playerName(playerNames, playerId);
  const repeated = (playerNames ?? []).filter(n => n === name).length > 1;
  return repeated ? `${name}, player ${playerId + 1},` : name;
}
