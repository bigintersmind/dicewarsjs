/**
 * Screen Reader Announcer Hook
 *
 * Generates announcement text for ARIA live regions from game state changes:
 * whose turn it is, what the board is waiting for and which territory is armed,
 * what a battle did to the board (and to whom), and how the game ended — with a
 * winner, with the human eliminated, or in a turn-cap draw.
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
 * "4 dice" / "1 die" — the same count the territory buttons speak (BoardFocus),
 * so the source this hook names and the button the player just pressed agree
 * word for word.
 *
 * @param {number} dice
 * @returns {string}
 */
function diceCount(dice) {
  return dice === 1 ? '1 die' : `${dice} dice`;
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
  const selectedFrom = useGameStore(store, s => s.selectedFrom);
  const selectedTo = useGameStore(store, s => s.selectedTo);
  const humanEliminated = useGameStore(store, s => s.humanEliminated);
  const gameOverReason = useGameStore(store, s => s.gameOverReason);

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

    // No game to talk about: the same rule as the screens above. Unreachable
    // today — every `gameState: null` write also puts the screen on 'title' —
    // but the hook says so itself rather than leave the last line standing.
    if (!gameState) {
      setAnnouncement('');
      return;
    }

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

    /*
     * The two ends that name nobody (#211 item 13). A mid-game elimination
     * leaves `winner` null — the surviving AIs play on, so the engine's phase
     * never reaches GAME_OVER — and a turn-cap draw ends a game nobody
     * conquered. Both reach this screen, and without these the branches below
     * narrate "<bot> is thinking." over a game that is finished. The lines are
     * the game-over screen's own subtitles, spoken.
     */
    if (screen === 'gameOver' && gameState.winner === null) {
      if (humanEliminated) {
        setAnnouncement('Game over. You were eliminated.');
        return;
      }
      if (gameOverReason === 'turnLimit') {
        setAnnouncement('Game over. Draw: turn limit reached.');
        return;
      }
    }

    /*
     * No seat, nothing more to say: a spectated game is watched, not played, and
     * every branch below is about the human's turn or the wait for it. Without
     * this, the last line spoken before SPECTATE — which puts the screen back
     * on 'playing' and nulls only the seat — would sit in the region for the whole
     * spectated game. The old per-screen remount cleared it as a side effect;
     * one node for the session (#211 item 9) means the hook has to say so.
     *
     * Below the game-over branches, not above them: a spectated game still ends
     * out loud, and neither of those lines is about a seat — the winner is named
     * as a bot, and the turn-cap draw is mostly how an AI-vs-AI game ends at all.
     */
    if (humanPlayerIndex === null) {
      setAnnouncement('');
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
      /*
       * The source is named the way its own button named it — "Territory 5, 4
       * dice" — because that is what the player heard when they pressed it, and
       * the comma is what makes the dice the territory's rather than the
       * attack's. A selection this hook cannot resolve to an area leaves the
       * prompt bare rather than half-said.
       *
       * The arrows are named here because this is the moment a screen-reader
       * player is stuck: every enemy territory is `tabindex="-1"`, so Tab
       * reaches no target at all, and the live region carries to every reader.
       */
      const source = selectedFrom != null ? gameState.areas?.[selectedFrom] : null;
      const prefix = source
        ? `Territory ${selectedFrom} selected, ${diceCount(source.dice)}. `
        : '';
      setAnnouncement(
        `${prefix}Select a neighboring territory to attack. Use the arrow keys to move.`
      );
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
    /*
     * Changing your mind about the source moves nothing else: same screen, same
     * phase, same turn, same board. Without it in the deps the prompt would go
     * on naming the territory the player has just moved away from. Re-picking
     * the SAME source recomputes the same string, and setAnnouncement of the
     * string already in state is a no-op — which is the right answer for a
     * selection that did not change.
     */
    selectedFrom,
    /*
     * The two winnerless ends read above. Both are written in the same setState
     * as the `screen` that shows them, so neither is a change this effect would
     * otherwise sleep through — they are here because the effect reads them.
     */
    humanEliminated,
    gameOverReason,
  ]);

  useEffect(() => {
    if (!battleResult) return;
    /*
     * `screen` is read here but deliberately kept OUT of this effect's deps. The
     * battle line must be spoken when a battle lands and only then; with `screen`
     * in the deps, a screen change while the last result still sat in the store
     * would re-speak a stale attack — and at the playing → gameOver seam it would
     * run after the effect above and overwrite "Game over…" with it. Deps of
     * [battleResult] mean this closure is invoked only on the render where the
     * result changed, so the screen it reads is that render's screen: the guard
     * is evaluated at the moment the battle actually arrives.
     *
     * Nothing today leaves a result in the store across a screen change:
     * goToTitle nulls `battleResult` in the same setState as the screen, and
     * both attack paths null it before calling triggerGameOver. So the guard and
     * this deps list hold the region against a future path and against an
     * exhaustive-deps "fix" rather than against a reproduced bug — which is why
     * a test drives the game-over case directly.
     */
    if (!onGameScreen) return;
    const atkTotal = battleResult.attackerRoll?.total ?? 0;
    const defTotal = battleResult.defenderRoll?.total ?? 0;
    const outcome = battleResult.success ? 'Success' : 'Failed';
    const rolls = `rolled ${atkTotal} vs ${defTotal}. ${outcome}.`;
    const bare = `Attack: ${rolls}`;

    /*
     * Which of the three lines this is comes from the seats the controller
     * recorded on the result, not from the board: `gameState` here is the
     * POST-attack board — the same store write that carried the result — where
     * a won territory already belongs to whoever took it. Everything else (the
     * ids, the dice that are on those territories now) is read from that board
     * on purpose: it is what the player would find if they went and looked.
     *
     * `selectedFrom` / `selectedTo` / `gameState` are read from the closure
     * rather than the deps, which stay `[battleResult]` for the reason argued
     * above; both attack paths write all four in one setState, so this closure
     * is the render where they arrived together.
     */
    const seated = humanPlayerIndex != null;
    const from = selectedFrom != null ? gameState?.areas?.[selectedFrom] : null;
    const to = selectedTo != null ? gameState?.areas?.[selectedTo] : null;

    if (seated && battleResult.attacker === humanPlayerIndex) {
      // Where your dice went: onto the territory you took, or spent off the one
      // you attacked from.
      if (battleResult.success && to) {
        setAnnouncement(`${bare} Territory ${selectedTo} is yours, ${diceCount(to.dice)}.`);
        return;
      }
      if (!battleResult.success && from) {
        setAnnouncement(`${bare} Territory ${selectedFrom} is down to ${diceCount(from.dice)}.`);
        return;
      }
      setAnnouncement(bare);
      return;
    }

    /*
     * An AI attacking the human. The board redraws for a sighted player; without
     * this line the only way to learn which of your territories a bot has taken
     * is to arrow over it afterwards. spokenName's trailing comma on a repeated
     * bot name reads as an appositive here — "Balanced AI, player 3, attacks…".
     */
    if (seated && battleResult.defender === humanPlayerIndex && to) {
      const fate = battleResult.success
        ? `Territory ${selectedTo} lost.`
        : `Territory ${selectedTo} holds.`;
      const who = spokenName(playerNames, battleResult.attacker);
      setAnnouncement(`${who} attacks your territory ${selectedTo}: ${rolls} ${fate}`);
      return;
    }

    // Two bots trading territories, a spectated game, or a result whose seats or
    // ids this hook cannot resolve: the rolls are the part that is always true.
    setAnnouncement(bare);
  }, [battleResult]);

  return announcement;
}
