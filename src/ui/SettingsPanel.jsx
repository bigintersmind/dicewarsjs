/**
 * Settings Panel
 *
 * Die-shaped button that opens a dropdown with theme, accessibility, and
 * animation preferences. The trigger is the game's own die — the legacy cube
 * art (DiceRenderer.js's decoded paths, replayed as SVG) showing faces
 * [3, 2, 1], so the top face reads as the three-dots "more" glyph in dice
 * language — cast in the DICE WARS logotype's layer palette so it reads as
 * chrome, not a player piece. The panel is built from the shared menu-chrome
 * language: each preference is the title screen's eyebrow-over-options group (`.dw-opt` bare
 * Anton text, accent when selected — no toggles or pills), the heading is the
 * logotype bevel at the mode rail's miniature scale, and the card is the
 * standard translucent panel. Everything theme-dependent goes through
 * var(--ui-*).
 *
 * Mounted by App on every screen — including 'playing', where no menu screen
 * (and so no CHROME_CSS <style>) is in the DOM — so, like TopNav, it renders
 * its own stylesheet: CHROME_CSS for the shared option idiom plus its own
 * scoped rules. Duplicate CHROME_CSS mounts are harmless (identical rules), and
 * SETTINGS_CSS's one override of a shared rule (.dw-opt.dw-set-opt) is written
 * to win on specificity, so mount order between the two <style>s doesn't matter.
 *
 * @module ui/SettingsPanel
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { DEFAULTS as PREF_DEFAULTS } from '../store/PreferencesManager.js';
import { CHROME_CSS } from './menuChrome.jsx';

/*
 * The legacy die geometry, as SVG path data: DiceRenderer.js's decoded Flash
 * paths (CUBE/SIDE/TOP, rim wedges, bottom crescent, glint star) and measured
 * pip tables (TOP_PIPS[3], LEFT_PIPS[2], RIGHT_PIPS[1]), serialized command
 * for command. Treat as opaque — if the die art ever changes, re-serialize
 * from DiceRenderer.js rather than editing coordinates here. Same coordinate
 * space as the renderer (origin = die center; the silhouette spans
 * 27.9 x 30.5, per DiceRenderer.js); the svg viewBox pads that box by
 * ~0.2 units per side.
 */
// prettier-ignore
const DIE_PATHS = {
  cube: 'M-3.05 14.52L-10.53 9.08Q-12.76 6.59 -13.92 3.3L-13.92 -3.49Q-12.46 -7.08 -10.18 -9.61L-3.73 -14.37Q-0.26 -15.67 3.74 -14.37L10.54 -9.27Q12.64 -7.08 13.93 -3.83L13.93 3.3Q13.1 6.11 11.22 8.4L3.06 14.52Q1.52 14.79 0 14.79Q-1.51 14.79 -3.05 14.52Z',
  side: 'M-3.07 14.52L-10.53 9.08Q-12.76 6.59 -13.92 3.32L-13.92 -3.48Q-12.19 -4.6 -10.18 -3.82L-3.4 1.28Q-1.05 3.48 0 6.7L0 13.5Q-0.85 14.54 -2.62 14.54Q-2.84 14.54 -3.07 14.52Z',
  top: 'M-3.38 1.26L-10.18 -3.84Q-12.61 -6.23 -10.18 -9.6L-3.72 -14.36Q-0.25 -15.67 3.74 -14.36L10.54 -9.27Q12.21 -6.45 10.54 -4.18L3.4 1.26Q1.74 2.14 0.04 2.14Q-1.64 2.14 -3.38 1.26Z',
  leftRim: 'M-10.2 -9.6Q-11.53 -6.39 -10.2 -3.84Q-12.19 -4.61 -13.92 -3.49Q-12.46 -7.08 -10.2 -9.6Z',
  rightRim: 'M10.56 -4.17Q11.53 -6.47 10.56 -9.26Q12.64 -7.08 13.93 -3.84Q12.3 -5.01 10.56 -4.17Z',
  bottomRim: 'M-3.05 14.52Q-0.93 14.65 0 13.52Q1.07 14.53 3.06 14.52Q1.52 14.78 0 14.78Q-1.51 14.78 -3.05 14.52Z',
  glint: 'M-3.38 1.28Q0 1.96 3.39 1.28Q0.88 3.72 0 6.7Q-1.04 3.48 -3.38 1.28Z',
  pipLeft2: 'M0.42 2.35Q-0.44 1.94 -1.16 0.99Q-1.89 0.03 -2.07 -0.91Q-2.24 -1.84 -1.76 -2.21Q-1.28 -2.58 -0.43 -2.16Q0.43 -1.74 1.16 -0.78Q1.88 0.17 2.06 1.11Q2.24 2.04 1.76 2.41Q1.53 2.58 1.23 2.58Q0.88 2.58 0.42 2.35Z',
  pipRight1: 'M-3.59 5.13Q-4.59 4.41 -4.23 2.45Q-3.87 0.49 -2.38 -1.53Q-0.89 -3.57 0.85 -4.51Q2.6 -5.44 3.59 -4.72Q4.59 -4 4.23 -2.04Q3.88 -0.08 2.38 1.94Q0.9 3.98 -0.85 4.92Q-1.83 5.44 -2.58 5.44Q-3.16 5.44 -3.59 5.13Z',
};

