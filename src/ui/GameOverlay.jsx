/**
 * Game Overlay
 *
 * In-game UI: END TURN button, instruction text, current player indicator.
 *
 * The instruction text has two forms. With coaching on (the default), the
 * CoachHint strip stands in for it: same job, but it explains *why* — which
 * territories can attack, what the roll will be, what just happened, what END
 * TURN pays out. With coaching off it falls back to the bare one-line prompts,
 * so a player who dismissed the coaching still gets told what to click.
 *
 * @module ui/GameOverlay
 */

import { useGameStore } from './hooks/useGameStore.js';
import { CoachHint } from './CoachHint.jsx';
import { playerName } from '../store/GameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

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
    color: 'var(--ui-text)',
    textShadow: '1px 1px 4px rgba(0,0,0,0.8)',
    marginBottom: '0.5rem',
    textAlign: 'center',
  },
  endTurnBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.5rem 2rem',
    background: 'var(--ui-accent)',
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
    color: 'var(--ui-text-muted)',
    marginBottom: '0.5rem',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} props.onEndTurn
 * @param {() => void} [props.onHideHints] - Turn the coaching off (the strip's × control)
 */
export function GameOverlay({ store, onEndTurn, onHideHints }) {
  const gameState = useGameStore(store, s => s.gameState);
  const awaitingInput = useGameStore(store, s => s.awaitingInput);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const playerNames = useGameStore(store, s => s.playerNames);
  const prefs = useGameStore(store, s => s.preferences);

  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const currentPlayerId = gameState.turnOrder[gameState.currentPlayerIndex];
  const isHumanTurn = currentPlayerId === humanPlayerIndex;

  const coachOn = (prefs?.coachHints ?? 'on') !== 'off';

  return (
    <div style={STYLE.overlay}>
      {coachOn && <CoachHint store={store} onHide={onHideHints} />}
      {!coachOn && isHumanTurn && awaitingInput === 'selectFrom' && (
        <p style={STYLE.message}>Click your territory to attack from</p>
      )}
      {!coachOn && isHumanTurn && awaitingInput === 'selectTo' && (
        <p style={STYLE.message}>Click a neighbor to attack</p>
      )}
      {/* The opponent by name ("Conqueror is thinking..."), in its seat
          color: the name gives each rival an identity, and the color already
          tells two seats running the same bot apart. */}
      {!isHumanTurn && humanPlayerIndex !== null && (
        <p style={STYLE.thinking}>
          <span style={{ color: colorPalette[currentPlayerId % colorPalette.length] }}>
            {playerName(playerNames, currentPlayerId)}
          </span>{' '}
          is thinking...
        </p>
      )}
      {isHumanTurn && (
        <button style={STYLE.endTurnBtn} onClick={onEndTurn}>
          END TURN
        </button>
      )}
    </div>
  );
}
