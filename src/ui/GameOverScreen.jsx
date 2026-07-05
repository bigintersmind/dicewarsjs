/**
 * Game Over Screen
 *
 * Overlay showing the winner with TITLE, HISTORY, and SPECTATE buttons.
 *
 * @module ui/GameOverScreen
 */

import { useGameStore } from './hooks/useGameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

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
  btn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.6rem 2rem',
    background: 'transparent',
    border: '2px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    cursor: 'pointer',
    borderRadius: '6px',
    letterSpacing: '0.05em',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} props.onTitle
 * @param {() => void} [props.onHistory]
 * @param {() => void} [props.onSpectate]
 */
export function GameOverScreen({ store, onTitle, onHistory, onSpectate }) {
  const gameState = useGameStore(store, s => s.gameState);
  const prefs = useGameStore(store, s => s.preferences);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const humanEliminated = useGameStore(store, s => s.humanEliminated);
  const gameOverReason = useGameStore(store, s => s.gameOverReason);
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
    subtitle = `Player ${winner + 1} wins!`;
  } else if (gameOverReason === 'turnLimit') {
    // No conquest before the turn cap — an AI-vs-AI stalemate ended as a draw.
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
        <button style={STYLE.btn} onClick={onTitle}>
          TITLE
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
      </div>
    </div>
  );
}
