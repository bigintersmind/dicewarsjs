// @vitest-environment jsdom
/**
 * SettingsPanel tests
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { SettingsPanel } from '../../src/ui/SettingsPanel.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary.jsx';
import { REPO_URL } from '../../src/ui/menuChrome.jsx';

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

function createMockPreferencesManager(initial = {}) {
  const prefs = {
    theme: 'dark',
    colorBlindMode: false,
    diceDisplayMode: 'dice',
    animationSpeed: 1,
    reducedMotion: 'system',
    muted: false,
    boardHints: 'on',
    ...initial,
  };
  return {
    set: vi.fn((key, value) => {
      prefs[key] = value;
    }),
    get: vi.fn(key => prefs[key]),
    getAll: vi.fn(() => ({ ...prefs })),
  };
}

let container;

function renderPanel(storeOverrides = {}, prefsOverrides = {}) {
  const store = createGameStore({
    preferences: {
      theme: 'dark',
      colorBlindMode: false,
      diceDisplayMode: 'dice',
      animationSpeed: 1,
      reducedMotion: 'system',
      muted: false,
      boardHints: 'on',
      ...prefsOverrides,
    },
    ...storeOverrides,
  });

  const pm = createMockPreferencesManager(prefsOverrides);

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(SettingsPanel, { store, preferencesManager: pm }), container);
  });

  return { store, pm };
}

afterEach(() => {
  if (container) {
    act(() => {
      render(null, container);
    });
    if (container.parentNode) {
      document.body.removeChild(container);
    }
    container = null;
  }
});

/** Find the option button with the given visible label inside a named group. */
function optionIn(groupLabel, optionLabel) {
  const group = container.querySelector(`[role="group"][aria-label="${groupLabel}"]`);
  if (!group) return null;
  return Array.from(group.querySelectorAll('button')).find(b => b.textContent === optionLabel);
}

/*
 * ---------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------
 */

