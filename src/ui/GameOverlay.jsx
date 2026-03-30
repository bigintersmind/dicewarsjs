/**
 * Game Overlay
 *
 * In-game UI: END TURN button, instruction text, current player indicator.
 *
 * @module ui/GameOverlay
 */

import { useGameStore } from './hooks/useGameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';
import { getTheme } from '../renderer/themes.js';

const STYLE = {
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: '50px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    alignItems: 'center',
    padding: '1rem',
    pointerEvents: 'none',
  },
  message: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '1rem',
    color: '#fff',
    textShadow: '1px 1px 4px rgba(0,0,0,0.8)',
    marginBottom: '0.5rem',
    textAlign: 'center',
  },
  endTurnBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.5rem 2rem',
    background: '#e94560',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    borderRadius: '6px',
    letterSpacing: '0.05em',
    pointerEvents: 'auto',
  },
  thinking: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.2rem',
    color: '#aaa',
    marginBottom: '0.5rem',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} props.onEndTurn
 */
export function GameOverlay({ store, onEndTurn }) {
  const gameState = useGameStore(store, s => s.gameState);
  const awaitingInput = useGameStore(store, s => s.awaitingInput);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const prefs = useGameStore(store, s => s.preferences);

  if (!gameState) return null;

  const theme = getTheme(prefs?.theme);
  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const currentPlayerId = gameState.turnOrder[gameState.currentPlayerIndex];
  const isHumanTurn = currentPlayerId === humanPlayerIndex;

  return (
    <div style={STYLE.overlay}>
      {isHumanTurn && awaitingInput === 'selectFrom' && (
        <p style={{ ...STYLE.message, color: theme.uiText }}>Click your territory to attack from</p>
      )}
      {isHumanTurn && awaitingInput === 'selectTo' && (
        <p style={{ ...STYLE.message, color: theme.uiText }}>Click a neighbor to attack</p>
      )}
      {!isHumanTurn && humanPlayerIndex !== null && (
        <p style={{ ...STYLE.thinking, color: theme.uiTextMuted }}>
          <span style={{ color: colorPalette[currentPlayerId % colorPalette.length] }}>
            Player {currentPlayerId + 1}
          </span>{' '}
          is thinking...
        </p>
      )}
      {isHumanTurn && (
        <button style={{ ...STYLE.endTurnBtn, background: theme.uiAccent }} onClick={onEndTurn}>
          END TURN
        </button>
      )}
    </div>
  );
}
