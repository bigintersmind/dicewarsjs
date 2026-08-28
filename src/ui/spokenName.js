/**
 * Spoken Names
 *
 * The phrases the live-region announcer (useAnnouncer) and the board's focus
 * targets (BoardFocus) both speak — who owns a territory, and how many dice are
 * on it — through two different channels: a live region and a button's
 * accessible name. The player hears both about the same territory, one after
 * the other, so they have to agree word for word. One rule, one file (#211).
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

/**
 * "4 dice" / "1 die" — a territory's dice, as both channels say it. The board's
 * buttons name every territory this way, and the live region's selection prompt
 * names the source the player has just pressed; a prompt that counted them
 * differently would read as a correction of the button.
 *
 * @param {number} dice
 * @returns {string}
 */
export function diceCount(dice) {
  return dice === 1 ? '1 die' : `${dice} dice`;
}
