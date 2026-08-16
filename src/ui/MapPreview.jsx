/**
 * Map Preview
 *
 * The board is generated and shown; this is the action dock underneath it.
 * Three verbs, three weights — PLAY (the title's START button, continued),
 * NEW MAP (its smaller sibling: reroll the board at the same setup) and a
 * muted ← BACK to the title/setup screen (#180 — the preview is otherwise a
 * dead end: the mode rail is deliberately not mounted here, see App's
 * `isHub`). A small eyebrow names the setup you'd be going back to change.
 *
 * Playtest feedback drove the shape: the earlier "Play this board? YES / NO"
 * gate didn't tell you NO meant "another board", and the way back was tacked
 * on the end of the row as an afterthought.
 *
 * @module ui/MapPreview
 */

import { useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS, MENU_STYLE } from './menuChrome.jsx';
import { DIFFICULTY_MODES } from '../ai/difficultyModes.js';

const STYLE = {
  /*
   * One anchored column at the foot of the board: warnings (if any), the setup
   * eyebrow, the button row. Clicks pass through everywhere except the row.
   *
   * 40px up, not the old 80px: the board is fit to (viewport − HUD bar) and
   * its lowest hexes come within ~150px of the bottom edge on a 720px-tall
   * window, so the taller dock (eyebrow + buttons, ~90px) has to sit lower to
   * clear them. Nothing is drawn in the bottom HUD band during the preview.
   */
  dock: {
    position: 'absolute',
    bottom: '40px',
    left: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.5rem',
    pointerEvents: 'none',
  },
  warnings: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.25rem',
    marginBottom: '0.5rem',
  },
  warning: {
    fontFamily: 'sans-serif',
    fontSize: '0.95rem',
    color: 'var(--ui-text)',
    background: 'rgba(0,0,0,0.6)',
    padding: '0.35rem 0.75rem',
    borderRadius: '6px',
    borderLeft: '3px solid var(--ui-accent)',
    maxWidth: '90%',
  },
  eyebrow: {
    ...MENU_STYLE.eyebrow,
    marginBottom: 0,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
    pointerEvents: 'auto',
  },
  /*
   * Tertiary by design: bare muted text (the .dw-opt idiom), sized under NEW
   * MAP and set off from the pair, so PLAY / NEW MAP stay the decision and
   * this reads as the way out.
   */
  back: {
    fontSize: '1rem',
    marginRight: '0.75rem',
  },
};

/** "Medium" → "medium map"; unknown/missing sizes are simply left out. */
const mapSizeLabel = mapSize => (typeof mapSize === 'string' ? `${mapSize} map` : null);

/** Preset name, or "custom" for a hand-picked lineup; anything else is left out. */
const difficultyLabel = difficulty =>
  DIFFICULTY_MODES[difficulty]?.name.toLowerCase() ?? (difficulty === 'custom' ? 'custom' : null);

/**
 * "7 players · medium map · hard" — what ← BACK takes you to change. Rendered
 * uppercase by the eyebrow style, so it's authored in plain case for screen
 * readers.
 */
export function describeSetup(config = {}) {
  const parts = [
    Number.isInteger(config.playerCount) ? `${config.playerCount} players` : null,
    mapSizeLabel(config.mapSize),
    difficultyLabel(config.difficulty),
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore: the setup summary and bot-load notices
 * @param {() => void} props.onAccept - PLAY: start the game on this board
 * @param {() => void} props.onReject - NEW MAP: regenerate at the same setup
 * @param {() => void} [props.onBack] - ← BACK: return to the title/setup screen.
 *   Omitted only in isolated renders; App always supplies it.
 */
export function MapPreview({ store, onAccept, onReject, onBack }) {
  const warnings = useGameStore(store, s => s.aiLoadWarnings);
  const config = useGameStore(store, s => s.config);
  const playRef = useRef(null);

  /*
   * Move focus to PLAY on arrival: the title's START was the last thing the
   * player activated, so Enter/Space carries straight through to the game.
   * Mouse users see no ring — :focus-visible only lights up after keyboard
   * input — and there is nothing to scroll here.
   */
  useEffect(() => {
    playRef.current?.focus({ preventScroll: true });
  }, []);

  /*
   * Escape is the keyboard twin of the BACK button. KeyboardController stays
   * out of it — that one only acts while `screen === 'playing'`.
   *
   * Listening on `window` rather than `document` is deliberate: the settings
   * dropdown's Escape handler sits on `document`, i.e. strictly earlier in the
   * bubble path, and stops the event there while the dropdown is open — so
   * Escape closes the dropdown without also throwing the player back to the
   * title. `defaultPrevented` is honored too, for any consumer that only
   * cancels the event.
   */
  useEffect(() => {
    if (!onBack) return undefined;
    const handleKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onBack();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onBack]);

  const setup = describeSetup(config);

  return (
    <div style={STYLE.dock}>
      {/* .dw-btn / .dw-opt live in the shared chrome stylesheet; no menu screen
          is mounted here, so the preview carries its own copy (duplicate mounts
          are harmless — identical rules). */}
      <style>{CHROME_CSS}</style>
      {warnings && warnings.length > 0 && (
        <div style={STYLE.warnings} role="alert">
          {warnings.map(message => (
            <div key={message} style={STYLE.warning}>
              ⚠ {message}
            </div>
          ))}
        </div>
      )}
      {setup && <div style={STYLE.eyebrow}>{setup}</div>}
      <div style={STYLE.row}>
        {onBack && (
          <button
            type="button"
            className="dw-opt"
            style={STYLE.back}
            onClick={onBack}
            aria-label="Back to setup"
            title="Back to setup (Esc)"
          >
            ← BACK
          </button>
        )}
        <button
          type="button"
          className="dw-btn"
          style={MENU_STYLE.heroBtn}
          onClick={onAccept}
          ref={playRef}
        >
          PLAY
        </button>
        <button
          type="button"
          className="dw-btn"
          style={MENU_STYLE.heroSecondaryBtn}
          onClick={onReject}
          title="Generate another board with the same setup"
        >
          NEW MAP
        </button>
      </div>
    </div>
  );
}
