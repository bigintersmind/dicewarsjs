// @vitest-environment jsdom
/**
 * TitleScreen tests
 *
 * Covers the pre-game setup controls: player-count and the new map-size preset
 * selector, plus that both START and AI-vs-AI thread the choices into onStart.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { TitleScreen } from '../../src/ui/TitleScreen.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { PLAYER_COLOR_NAMES } from '../../src/renderer/constants.js';

let container;

function renderTitle(props = {}) {
  const store = createGameStore();
  const onStart = vi.fn();

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(TitleScreen, { store, onStart, ...props }), container);
  });

  return { store, onStart };
}

const sizeBtn = label => container.querySelector(`button[aria-label="${label} map"]`);
const playerBtn = n => container.querySelector(`button[aria-label="Play with ${n} players"]`);
const startBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent === 'START');
const aiBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent === 'AI vs AI');
const customizeBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent.includes('Customize players'));
// Slots are labelled by player color now; `n` stays the 1-indexed player number.
const slotSelect = n => {
  const colorName = PLAYER_COLOR_NAMES[(n - 1) % PLAYER_COLOR_NAMES.length];
  return container.querySelector(`select[aria-label="Bot for ${colorName} player"]`);
};

/** Set a native <select> value and fire the change event Preact listens for. */
function chooseBot(playerNumber, aiId) {
  const sel = slotSelect(playerNumber);
  act(() => {
    sel.value = aiId;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('TitleScreen', () => {
  it('renders the three map-size presets', () => {
    renderTitle();
    expect(sizeBtn('Small')).toBeTruthy();
    expect(sizeBtn('Medium')).toBeTruthy();
    expect(sizeBtn('Large')).toBeTruthy();
  });

  it('defaults to the Medium preset selected', () => {
    renderTitle();
    expect(sizeBtn('Medium').getAttribute('aria-pressed')).toBe('true');
    expect(sizeBtn('Small').getAttribute('aria-pressed')).toBe('false');
    expect(sizeBtn('Large').getAttribute('aria-pressed')).toBe('false');
  });

  it('updates the selected preset when a size button is clicked', () => {
    renderTitle();
    act(() => sizeBtn('Large').click());
    expect(sizeBtn('Large').getAttribute('aria-pressed')).toBe('true');
    expect(sizeBtn('Medium').getAttribute('aria-pressed')).toBe('false');
  });

  it('passes the default map size to onStart via START', () => {
    const { onStart } = renderTitle();
    act(() => startBtn().click());
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ playerCount: 7, spectator: false, mapSize: 'medium' })
    );
  });

  it('passes the chosen map size to onStart via START', () => {
    const { onStart } = renderTitle();
    act(() => sizeBtn('Small').click());
    act(() => startBtn().click());
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ playerCount: 7, spectator: false, mapSize: 'small' })
    );
  });

  it('threads the chosen map size through the AI-vs-AI (spectator) path', () => {
    const { onStart } = renderTitle();
    act(() => sizeBtn('Large').click());
    act(() => aiBtn().click());
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ playerCount: 7, spectator: true, mapSize: 'large' })
    );
  });

  it('renders an error banner when error prop is set', () => {
    renderTitle({ error: 'Map generation failed' });
    expect(container.textContent).toContain('Map generation failed');
  });

  describe('per-slot bot picker', () => {
    it('hides the slot controls until "Customize players" is expanded', () => {
      renderTitle();
      expect(slotSelect(2)).toBeNull();
      act(() => customizeBtn().click());
      expect(slotSelect(2)).toBeTruthy();
    });

    it('shows one bot dropdown per AI slot, with slot 0 marked as the human', () => {
      renderTitle();
      act(() => customizeBtn().click());
      // 7 players → slot 0 is "You", slots 1..6 are dropdowns.
      expect(container.querySelectorAll('select')).toHaveLength(6);
      expect(container.textContent).toContain('You (human)');
    });

    it('resizes the slot list when the player count changes', () => {
      renderTitle();
      act(() => customizeBtn().click());
      expect(container.querySelectorAll('select')).toHaveLength(6);
      act(() => playerBtn(3).click());
      // 3 players → slot 0 human + 2 dropdowns.
      expect(container.querySelectorAll('select')).toHaveLength(2);
    });

    it('always sends a human (null) slot 0 and a concrete bot for every AI slot', () => {
      const { onStart } = renderTitle();
      act(() => startBtn().click());
      const { aiAssignments } = onStart.mock.calls[0][0];
      expect(aiAssignments).toHaveLength(7);
      expect(aiAssignments[0]).toBeNull();
      expect(aiAssignments.slice(1).every(id => typeof id === 'string')).toBe(true);
    });

    it('threads chosen bots — including duplicates — into onStart', () => {
      const { onStart } = renderTitle();
      act(() => customizeBtn().click());
      chooseBot(2, 'ai_strategist');
      chooseBot(3, 'ai_strategist');
      act(() => startBtn().click());
      const { aiAssignments } = onStart.mock.calls[0][0];
      expect(aiAssignments[0]).toBeNull();
      expect(aiAssignments[1]).toBe('ai_strategist');
      expect(aiAssignments[2]).toBe('ai_strategist');
    });

    it('carries the chosen lineup through the AI-vs-AI path too', () => {
      const { onStart } = renderTitle();
      act(() => customizeBtn().click());
      chooseBot(2, 'ai_lookahead');
      act(() => aiBtn().click());
      const { spectator, aiAssignments } = onStart.mock.calls[0][0];
      expect(spectator).toBe(true);
      expect(aiAssignments[1]).toBe('ai_lookahead');
    });

    it('offers curated community bots in a "Community" optgroup', () => {
      renderTitle();
      act(() => customizeBtn().click());
      const select = slotSelect(2);
      const builtIn = select.querySelector('optgroup[label="Built-in"]');
      const community = select.querySelector('optgroup[label="Community"]');
      expect(builtIn).toBeTruthy();
      expect(community).toBeTruthy();
      const values = [...community.querySelectorAll('option')].map(o => o.value);
      expect(values).toContain('community:bigintersmind/connector');
      // Community option values are namespaced so the controller can route them.
      expect(values.every(v => v.startsWith('community:'))).toBe(true);
    });

    it('threads a chosen community bot (namespaced id) into onStart', () => {
      const { onStart } = renderTitle();
      act(() => customizeBtn().click());
      chooseBot(2, 'community:bigintersmind/connector');
      act(() => startBtn().click());
      const { aiAssignments } = onStart.mock.calls[0][0];
      expect(aiAssignments[1]).toBe('community:bigintersmind/connector');
    });
  });
});
