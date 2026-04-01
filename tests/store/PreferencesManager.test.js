import { createPreferencesManager } from '../../src/store/PreferencesManager.js';

describe('PreferencesManager', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('defaults', () => {
    it('returns default values when localStorage is empty', () => {
      const pm = createPreferencesManager();
      expect(pm.getAll()).toEqual({
        theme: 'dark',
        colorBlindMode: false,
        animationSpeed: 1,
        reducedMotion: 'system',
      });
      pm.destroy();
    });
  });

  describe('get/set', () => {
    it('gets and sets individual preferences', () => {
      const pm = createPreferencesManager();
      expect(pm.set('theme', 'light')).toBe(true);
      expect(pm.get('theme')).toBe('light');
      pm.destroy();
    });

    it('warns and ignores unknown keys', () => {
      const pm = createPreferencesManager();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(pm.set('unknownKey', 'value')).toBe(false);
      expect(pm.get('unknownKey')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown preference key'));
      warnSpy.mockRestore();
      pm.destroy();
    });

    it('warns and rejects invalid value types', () => {
      const pm = createPreferencesManager();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(pm.set('animationSpeed', 'banana')).toBe(false);
      expect(pm.get('animationSpeed')).toBe(1); // unchanged default
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid value'), 'banana');
      warnSpy.mockRestore();
      pm.destroy();
    });

    it('rejects out-of-range animationSpeed values', () => {
      const pm = createPreferencesManager();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm.set('animationSpeed', -1);
      expect(pm.get('animationSpeed')).toBe(1);
      pm.set('animationSpeed', 0);
      expect(pm.get('animationSpeed')).toBe(1);
      warnSpy.mockRestore();
      pm.destroy();
    });

    it('rejects invalid reducedMotion values', () => {
      const pm = createPreferencesManager();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm.set('reducedMotion', 'invalid');
      expect(pm.get('reducedMotion')).toBe('system');
      warnSpy.mockRestore();
      pm.destroy();
    });

    it('rejects invalid theme values', () => {
      const pm = createPreferencesManager();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      pm.set('theme', 123);
      expect(pm.get('theme')).toBe('dark');
      warnSpy.mockRestore();
      pm.destroy();
    });

    it('does not notify when value is unchanged', () => {
      const pm = createPreferencesManager();
      const listener = vi.fn();
      pm.subscribe(listener);
      expect(pm.set('theme', 'dark')).toBe(true); // returns true even for no-op
      expect(listener).not.toHaveBeenCalled();
      pm.destroy();
    });
  });

  describe('persistence', () => {
    it('saves to localStorage on set', () => {
      const pm = createPreferencesManager();
      pm.set('theme', 'light');
      const stored = JSON.parse(localStorage.getItem('dicewars_prefs'));
      expect(stored.theme).toBe('light');
      pm.destroy();
    });

    it('loads from localStorage on creation', () => {
      localStorage.setItem('dicewars_prefs', JSON.stringify({ theme: 'light', animationSpeed: 2 }));
      const pm = createPreferencesManager();
      expect(pm.get('theme')).toBe('light');
      expect(pm.get('animationSpeed')).toBe(2);
      // Non-stored keys use defaults
      expect(pm.get('colorBlindMode')).toBe(false);
      pm.destroy();
    });

    it('rejects invalid values from localStorage', () => {
      localStorage.setItem(
        'dicewars_prefs',
        JSON.stringify({ theme: 'neon', animationSpeed: 'fast', colorBlindMode: 'yes' })
      );
      const pm = createPreferencesManager();
      // All invalid values should be ignored; defaults used
      expect(pm.get('theme')).toBe('dark');
      expect(pm.get('animationSpeed')).toBe(1);
      expect(pm.get('colorBlindMode')).toBe(false);
      pm.destroy();
    });

    it('handles corrupt localStorage gracefully', () => {
      localStorage.setItem('dicewars_prefs', 'not-json');
      const pm = createPreferencesManager();
      expect(pm.getAll()).toEqual({
        theme: 'dark',
        colorBlindMode: false,
        animationSpeed: 1,
        reducedMotion: 'system',
      });
      pm.destroy();
    });
  });

  describe('subscribe', () => {
    it('notifies subscribers on change', () => {
      const pm = createPreferencesManager();
      const listener = vi.fn();
      pm.subscribe(listener);
      pm.set('colorBlindMode', true);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ colorBlindMode: true }));
      pm.destroy();
    });

    it('returns unsubscribe function', () => {
      const pm = createPreferencesManager();
      const listener = vi.fn();
      const unsub = pm.subscribe(listener);
      unsub();
      pm.set('theme', 'light');
      expect(listener).not.toHaveBeenCalled();
      pm.destroy();
    });

    it('isolates subscriber errors', () => {
      const pm = createPreferencesManager();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const badListener = () => {
        throw new Error('boom');
      };
      const goodListener = vi.fn();
      pm.subscribe(badListener);
      pm.subscribe(goodListener);
      pm.set('theme', 'light');
      expect(goodListener).toHaveBeenCalled();
      errorSpy.mockRestore();
      pm.destroy();
    });
  });

  describe('effectiveReducedMotion', () => {
    it('returns false when reducedMotion is "off"', () => {
      const pm = createPreferencesManager();
      pm.set('reducedMotion', 'off');
      expect(pm.effectiveReducedMotion()).toBe(false);
      pm.destroy();
    });

    it('returns true when reducedMotion is "on"', () => {
      const pm = createPreferencesManager();
      pm.set('reducedMotion', 'on');
      expect(pm.effectiveReducedMotion()).toBe(true);
      pm.destroy();
    });

    it('defers to system when reducedMotion is "system"', () => {
      const pm = createPreferencesManager();
      // In test environment, matchMedia returns false by default
      expect(pm.effectiveReducedMotion()).toBe(false);
      pm.destroy();
    });
  });

  describe('destroy', () => {
    it('clears all listeners', () => {
      const pm = createPreferencesManager();
      const listener = vi.fn();
      pm.subscribe(listener);
      pm.destroy();
      pm.set('theme', 'light');
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
