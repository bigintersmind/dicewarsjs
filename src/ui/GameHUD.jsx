/**
 * Player Status HUD
 *
 * Shows player stats at the bottom of the screen, and — during play — the QUIT
 * control that opens the abandon-game confirm (#181). QUIT sits at the far left
 * of the bar, bare muted text at the small end of the scale: END TURN is the
 * centered button just above, and the way out of a game must not compete with
 * the way through it. A hidden twin on the right keeps the player chips
 * optically centered in the bar.
 *
 * @module ui/GameHUD
 */

import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS } from './menuChrome.jsx';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../renderer/constants.js';

const STYLE = {
  bar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    padding: '0.5rem',
    background: 'var(--ui-bg)',
    pointerEvents: 'auto',
  },
  /* Takes the space between QUIT and its hidden twin, so the chips stay
     centered in the bar; wraps rather than overflowing on a phone. */
  players: {
    flex: 1,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '0.5rem',
  },
  quit: {
    fontSize: '0.8rem',
    flexShrink: 0,
  },
  player: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
    padding: '0.3rem 0.6rem',
    borderRadius: '4px',
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    color: 'var(--ui-text)',
    transition: 'opacity 0.3s',
  },
  swatch: {
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: '1px solid rgba(255,255,255,0.3)',
    flexShrink: 0,
  },
  current: {
    outline: '2px solid #fff',
    outlineOffset: '2px',
  },
  stock: {
    fontSize: '0.75rem',
    color: 'var(--ui-text-muted)',
    marginLeft: '0.2rem',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {() => void} [props.onQuit] - Opens the abandon-game confirm. Supplied
 *   only while playing; on the game-over screen there is already a way out.
 */
export function GameHUD({ store, onQuit }) {
  const gameState = useGameStore(store, s => s.gameState);
  const prefs = useGameStore(store, s => s.preferences);
  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const { players, turnOrder, currentPlayerIndex } = gameState;
  const currentPlayerId = turnOrder[currentPlayerIndex];

  return (
    <div style={STYLE.bar}>
      {onQuit && (
        <>
          {/* .dw-opt lives in the shared chrome stylesheet, which no menu
              screen mounts during play (duplicate mounts are harmless). */}
          <style>{CHROME_CSS}</style>
          <button
            type="button"
            className="dw-opt"
            style={STYLE.quit}
            onClick={onQuit}
            aria-label="Quit to title"
            title="Quit to title (Esc)"
          >
            QUIT
          </button>
        </>
      )}
      <div style={STYLE.players}>
        {players.map(p => {
          if (p.eliminated) return null;
          const isCurrent = p.id === currentPlayerId;
          const color = colorPalette[p.id % colorPalette.length];
          return (
            <div
              key={p.id}
              style={{
                ...STYLE.player,
                ...(isCurrent ? STYLE.current : {}),
              }}
            >
              <span style={{ ...STYLE.swatch, background: color }} />
              <span>{p.territoryCount}</span>
              {p.stock > 0 && <span style={STYLE.stock}>+{p.stock}</span>}
            </div>
          );
        })}
      </div>
      {onQuit && (
        <span className="dw-opt" style={{ ...STYLE.quit, visibility: 'hidden' }} aria-hidden="true">
          QUIT
        </span>
      )}
    </div>
  );
}
