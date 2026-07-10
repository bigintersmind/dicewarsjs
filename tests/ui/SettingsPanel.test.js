// @vitest-environment jsdom
/**
 * SettingsPanel tests
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { SettingsPanel } from '../../src/ui/SettingsPanel.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

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

  it('renders the gear button', () => {
    renderPanel();
    const btn = container.querySelector('button[aria-label="Settings"]');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens panel on gear button click', () => {
    renderPanel();
    const btn = container.querySelector('button[aria-label="Settings"]');

    act(() => btn.click());

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('SETTINGS');
  });

  it('closes panel on second gear button click', () => {
    renderPanel();
    const btn = container.querySelector('button[aria-label="Settings"]');

    act(() => btn.click()); // open
    act(() => btn.click()); // close

    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('SETTINGS');
  });

  /*
   * -----------------------------------------------------------------------
   * Theme
   * -----------------------------------------------------------------------
   */

  it('calls setPref with light theme when selecting Light', () => {
    const { pm } = renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

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

  it('calls setPref to enable color-blind mode', () => {
    const { pm } = renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    const onBtn = optionIn('Color-blind', 'On');
    expect(onBtn).toBeTruthy();

    act(() => onBtn.click());

    expect(pm.set).toHaveBeenCalledWith('colorBlindMode', true);
  });

  /*
   * -----------------------------------------------------------------------
   * Dice display mode
   * -----------------------------------------------------------------------
   */

  it('calls setPref to switch dice display to number', () => {
    const { pm } = renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

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
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    const onBtn = optionIn('Sound', 'On');
    const offBtn = optionIn('Sound', 'Off');
    expect(onBtn.getAttribute('aria-pressed')).toBe('true');

    act(() => offBtn.click());

    expect(pm.set).toHaveBeenCalledWith('muted', true);
  });

  it('calls setPref to unmute when selecting Sound On while muted', () => {
    const { pm } = renderPanel({}, { muted: true });
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

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
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

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
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    const onBtn = optionIn('Reduce motion', 'On');
    expect(onBtn).toBeTruthy();

    act(() => onBtn.click());

    expect(pm.set).toHaveBeenCalledWith('reducedMotion', 'on');
  });

  /*
   * -----------------------------------------------------------------------
   * Escape and click-outside
   * -----------------------------------------------------------------------
   */

  it('closes panel on Escape key', () => {
    renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    expect(container.textContent).toContain('SETTINGS');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(gearBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes panel on click outside', () => {
    renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    expect(container.textContent).toContain('SETTINGS');

    // Create an element outside the panel to click on
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });

    expect(gearBtn.getAttribute('aria-expanded')).toBe('false');
    document.body.removeChild(outside);
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