describe('SettingsPanel', () => {
  /*
   * -----------------------------------------------------------------------
   * Rendering
   * -----------------------------------------------------------------------
   */

  it('renders the settings die button', () => {
    renderPanel();
    const btn = container.querySelector('button[aria-label="Settings"]');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    // The die art must actually render (an empty pill would be an invisible
    // trigger), and stay decorative — the button's aria-label is the name.
    const svg = btn.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens panel on die button click', () => {
    renderPanel();
    const btn = container.querySelector('button[aria-label="Settings"]');

    act(() => btn.click());

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('SETTINGS');
  });

  it('closes panel on second die button click', () => {
    renderPanel();
    const btn = container.querySelector('button[aria-label="Settings"]');

    act(() => btn.click()); // open
    act(() => btn.click()); // close

    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('SETTINGS');
  });

  /*
   * -----------------------------------------------------------------------
   * The store flag (#211 item 8)
   * -----------------------------------------------------------------------
   * `settingsOpen` IS the open state, not a mirror of one, and this panel is its
   * only writer in production. KeyboardController reads it to stand the board's
   * keys down while the dropdown is up; that side is pinned in its own tests.
   */

  it('keeps its open state in the store, on every way in and out', () => {
    const { store } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    expect(store.getState().settingsOpen).toBe(false);

    act(() => dieBtn.click());
    expect(store.getState().settingsOpen).toBe(true);

    act(() => dieBtn.click());
    expect(store.getState().settingsOpen).toBe(false);

    act(() => dieBtn.click());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(store.getState().settingsOpen).toBe(false);

    act(() => dieBtn.click());
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    try {
      act(() => {
        outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
    } finally {
      document.body.removeChild(outside);
    }
    expect(store.getState().settingsOpen).toBe(false);
  });

  // The direction of ownership: the store drives the panel, so a component-local
  // state with an effect mirroring it outward would render this one closed.
  it('renders open when the flag is written from outside', () => {
    const { store } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');

    act(() => store.setState({ settingsOpen: true }));

    expect(dieBtn.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('SETTINGS');
  });

  /*
   * The flag cannot outlive the panel. Its own Escape and click-outside always
   * clear it while the panel is alive; this is the other case — the panel gone
   * with the flag still true, which is what the ErrorBoundary App wraps it in
   * does to a panel whose render threw. With nothing left to write the flag,
   * the board's arrows, E and Escape would stay suspended for the session, and
   * since enemy territories are reachable only by the arrows, that is a game
   * nobody can win by keyboard — not a lost shortcut.
   */
  it('drops the flag when it unmounts while open', () => {
    const { store } = renderPanel();
    act(() => container.querySelector('button[aria-label="Settings"]').click());
    expect(store.getState().settingsOpen).toBe(true);

    act(() => render(null, container));

    expect(store.getState().settingsOpen).toBe(false);
  });

  it('takes the flag down with it when its render throws inside the ErrorBoundary', () => {
    const store = createGameStore({ preferences: { theme: 'dark', boardHints: 'on' } });
    const pm = createMockPreferencesManager();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      render(
        h(ErrorBoundary, null, h(SettingsPanel, { store, preferencesManager: pm })),
        container
      );
    });
    act(() => container.querySelector('button[aria-label="Settings"]').click());
    expect(store.getState().settingsOpen).toBe(true);

    // A preferences object the panel cannot read: its next render throws, the
    // boundary swaps in its fallback, and the panel — flag and all — is gone.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      act(() => {
        store.setState({
          preferences: {
            get theme() {
              throw new Error('preferences unreadable');
            },
          },
        });
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(container.querySelector('button[aria-label="Settings"]')).toBeNull();
    expect(store.getState().settingsOpen).toBe(false);
  });

  /*
   * -----------------------------------------------------------------------
   * Theme
   * -----------------------------------------------------------------------
   */

  it('calls setPref with light theme when selecting Light', () => {
    const { pm } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const darkBtn = optionIn('Theme', 'Dark');
    const lightBtn = optionIn('Theme', 'Light');
    expect(darkBtn.getAttribute('aria-pressed')).toBe('true');
    expect(lightBtn.getAttribute('aria-pressed')).toBe('false');

    act(() => lightBtn.click());

    expect(pm.set).toHaveBeenCalledWith('theme', 'light');
  });

  /*
   * -----------------------------------------------------------------------
   * Color-blind mode
   * -----------------------------------------------------------------------
   */

  it('shows Off pressed by default and enables color-blind mode when selecting On', () => {
    const { pm } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const onBtn = optionIn('Color-blind', 'On');
    const offBtn = optionIn('Color-blind', 'Off');
    expect(offBtn.getAttribute('aria-pressed')).toBe('true');
    expect(onBtn.getAttribute('aria-pressed')).toBe('false');

    act(() => onBtn.click());

    expect(pm.set).toHaveBeenCalledWith('colorBlindMode', true);
  });

  it('disables color-blind mode when selecting Off while enabled', () => {
    const { pm } = renderPanel({}, { colorBlindMode: true });
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    expect(optionIn('Color-blind', 'On').getAttribute('aria-pressed')).toBe('true');

    act(() => optionIn('Color-blind', 'Off').click());

    expect(pm.set).toHaveBeenCalledWith('colorBlindMode', false);
  });

  /*
   * -----------------------------------------------------------------------
   * Dice display mode
   * -----------------------------------------------------------------------
   */

  it('calls setPref to switch dice display to number', () => {
    const { pm } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const numberBtn = optionIn('Dice style', 'Number');
    expect(numberBtn).toBeTruthy();

    act(() => numberBtn.click());

    expect(pm.set).toHaveBeenCalledWith('diceDisplayMode', 'number');
  });

  /*
   * -----------------------------------------------------------------------
   * Sound
   * -----------------------------------------------------------------------
   */

  it('calls setPref to mute when selecting Sound Off', () => {
    const { pm } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const onBtn = optionIn('Sound', 'On');
    const offBtn = optionIn('Sound', 'Off');
    expect(onBtn.getAttribute('aria-pressed')).toBe('true');

    act(() => offBtn.click());

    expect(pm.set).toHaveBeenCalledWith('muted', true);
  });

  it('calls setPref to unmute when selecting Sound On while muted', () => {
    const { pm } = renderPanel({}, { muted: true });
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const offBtn = optionIn('Sound', 'Off');
    expect(offBtn.getAttribute('aria-pressed')).toBe('true');

    act(() => optionIn('Sound', 'On').click());

    expect(pm.set).toHaveBeenCalledWith('muted', false);
  });

  /*
   * -----------------------------------------------------------------------
   * Animation speed
   * -----------------------------------------------------------------------
   */

  it('calls setPref with animationSpeed value', () => {
    const { pm } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const speedBtn = optionIn('Speed', '2x');
    expect(speedBtn).toBeTruthy();

    act(() => speedBtn.click());

    expect(pm.set).toHaveBeenCalledWith('animationSpeed', 2);
  });

  /*
   * -----------------------------------------------------------------------
   * Reduced motion
   * -----------------------------------------------------------------------
   */

  it('calls setPref with reducedMotion value', () => {
    const { pm } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const onBtn = optionIn('Reduce motion', 'On');
    expect(onBtn).toBeTruthy();

    act(() => onBtn.click());

    expect(pm.set).toHaveBeenCalledWith('reducedMotion', 'on');
  });

  /*
   * -----------------------------------------------------------------------
   * Board hints
   * -----------------------------------------------------------------------
   */

  it('shows the board-hints preference as on by default', () => {
    renderPanel();
    act(() => container.querySelector('button[aria-label="Settings"]').click());

    expect(optionIn('Board hints', 'On').getAttribute('aria-pressed')).toBe('true');
    expect(optionIn('Board hints', 'Off').getAttribute('aria-pressed')).toBe('false');
  });

  it('calls setPref with the boardHints value', () => {
    const { pm } = renderPanel();
    act(() => container.querySelector('button[aria-label="Settings"]').click());

    act(() => optionIn('Board hints', 'Off').click());

    expect(pm.set).toHaveBeenCalledWith('boardHints', 'off');
  });

  it('reflects board hints already turned off — the way back on', () => {
    renderPanel({}, { boardHints: 'off' });
    act(() => container.querySelector('button[aria-label="Settings"]').click());

    expect(optionIn('Board hints', 'Off').getAttribute('aria-pressed')).toBe('true');
  });

  /*
   * -----------------------------------------------------------------------
   * Escape and click-outside
   * -----------------------------------------------------------------------
   */

  it('closes panel on Escape key', () => {
    renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    expect(container.textContent).toContain('SETTINGS');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });

    expect(dieBtn.getAttribute('aria-expanded')).toBe('false');
  });

  // The rules card layers over the dropdown and claims Escape from a capture-phase
  // window listener (RulesModal.jsx); one press must not close both. The same
  // yield is what lets KeyboardController pass Escape through to this panel.
  it('ignores an Escape another handler already claimed', () => {
    const { store } = renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      document.dispatchEvent(event);
    });

    expect(dieBtn.getAttribute('aria-expanded')).toBe('true');
    expect(store.getState().settingsOpen).toBe(true);
  });

  it('consumes Escape while open so a screen-level handler does not also fire (#180)', () => {
    renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    // MapPreview's back-on-Escape listens on window, one hop up the bubble path.
    const onWindowEscape = vi.fn();
    window.addEventListener('keydown', onWindowEscape);
    try {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );
      });
    } finally {
      window.removeEventListener('keydown', onWindowEscape);
    }

    expect(dieBtn.getAttribute('aria-expanded')).toBe('false');
    expect(onWindowEscape).not.toHaveBeenCalled();
  });

  it('closes panel on click outside', () => {
    renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    expect(container.textContent).toContain('SETTINGS');

    // Create an element outside the panel to click on
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(dieBtn.getAttribute('aria-expanded')).toBe('false');
    document.body.removeChild(outside);
  });

  it('stays open when clicking an option inside the panel', () => {
    renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    // A pointerdown inside the panel must not trip the click-outside handler.
    act(() => {
      optionIn('Theme', 'Light').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(dieBtn.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('SETTINGS');
  });

  /*
   * -----------------------------------------------------------------------
   * Open animation
   * -----------------------------------------------------------------------
   */

  it('applies the open animation class by default', () => {
    renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const panel = container.querySelector('.dw-set-panel');
    expect(panel.classList.contains('dw-set-panel-anim')).toBe(true);
  });

  it('omits the open animation class when reduced motion is on', () => {
    renderPanel({}, { reducedMotion: 'on' });
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const panel = container.querySelector('.dw-set-panel');
    expect(panel.classList.contains('dw-set-panel-anim')).toBe(false);
  });

  /*
   * -----------------------------------------------------------------------
   * Source link (#183)
   * -----------------------------------------------------------------------
   */

  it('offers a source-repository link in the open panel', () => {
    renderPanel();
    const dieBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => dieBtn.click());

    const link = container.querySelector('.dw-set-footer a');
    expect(link).toBeTruthy();
    expect(link.textContent.trim()).toBe('Source on GitHub');
    expect(link.getAttribute('href')).toBe(REPO_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('hides the source link while the panel is closed', () => {
    renderPanel();
    expect(container.querySelector('.dw-set-footer')).toBeNull();
  });

  /*
   * -----------------------------------------------------------------------
   * Null guard
   * -----------------------------------------------------------------------
   */

  it('renders without crashing when preferences is null', () => {
    const store = createGameStore({ preferences: null });
    const pm = createMockPreferencesManager();
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      render(h(SettingsPanel, { store, preferencesManager: pm }), container);
    });

    const btn = container.querySelector('button[aria-label="Settings"]');
    expect(btn).toBeTruthy();
  });
});

/*
 * The heading is lettered in the logotype bevel, which used to be a hardcoded
 * #ff9c00 here — unreadable (1.83:1) on the light theme's dropdown. It now goes
 * through the --ui-bevel-* tokens; themes.test.js measures what those resolve
 * to, so what matters here is that the stylesheet actually asks for them and
 * that no literal survived the swap. The die art keeps its own fixed palette,
 * but that lives in a JS object, never in this CSS.
 */
describe('SettingsPanel — heading bevel tokens (#220)', () => {
  /** The panel's stylesheet: CHROME_CSS + SETTINGS_CSS in one mounted <style>. */
  const styleText = () => container.querySelector('style').textContent;

  it('letters the heading in the bevel tokens', () => {
    renderPanel();
    expect(styleText()).toContain('color: var(--ui-bevel-face);');
    expect(styleText()).toContain('text-shadow: var(--ui-bevel-shadow);');
  });

  it('leaves no hardcoded wordmark orange in the panel CSS', () => {
    renderPanel();
    expect(styleText().toLowerCase()).not.toContain('#ff9c00');
  });
});
