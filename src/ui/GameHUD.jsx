/**
 * Player Status HUD
 *
 * Shows player stats at the bottom of the screen, plus the bar's two text
 * controls: QUIT, which opens the abandon-game confirm during play (#181), and
 * RULES, which opens the "How to play" reference. Both sit at the far left,
 * bare muted text at the small end of the scale: END TURN is the centered
 * button just above, and neither the way out of a game nor the rulebook must
 * compete with the way through it. Each has a hidden twin of the same width on
 * the right, so the player chips stay optically centered in the bar. App also
 * mounts the bar on the game-over screen with neither handler — no QUIT/RULES
 * row, just the chips, under an overlay that covers them.
 *
 * On a phone the single row does not fit: at 390px with eight seats the chips
 * for players 7 and 8 sat past the right edge, and `overflow: hidden` on the
 * page meant nobody could scroll them back — two opponents' territory counts
 * and stockpiles simply gone, and the bar is the only place that information
 * lives (#222). So under 560px the bar becomes two rows — QUIT and RULES on
 * the first, the chips across the whole width of the second — and the bar is
 * correspondingly taller. That height is a contract with the renderer (which
 * reserves board space under it) and the overlay (which stops its END TURN
 * strip on top of it), so the mounted HUD measures its own bar and publishes
 * the result as `--dw-hud-bar-height` (see the publish effect below) rather
 * than everyone hard-coding 50.
 *
 * @module ui/GameHUD
 */

import { useLayoutEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS } from './menuChrome.jsx';
import {
  PLAYER_COLORS_CSS,
  COLORBLIND_PLAYER_COLORS_CSS,
  HUD_BAR_HEIGHT,
} from '../renderer/constants.js';

/** The custom property the bar's measured height is published as. */
const BAR_HEIGHT_VAR = '--dw-hud-bar-height';

/*
 * The bar's layout stylesheet. An inline style cannot carry a media query and
 * the phone layout is nothing but a media query, so every property the
 * breakpoint touches lives here; STYLE below keeps what is the same at every
 * width (position, color, the per-chip bits that vary with game state).
 *
 * The height is NOT declared here. The bar's height is a contract — the
 * renderer reserves that many real pixels under the board, the overlay hangs
 * its END TURN strip off it — and under 560px it is content-driven, so the
 * mounted HUD measures itself and publishes `--dw-hud-bar-height` instead (the
 * effect in GameHUD below). What IS here is the floor: `.dw-hud` never
 * measures shorter than HUD_BAR_HEIGHT, the constant both consumers fall back
 * to with no HUD in the DOM (title screen, tests), so the desktop bar can
 * never come out shorter than the space reserved for it. That floor is a
 * literal on purpose — read from the published variable it would be a feedback
 * loop, and a bar measured at 80 in portrait could never shrink back to 50
 * after a rotation to landscape. `box-sizing: border-box` makes it a floor on
 * the whole box, since the bar's own padding is inline on STYLE.bar.
 * HexGridRenderer's use of the same constant is unrelated: it reserves 50
 * units inside the fixed 840x840 base frame, which no viewport changes.
 *
 * The breakpoint is the mode rail's 560px breakpoint (menuChrome.jsx),
 * deliberately reused rather than a second number to keep in step.
 */
