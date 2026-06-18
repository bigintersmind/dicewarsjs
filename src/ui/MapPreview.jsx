/**
 * Map Preview
 *
 * "Play this board?" dialog with YES/NO buttons.
 *
 * @module ui/MapPreview
 */

const STYLE = {
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
 * @param {() => void} props.onAccept
 * @param {() => void} props.onReject
 */
export function MapPreview({ onAccept, onReject }) {
  return (
    <div style={STYLE.overlay}>
      <span style={STYLE.label}>Play this board?</span>
      <button style={{ ...STYLE.btn, ...STYLE.yes }} onClick={onAccept}>
        YES
      </button>
      <button style={{ ...STYLE.btn, ...STYLE.no }} onClick={onReject}>
        NO
      </button>
    </div>
  );
}
