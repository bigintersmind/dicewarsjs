/**
 * Game Over Screen
 *
 * Overlay showing the winner with a TITLE button.
 *
 * @module ui/GameOverScreen
 */

import { useGameStore } from './hooks/useGameStore.js';
import { PLAYER_COLORS_CSS } from '../renderer/constants.js';

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
    background: 'rgba(0, 0, 0, 0.75)',
    pointerEvents: 'auto',
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '3.5rem',
    color: '#fff',
    letterSpacing: '0.3em',
    marginBottom: '1rem',
    textShadow: '2px 2px 8px rgba(0,0,0,0.6)',
  },
  winner: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    marginBottom: '2rem',
  },
  btn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.6rem 2rem',
    background: 'transparent',
    border: '2px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '6px',
    letterSpacing: '0.05em',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} props.onTitle
 */
export function GameOverScreen({ store, onTitle }) {
  const gameState = useGameStore(store, s => s.gameState);
  if (!gameState) return null;

  const winner = gameState.winner;
  const color = winner !== null ? PLAYER_COLORS_CSS[winner % PLAYER_COLORS_CSS.length] : '#fff';

  return (
    <div style={STYLE.overlay}>
      <h1 style={STYLE.title}>G A M E&nbsp;&nbsp;O V E R</h1>
      {winner !== null && <p style={{ ...STYLE.winner, color }}>Player {winner + 1} wins!</p>}
      <button style={STYLE.btn} onClick={onTitle}>
        TITLE
      </button>
    </div>
  );
}
