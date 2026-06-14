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
   * Theme toggle
   * -----------------------------------------------------------------------
   */

  it('calls setPref with light theme when toggling from dark', () => {
    const { pm } = renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    const themeBtn = container.querySelector('button[aria-label="Switch to light theme"]');
    expect(themeBtn).toBeTruthy();

    act(() => themeBtn.click());

    expect(pm.set).toHaveBeenCalledWith('theme', 'light');
  });

  /*
   * -----------------------------------------------------------------------
   * Color-blind toggle
   * -----------------------------------------------------------------------
   */

  it('calls setPref to enable color-blind mode', () => {
    const { pm } = renderPanel();
    const gearBtn = container.querySelector('button[aria-label="Settings"]');
    act(() => gearBtn.click());

    const cbBtn = container.querySelector('button[aria-label="Enable color-blind mode"]');
    expect(cbBtn).toBeTruthy();

    act(() => cbBtn.click());

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

    const buttons = Array.from(container.querySelectorAll('button'));
    const numberBtn = buttons.find(b => b.textContent === 'Number');
    expect(numberBtn).toBeTruthy();

    act(() => numberBtn.click());

    expect(pm.set).toHaveBeenCalledWith('diceDisplayMode', 'number');
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

    const buttons = Array.from(container.querySelectorAll('button'));
    const speedBtn = buttons.find(b => b.textContent === '2x');
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

    const buttons = Array.from(container.querySelectorAll('button'));
    const onBtn = buttons.find(b => b.textContent === 'On');
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
