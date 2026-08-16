/**
 * Map Preview
 *
 * "Play this board?" dialog with YES/NO buttons, plus a tertiary way back out
 * to the title/options screen (#180) — the preview is otherwise a dead end:
 * NO only rerolls the board at the same size/lineup, and the mode rail is
 * deliberately not mounted here (see App's `isHub`).
 *
 * @module ui/MapPreview
 */

import { useEffect } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';

const STYLE = {
  warnings: {
    position: 'absolute',
    bottom: '140px',
    left: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.25rem',
    pointerEvents: 'none',
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
  overlay: {
    position: 'absolute',
    bottom: '80px',
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'center',
    gap: '1rem',
    pointerEvents: 'auto',
  },
  label: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.4rem',
    color: 'var(--ui-text)',
    textShadow: '1px 1px 4px rgba(0,0,0,0.8)',
    alignSelf: 'center',
  },
  btn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.5rem 1.5rem',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    letterSpacing: '0.05em',
  },
  yes: {
    background: 'var(--ui-accent)',
    color: '#fff',
  },
  no: {
    background: 'transparent',
    border: '2px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
  },
  /*
   * Tertiary by design: bare text, muted, smaller than NO, so the YES/NO
   * decision stays the focus of the screen and this reads as an escape hatch.
   */
  back: {
    background: 'transparent',
    border: 'none',
    color: 'var(--ui-text-muted)',
    fontSize: '1rem',
    padding: '0.5rem 0.75rem',
    textShadow: '1px 1px 3px rgba(0,0,0,0.8)',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore, used to surface bot-load notices
 * @param {() => void} props.onAccept
 * @param {() => void} props.onReject
 * @param {() => void} [props.onBack] - Return to the title/options screen.
 *   Omitted only in isolated renders; App always supplies it.
 */
export function MapPreview({ store, onAccept, onReject, onBack }) {
  const warnings = useGameStore(store, s => s.aiLoadWarnings);

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

  return (
    <>
      {warnings && warnings.length > 0 && (
        <div style={STYLE.warnings} role="alert">
          {warnings.map(message => (
            <div key={message} style={STYLE.warning}>
              ⚠ {message}
            </div>
          ))}
        </div>
      )}
      <div style={STYLE.overlay}>
        <span style={STYLE.label}>Play this board?</span>
        <button style={{ ...STYLE.btn, ...STYLE.yes }} onClick={onAccept}>
          YES
        </button>
        <button style={{ ...STYLE.btn, ...STYLE.no }} onClick={onReject}>
          NO
        </button>
        {onBack && (
          <button
            type="button"
            style={{ ...STYLE.btn, ...STYLE.back }}
            onClick={onBack}
            aria-label="Back to options"
            title="Back to options (Esc)"
          >
            ← OPTIONS
          </button>
        )}
      </div>
    </>
  );
}
