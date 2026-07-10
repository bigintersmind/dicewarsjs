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
import { lineupForMode } from '../../src/ai/difficultyModes.js';
import {
  PLAYER_COLOR_NAMES,
  PLAYER_COLORS_CSS,
  COLORBLIND_PLAYER_COLOR_NAMES,
  COLORBLIND_PLAYER_COLORS_CSS,
} from '../../src/renderer/constants.js';

let container;

function renderTitle(props = {}) {
  const { store = createGameStore(), onStart = vi.fn(), ...rest } = props;

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(TitleScreen, { store, onStart, ...rest }), container);
  });

  return { store, onStart };
}

const sizeBtn = label => container.querySelector(`button[aria-label="${label} map"]`);
const playerBtn = n => container.querySelector(`button[aria-label="Play with ${n} players"]`);
const startBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent === 'START');
const aiBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent === 'AI vs AI');
const modeBtn = name => container.querySelector(`button[aria-label="${name} difficulty"]`);
/*
 * Slots are labelled by player color now; `n` stays the 1-indexed player number.
 * Assumes the default palette — color-blind-mode tests query by name directly.
 */
const slotSelect = n => {
  const colorName = PLAYER_COLOR_NAMES[(n - 1) % PLAYER_COLOR_NAMES.length];
  return container.querySelector(`select[aria-label="Bot for ${colorName} player"]`);
};

/*
 * The slot swatch is a bare <span> with no test hook; identify it by its
 * fixed 14×14 inline dimensions (see STYLE.swatch in TitleScreen.jsx).
 */
const slotSwatches = () =>
  [...container.querySelectorAll('span')].filter(
    s => s.style.width === '14px' && s.style.height === '14px'
  );

/*
 * jsdom's CSSOM normalizes a hex `background` to the `rgb(r, g, b)` form, so
 * compare swatch fills against the converted palette value.
 */
