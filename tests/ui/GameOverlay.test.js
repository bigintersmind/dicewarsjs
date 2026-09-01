// @vitest-environment jsdom
/**
 * GameOverlay tests
 *
 * Covers the "is thinking..." line shown over the board on an AI turn: it names
 * the opponent by its bot ("Conqueror is thinking..."), so each rival has an
 * identity rather than a seat number, with the seat's color beside the name as a
 * swatch — the color is what tells two seats running the same bot apart, but it
 * never sets the words themselves (#220), which on the light theme's board left
 * a pastel seat unreadable.
 *
 * Also the two things the END TURN button owns here: its own focus-ring class
 * (the shared one's accent is this button's background) and the
 * `aria-keyshortcuts="E"` that announces the shortcut past the tab walk.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameOverlay } from '../../src/ui/GameOverlay.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../../src/renderer/constants.js';
import { THEMES } from '../../src/renderer/themes.js';
import { contrast, surface, WCAG } from '../helpers/contrast.js';

let container;

function makeGameState(overrides = {}) {
  return {
    phase: 'playing',
    turnOrder: [0, 1, 2],
    currentPlayerIndex: 1,
    winner: null,
    players: [
      { id: 0, territoryCount: 5, eliminated: false },
      { id: 1, territoryCount: 3, eliminated: false },
      { id: 2, territoryCount: 4, eliminated: false },
    ],
    ...overrides,
  };
}

function renderOverlay(stateOverrides = {}, { onEndTurn = vi.fn() } = {}) {
  const store = createGameStore({
    screen: 'playing',
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: null,
    playerNames: ['You', 'Conqueror', 'Conqueror'],
    ...stateOverrides,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(GameOverlay, { store, onEndTurn }), container);
  });
  return { store, onEndTurn };
}

/** The thinking line, located by its text so another <p> can't be mistaken for it. */
const thinkingLine = () =>
  [...container.querySelectorAll('p')].find(p => p.textContent.includes('is thinking'));
/** The seat swatch in front of the name — the only aria-hidden span in the line. */
const seatSwatch = () => thinkingLine().querySelector('span[aria-hidden="true"]');
/** The name span inside the thinking line (the swatch is its aria-hidden sibling). */
const nameSpan = () =>
  [...thinkingLine().querySelectorAll('span')].find(el => !el.hasAttribute('aria-hidden'));
const endTurnButton = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'END TURN');

/** jsdom normalizes hex colors to rgb(); compare against the same normalization. */
function cssColor(hex) {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
}

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('GameOverlay — AI thinking line', () => {
  it('names the current bot rather than its seat number', () => {
    renderOverlay();
    expect(container.textContent).toContain('Conqueror is thinking...');
    expect(container.textContent).not.toContain('Player 2');
  });

  it('marks the seat with a swatch and sets the name in the text color', () => {
    renderOverlay({ gameState: makeGameState({ currentPlayerIndex: 2 }) });
    // Seats 1 and 2 both run Conqueror; only the swatch says which one is up.
    expect(nameSpan().textContent).toBe('Conqueror');
    expect(seatSwatch().style.background).toBe(cssColor(PLAYER_COLORS_CSS[2]));
    expect(nameSpan().style.color).toBe('var(--ui-text)');
  });

  // Real games shuffle turnOrder, so the seat whose turn it is (turnOrder[currentPlayerIndex])
  // is not the turn slot. Names are indexed by seat: an identity-order fixture could not tell
  // the two apart, and the wrong index would show one bot's name in another seat's color.
  it('names the seat whose turn it is, not the turn slot', () => {
    renderOverlay({
      gameState: makeGameState({ turnOrder: [2, 0, 1], currentPlayerIndex: 0 }),
      playerNames: ['You', 'Blitz', 'Conqueror'],
    });
    expect(container.textContent).toContain('Conqueror is thinking...');
    expect(container.textContent).not.toContain('Blitz');
    // Name and swatch agree on the seat.
    expect(seatSwatch().style.background).toBe(cssColor(PLAYER_COLORS_CSS[2]));
  });

  it('uses the color-blind palette for the swatch when that preference is on', () => {
    renderOverlay({
      preferences: { colorBlindMode: true },
      gameState: makeGameState({ currentPlayerIndex: 1 }),
    });
    expect(seatSwatch().style.background).toBe(cssColor(COLORBLIND_PLAYER_COLORS_CSS[1]));
  });

  it('falls back to the seat number when no player names are recorded', () => {
    renderOverlay({ playerNames: [] });
    expect(container.textContent).toContain('Player 2 is thinking...');
  });

  it('shows no thinking line on the human turn', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(container.textContent).not.toContain('is thinking');
  });

  it('shows no thinking line in spectator mode', () => {
    renderOverlay({ humanPlayerIndex: null });
    expect(container.textContent).not.toContain('is thinking');
  });
});

