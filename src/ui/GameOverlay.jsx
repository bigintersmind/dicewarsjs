/**
 * Game Overlay
 *
 * In-game UI: END TURN button, instruction text, current player indicator.
 *
 * @module ui/GameOverlay
 */

import { useGameStore } from './hooks/useGameStore.js';
import { playerName } from '../store/GameStore.js';
import { END_TURN_BUTTON_ID } from '../controller/KeyboardController.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

/*
 * END TURN cannot borrow `.dw-btn`'s focus ring: that ring is `--ui-accent`,
 * which is exactly this button's background, so it would be invisible on the
 * one control the keyboard tab-order seam aims at (#201). Its own ring is drawn
 * in the text color instead. :focus-visible, like the rest of the chrome, so a
 * mouse click leaves no ring behind.
 */
const OVERLAY_CSS = `
.dw-end-turn:focus-visible {
  outline: 3px solid var(--ui-text);
  outline-offset: 3px;
}
`;

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
 */
export function GameOverlay({ store, onEndTurn }) {
  const gameState = useGameStore(store, s => s.gameState);
  const awaitingInput = useGameStore(store, s => s.awaitingInput);
  const humanPlayerIndex = useGameStore(store, s => s.humanPlayerIndex);
  const playerNames = useGameStore(store, s => s.playerNames);
  const prefs = useGameStore(store, s => s.preferences);

  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const currentPlayerId = gameState.turnOrder[gameState.currentPlayerIndex];
  const isHumanTurn = currentPlayerId === humanPlayerIndex;

  return (
    <div style={STYLE.overlay}>
      <style>{OVERLAY_CSS}</style>
      {isHumanTurn && awaitingInput === 'selectFrom' && (
        <p style={STYLE.message}>Click your territory to attack from</p>
      )}
      {isHumanTurn && awaitingInput === 'selectTo' && (
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
      {/* The id is KeyboardController's handle on this button: the board is one
          virtual tab stop sitting immediately before it, so Tab past the last
          own territory lands here and Shift+Tab goes back (#201). E gets here
          in one press; the title advertises it the way QUIT advertises Esc. */}
      {isHumanTurn && (
        <button
          id={END_TURN_BUTTON_ID}
          className="dw-end-turn"
          style={STYLE.endTurnBtn}
          onClick={onEndTurn}
          title="End turn (E)"
          aria-keyshortcuts="E"
        >
          END TURN
        </button>
      )}
    </div>
  );
}
