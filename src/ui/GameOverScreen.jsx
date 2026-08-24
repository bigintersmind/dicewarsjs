/**
 * Game Over Screen
 *
 * Overlay showing the winner with a BATTLE button (back to the landing
 * screen) plus, when available, HISTORY, SPECTATE and HOW TO PLAY.
 *
 * @module ui/GameOverScreen
 */

import { useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { playerName } from '../store/GameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

/** The screen's one button shape; `mutedBtn` is the same outline, quieter ink. */
const BTN = {
  fontFamily: 'Anton, sans-serif',
  fontSize: '1.3rem',
  padding: '0.6rem 2rem',
  background: 'transparent',
  border: '2px solid var(--ui-accent)',
  color: 'var(--ui-accent)',
  cursor: 'pointer',
  borderRadius: '6px',
  letterSpacing: '0.05em',
};

const STYLE = {
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    background: 'var(--ui-overlay-bg)',
    pointerEvents: 'auto',
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '3.5rem',
    color: 'var(--ui-text)',
    letterSpacing: '0.3em',
    marginBottom: '1rem',
    textShadow: '2px 2px 8px rgba(0,0,0,0.6)',
  },
  winner: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    marginBottom: '2rem',
  },
  buttonRow: {
    display: 'flex',
    gap: '1rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  btn: BTN,
  /** A reference sitting beside the real actions, so: smaller and greyed. */
  mutedBtn: {
    ...BTN,
    fontSize: '1.05rem',
    padding: '0.55rem 1.4rem',
    border: '2px solid var(--ui-border)',
    color: 'var(--ui-text-muted)',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} props.onTitle
 * @param {() => void} [props.onHistory]
 * @param {() => void} [props.onSpectate]
 * @param {() => void} [props.onRules] - Opens the "How to play" reference: the
 *   end of a game you lost is when a rule you missed is worth looking up.
 */
export function GameOverScreen({ store, onTitle, onHistory, onSpectate, onRules }) {
  const gameState = useGameStore(store, s => s.gameState);
  const prefs = useGameStore(store, s => s.preferences);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const humanEliminated = useGameStore(store, s => s.humanEliminated);
  const gameOverReason = useGameStore(store, s => s.gameOverReason);
  const playerNames = useGameStore(store, s => s.playerNames);

  const battleRef = useRef(null);

  /*
   * Move focus to BATTLE when this screen mounts: the game ends on its own, so
   * focus is sitting on the canvas or nowhere at all, and BATTLE is the primary
   * action here — the way on to the next game. It fires again on the way back
   * from the HISTORY replay viewer (goBackFromReplay remounts this screen),
   * which is what you want: the viewer's ← BACK just unmounted underneath the
   * player. Mouse users see no ring — :focus-visible only lights up after
   * keyboard input.
   *
   * Stands down while the "How to play" card is up: the card outlives the game
   * ending behind it (triggerGameOver deliberately leaves `rulesOpen` alone),
   * it layers above this screen and traps Tab inside itself, so pulling focus
   * to BATTLE under the scrim would strand the keyboard outside the trap. The
   * card hands focus to a live control — this BATTLE — when it closes.
   *
   * Above the `!gameState` early return, so the hook order stays fixed whether
   * or not there is a terminal state to show.
   */
  useEffect(() => {
    if (store.getState().rulesOpen) return;
    battleRef.current?.focus({ preventScroll: true });
  }, []);

  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const winner = gameState.winner;
  const winnerColor =
    winner !== null ? colorPalette[winner % colorPalette.length] : 'var(--ui-text)';

  // Determine heading and subtitle
  const isHumanWinner = winner !== null && winner === humanPlayerIndex;
  const heading = isHumanWinner ? 'Y O U\u00A0\u00A0W I N !' : 'G A M E\u00A0\u00A0O V E R';

  let subtitle = null;
  if (isHumanWinner) {
    subtitle = null; // heading says it all
  } else if (humanEliminated) {
    subtitle = 'You were eliminated!';
  } else if (winner !== null) {
    subtitle = `${playerName(playerNames, winner)} wins!`;
  } else if (gameOverReason === 'turnLimit') {
    // No conquest before the turn cap — a stalemate (typically AI-vs-AI) ended as a draw.
    // Fires for any winnerless game that hits the cap, including a human still alive at 300.
    subtitle = 'Draw — turn limit reached';
  }

  return (
    <div style={STYLE.overlay}>
      <h1 style={{ ...STYLE.title, color: isHumanWinner ? winnerColor : 'var(--ui-text)' }}>
        {heading}
      </h1>
      {subtitle && (
        <p style={{ ...STYLE.winner, color: humanEliminated ? 'var(--ui-text)' : winnerColor }}>
          {subtitle}
        </p>
      )}
      <div style={STYLE.buttonRow}>
        <button style={STYLE.btn} onClick={onTitle} ref={battleRef}>
          BATTLE
        </button>
        {onHistory && (
          <button style={STYLE.btn} onClick={onHistory}>
            HISTORY
          </button>
        )}
        {onSpectate && humanEliminated && (
          <button style={STYLE.btn} onClick={onSpectate}>
            SPECTATE
          </button>
        )}
        {/* Muted, unlike its neighbours: BATTLE is what you came here to press,
            and this is a reference rather than a way on. */}
        {onRules && (
          <button
            type="button"
            style={STYLE.mutedBtn}
            onClick={onRules}
            aria-label="How to play — the rules in one card"
          >
            HOW TO PLAY
          </button>
        )}
      </div>
    </div>
  );
}
