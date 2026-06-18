/**
 * Settings Panel
 *
 * Gear icon button that opens a dropdown with theme, accessibility,
 * and animation preferences.
 *
 * @module ui/SettingsPanel
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { DEFAULTS as PREF_DEFAULTS } from '../store/PreferencesManager.js';

const SPEED_OPTIONS = [
  { value: 0.5, label: '0.5x' },
  { value: 1, label: '1x' },
  { value: 2, label: '2x' },
  { value: 4, label: '4x' },
];

const MOTION_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const DICE_DISPLAY_OPTIONS = [
  { value: 'dice', label: 'Dice' },
  { value: 'number', label: 'Number' },
];

const STYLE = {
  wrapper: {
    position: 'fixed',
    top: '0.75rem',
    right: '0.75rem',
    zIndex: 1000,
    pointerEvents: 'auto',
  },
  gearBtn: {
    width: '36px',
    height: '36px',
    border: 'none',
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: '1.2rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 0.2s',
    padding: 0,
  },
  panel: {
    position: 'absolute',
    top: '42px',
    right: 0,
    width: '220px',
    borderRadius: '8px',
    padding: '0.75rem',
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
  },
  heading: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '0.95rem',
    marginBottom: '0.6rem',
    letterSpacing: '0.05em',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  label: {
    fontSize: '0.85rem',
  },
  btnGroup: {
    display: 'flex',
    gap: '4px',
  },
  optionBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    padding: '2px 8px',
    border: '1px solid',
    borderRadius: '3px',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  toggle: {
    position: 'relative',
    width: '36px',
    height: '20px',
    borderRadius: '10px',
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.2s',
    padding: 0,
  },
  toggleKnob: {
    position: 'absolute',
    top: '2px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.2s',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 * @param {Object} props.preferencesManager - PreferencesManager instance
 */
export function SettingsPanel({ store, preferencesManager }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const rawPrefs = useGameStore(store, s => s.preferences);
  const prefs = rawPrefs || PREF_DEFAULTS;

  const setPref = useCallback(
    (key, value) => {
      preferencesManager.set(key, value);
    },
    [preferencesManager]
  );

  // Close on Escape or click outside
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handleClickOutside);
    };
  }, [open]);

  const theme = prefs.theme || 'dark';
  const isDark = theme === 'dark';

  const panelBg = isDark ? 'rgba(26, 26, 46, 0.95)' : 'rgba(240, 240, 245, 0.95)';
  const textColor = isDark ? '#ffffff' : '#1a1a2e';
  const mutedColor = isDark ? '#aaaaaa' : '#555566';
  const accent = isDark ? '#e94560' : '#c0283d';
  const borderColor = isDark ? '#555555' : '#999999';

  return (
    <div style={STYLE.wrapper} ref={wrapperRef}>
      <button
        style={{
          ...STYLE.gearBtn,
          background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
          color: textColor,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}
        onClick={() => setOpen(!open)}
        aria-label="Settings"
        aria-expanded={open}
      >
        {'\u2699'}
      </button>

      {open && (
        <div
          style={{
            ...STYLE.panel,
            background: panelBg,
            color: textColor,
            border: `1px solid ${borderColor}`,
          }}
        >
          <div style={{ ...STYLE.heading, color: accent }}>SETTINGS</div>

          {/* Theme */}
          <div style={STYLE.row}>
            <span style={STYLE.label}>Theme</span>
            <button
              style={{
                ...STYLE.toggle,
                background: isDark ? '#555' : accent,
              }}
              onClick={() => setPref('theme', isDark ? 'light' : 'dark')}
              aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
            >
              <div
                style={{
                  ...STYLE.toggleKnob,
                  left: isDark ? '2px' : '18px',
                }}
              />
            </button>
          </div>
          <div
            style={{
              fontSize: '0.7rem',
              color: mutedColor,
              marginTop: '-6px',
              marginBottom: '0.5rem',
            }}
          >
            {isDark ? 'Dark' : 'Light'}
          </div>

          {/* Color-blind mode */}
          <div style={STYLE.row}>
            <span style={STYLE.label}>Color-blind</span>
            <button
              style={{
                ...STYLE.toggle,
                background: prefs.colorBlindMode ? accent : '#555',
              }}
              onClick={() => setPref('colorBlindMode', !prefs.colorBlindMode)}
              aria-label={`${prefs.colorBlindMode ? 'Disable' : 'Enable'} color-blind mode`}
            >
              <div
                style={{
                  ...STYLE.toggleKnob,
                  left: prefs.colorBlindMode ? '18px' : '2px',
                }}
              />
            </button>
          </div>

          {/* Dice style */}
          <div style={STYLE.row}>
            <span style={STYLE.label}>Dice style</span>
            <div style={STYLE.btnGroup}>
              {DICE_DISPLAY_OPTIONS.map(opt => {
                const active = (prefs.diceDisplayMode || 'number') === opt.value;
                return (
                  <button
                    key={opt.value}
                    style={{
                      ...STYLE.optionBtn,
                      background: active ? accent : 'transparent',
                      color: active ? '#fff' : textColor,
                      borderColor: active ? accent : borderColor,
                    }}
                    onClick={() => setPref('diceDisplayMode', opt.value)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mute sounds */}
          <div style={STYLE.row}>
            <span style={STYLE.label}>Mute sounds</span>
            <button
              style={{
                ...STYLE.toggle,
                background: prefs.muted ? accent : '#555',
              }}
              onClick={() => setPref('muted', !prefs.muted)}
              aria-label={`${prefs.muted ? 'Unmute' : 'Mute'} sounds`}
            >
              <div
                style={{
                  ...STYLE.toggleKnob,
                  left: prefs.muted ? '18px' : '2px',
                }}
              />
            </button>
          </div>

          {/* Animation speed */}
          <div style={STYLE.row}>
            <span style={STYLE.label}>Speed</span>
            <div style={STYLE.btnGroup}>
              {SPEED_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  style={{
                    ...STYLE.optionBtn,
                    background: prefs.animationSpeed === opt.value ? accent : 'transparent',
                    color: prefs.animationSpeed === opt.value ? '#fff' : textColor,
                    borderColor: prefs.animationSpeed === opt.value ? accent : borderColor,
                  }}
                  onClick={() => setPref('animationSpeed', opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Reduced motion */}
          <div style={STYLE.row}>
            <span style={STYLE.label}>Reduce motion</span>
            <div style={STYLE.btnGroup}>
              {MOTION_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  style={{
                    ...STYLE.optionBtn,
                    background: prefs.reducedMotion === opt.value ? accent : 'transparent',
                    color: prefs.reducedMotion === opt.value ? '#fff' : textColor,
                    borderColor: prefs.reducedMotion === opt.value ? accent : borderColor,
                  }}
                  onClick={() => setPref('reducedMotion', opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
