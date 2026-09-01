/**
 * Game Overlay
 *
 * In-game UI: END TURN button, instruction text, current player indicator.
 *
 * @module ui/GameOverlay
 */

import { useGameStore } from './hooks/useGameStore.js';
import { SeatSwatch } from './SeatSwatch.jsx';
import { playerName } from '../store/GameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

/*
 * END TURN cannot borrow `.dw-btn`'s focus ring: that ring is `--ui-accent`,
 * which is exactly this button's background, so it would be invisible on the
 * control a keyboard player tabs onto off the end of the board (#201). Its own
 * ring is drawn in the text color instead. :focus-visible, like the rest of the
 * chrome, so a mouse click leaves no ring behind.
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
  /*
   * The instruction line sits directly on the live board, so it carries the
   * ink-rim halo as its own backing rather than a fixed dark smudge: the rim
   * flips with the theme (a pale rim behind dark text on the light board),
   * where `1px 1px 4px rgba(0,0,0,0.8)` only ever worked under white (#220).
   */
  message: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '1rem',
    color: 'var(--ui-text)',
    textShadow: 'var(--ui-text-halo)',
    marginBottom: '0.5rem',
    textAlign: 'center',
  },
  /*
   * White on the accent fill is a deliberate literal, not a missed token. END
   * TURN is 1.3rem Anton (~21px bold), so WCAG's large-text 3:1 is the bar,
   * and white clears it on both accents (dark 3.83:1, light 5.81:1) — pinned
   * in GameOverlay.test.js. A `--ui-on-accent` token would carry the same
   * value in both themes and buy nothing (#220).
   */
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
  /* Floats straight on the live board with no panel under it — and until #220
     carried no shadow at all — so it takes the same ink rim the rest of the
     over-the-board text uses (composeTextHalo): its legibility must not depend
     on which territory drifts beneath it. */
  thinking: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.2rem',
    color: 'var(--ui-text-muted)',
    textShadow: 'var(--ui-text-halo)',
    marginBottom: '0.5rem',
  },
  /* The bot's name, a step brighter than the muted "is thinking..." around it. */
  thinkingName: { color: 'var(--ui-text)' },
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
      {/* The opponent by name ("Conqueror is thinking..."), with its seat as a
          swatch in front: the name gives each rival an identity and the seat
          color tells two seats running the same bot apart, but the color rides
          beside the words rather than in them — as text a pastel seat was
          unreadable on the light theme's board (#220). The name is set in the
          text color to keep it ahead of the muted "is thinking...". */}
      {!isHumanTurn && humanPlayerIndex !== null && (
        <p style={STYLE.thinking}>
          <SeatSwatch color={colorPalette[currentPlayerId % colorPalette.length]} />
          <span style={STYLE.thinkingName}>{playerName(playerNames, currentPlayerId)}</span> is
          thinking...
        </p>
      )}
      {/* Last in the playing screen's tab order: App renders BoardFocus — the
          human's own territories, as real buttons — immediately before this
          overlay, so Tab past the last of them lands here and Shift+Tab goes
          back onto the board (#201, #211). E is the shortcut past that walk;
          the title advertises it the way QUIT advertises Esc. */}
      {isHumanTurn && (
        <button
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
