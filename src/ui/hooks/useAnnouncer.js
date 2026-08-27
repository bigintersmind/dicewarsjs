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

  /*
   * The two screens that have a game to talk about. Everything else — title,
   * map preview, arena, tournament, leaderboard, replay — is silent, and the
   * hook has to say so itself: since #211 item 9 the region is mounted for the
   * whole session rather than by the playing / gameOver branches of App's
   * screen switch, so "am I on a game screen?" stopped being implied by being
   * mounted at all.
   */
  const onGameScreen = screen === 'playing' || screen === 'gameOver';

  useEffect(() => {
    /*
     * Off the game screens, empty the line. Two things ride on this:
     *
     * - Silence where there is no game. The store keeps a whole gameState
     *   through the map preview — a fresh board with `awaitingInput: null` and a
     *   turn order that may open on a bot, which is exactly the "is thinking"
     *   branch's precondition below. It would narrate a board nobody is playing.
     * - Making the next game's lines audible. `setAnnouncement(sameString)` is a
     *   no-op: no re-render, no DOM mutation, nothing for assistive tech to
     *   notice. On one persistent region, two games ending "Game over. You win!"
     *   would announce the first and leave the second silent. Clearing on the
     *   way out makes each game's identical line a change again.
     */
    if (!onGameScreen) {
      setAnnouncement('');
      return;
    }

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
    /*
     * `screen` is read here but deliberately kept OUT of this effect's deps. The
     * battle line must be spoken when a battle lands and only then; with `screen`
     * in the deps, any screen change while the last result still sat in the store
     * would re-speak a stale attack — and at the playing → gameOver seam it would
     * run after the effect above and overwrite "Game over…" with it. Deps of
     * [battleResult] mean this closure is invoked only on the render where the
     * result changed, so the screen it reads is that render's screen: the guard
     * is evaluated at the moment the battle actually arrives.
     */
    if (!onGameScreen) return;
    const atkTotal = battleResult.attackerRoll?.total ?? 0;
    const defTotal = battleResult.defenderRoll?.total ?? 0;
    const outcome = battleResult.success ? 'Success' : 'Failed';
    setAnnouncement(`Attack: rolled ${atkTotal} vs ${defTotal}. ${outcome}.`);
  }, [battleResult]);

  return announcement;
}