export const HUD_CSS = `
.dw-hud {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  min-height: ${HUD_BAR_HEIGHT}px;
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
  /* Two rows: the chips row takes a whole line of its own, so quit and rules
     keep the first one. The twins go away with it — centering is moot once the
     chips have the full width, and left in they would claim a third row.
     Tightened, a chip runs 35px (one-digit count, no stockpile) to ~56px
     (both), so a mid-game eight-seat row measures right around the 374px the
     bar has at 390px and fits. "overflow-x: auto" is the valve for the boards
     that don't — eight seats *all* holding a two-digit count and a stockpile
     come to ~465px — since scrolling beats clipping. The scrollbar itself is
     hidden: on the engines that lay one out it would eat ~15px of the bar's
     height for a valve that only opens on a crowded board. Centered flex
     content that overflows becomes unreachable at its *start*, so the row
     left-aligns and centers itself with auto margins instead — the same 'safe
     center' the mode rail uses. The row's padding is the current-player ring's
     clearance (2px outline at 2px offset), which the overflow box would
     otherwise cut off; on all four sides rather than just top and bottom
     because once the row scrolls the auto margins resolve to 0 and the
     outermost chip's ring has nothing else between it and the edge. (Padding
     on the inline-end of a scroll container is honoured inconsistently across
     engines, so in the pathological case where all eight seats overflow the
     right-hand ring may still clip by ~2px.) */
  .dw-hud { flex-wrap: wrap; row-gap: 0.25rem; }
  .dw-hud-players {
    flex: 1 1 100%;
    justify-content: flex-start;
    gap: 0.15rem;
    padding: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dw-hud-players::-webkit-scrollbar { display: none; }
  .dw-hud-chip { gap: 0.15rem; padding: 0.15rem 0.3rem; font-size: 0.9rem; }
  .dw-hud-chip:first-child { margin-left: auto; }
  .dw-hud-chip:last-child { margin-right: auto; }
  .dw-hud-twin { display: none; }
}
/* CHROME_CSS's coarse-pointer block gives every .dw-opt a 40px hit area on
   touch (#222). Applied to these two that would grow the bar and break its
   height contract, so the pair takes the padding as *overhang* instead,
   cancelled by an equal negative margin: 11px around a 19px text box makes the
   hit area 41px while the flex line still measures the text, so the bar keeps
   its height. Doubled class (.dw-opt.dw-hud-opt) so it outranks the generic
   rule on specificity rather than source order — this component mounts
   <style>{CHROME_CSS}</style> immediately after its own <style>{HUD_CSS}</style>
   in the same subtree, so the generic .dw-opt always comes later in document
   order and an equal-specificity rule here would lose that tie every time.
   Every property the generic rule sets is overridden here. */
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
     in both themes. Outline only, and deliberately so: an inline box property
     here would out-specify the phone block's chip rule for whichever chip is
     current, and that one chip would size differently from the rest. */
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
  const barRef = useRef(null);
  const hasBar = Boolean(gameState);

  /*
   * Publish the bar's MEASURED height on the document root, the way
   * applyThemeVars.js writes the `--ui-*` palette there, so GameRenderer and
   * GameOverlay size themselves against what the bar actually is. Measured
   * rather than declared because under 560px the height is content-driven: at a
   * larger browser default font the rem-based rows come out ~89px rather than
   * 80, and a scrollbar gutter or a late web-font swap moves it again. An
   * inline property on the root outranks any :root rule in a stylesheet, so
   * consumers need no change to prefer it.
   *
   * The dispatched 'resize' is how the renderer hears about it — GameRenderer
   * re-reserves on the window's resize event and on nothing else, and nothing
   * fires one when the HUD mounts (main.jsx dispatches a synthetic resize only
   * on a non-canvas -> canvas screen change, and every screen the HUD is on is
   * already a canvas screen). Without this the phone bar would grow to two rows
   * over a board still reserving 50px, and cover its bottom edge.
   *
   * The ResizeObserver keeps that true for every later change (rotation, a font
   * swap, a scrollbar gutter appearing). jsdom has none, hence the feature
   * test. Unmount removes the property so the next render without a HUD — the
   * title screen — gets the fallback reservation back.
   */
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;

    const root = document.documentElement;
    const publish = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      // A zero height is a bar that has not been laid out (a hidden subtree, a
      // browser mid-swap): publishing it would reserve nothing at all.
      if (height <= 0) return;
      const next = `${height}px`;
      // The observer fires on every layout pass that touches the bar; only an
      // actual change is worth a rescale of the whole board.
      if (root.style.getPropertyValue(BAR_HEIGHT_VAR) === next) return;
      root.style.setProperty(BAR_HEIGHT_VAR, next);
      window.dispatchEvent(new Event('resize'));
    };

    publish();

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    if (observer) observer.observe(el);

    return () => {
      if (observer) observer.disconnect();
      root.style.removeProperty(BAR_HEIGHT_VAR);
      window.dispatchEvent(new Event('resize'));
    };
  }, [hasBar]);

  if (!gameState) return null;

  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const { players, turnOrder, currentPlayerIndex } = gameState;
  const currentPlayerId = turnOrder[currentPlayerIndex];

  return (
    <div className="dw-hud" style={STYLE.bar} ref={barRef}>
      {/* HUD_CSS is unconditional: it carries the bar's own layout, which the
          chips need whether or not the two controls are there. .dw-opt lives in
          the shared chrome stylesheet; SettingsPanel happens to mount a copy on
          every screen, but the HUD carries its own so it doesn't depend on that
          — it stays styled in a standalone render (a test, a future screen
          without the settings die). Duplicate mounts are harmless: identical
          rules. */}
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
      {/* No inline style: the phone block gives this row its own line and a
          left-aligned 'safe center', and an inline justifyContent here would
          out-specify it and put the first chips back out of reach. */}
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
          the one that decides what they are. .dw-hud-opt rides along on the
          twins too: on a coarse pointer wider than the breakpoint they are
          visible, and without it they would take the generic 40px hit area and
          stop matching the controls whose width they exist to mirror. */}
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
