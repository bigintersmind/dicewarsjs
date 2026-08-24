// @vitest-environment jsdom
/**
 * TitleScreen tests
 *
 * Covers the pre-game setup controls: player-count and the new map-size preset
 * selector, the difficulty-mode row (#167, including preset lineups deriving
 * correctly from a truncated store), plus that both START and AI-vs-AI thread
 * the choices into onStart; and the landing page's hierarchy (#182): START the
 * one filled control, the happy-path caption, and the footer link row that
 * took over from the mode rail on this screen; and the luck axis (#179), which
 * lives inside the Custom panel — presets always mean fair dice.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { TitleScreen } from '../../src/ui/TitleScreen.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { DIFFICULTY_MODES, lineupForMode } from '../../src/ai/difficultyModes.js';
import { LUCK_LEVELS, DEFAULT_LUCK } from '../../src/utils/config.js';
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
const luckBtn = name => container.querySelector(`button[aria-label="Luck: ${name}"]`);
const luckGroup = () => container.querySelector('[role="group"][aria-label="Your luck"]');
/** The luck row lives inside the Custom panel: open it before querying the rungs. */
const openCustom = () => act(() => modeBtn('Custom').click());
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

  describe('seeding from the persisted config (#180)', () => {
    it('restores the player count and map size the player last chose', () => {
      // What the store holds after a START that was backed out of on the map preview.
      const store = createGameStore({
        config: {
          playerCount: 4,
          mapSize: 'large',
          difficulty: 'standard',
          aiAssignments: [null, ...Array(3).fill('ai_default')],
        },
      });
      const { onStart } = renderTitle({ store });

      expect(playerBtn(4).getAttribute('aria-pressed')).toBe('true');
      expect(playerBtn(7).getAttribute('aria-pressed')).toBe('false');
      expect(sizeBtn('Large').getAttribute('aria-pressed')).toBe('true');
      expect(sizeBtn('Medium').getAttribute('aria-pressed')).toBe('false');

      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ playerCount: 4, mapSize: 'large' })
      );
    });

    it('keeps the first-launch defaults when the config carries neither', () => {
      const store = createGameStore({ config: {} });
      const { onStart } = renderTitle({ store });

      expect(playerBtn(7).getAttribute('aria-pressed')).toBe('true');
      expect(sizeBtn('Medium').getAttribute('aria-pressed')).toBe('true');

      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ playerCount: 7, mapSize: 'medium' })
      );
    });
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
        expect.objectContaining({
          difficulty: 'hard',
          spectator: true,
          // Slot 0 stays null even as a spectator — the controller fills it.
          aiAssignments: lineupForMode('hard', 7),
        })
      );
    });

    it('sends the full 8-slot Hard lineup for an 8-player game', () => {
      // Guards the playerCount → lineupForMode wiring: a stale 7-slot lineup
      // here would give player 7 a null slot — a phantom second human.
      const { onStart } = renderTitle();
      act(() => playerBtn(8).click());
      act(() => modeBtn('Hard').click());
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          difficulty: 'hard',
          aiAssignments: lineupForMode('hard', 8),
        })
      );
    });

    it('slices a preset down to a 2-player game (Easy → its gentlest opponent)', () => {
      const { onStart } = renderTitle();
      act(() => playerBtn(2).click());
      act(() => modeBtn('Easy').click());
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ difficulty: 'easy', aiAssignments: [null, 'ai_example'] })
      );
    });

    it('discards hand edits when a preset is clicked (Custom → edit → Easy → Custom)', () => {
      renderTitle();
      act(() => modeBtn('Custom').click());
      chooseBot(2, 'ai_lookahead');
      act(() => modeBtn('Easy').click());
      act(() => modeBtn('Custom').click());
      // Re-entering Custom seeds from the pressed preset, not the stale edit.
      expect(slotSelect(2).value).toBe('ai_example');
    });

    it('derives a preset lineup even when the store holds a truncated one (#167)', () => {
      // A finished 3-player game persists a 3-slot lineup; a fresh 7-player
      // START on the still-pressed preset must send the full preset slice,
      // not the truncated array padded with defaults under the same label.
      const store = createGameStore({
        config: {
          playerCount: 3,
          mapSize: 'medium',
          difficulty: 'hard',
          aiAssignments: [null, 'ai_conqueror', 'ai_blitz'],
        },
      });
      const { onStart } = renderTitle({ store });
      expect(modeBtn('Hard').getAttribute('aria-pressed')).toBe('true');
      // The count now seeds from the store (#180), so bump it back up by hand.
      act(() => playerBtn(7).click());
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          difficulty: 'hard',
          aiAssignments: lineupForMode('hard', 7),
        })
      );
    });

    it("mounts with the per-slot panel open when the store persisted difficulty 'custom'", () => {
      const store = createGameStore({
        config: {
          playerCount: 7,
          mapSize: 'medium',
          difficulty: 'custom',
          aiAssignments: [null, 'ai_conqueror', 'ai_blitz'],
        },
      });
      renderTitle({ store });
      expect(modeBtn('Custom').getAttribute('aria-pressed')).toBe('true');
      expect(slotSelect(2)).not.toBeNull();
    });

    it('pads Custom slots beyond a truncated store lineup with ai_default', () => {
      // A previous 3-player Custom game persisted a 3-slot lineup; a fresh
      // 7-player START in Custom must pad the unseeded slots, never send
      // undefined entries (each would read as another human seat).
      const store = createGameStore({
        config: {
          playerCount: 3,
          mapSize: 'medium',
          difficulty: 'custom',
          aiAssignments: [null, 'ai_conqueror', 'ai_blitz'],
        },
      });
      const { onStart } = renderTitle({ store });
      // The count now seeds from the store (#180), so bump it back up by hand.
      act(() => playerBtn(7).click());
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          difficulty: 'custom',
          aiAssignments: [null, 'ai_conqueror', 'ai_blitz', ...Array(4).fill('ai_default')],
        })
      );
    });
  });

  describe('your luck (#179)', () => {
    // Presets always mean fair dice, so the rung is only offered under Custom.
    it('is absent for every preset and appears inside the Custom panel', () => {
      renderTitle();
      Object.values(DIFFICULTY_MODES).forEach(mode => {
        act(() => modeBtn(mode.name).click());
        expect(luckGroup()).toBeNull();
      });

      openCustom();
      expect(luckGroup()).not.toBeNull();
      // Inside the panel box alongside the per-slot picker — but NOT inside
      // the picker's scrolling list, or at 6+ players the row would sit past
      // the fold of a 30vh box with nothing to say it's there. The scroller is
      // the innermost ancestor of a slot select with an overflow-y rule (the
      // page container scrolls too).
      const scroller = [...container.querySelectorAll('div')]
        .filter(div => div.style.overflowY === 'auto' && div.contains(slotSelect(2)))
        .at(-1);
      expect(scroller).toBeTruthy();
      expect(scroller.contains(luckGroup())).toBe(false);
      expect(scroller.parentElement.contains(luckGroup())).toBe(true);
      expect(scroller.parentElement.classList.contains('dw-panel')).toBe(false);
      // ...and labelled by the same eyebrow idiom as the other option rows.
      const eyebrow = luckGroup().previousElementSibling;
      expect(eyebrow.textContent).toBe('Your luck');
      expect(eyebrow.classList.contains('dw-eyebrow')).toBe(true);
    });

    // Derived from the ladder, so a new rung is covered without editing this test.
    it('renders every rung on the ladder, with exactly one pressed', () => {
      renderTitle();
      openCustom();
      const buttons = LUCK_LEVELS.map(level => luckBtn(level.name));
      expect(buttons.every(Boolean)).toBe(true);
      expect(buttons.filter(b => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
      // ...and on first launch it is the default rung.
      const pressed = LUCK_LEVELS.find(
        level => luckBtn(level.name).getAttribute('aria-pressed') === 'true'
      );
      expect(pressed.id).toBe(DEFAULT_LUCK);
    });

    it("shows the selected rung's explanation, and swaps it on selection", () => {
      renderTitle();
      openCustom();
      const blurbOf = id => LUCK_LEVELS.find(level => level.id === id).blurb;

      expect(container.textContent).toContain(blurbOf(0));
      expect(container.textContent).not.toContain(blurbOf(1));

      act(() => luckBtn('Lucky').click());

      expect(luckBtn('Lucky').getAttribute('aria-pressed')).toBe('true');
      expect(luckBtn('Normal').getAttribute('aria-pressed')).toBe('false');
      // Visible copy, not a hover-only title: a touch device has no hover.
      expect(container.textContent).toContain(blurbOf(1));
      expect(container.textContent).not.toContain(blurbOf(0));
    });

    it('describes the row for screen readers via the caption', () => {
      renderTitle();
      openCustom();
      const group = luckGroup();
      const describedBy = group.getAttribute('aria-describedby');
      expect(container.querySelector(`#${describedBy}`).textContent).toBe(
        LUCK_LEVELS.find(level => level.id === 0).blurb
      );
    });

    it('threads the default (Normal) rung into onStart for a preset', () => {
      const { onStart } = renderTitle();
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ luck: 0 }));
    });

    it('threads the chosen rung into onStart via START', () => {
      const { onStart } = renderTitle();
      openCustom();
      act(() => luckBtn('Very lucky').click());
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({ luck: 2, difficulty: 'custom', spectator: false })
      );
    });

    it('threads the chosen rung through the AI-vs-AI (spectator) path too', () => {
      // The controller drops the handicap for a spectator game; the payload
      // still carries the rung so the store remembers the player's choice.
      const { onStart } = renderTitle();
      openCustom();
      act(() => luckBtn('Lucky').click());
      act(() => aiBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ luck: 1, spectator: true }));
    });

    /*
     * A preset's label has to be the whole truth about the game it starts: a
     * rung picked under Custom must not ride along invisibly into Hard. So a
     * preset click resets it, exactly as it replaces the hand-edited lineup —
     * and coming back to Custom starts from Normal, not the stale rung.
     */
    it('resets to Normal when a preset is picked, and stays reset on return to Custom', () => {
      const { onStart } = renderTitle();
      openCustom();
      act(() => luckBtn('Very lucky').click());

      act(() => modeBtn('Hard').click());
      expect(luckGroup()).toBeNull();
      act(() => startBtn().click());
      expect(onStart).toHaveBeenLastCalledWith(
        expect.objectContaining({ luck: 0, difficulty: 'hard' })
      );

      openCustom();
      expect(luckBtn('Normal').getAttribute('aria-pressed')).toBe('true');
      expect(luckBtn('Very lucky').getAttribute('aria-pressed')).toBe('false');
    });

    it('re-clicking Custom keeps the chosen rung — only a preset resets it', () => {
      renderTitle();
      openCustom();
      act(() => luckBtn('Lucky').click());
      openCustom();
      expect(luckBtn('Lucky').getAttribute('aria-pressed')).toBe('true');
    });

    it('picking a rung leaves the lineup axis alone', () => {
      const { onStart } = renderTitle();
      openCustom();
      chooseBot(2, 'ai_lookahead');
      act(() => luckBtn('Very lucky').click());

      expect(modeBtn('Custom').getAttribute('aria-pressed')).toBe('true');
      expect(slotSelect(2).value).toBe('ai_lookahead');
      act(() => startBtn().click());
      const payload = onStart.mock.calls[0][0];
      expect(payload).toMatchObject({ luck: 2, difficulty: 'custom' });
      expect(payload.aiAssignments[1]).toBe('ai_lookahead');
    });

    it('seeds the rung from a persisted Custom config (#180 round-trip)', () => {
      const store = createGameStore({
        config: { playerCount: 4, mapSize: 'medium', difficulty: 'custom', luck: 2 },
      });
      const { onStart } = renderTitle({ store });

      // Custom is already open, with the rung pressed.
      expect(luckBtn('Very lucky').getAttribute('aria-pressed')).toBe('true');
      expect(luckBtn('Normal').getAttribute('aria-pressed')).toBe('false');

      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ luck: 2 }));
    });

    /*
     * A stored rung under a preset has no row to show it (only Custom renders
     * one), so honouring it would start a handicapped game behind a label that
     * promises fair dice. It is dropped, not carried.
     */
    it('ignores a persisted rung when the persisted difficulty is a preset, naming it', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createGameStore({
        config: { playerCount: 4, mapSize: 'medium', difficulty: 'hard', luck: 2 },
      });
      const { onStart } = renderTitle({ store });
      expect(luckGroup()).toBeNull();
      // The controller never stores that pair, so a drop means some new writer
      // of config.luck forgot the rule — say so, like the off-ladder case.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/2.*"hard"/));

      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ luck: 0 }));

      openCustom();
      expect(luckBtn('Normal').getAttribute('aria-pressed')).toBe('true');
      warnSpy.mockRestore();
    });

    // A stored Normal under a preset is the ordinary case — nothing to report.
    it('does not warn about a persisted Normal rung under a preset', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      renderTitle({ store: createGameStore({ config: { difficulty: 'hard', luck: 0 } }) });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    /*
     * The presets hide the row, so a one-line hint under Difficulty is the only
     * thing on the page that says luck exists — and, because it is always
     * mounted and its text swaps, the only live region still standing when a
     * preset click unmounts the luck row's own.
     */
    it('says where luck lives under the Difficulty row, swapping with the mode', () => {
      renderTitle();
      const hint = container.querySelector('#dw-mode-hint');
      expect(hint.getAttribute('aria-live')).toBe('polite');
      expect(
        container
          .querySelector('[role="group"][aria-label="Difficulty"]')
          .getAttribute('aria-describedby')
      ).toBe('dw-mode-hint');
      expect(hint.textContent).toMatch(/fair dice/i);
      expect(hint.textContent).toMatch(/Custom/);

      openCustom();
      expect(container.querySelector('#dw-mode-hint')).toBe(hint);
      expect(hint.textContent).toMatch(/luck below/i);

      act(() => modeBtn('Hard').click());
      expect(container.querySelector('#dw-mode-hint')).toBe(hint);
      expect(hint.textContent).toMatch(/fair dice/i);
    });

    it('falls back to Normal when the config carries no rung', () => {
      const { onStart } = renderTitle({ store: createGameStore({ config: {} }) });
      openCustom();
      expect(luckBtn('Normal').getAttribute('aria-pressed')).toBe('true');
      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ luck: 0 }));
    });

    /*
     * A stored rung that is no longer on the ladder would render a row with
     * nothing pressed and no blurb, and START would hand the controller a value
     * luckToHandicap throws on. Fall back to Normal, and say which value was
     * discarded — a stale rung is a bug worth seeing.
     */
    it('discards an off-ladder stored rung, naming it', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { onStart } = renderTitle({
        store: createGameStore({ config: { difficulty: 'custom', luck: 5 } }),
      });

      expect(luckBtn('Normal').getAttribute('aria-pressed')).toBe('true');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('5'));

      act(() => startBtn().click());
      expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ luck: DEFAULT_LUCK }));
      warnSpy.mockRestore();
    });

    /*
     * Reading/tab order inside the panel: the per-slot picker first (who
     * plays), then the luck row (how the dice roll), and START after the
     * panel closes.
     */
    it('sits after the last slot row in the Custom panel, before START', () => {
      renderTitle();
      openCustom();

      const lastSlot = slotSelect(7);
      expect(lastSlot).not.toBeNull();

      const follows = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(follows(lastSlot, luckGroup())).toBeTruthy();
      expect(follows(luckGroup(), startBtn())).toBeTruthy();
    });

    // The group's aria-describedby is only announced on entry; the live region
    // is what speaks the new meaning when the rung changes under the cursor.
    it('announces the blurb change politely', () => {
      renderTitle();
      openCustom();
      expect(container.querySelector('#dw-luck-blurb').getAttribute('aria-live')).toBe('polite');
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

  /*
   * -----------------------------------------------------------------------
   * Landing-page hierarchy (#182)
   * -----------------------------------------------------------------------
   */

  describe('happy-path hierarchy (#182)', () => {
    const footerNav = () => container.querySelector('nav[aria-label="More game modes"]');
    const footLinks = () => [...container.querySelectorAll('.dw-footlink')];

    it('makes START the only filled button — AI vs AI is a bare text link beside it', () => {
      renderTitle();
      const filled = [...container.querySelectorAll('.dw-btn')];
      expect(filled.map(b => b.textContent)).toEqual(['START']);
      expect(aiBtn().classList.contains('dw-opt')).toBe(true);
      expect(aiBtn().classList.contains('dw-btn')).toBe(false);
      // Still a real button in the same row: it shares START's parent.
      expect(aiBtn().parentElement).toBe(startBtn().parentElement);
    });

    // The bare label doesn't say what the link does; the aria-label spells it
    // out and opens with the visible text, so label-in-name (WCAG 2.5.3) holds.
    it('spells out AI vs AI in an aria-label that starts with the visible text', () => {
      renderTitle();
      expect(aiBtn().getAttribute('aria-label')).toMatch(/^AI vs AI/);
    });

    // Selected by class, not by position: `.dw-hint` is the hook the ≤760px
    // rule centers the caption with, so pinning it keeps that rule wired up.
    it('names the happy path in one caption right above the START row', () => {
      renderTitle();
      const caption = container.querySelector('.dw-hint');
      expect(caption.textContent).toBe('Pick your players, map and difficulty, then START.');
      expect(
        caption.compareDocumentPosition(startBtn()) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('labels the player-count group with an eyebrow like map size and difficulty', () => {
      renderTitle();
      const groupLabel = label => container.querySelector(`[role="group"][aria-label="${label}"]`);
      ['Players', 'Map size', 'Difficulty'].forEach(label => {
        const prev = groupLabel(label).previousElementSibling;
        expect(prev.textContent).toBe(label);
        // Same reason as the caption: `.dw-eyebrow` feeds the ≤760px centering rule.
        expect(prev.classList.contains('dw-eyebrow')).toBe(true);
      });
    });

    it('offers Arena, Tournament and Leaderboard in a footer row, in rail order', () => {
      renderTitle({ onNavigate: vi.fn() });
      expect(footerNav()).toBeTruthy();
      expect(footLinks().map(b => b.textContent)).toEqual(['Arena', 'Tournament', 'Leaderboard']);
    });

    it('routes footer taps through onNavigate with the screen id', () => {
      const onNavigate = vi.fn();
      renderTitle({ onNavigate });
      footLinks().forEach(link => act(() => link.click()));
      expect(onNavigate.mock.calls.map(c => c[0])).toEqual([
        'arena',
        'tournament',
        'onlineLeaderboard',
      ]);
    });

    // The scan path IS the tab path: every setup control and START come
    // before the bot-author screens, which sit in the page footer.
    it('places the footer row after START, in the page footer', () => {
      renderTitle({ onNavigate: vi.fn() });
      const first = footLinks()[0];
      expect(
        startBtn().compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        aiBtn().compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(footerNav().closest('footer')).toBeTruthy();
    });

    // The link row is the footer's only content, so without it there is no
    // (empty) footer landmark either.
    it('leaves the footer out of an isolated render with no onNavigate', () => {
      renderTitle();
      expect(footerNav()).toBeNull();
      expect(container.querySelector('footer')).toBeNull();
    });

    // The original game's copyright line (and the repo link that rode it,
    // #183) is gone from the landing page: the source is credited in the
    // repository and the settings panel carries the "Source on GitHub" link,
    // so the footer ends on the link row alone.
    it('carries no copyright line or outbound links in the footer', () => {
      renderTitle({ onNavigate: vi.fn() });
      expect(container.textContent).not.toMatch(/Copyright|GAMEDESIGN/);
      expect(container.querySelector('footer a')).toBeNull();
      expect(container.querySelectorAll('a')).toHaveLength(0);
    });
  });

  /*
   * "How to play": the rules reference reachable from the landing page. Same
   * bare-text weight as AI vs AI — playtesters need the rules more than the bot
   * show, but neither may take the eye off START, the page's one filled control.
   */
  describe('how to play link', () => {
    const rulesBtn = () =>
      container.querySelector('button[aria-label="How to play \u2014 the rules in one card"]');

    it('reports its clicks and starts nothing', () => {
      const onRules = vi.fn();
      const { onStart } = renderTitle({ onRules });

      const button = rulesBtn();
      expect(button.textContent.trim()).toBe('HOW TO PLAY');
      expect(button.className).toBe('dw-opt');
      // Opens with the visible text, so label-in-name (WCAG 2.5.3) holds.
      expect(button.getAttribute('aria-label')).toMatch(/^How to play/);
      expect(button.parentElement).toBe(startBtn().parentElement);

      act(() => button.click());
      expect(onRules).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
    });

    it('leaves START the only filled control', () => {
      renderTitle({ onRules: vi.fn() });
      expect([...container.querySelectorAll('.dw-btn')].map(b => b.textContent)).toEqual(['START']);
    });

    it('is left out of an isolated render with no onRules', () => {
      renderTitle();
      expect(rulesBtn()).toBeNull();
    });
  });

  /*
   * #189: every route back to the title unmounts the control the player just
   * activated (map preview's BACK, game over's BATTLE, quit-to-title, the
   * rail's Battle tab), so this screen has to pick focus back up or it drops
   * to <body>.
   */
  describe('route-change focus (#189)', () => {
    it('moves focus onto START when it mounts', () => {
      renderTitle();
      expect(document.activeElement).toBe(startBtn());
    });

    // Mount only: setup happens entirely inside a mounted TitleScreen, so a
    // preset click must not yank focus off the control the player is using.
    it('leaves focus alone once the player is choosing a setup', () => {
      renderTitle();
      const easy = modeBtn('Easy');
      easy.focus();
      expect(document.activeElement).toBe(easy);

      act(() => easy.click());
      expect(document.activeElement).not.toBe(startBtn());
      expect(document.activeElement).toBe(modeBtn('Easy'));
    });
  });
});

describe('player color palettes', () => {
  it('keeps the color-name arrays index-aligned with their palettes', () => {
    expect(PLAYER_COLOR_NAMES).toHaveLength(PLAYER_COLORS_CSS.length);
    expect(COLORBLIND_PLAYER_COLOR_NAMES).toHaveLength(COLORBLIND_PLAYER_COLORS_CSS.length);
  });
});
