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
 * On a phone the single row does not fit: at 390px with eight seats the chips
 * for players 7 and 8 sat past the right edge, and `overflow: hidden` on the
 * page meant nobody could scroll them back — two opponents' territory counts
 * and stockpiles simply gone, and the bar is the only place that information
 * lives (#222). So under 560px the bar becomes two rows — QUIT and RULES on
 * the first, the chips across the whole width of the second — and the bar is
 * correspondingly taller. That height is a contract with the renderer, so the
 * HUD publishes it as `--hud-bar-height` (see HUD_CSS) rather than everyone
 * hard-coding 50.
 *
 * @module ui/GameHUD
 */

import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS } from './menuChrome.jsx';
import {
  PLAYER_COLORS_CSS,
  COLORBLIND_PLAYER_COLORS_CSS,
  HUD_BAR_HEIGHT,
} from '../renderer/constants.js';

/*
 * The bar's layout stylesheet. An inline style cannot carry a media query and
 * the phone layout is nothing but a media query, so every property the
 * breakpoint touches lives here; STYLE below keeps what is the same at every
 * width (position, color, the per-chip bits that vary with game state).
 *
 * `--hud-bar-height` is the bar's height as a contract: GameRenderer._resize
 * reserves that many real pixels under the board and GameOverlay hangs the
 * "Your turn" strip off it, so one declaration moves all three together. The
 * HUD owns the value because the HUD is what decides how tall the bar is; both
 * consumers read it with HUD_BAR_HEIGHT as the fallback, which is what applies
 * in any render with no HUD in the DOM (title screen, tests). HexGridRenderer's
 * use of the same constant is NOT one of them: it reserves 50 units inside the
 * fixed 840x840 base frame, which no viewport changes.
 *
 * The breakpoint is the chrome's one phone breakpoint — the mode rail in
 * menuChrome.jsx tightens at exactly 560px — deliberately reused rather than a
 * second number to keep in step.
 */
export const HUD_CSS = `
:root { --hud-bar-height: ${HUD_BAR_HEIGHT}px; }
.dw-hud {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  min-height: var(--hud-bar-height);
}
.dw-hud-players {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}
.dw-hud-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.6rem;
  border-radius: 4px;
  font-family: Anton, sans-serif;
  font-size: 1rem;
  color: var(--ui-text);
  transition: opacity 0.3s;
}
@media (max-width: 560px) {
  /* Two rows: the chips row takes a whole line of its own, so QUIT and RULES
     keep the first one. The twins go away with it — centering is moot once the
     chips have the full width, and left in they would claim a third row.
     Tightened, a chip runs 35px (one-digit count, no stockpile) to 56px (both),
     so a mid-game eight-seat row measures right around the 374px the bar has at
     390px and fits. "overflow-x: auto" is the valve for the boards that don't —
     eight seats *all* holding a two-digit count and a stockpile come to 462px —
     since scrolling beats clipping. Centered flex content that overflows becomes
     unreachable at its *start*, so the row left-aligns and centers itself with
     auto margins instead — the same 'safe center' the mode rail uses. The row's
     vertical padding is the current-player ring's clearance (2px outline at 2px
     offset), which the overflow box would otherwise cut off. */
  :root { --hud-bar-height: 80px; }
  .dw-hud { flex-wrap: wrap; row-gap: 0.25rem; }
  .dw-hud-players {
    flex: 1 1 100%;
    justify-content: flex-start;
    gap: 0.15rem;
    padding: 4px 0;
    overflow-x: auto;
  }
  .dw-hud-chip { gap: 0.15rem; padding: 0.15rem 0.3rem; font-size: 0.9rem; }
  .dw-hud-chip:first-child { margin-left: auto; }
  .dw-hud-chip:last-child { margin-right: auto; }
  .dw-hud-twin { display: none; }
}
/* Item 4 of #222 gives every .dw-opt a 40px-tall hit area on touch. Applied
   to these two that would grow the bar and break its height contract, so the
   pair takes the padding as *overhang* instead, cancelled by an equal negative
   margin: 11px around a 19px text box makes the hit area 41px while the flex
   line still measures the text, so the bar keeps its height. Doubled class
   (.dw-opt.dw-hud-opt) so it outranks the generic rule on specificity rather
   than source order — CHROME_CSS mounts a second copy of itself on hub
   screens, and an equal-specificity rule would lose that tie. Every property
   the generic rule sets is overridden here. */
@media (pointer: coarse) {
  .dw-opt.dw-hud-opt { padding: 11px 0.4rem; margin: -11px 0; min-height: 0; }
}
`;

const STYLE = {
  bar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '0.5rem',
    background: 'var(--ui-bg)',
    pointerEvents: 'auto',
  },
  quit: {
    fontSize: '0.8rem',
    flexShrink: 0,
  },
  /* The hairline that lifts a seat color off the bar, in --ui-border rather
     than a fixed 30% white: the light theme's 85%-white bar swallowed that
     (1.01:1). It is decoration — the fill is the information — so it isn't
     held to 3:1, only to being visible in both themes (#220). */
  swatch: {
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: '1px solid var(--ui-border)',
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
    <div className="dw-hud" style={STYLE.bar}>
      {/* HUD_CSS is unconditional: it carries the bar's own layout and the
          --hud-bar-height the renderer and the overlay size themselves
          against, which the chips need whether or not the two controls are
          there. .dw-opt lives in the shared chrome stylesheet; SettingsPanel
          happens to mount a copy on every screen, but the HUD carries its own
          so it doesn't depend on that — it stays styled in a standalone render
          (a test, a future screen without the settings die). Duplicate mounts
          are harmless: identical rules. */}
      <style>{HUD_CSS}</style>
      {(onQuit || onRules) && <style>{CHROME_CSS}</style>}
      {onQuit && (
        <button
          type="button"
          className="dw-opt dw-hud-opt"
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
          className="dw-opt dw-hud-opt"
          style={STYLE.quit}
          onClick={onRules}
          aria-label="Rules: how to play"
          title="How to play"
        >
          RULES
        </button>
      )}
      <div className="dw-hud-players">
        {players.map(p => {
          if (p.eliminated) return null;
          const isCurrent = p.id === currentPlayerId;
          const color = colorPalette[p.id % colorPalette.length];
          return (
            <div key={p.id} className="dw-hud-chip" style={isCurrent ? STYLE.current : undefined}>
              <span style={{ ...STYLE.swatch, background: color }} />
              <span>{p.territoryCount}</span>
              {p.stock > 0 && <span style={STYLE.stock}>+{p.stock}</span>}
            </div>
          );
        })}
      </div>
      {/* Mirrored: each left-hand control has a hidden twin of the same width
          on the right, in reverse order, so both ends of the bar measure the
          same and the chips stay optically centered. Kept in the DOM under the
          phone breakpoint and merely hidden by it, so the desktop layout is
          the one that decides what they are. */}
      {onRules && (
        <span
          className="dw-opt dw-hud-opt dw-hud-twin"
          style={{ ...STYLE.quit, visibility: 'hidden' }}
          aria-hidden="true"
        >
          RULES
        </span>
      )}
      {onQuit && (
        <span
          className="dw-opt dw-hud-opt dw-hud-twin"
          style={{ ...STYLE.quit, visibility: 'hidden' }}
          aria-hidden="true"
        >
          QUIT
        </span>
      )}
    </div>
  );
}