/** TOP_PIPS[3]: three pips in a row — the "more" glyph in dice language. */
const TOP_PIP_3 = { rx: 2.23, ry: 1.62, pts: [[-7.06, -6.78], [-0.14, -6.75], [6.83, -6.79]] }; // prettier-ignore
/** LEFT_PIPS[2] / RIGHT_PIPS[1] stamp positions (die-center-relative). */
const LEFT_PIP_2_PTS = [[-9.84, 5.42], [-4.23, 4.34]]; // prettier-ignore
const RIGHT_PIP_1_PT = [6.85, 5.04];

/*
 * Face colors cast from the DICE WARS logotype's layer palette (titleArt.jsx
 * / .dw-screen-title): #FF9C00 face, #C57900 first extrusion as the left
 * wall, #4A2D00 deepest layer as the silhouette, #FFFF33 rim light as the
 * glint. Identity colors, not theme — like the wordmark and the active nav
 * tab — so the die reads as chrome rather than the orange player's piece
 * (whose identity triple is the distinct amber E67F02/945100/371E00). The two rim wedges
 * and bottom crescent interpolate within that ramp the way the legacy die
 * sets do (left rim just under the top face, right rim a step above the
 * base, crescent darkest); pips are black like every light-bodied die.
 */
const DIE_COLORS_CHROME = {
  top: '#ff9c00',
  side: '#c57900',
  base: '#4a2d00',
  glint: '#ffff33',
  leftRim: '#e68a00',
  rightRim: '#6e3c00',
  bottomRim: '#2e1b00',
  pips: '#000000',
};

/**
 * The settings die: the legacy cube replayed in the original layer order
 * (silhouette, left wall, top face, rims, glint, pips) with faces [3, 2, 1] —
 * a physically valid corner (no opposite-face pairs, cf. DIE_FACES).
 */
function SettingsDie() {
  const c = DIE_COLORS_CHROME;
  return (
    <svg viewBox="-14.1 -15.9 28.2 30.9" aria-hidden="true">
      <path d={DIE_PATHS.cube} fill={c.base} />
      <path d={DIE_PATHS.side} fill={c.side} />
      <path d={DIE_PATHS.top} fill={c.top} />
      <path d={DIE_PATHS.leftRim} fill={c.leftRim} />
      <path d={DIE_PATHS.rightRim} fill={c.rightRim} />
      <path d={DIE_PATHS.bottomRim} fill={c.bottomRim} />
      <path d={DIE_PATHS.glint} fill={c.glint} />
      {TOP_PIP_3.pts.map(([x, y], i) => (
        <ellipse key={i} cx={x} cy={y} rx={TOP_PIP_3.rx} ry={TOP_PIP_3.ry} fill={c.pips} />
      ))}
      {LEFT_PIP_2_PTS.map(([x, y], i) => (
        <path key={i} d={DIE_PATHS.pipLeft2} transform={`translate(${x} ${y})`} fill={c.pips} />
      ))}
      <path
        d={DIE_PATHS.pipRight1}
        transform={`translate(${RIGHT_PIP_1_PT[0]} ${RIGHT_PIP_1_PT[1]})`}
        fill={c.pips}
      />
    </svg>
  );
}

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
/* The pill shares the panel's radius (not a circle) so button and dropdown
   read as one piece of chrome. Open state: the die tumbles to the splash
   art's green-die tilt (titleArt.jsx rotates it -15deg). */
.dw-set-die {
  width: 36px;
  height: 36px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  transition: border-color 0.12s ease;
}
.dw-set-die svg {
  width: 24px;
  height: 26px;
  transition: transform 0.2s ease;
}
.dw-set-die:hover { border-color: var(--ui-text-muted); }
.dw-set-die[aria-expanded='true'] svg { transform: rotate(-15deg); }
.dw-set-die:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }

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
/* Negative margin cancels the first/last .dw-set-opt padding so option text
   left-aligns with the eyebrow inside the tight card. */
.dw-set-row {
  display: flex;
  flex-wrap: wrap;
  margin: 0 -0.45rem;
}
/* Doubled class (.dw-opt.dw-set-opt) so this padding override outranks the base
   .dw-opt on specificity, not source order: on hub screens a second CHROME_CSS
   copy mounts after this <style>, and an equal-specificity rule would let its
   .dw-opt win the tie and shift the option text out of eyebrow alignment. */
.dw-opt.dw-set-opt {
  font-size: 0.95rem;
  text-transform: uppercase;
  padding: 0.12rem 0.45rem;
}
@media (prefers-reduced-motion: reduce) {
  .dw-set-die svg { transition: none; }
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
      if (e.key !== 'Escape') return;
      /*
       * The dropdown owns Escape while it is open: stop the event here so a
       * screen-level Escape handler further up the bubble path (MapPreview's
       * back-to-title, #180) does not also fire on the same keypress.
       */
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
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
        className="dw-set-die"
        onClick={() => setOpen(!open)}
        aria-label="Settings"
        aria-expanded={open}
      >
        <SettingsDie />
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
