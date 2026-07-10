/**
 * Settings Panel
 *
 * Gear icon button that opens a dropdown with theme, accessibility, and
 * animation preferences, built from the shared menu-chrome language: each
 * preference is the title screen's eyebrow-over-options group (`.dw-opt` bare
 * Anton text, accent when selected — no toggles or pills), the heading is the
 * logotype bevel at the mode rail's miniature scale, and the card is the
 * standard translucent panel. Everything theme-dependent goes through
 * var(--ui-*).
 *
 * Mounted by App on every screen — including 'playing', where no menu screen
 * (and so no CHROME_CSS <style>) is in the DOM — so, like TopNav, it renders
 * its own stylesheet: CHROME_CSS for the shared option idiom plus its own
 * scoped rules. Duplicate mounts are harmless (identical rules).
 *
 * @module ui/SettingsPanel
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { DEFAULTS as PREF_DEFAULTS } from '../store/PreferencesManager.js';
import { CHROME_CSS } from './menuChrome.jsx';

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/* Boolean prefs as the same bare-text pair (value mapping done per group). */
const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const DICE_DISPLAY_OPTIONS = [
  { value: 'dice', label: 'Dice' },
  { value: 'number', label: 'Number' },
];

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

/*
 * Interactive states need a stylesheet (see CHROME_CSS's own comment). The
 * heading's fixed bevel colors are titleArt.jsx's wordmark palette at the
 * TopNav active-tab scale — identity, not theme, so they don't vary with
 * var(--ui-*).
 */
const SETTINGS_CSS = `
.dw-set-gear {
  width: 36px;
  height: 36px;
  border: 1px solid var(--ui-border);
  border-radius: 50%;
  background: var(--ui-overlay-bg);
  color: var(--ui-text);
  font-size: 1.15rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  transition: transform 0.2s ease, border-color 0.12s ease;
}
.dw-set-gear:hover { border-color: var(--ui-text-muted); }
.dw-set-gear[aria-expanded='true'] { transform: rotate(90deg); }
.dw-set-gear:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }

.dw-set-panel {
  position: absolute;
  top: 44px;
  right: 0;
  width: 236px;
  max-height: calc(100vh - 76px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0.85rem 0.95rem 0.95rem;
  background: var(--ui-overlay-bg);
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  transform-origin: top right;
}
@keyframes dw-set-open {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
  to { opacity: 1; transform: none; }
}
.dw-set-panel-anim { animation: dw-set-open 0.16s ease-out both; }

.dw-set-heading {
  font-family: Anton, sans-serif;
  font-size: 1.05rem;
  letter-spacing: 0.08em;
  color: #ff9c00;
  text-shadow:
    1px 1px 0 #875300,
    2px 2px 0 #4a2d00,
    1px 3px 6px rgba(0, 0, 0, 0.35);
}
.dw-set-eyebrow {
  font-family: Roboto, sans-serif;
  font-size: 0.65rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
  margin-bottom: 0.1rem;
}
/* Negative margin cancels the first/last .dw-opt padding so option text
   left-aligns with the eyebrow inside the tight card. */
.dw-set-row {
  display: flex;
  flex-wrap: wrap;
  margin: 0 -0.45rem;
}
.dw-set-opt {
  font-size: 0.95rem;
  text-transform: uppercase;
  padding: 0.12rem 0.45rem;
}
@media (prefers-reduced-motion: reduce) {
  .dw-set-gear { transition: border-color 0.12s ease; }
  .dw-set-panel-anim { animation: none; }
}
`;

/**
 * One preference as the title screen's option-group idiom: Roboto eyebrow
 * label above a wrapping row of bare Anton toggles.
 *
 * @param {Object} props
 * @param {string} props.label - Group label (eyebrow + accessible group name)
 * @param {{ value: string | number, label: string }[]} props.options
 * @param {string | number} props.value - Currently selected option value
 * @param {(value: string | number) => void} props.onSelect
 */
function OptionGroup({ label, options, value, onSelect }) {
  return (
    <div>
      <div className="dw-set-eyebrow">{label}</div>
      <div className="dw-set-row" role="group" aria-label={label}>
        {options.map(opt => (
          <button
            key={String(opt.value)}
            type="button"
            className="dw-opt dw-set-opt"
            aria-pressed={opt.value === value}
            onClick={() => onSelect(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

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

  /*
   * The system-level preference is handled in CSS (prefers-reduced-motion);
   * this only needs to honor an explicit in-app "on".
   */
  const animate = prefs.reducedMotion !== 'on';

  return (
    <div
      style={{
        position: 'fixed',
        top: '0.75rem',
        right: '0.75rem',
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
      ref={wrapperRef}
    >
      <style>{CHROME_CSS + SETTINGS_CSS}</style>
      <button
        type="button"
        className="dw-set-gear"
        onClick={() => setOpen(!open)}
        aria-label="Settings"
        aria-expanded={open}
      >
        {'⚙'}
      </button>

      {open && (
        <div className={animate ? 'dw-set-panel dw-set-panel-anim' : 'dw-set-panel'}>
          <div className="dw-set-heading">SETTINGS</div>

          <OptionGroup
            label="Theme"
            options={THEME_OPTIONS}
            value={prefs.theme || 'dark'}
            onSelect={v => setPref('theme', v)}
          />

          <OptionGroup
            label="Color-blind"
            options={ON_OFF_OPTIONS}
            value={prefs.colorBlindMode ? 'on' : 'off'}
            onSelect={v => setPref('colorBlindMode', v === 'on')}
          />

          <OptionGroup
            label="Dice style"
            options={DICE_DISPLAY_OPTIONS}
            value={prefs.diceDisplayMode || 'dice'}
            onSelect={v => setPref('diceDisplayMode', v)}
          />

          {/* Player-facing polarity: SOUND ON means audible (muted: false). */}
          <OptionGroup
            label="Sound"
            options={ON_OFF_OPTIONS}
            value={prefs.muted ? 'off' : 'on'}
            onSelect={v => setPref('muted', v === 'off')}
          />

          <OptionGroup
            label="Speed"
            options={SPEED_OPTIONS}
            value={prefs.animationSpeed}
            onSelect={v => setPref('animationSpeed', v)}
          />

          <OptionGroup
            label="Reduce motion"
            options={MOTION_OPTIONS}
            value={prefs.reducedMotion}
            onSelect={v => setPref('reducedMotion', v)}
          />
        </div>
      )}
    </div>
  );
}
