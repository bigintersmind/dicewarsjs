/**
 * Player Status HUD
 *
 * Shows player stats at the bottom of the screen, plus the bar's two text
 * controls: QUIT, which opens the abandon-game confirm during play (#181), and
 * RULES, which opens the "How to play" reference. Both sit at the far left,
 * bare muted text at the small end of the scale: END TURN is the centered
 * button just above, and neither the way out of a game nor the rulebook must
 * compete with the way through it. Each has a hidden twin of the same width on
 * the right, so the player chips stay optically centered in the bar.
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
     centered in the bar. Deliberately does not wrap: the bar's height is a
     contract with the renderer (HUD_BAR_HEIGHT in renderer/constants.js is a
     hard-coded 50, and GameRenderer, HexGridRenderer and GameOverlay all size
     themselves against it), so a crowded row on a narrow phone overflows the
     way it always has rather than growing a second line the map has no room
     for. */
  players: {
    flex: 1,
    display: 'flex',
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
  /* The ring is drawn in the text color, not white: the light theme's bar is
     85% white, and a white ring on it measured 1.03:1 — in the DOM and not on
     screen (#220). --ui-text is the one color guaranteed to read on --ui-bg
     in both themes. */
  current: {
    outline: '2px solid var(--ui-text)',
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
 * @param {() => void} [props.onRules] - Opens the "How to play" reference.
 *   Supplied only while playing: the game-over screen's overlay covers this
 *   bar, and carries its own HOW TO PLAY button instead.
 */
export function GameHUD({ store, onQuit, onRules }) {
  const gameState = useGameStore(store, s => s.gameState);
  const prefs = useGameStore(store, s => s.preferences);
  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const { players, turnOrder, currentPlayerIndex } = gameState;
  const currentPlayerId = turnOrder[currentPlayerIndex];

  return (
    <div style={STYLE.bar}>
      {/* .dw-opt lives in the shared chrome stylesheet. SettingsPanel
          happens to mount a copy on every screen, but the HUD carries its
          own so it doesn't depend on that — it stays styled in a
          standalone render (a test, a future screen without the settings
          die). Duplicate mounts are harmless: identical rules. */}
      {(onQuit || onRules) && <style>{CHROME_CSS}</style>}
      {onQuit && (
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
      )}
      {onRules && (
        <button
          type="button"
          className="dw-opt"
          style={STYLE.quit}
          onClick={onRules}
          aria-label="Rules: how to play"
          title="How to play"
        >
          RULES
        </button>
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
      {/* Mirrored: each left-hand control has a hidden twin of the same width
          on the right, in reverse order, so both ends of the bar measure the
          same and the chips stay optically centered. */}
      {onRules && (
        <span className="dw-opt" style={{ ...STYLE.quit, visibility: 'hidden' }} aria-hidden="true">
          RULES
        </span>
      )}
      {onQuit && (
        <span className="dw-opt" style={{ ...STYLE.quit, visibility: 'hidden' }} aria-hidden="true">
          QUIT
        </span>
      )}
    </div>
  );
}
