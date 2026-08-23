/**
 * Coach Hint Strip
 *
 * Contextual rules coaching for the human player (the "Coach" prototype).
 * Early playtesters reported that DiceWars' rules are not self-apparent, and
 * this teaches them *in the moment* rather than in a page nobody reads: what to
 * click and why, what the dice actually decide, what just happened in a battle,
 * and what END TURN is going to pay out. Every number in it is read from the
 * live engine state — the dice you are about to roll, the totals you just
 * rolled, the size of your largest connected group — so the strip is never
 * telling you a rule the engine isn't playing.
 *
 * Its board-side half is the affordance highlighting owned by GameController /
 * HexGridRenderer (`candidateAreas` → `setCandidateHighlights`); both halves are
 * gated on the same `coachHints` preference, which the strip's own dismiss
 * control turns off.
 *
 * Accessibility: only the prompt lines are a live region. The battle recap is
 * marked `aria-hidden` while it shows, because ScreenReaderAnnouncer already
 * speaks the result ("Attack: rolled 18 vs 11. Success.") and a second
 * announcement of the same event is noise. The reinforcement line sits outside
 * the live region — it is a standing rule reminder, not an event, and it
 * changes on every capture.
 *
 * @module ui/CoachHint
 */

import { useState, useEffect } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { getValidMoves, calculateReinforcements, MAX_DICE } from '../engine/index.js';

const COACH_CSS = `
.dw-coach {
  position: relative;
  max-width: min(34rem, 90vw);
  margin: 0 0 0.6rem 0;
  padding: 0.55rem 2.1rem 0.6rem 1.1rem;
  background: var(--ui-overlay-bg);
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  text-align: center;
  pointer-events: none;
}
.dw-coach p {
  margin: 0;
  font-family: Roboto, sans-serif;
}
.dw-coach-line {
  font-size: 0.95rem;
  font-weight: 500;
  line-height: 1.3;
  color: var(--ui-text);
}
.dw-coach-detail {
  margin-top: 0.15rem !important;
  font-size: 0.78rem;
  line-height: 1.35;
  color: var(--ui-text-muted);
}
/* The payout line is the standing rule, set off from the moment-to-moment
   prompt by a hairline rather than by another block of the same weight. */
.dw-coach-foot {
  margin-top: 0.45rem !important;
  padding-top: 0.4rem;
  border-top: 1px solid var(--ui-border);
  font-size: 0.72rem;
  line-height: 1.35;
  color: var(--ui-text-muted);
}
.dw-coach-hide {
  position: absolute;
  top: 0.15rem;
  right: 0.2rem;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  background: none;
  border: none;
  border-radius: 6px;
  font-family: Roboto, sans-serif;
  font-size: 1.05rem;
  line-height: 1;
  color: var(--ui-text-muted);
  cursor: pointer;
  pointer-events: auto;
}
.dw-coach-hide:hover { color: var(--ui-text); background: var(--ui-accent-soft); }
.dw-coach-hide:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
`;

/**
 * Attack moves available to whoever is to move, or null when the state at hand
 * can't be asked (a fixture without a real `areas` array, a board mid-teardown).
 * Null means "unknown", which the copy treats differently from "none".
 *
 * @param {Object | null} gameState
 * @returns {import('../engine/types.js').Move[] | null}
 */
function attackMoves(gameState) {
  if (!gameState || !Array.isArray(gameState.areas) || !Array.isArray(gameState.turnOrder)) {
    return null;
  }
  return getValidMoves(gameState);
}

/**
 * The prompt for the current input phase: what to click, and what clicking it
 * will actually roll.
 *
 * @param {Object} args
 * @returns {{ headline: string, detail: string | null }}
 */
function promptCopy({ gameState, awaitingInput, selectedFrom, moves }) {
  if (awaitingInput === 'selectTo' && selectedFrom != null) {
    const targets = moves ? moves.filter(m => m.from === selectedFrom) : null;
    if (targets && targets.length === 0) {
      return {
        headline: 'That territory has no enemy neighbor to attack.',
        detail: 'Pick another one of yours — it has to touch an enemy.',
      };
    }
    const dice = gameState?.areas?.[selectedFrom]?.dice ?? 0;
    return {
      headline: 'Now pick an adjacent enemy.',
      detail: `You'll roll ${dice} dice vs theirs — higher total wins, ties go to the defender.`,
    };
  }

  if (moves && moves.length === 0) {
    return {
      headline: 'No attacks available — end your turn to collect reinforcements.',
      detail: null,
    };
  }

  return {
    headline: 'Pick one of your territories with 2 or more dice.',
    detail: "Territories with a single die can't attack.",
  };
}

