/**
 * Screen Reader Announcer Hook
 *
 * Generates announcement text for ARIA live regions from game state changes:
 * whose turn it is, what input the board is waiting for, a battle result, the
 * winner.
 *
 * The board's own keyboard focus is NOT announced here. It used to be (#211
 * item 1), because the focus ring was virtual and no DOM element held it; since
 * item 2 each territory is a real button in `BoardFocus`, and the browser
 * announces the focused one itself. A second voice over the same move is worse
 * than none.
 *
 * @module ui/hooks/useAnnouncer
 */

import { useState, useEffect } from 'preact/hooks';
import { useGameStore } from './useGameStore.js';
import { spokenName } from '../spokenName.js';

/**
 * @param {Object} store - GameStore instance
 * @returns {string} Current announcement text
 */
export function useAnnouncer(store) {
  const [announcement, setAnnouncement] = useState('');

  const screen = useGameStore(store, s => s.screen);
  const awaitingInput = useGameStore(store, s => s.awaitingInput);
  const battleResult = useGameStore(store, s => s.battleResult);
  const gameState = useGameStore(store, s => s.gameState);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const playerNames = useGameStore(store, s => s.playerNames);

  useEffect(() => {
    if (!gameState) return;

    const currentPlayerId = gameState.turnOrder[gameState.currentPlayerIndex];
    const isHumanTurn = currentPlayerId === humanPlayerIndex;

    if (screen === 'gameOver' && gameState.winner !== null) {
      // The visible screen names the winner too (GameOverScreen), so a bot's
      // seat is announced by its bot name. The human seat's recorded name is
      // "You", which the generic template would render as "You wins!" — hence
      // its own branch.
      setAnnouncement(
        gameState.winner === humanPlayerIndex
          ? 'Game over. You win!'
          : `Game over. ${spokenName(playerNames, gameState.winner)} wins!`
      );
      return;
    }

    if (isHumanTurn && awaitingInput === 'selectFrom') {
      const territories = gameState.players[humanPlayerIndex]?.territoryCount || 0;
      setAnnouncement(
        `Your turn. You have ${territories} territories. Select a territory to attack from.`
      );
      return;
    }

    if (isHumanTurn && awaitingInput === 'selectTo') {
      // The arrows are named here because this is the moment a screen-reader
      // player is stuck: every enemy territory is `tabindex="-1"`, so Tab
      // reaches no target at all, and the live region carries to every reader.
      setAnnouncement('Select a neighboring territory to attack. Use the arrow keys to move.');
      return;
    }

    if (!isHumanTurn && humanPlayerIndex !== null) {
      setAnnouncement(`${spokenName(playerNames, currentPlayerId)} is thinking.`);
      return;
    }
  }, [
    screen,
    awaitingInput,
    gameState?.currentPlayerIndex,
    humanPlayerIndex,
    playerNames,
    gameState?.winner,
    gameState?.phase,
  ]);

  useEffect(() => {
    if (!battleResult) return;
    const atkTotal = battleResult.attackerRoll?.total ?? 0;
    const defTotal = battleResult.defenderRoll?.total ?? 0;
    const outcome = battleResult.success ? 'Success' : 'Failed';
    setAnnouncement(`Attack: rolled ${atkTotal} vs ${defTotal}. ${outcome}.`);
  }, [battleResult]);

  return announcement;
}
