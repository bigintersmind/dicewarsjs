/**
 * Map Preview
 *
 * "Play this board?" dialog with YES/NO buttons.
 *
 * @module ui/MapPreview
 */

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
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore, used to surface bot-load notices
 * @param {() => void} props.onAccept
 * @param {() => void} props.onReject
 */
export function MapPreview({ store, onAccept, onReject }) {
  const warnings = useGameStore(store, s => s.aiLoadWarnings);

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
      </div>
    </>
  );
}