/**
 * The recap of the attack that just resolved, in the numbers that were actually
 * rolled.
 *
 * @param {{ attacker: number, defender: number, success: boolean }} battle
 * @returns {{ headline: string, detail: string }}
 */
function battleCopy(battle) {
  if (battle.success) {
    return {
      headline: `Won ${battle.attacker} vs ${battle.defender} — territory captured.`,
      detail: 'All but one die moved in.',
    };
  }
  return {
    headline: `Lost ${battle.attacker} vs ${battle.defender} — your attacker is down to 1 die.`,
    detail: 'The defender keeps everything.',
  };
}

/**
 * The END TURN payout, straight from the engine's reinforcement rule (largest
 * connected group). Null when the state can't answer it or the player is owed
 * nothing.
 *
 * @param {Object | null} gameState
 * @param {number | null} playerId
 * @returns {string | null}
 */
function reinforcementCopy(gameState, playerId) {
  if (!gameState || playerId == null) return null;
  if (!Array.isArray(gameState.areas) || !gameState.players?.[playerId]) return null;

  const dice = calculateReinforcements(gameState, playerId);
  if (!dice) return null;

  return (
    `END TURN gives you ${dice} new ${dice === 1 ? 'die' : 'dice'} — the size of your largest ` +
    `connected group. Max ${MAX_DICE} per territory; extras go to your stockpile.`
  );
}

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} [props.onHide] - Turn the coaching off (the × control)
 */
export function CoachHint({ store, onHide }) {
  const gameState = useGameStore(store, s => s.gameState);
  const awaitingInput = useGameStore(store, s => s.awaitingInput);
  const selectedFrom = useGameStore(store, s => s.selectedFrom);
  const battleResult = useGameStore(store, s => s.battleResult);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const prefs = useGameStore(store, s => s.preferences);

  const currentPlayerId = gameState?.turnOrder?.[gameState.currentPlayerIndex] ?? null;
  const isHumanTurn = humanPlayerIndex !== null && currentPlayerId === humanPlayerIndex;

  /*
   * `battleResult` lives only for the length of the dice animation — far too
   * short to read a sentence — so the recap is latched here and held until the
   * player's next move. Only the human's own attacks are latched: an AI attack
   * resolves on a turn where this strip isn't rendered at all.
   */
  const [lastBattle, setLastBattle] = useState(null);

  useEffect(() => {
    if (!battleResult || !isHumanTurn) return;
    setLastBattle({
      attacker: battleResult.attackerRoll?.total ?? 0,
      defender: battleResult.defenderRoll?.total ?? 0,
      success: !!battleResult.success,
    });
  }, [battleResult]);

  useEffect(() => {
    // Cleared by the player moving on (a new target picked) or the turn ending.
    if (awaitingInput === 'selectTo' || !isHumanTurn) setLastBattle(null);
  }, [awaitingInput, isHumanTurn]);

  if (!gameState || !isHumanTurn) return null;
  if ((prefs?.coachHints ?? 'on') === 'off') return null;

  const moves = attackMoves(gameState);
  const showingBattle = lastBattle !== null;
  const { headline, detail } = showingBattle
    ? battleCopy(lastBattle)
    : promptCopy({ gameState, awaitingInput, selectedFrom, moves });
  const payout = reinforcementCopy(gameState, humanPlayerIndex);

  return (
    <div className="dw-coach">
      <style>{COACH_CSS}</style>
      {/* Stays mounted so a text swap is announced; muted while it carries the
          battle recap, which ScreenReaderAnnouncer already speaks. */}
      <div aria-live="polite" aria-hidden={showingBattle ? 'true' : undefined}>
        <p className="dw-coach-line">{headline}</p>
        {detail && <p className="dw-coach-detail">{detail}</p>}
      </div>
      {payout && <p className="dw-coach-foot">{payout}</p>}
      {onHide && (
        <button
          type="button"
          className="dw-coach-hide"
          onClick={onHide}
          aria-label="Hide hints"
          title="Hide hints"
        >
          ×
        </button>
      )}
    </div>
  );
}
