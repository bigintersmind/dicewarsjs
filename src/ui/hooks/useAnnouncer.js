/**
 * Screen Reader Announcer Hook
 *
 * Generates announcement text for ARIA live regions: from game state changes,
 * and from the board's keyboard focus as the player tabs or arrows around it.
 *
 * @module ui/hooks/useAnnouncer
 */

import { useState, useEffect, useRef } from 'preact/hooks';
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
  const focusedAreaId = useGameStore(store, s => s.focusedAreaId);

  // The board's keyboard focus ring (#211), in its own effect and declared FIRST on purpose.
  // Effects flush in declaration order, so a single commit that changed both the ring and the turn
  // (or the battle) ends on one of the effects below: the turn or the battle wins, not the ring.
  // That ordering is a contract for whoever writes the next non-null `focusedAreaId` — #211 item 3's
  // turn-boundary reset is first in line. Write null at such a moment, or accept the trade: the
  // player has to hear whose turn it is, and the ring is one keypress away from being re-read.
  //
  // Only `focusedAreaId` is a dep, because this speaks when the ring MOVES. Everything else it
  // needs — `screen`, `gameState`, the human seat, the lineup — is read from the closure of the
  // render that saw the id change, which carries all of them. Depending on those instead would
  // re-speak a standing ring on writes that are not focus moves at all: GameController.startNewGame
  // writes a fresh `playerNames: []` while the finished game's ring is still set (BATTLE re-spoke
  // its territory as "owned by Player 2"), and startSpectate writes `humanPlayerIndex: null` and
  // leaves the ring where it was (SPECTATE spoke "owned by You").
  //
  // The only writer of a NON-NULL id is KeyboardController.setFocus, which writes nothing else in
  // the same commit; every other write of this field is null.
  //
  // All of this exists because the ring is virtual — no DOM element holds it. When the board grows
  // a real focus target (#211 item 2) the browser will announce that element itself and this effect
  // becomes a second voice over the same move: delete it then.
  const prevFocusRef = useRef(null);
  useEffect(() => {
    // The announcer remounts per screen (App.jsx renders it inside the `playing` and `gameOver`
    // branches, under `<ErrorBoundary key={screen}>`), so at game over this runs afresh over a ring
    // that nothing cleared — `triggerGameOver` leaves `focusedAreaId` set. The closing line belongs
    // to the game-over branch of the effect below: say nothing here, and clear nothing either.
    if (screen !== 'playing') return;

    const entering = prevFocusRef.current == null;
    prevFocusRef.current = focusedAreaId;

    // A spectator has no board focus — KeyboardController bails on this same condition before it can
    // move the ring. But it can INHERIT one: startSpectate hands the seat to a bot without clearing
    // the id, and keeps `playerNames`, so the seat the branches below would call "yours" is no
    // longer the viewer's.
    if (humanPlayerIndex == null) return;

    // Clearing the region is silent — the default `aria-relevant` is "additions text", so removals
    // are not announced — and it is what makes the way back onto the board speak at all: without
    // it, re-entering on the territory you tabbed off (which is exactly where both seams re-enter)
    // hands Preact the identical string, no DOM changes, and nothing is uttered. It also keeps a
    // browse-mode reader from finding a stale territory in the region while focus sits elsewhere.
    // Every path that nulls the id lands DOM focus on a real control the screen reader names
    // itself: the seam to END TURN or to its predecessor (including the broken-seam case, where the
    // ring comes down and the uncancelled Tab hands the move to the browser), and `focusin` from a
    // mouse click on QUIT / RULES / the settings die or from a dialog restoring focus.
    // `== null` matches KeyboardController's own test on this field; 0 has to pass it, being a real
    // (if sentinel) index — the area guard below is what rejects that one.
    if (focusedAreaId == null) {
      setAnnouncement('');
      return;
    }

    // A focused id with no live area behind it means the ring outlived the board it was set on.
    // Both halves are load-bearing: the engine's `areas` is a dense `Area[]` whose unused slots are
    // truthy sentinels with `size: 0`. Silence rather than a guess — the renderer's own paint of
    // that id is where such a mismatch is visible (#211 item 4 makes `setFocusHighlight` warn
    // there), and a live region is the wrong channel for a wiring bug.
    const area = gameState?.areas?.[focusedAreaId];
    if (!area || area.size === 0) return;

    // Arriving from a null ring means focus is entering the board: the game's first Tab, a Tab
    // after a clicked control, or the way back from END TURN or RULES — which blurs to `<body>`,
    // and VoiceOver and JAWS narrate that as leaving for the document or web area. The prefix says
    // where focus landed before the territory arrives as a bare noun phrase. A step from one
    // territory to the next is already in context and takes no preamble.
    const prefix = entering ? 'Board. ' : '';
    const dice = area.dice === 1 ? '1 die' : `${area.dice} dice`;

    // Defensive: MapGenerator gives every live area an owner, so this is a torn-state guard rather
    // than a state the player can reach — it honours the `Area` typedef's "-1 = unowned" contract.
    if (typeof area.owner !== 'number' || area.owner < 0) {
      setAnnouncement(`${prefix}Territory ${focusedAreaId}, unowned, ${dice}.`);
      return;
    }

    if (area.owner === humanPlayerIndex) {
      setAnnouncement(`${prefix}Territory ${focusedAreaId}, yours, ${dice}.`);
      return;
    }

    // The owner is spoken before the dice because spokenName brings its own trailing comma on a
    // repeated name ("Balanced AI, player 3,"), which flows straight into the dice clause where a
    // possessive could not.
    const spoken = spokenName(playerNames, area.owner);
    const ownerClause = spoken.endsWith(',') ? spoken : `${spoken},`;
    setAnnouncement(`${prefix}Territory ${focusedAreaId}, owned by ${ownerClause} ${dice}.`);
  }, [focusedAreaId]);

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