describe('GameOverlay — seat color never carries glyphs (#220)', () => {
  /*
   * The rule this line now follows: words in the theme's ink, seat identity in
   * a swatch beside them. Walk everything rendered rather than the name span
   * alone, so a future line that reaches for a seat color as text is caught
   * here too.
   */
  it.each([
    ['default', PLAYER_COLORS_CSS, {}],
    ['color-blind', COLORBLIND_PLAYER_COLORS_CSS, { colorBlindMode: true }],
  ])('sets no text in a %s palette color', (_label, palette, preferences) => {
    renderOverlay({ preferences, gameState: makeGameState({ currentPlayerIndex: 1 }) });
    // The walk is vacuous on an empty container (GameOverlay renders null with
    // no gameState), so pin that the line under test is actually up.
    expect(seatSwatch()).toBeTruthy();
    const seatColors = palette.map(cssColor);
    for (const el of container.querySelectorAll('*')) {
      expect(seatColors).not.toContain(el.style.color);
    }
  });

  /*
   * The line floats on the live board with no panel behind it, so it carries
   * the ink rim instead — the same portable backing the menu text uses.
   */
  it('carries the ink rim, since nothing is drawn behind it', () => {
    renderOverlay();
    expect(thinkingLine().style.textShadow).toBe('var(--ui-text-halo)');
  });

  /*
   * No opaque surface backs this line: the overlay paints no panel, and
   * `playing` is not an attract screen, so there is no scrim under it either —
   * it sits directly on whatever territory drifts beneath. What actually
   * carries it is the ink rim the halo paints (composeTextHalo(uiInk,
   * uiInkSoft)), so that is the surface to measure: the theme's ink flattened
   * onto each seat color in turn, both palettes, both of the line's inks — the
   * name in `--ui-text`, "is thinking..." in the muted one.
   */
  it.each(['dark', 'light'])('the %s ink rim carries the line over any seat color', name => {
    const theme = THEMES[name];
    for (const palette of [PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS]) {
      for (const seat of palette) {
        const rim = surface(seat, theme.uiInk); // the halo's ink, over the territory beneath
        expect(contrast(theme.uiText, rim)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
        expect(contrast(theme.uiTextMuted, rim)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
      }
    }
  });
});

describe('GameOverlay — human turn', () => {
  it('shows the attack-from prompt and an END TURN button that reports clicks', () => {
    const { onEndTurn } = renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(container.textContent).toContain('Click your territory to attack from');
    expect(endTurnButton()).toBeTruthy();
    act(() => endTurnButton().click());
    expect(onEndTurn).toHaveBeenCalledTimes(1);
  });

  it('shows the attack-target prompt once a territory is selected', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectTo',
    });
    expect(container.textContent).toContain('Click a neighbor to attack');
    expect(container.textContent).not.toContain('attack from');
  });

  /*
   * Where a keyboard player lands off the end of the board (#201, #211), so it
   * has to show a focus ring — and it cannot use the shared .dw-btn one, whose
   * accent color is this button's own background. E is the shortcut past that
   * walk; the title advertises it the way QUIT advertises Esc, and
   * aria-keyshortcuts says the same thing to a screen reader.
   */
  it('advertises the E shortcut and carries its own focus-ring class', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(endTurnButton().getAttribute('title')).toContain('(E)');
    expect(endTurnButton().getAttribute('aria-keyshortcuts')).toBe('E');
    expect(endTurnButton().className).toContain('dw-end-turn');
  });

  it('offers no END TURN button on an AI turn', () => {
    renderOverlay();
    expect(endTurnButton()).toBeUndefined();
  });
});

describe('GameOverlay — theme-blind literals (#220)', () => {
  /*
   * The instruction line floats on the live board, with whatever territory
   * happens to be under it, so it carries its own backing. That backing has to
   * flip with the theme: the fixed `rgba(0,0,0,0.8)` it used to carry was a
   * smudge under the light theme's navy text.
   */
  it('backs the instruction line with the ink-rim halo', () => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    const line = [...container.querySelectorAll('p')].find(p =>
      p.textContent.includes('attack from')
    );
    expect(line.style.textShadow).toBe('var(--ui-text-halo)');
  });

  /*
   * END TURN's white ink is the one literal this file keeps: the button is
   * filled with the accent in both themes, and white is what reads on both.
   * The pair the button actually carries is read off the rendered element, so
   * this measures the button rather than restating a palette fact — a fill
   * moved onto a token with a different value would no longer be covered by
   * the number below. 1.3rem Anton is ~21px bold, so WCAG's large-text bar
   * applies, and a future accent that darkens under white fails here.
   */
  it.each(['dark', 'light'])('keeps white END TURN ink over the %s accent', name => {
    renderOverlay({
      gameState: makeGameState({ currentPlayerIndex: 0 }),
      awaitingInput: 'selectFrom',
    });
    expect(endTurnButton().style.background).toBe('var(--ui-accent)');
    expect(endTurnButton().style.color).toBe(cssColor('#ffffff'));
    expect(contrast('#ffffff', THEMES[name].uiAccent)).toBeGreaterThanOrEqual(WCAG.AA_LARGE);
  });
});
