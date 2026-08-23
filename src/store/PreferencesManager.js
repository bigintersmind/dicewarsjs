/**
 * Preferences Manager
 *
 * Persists user preferences to localStorage and provides
 * reactive subscriptions for preference changes.
 *
 * @module store/PreferencesManager
 */

const STORAGE_KEY = 'dicewars_prefs';

export const DEFAULTS = {
  theme: 'dark',
  colorBlindMode: false,
  diceDisplayMode: 'dice', // 'dice' | 'number'
  animationSpeed: 1,
  reducedMotion: 'system', // 'system' | 'on' | 'off'
  muted: false,
  /*
   * Contextual rules coaching (the "Coach" prototype): the in-game hint strip
   * and the board's affordance highlights. On by default — early playtesters
   * reported the rules were not self-apparent — and turned off from the strip's
   * own dismiss control or the settings panel.
   */
  coachHints: 'on', // 'on' | 'off'
};

const VALIDATORS = {
  theme: v => typeof v === 'string' && ['dark', 'light'].includes(v),
  colorBlindMode: v => typeof v === 'boolean',
  diceDisplayMode: v => typeof v === 'string' && ['dice', 'number'].includes(v),
  animationSpeed: v => typeof v === 'number' && v > 0 && v <= 10,
  reducedMotion: v => typeof v === 'string' && ['system', 'on', 'off'].includes(v),
  muted: v => typeof v === 'boolean',
  coachHints: v => typeof v === 'string' && ['on', 'off'].includes(v),
};

/**
 * Create a preferences manager.
 *
 * @returns {{ get, set, getAll, subscribe, effectiveReducedMotion, destroy }}
 */
export function createPreferencesManager() {
  let prefs = { ...DEFAULTS };
  const listeners = new Set();

  // Load from localStorage
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Only merge known keys with valid values to avoid stale/invalid data
      for (const key of Object.keys(DEFAULTS)) {
        if (key in parsed && (!VALIDATORS[key] || VALIDATORS[key](parsed[key]))) {
          prefs[key] = parsed[key];
        }
      }
    }
  } catch (err) {
    console.warn('[PreferencesManager] Failed to load preferences:', err);
  }

  // Track system reduced-motion preference
  let systemReducedMotion = false;
  let motionQuery = null;

  try {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    systemReducedMotion = motionQuery.matches;
    motionQuery.addEventListener('change', handleMotionChange);
  } catch (err) {
    console.warn('[PreferencesManager] Cannot detect system motion preference:', err);
  }

  function handleMotionChange(e) {
    systemReducedMotion = e.matches;
    notify();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (err) {
      console.warn('[PreferencesManager] Failed to save preferences:', err);
    }
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn(prefs);
      } catch (err) {
        console.error('[PreferencesManager] Subscriber threw:', err);
      }
    }
  }

  function get(key) {
    if (!(key in DEFAULTS)) {
      console.warn(`[PreferencesManager] Unknown preference key: "${key}"`);
      return undefined;
    }
    return prefs[key];
  }

  function set(key, value) {
    if (!(key in DEFAULTS)) {
      console.warn(`[PreferencesManager] Unknown preference key: "${key}"`);
      return false;
    }
    if (VALIDATORS[key] && !VALIDATORS[key](value)) {
      console.warn(`[PreferencesManager] Invalid value for "${key}":`, value);
      return false;
    }
    if (prefs[key] === value) return true;
    prefs = { ...prefs, [key]: value };
    save();
    notify();
    return true;
  }

  function getAll() {
    return { ...prefs };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Resolve the effective reduced-motion setting.
   * 'system' defers to the OS preference; 'on'/'off' are explicit overrides.
   */
  function effectiveReducedMotion() {
    if (prefs.reducedMotion === 'on') return true;
    if (prefs.reducedMotion === 'off') return false;
    return systemReducedMotion;
  }

  function destroy() {
    if (motionQuery) {
      motionQuery.removeEventListener('change', handleMotionChange);
    }
    listeners.clear();
  }

  return { get, set, getAll, subscribe, effectiveReducedMotion, destroy };
}
