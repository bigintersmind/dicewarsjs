/**
 * Screen Reader Announcer Hook
 *
 * Generates announcement text from game state changes
 * for ARIA live regions.
 *
 * @module ui/hooks/useAnnouncer
 */

import { useState, useEffect } from 'preact/hooks';
import { useGameStore } from './useGameStore.js';
import { playerName } from '../../store/GameStore.js';

/**
 * Spoken name for a seat. The visual labels lean on the seat color to tell two
 * seats running the same bot apart; a live region has no color, so when the
 * lineup repeats a name the seat number is spoken too — "Balanced AI, player 3"
 * (the whole Standard lineup is Balanced AI). A name unique in the lineup is
 * spoken bare.
 *
 * @param {string[] | undefined} playerNames - StoreState.playerNames
 * @param {number} playerId
 * @returns {string}
 */
function spokenName(playerNames, playerId) {
  const name = playerName(playerNames, playerId);
  const repeated = (playerNames ?? []).filter(n => n === name).length > 1;
  return repeated ? `${name}, player ${playerId + 1},` : name;
}

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
      setAnnouncement('Select a neighboring territory to attack.');
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
