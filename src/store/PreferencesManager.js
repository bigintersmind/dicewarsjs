/**
 * Preferences Manager
 *
 * Persists user preferences to localStorage and provides
 * reactive subscriptions for preference changes.
 *
 * @module store/PreferencesManager
 */

const STORAGE_KEY = 'dicewars_prefs';

const DEFAULTS = {
  theme: 'dark',
  colorBlindMode: false,
  animationSpeed: 1,
  reducedMotion: 'system', // 'system' | 'on' | 'off'
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
      // Only merge known keys to avoid stale/invalid data
      for (const key of Object.keys(DEFAULTS)) {
        if (key in parsed) {
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
    return prefs[key];
  }

  function set(key, value) {
    if (!(key in DEFAULTS)) return;
    if (prefs[key] === value) return;
    prefs = { ...prefs, [key]: value };
    save();
    notify();
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