const cssHexToRgb = hex => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
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
    it('hides the slot controls until the Custom difficulty is selected (#167)', () => {
      renderTitle();
      expect(slotSelect(2)).toBeNull();
      act(() => modeBtn('Custom').click());
      expect(slotSelect(2)).not.toBeNull();
    });

    it('shows one bot dropdown per AI slot, with slot 0 marked as the human', () => {
      renderTitle();
      act(() => modeBtn('Custom').click());
      // 7 players → slot 0 is "You", slots 1..6 are dropdowns.
      expect(container.querySelectorAll('select')).toHaveLength(6);
      expect(container.textContent).toContain('You (human)');
    });

    it('labels each slot with its in-game color name and a swatch', () => {
      renderTitle();
      act(() => modeBtn('Custom').click());
      // Default palette names for the first slots (human slot 0 + AI slots).
      expect(container.textContent).toContain('Lavender'); // slot 0
      expect(container.textContent).toContain('Lime'); // slot 1
      expect(container.textContent).toContain('Green'); // slot 2
      // One swatch per visible slot (7 players → 7 swatches).
      expect(slotSwatches()).toHaveLength(7);
      // Swatch fill matches the in-game player palette, by slot index.
      expect(slotSwatches()[0].style.background).toBe(cssHexToRgb(PLAYER_COLORS_CSS[0]));
    });

    it('resizes the slot list when the player count changes', () => {
      renderTitle();
      act(() => modeBtn('Custom').click());
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
      act(() => modeBtn('Custom').click());
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
      act(() => modeBtn('Custom').click());
      chooseBot(2, 'ai_lookahead');
      act(() => aiBtn().click());
      const { spectator, aiAssignments } = onStart.mock.calls[0][0];
      expect(spectator).toBe(true);
      expect(aiAssignments[1]).toBe('ai_lookahead');
    });

    it('groups bots into Self-Play, General, then Community sections (in that order)', () => {
      renderTitle();
      act(() => modeBtn('Custom').click());
      const select = slotSelect(2);

      // The learned personas lead, then the hand-written heuristics, then community bots.
      const groups = [...select.querySelectorAll('optgroup')].map(g => g.label);
      expect(groups).toEqual(['Self-Play', 'General', 'Community']);

      // Self-Play holds exactly the neural personas.
      const selfPlay = select.querySelector('optgroup[label="Self-Play"]');
      expect([...selfPlay.querySelectorAll('option')].map(o => o.textContent)).toEqual([
        'Conqueror',
        'Blitz',
        'Survivor',
      ]);

      // General holds exactly the picker-visible heuristics, strongest-first,
      // with the #167 revived weak bots (Easy-mode ingredients) at the bottom.
      // Expectimax must not render — it stays trimmed everywhere.
      const general = select.querySelector('optgroup[label="General"]');
      const genValues = [...general.querySelectorAll('option')].map(o => o.value);
      expect(genValues).toEqual([
        'ai_lookahead',
        'ai_strategist',
        'ai_adaptive',
        'ai_default',
        'ai_defensive',
        'ai_example',
      ]);

      // Community option values are namespaced so the controller can route them.
      const community = select.querySelector('optgroup[label="Community"]');
      const values = [...community.querySelectorAll('option')].map(o => o.value);
      expect(values).toContain('community:bigintersmind/connector');
      expect(values.every(v => v.startsWith('community:'))).toBe(true);
    });

    it('threads a chosen community bot (namespaced id) into onStart', () => {
      const { onStart } = renderTitle();
      act(() => modeBtn('Custom').click());
      chooseBot(2, 'community:bigintersmind/connector');
      act(() => startBtn().click());
      const { aiAssignments } = onStart.mock.calls[0][0];
      expect(aiAssignments[1]).toBe('community:bigintersmind/connector');
    });
  });

  describe('difficulty modes (#167)', () => {
    it('renders Easy, Standard, Hard, Custom with Standard pre-selected', () => {
      renderTitle();
      for (const name of ['Easy', 'Standard', 'Hard', 'Custom']) {
        expect(modeBtn(name)).not.toBeNull();
      }
      expect(modeBtn('Standard').getAttribute('aria-pressed')).toBe('true');
      expect(modeBtn('Easy').getAttribute('aria-pressed')).toBe('false');
    });

    it('threads the default Standard mode and all-Default lineup into onStart', () => {
      const { onStart } = renderTitle();
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          difficulty: 'standard',
          aiAssignments: [null, ...Array(6).fill('ai_default')], // default 7 players
        })
      );
    });

    it('replaces the lineup when a preset is clicked (Easy, sliced to 7)', () => {
      const { onStart } = renderTitle();
      act(() => modeBtn('Easy').click());
      expect(modeBtn('Easy').getAttribute('aria-pressed')).toBe('true');
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          difficulty: 'easy',
          aiAssignments: lineupForMode('easy', 7),
        })
      );
    });

    it('seeds Custom from the last-selected preset (Hard → Custom)', () => {
      renderTitle();
      act(() => modeBtn('Hard').click());
      act(() => modeBtn('Custom').click());
      // Slot 1 (player 2) shows Hard's first opponent, ready to tweak.
      expect(slotSelect(2).value).toBe('ai_conqueror');
      expect(slotSelect(3).value).toBe('ai_blitz');
    });

    it('sends hand-edited lineups as custom difficulty', () => {
      const { onStart } = renderTitle();
      act(() => modeBtn('Custom').click());
      chooseBot(2, 'ai_lookahead');
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ difficulty: 'custom' }));
      expect(onStart.mock.calls[0][0].aiAssignments[1]).toBe('ai_lookahead');
    });

    it('threads difficulty through the AI-vs-AI path too', () => {
      const { onStart } = renderTitle();
      act(() => modeBtn('Hard').click());
      act(() => aiBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ difficulty: 'hard', spectator: true })
      );
    });
  });

  describe('color-blind mode', () => {
    const cbStore = () => createGameStore({ preferences: { colorBlindMode: true } });

    it('labels slots with the Wong palette names when color-blind mode is on', () => {
      renderTitle({ store: cbStore() });
      act(() => modeBtn('Custom').click());
      // index 0 → 'Blue' (Wong) instead of 'Lavender' (default).
      expect(container.textContent).toContain('Blue');
      expect(container.textContent).not.toContain('Lavender');
    });

    it('keys the slot dropdown aria-label off the color-blind color name', () => {
      renderTitle({ store: cbStore() });
      act(() => modeBtn('Custom').click());
      // index 2 → 'Teal' (Wong) instead of 'Green' (default).
      expect(container.querySelector('select[aria-label="Bot for Teal player"]')).toBeTruthy();
      expect(container.querySelector('select[aria-label="Bot for Green player"]')).toBeNull();
    });

    it('paints the swatches from the Wong palette in color-blind mode', () => {
      renderTitle({ store: cbStore() });
      act(() => modeBtn('Custom').click());
      expect(slotSwatches()[0].style.background).toBe(cssHexToRgb(COLORBLIND_PLAYER_COLORS_CSS[0]));
    });

    it('updates slot labels reactively when color-blind mode is toggled', () => {
      const { store } = renderTitle();
      act(() => modeBtn('Custom').click());
      // Default palette initially: slot 2 is 'Green'.
      expect(container.querySelector('select[aria-label="Bot for Green player"]')).toBeTruthy();
      // Flip the preference; the panel re-renders from the store subscription.
      act(() =>
        store.setState({ preferences: { ...store.getState().preferences, colorBlindMode: true } })
      );
      expect(container.querySelector('select[aria-label="Bot for Teal player"]')).toBeTruthy();
      expect(container.querySelector('select[aria-label="Bot for Green player"]')).toBeNull();
    });
  });
});

describe('player color palettes', () => {
  it('keeps the color-name arrays index-aligned with their palettes', () => {
    expect(PLAYER_COLOR_NAMES).toHaveLength(PLAYER_COLORS_CSS.length);
    expect(COLORBLIND_PLAYER_COLOR_NAMES).toHaveLength(COLORBLIND_PLAYER_COLORS_CSS.length);
  });
});
