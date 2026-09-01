// @vitest-environment jsdom
/**
 * GameHUD tests
 *
 * Covers the player-status bar and the QUIT control it carries during play
 * (#181) — present only when App supplies a handler, and never dressed as a
 * primary action.
 *
 * Plus the phone layout (#222) and the height contract behind it. jsdom does no
 * layout and evaluates no media query, so the two-row bar itself is not
 * observable here; what IS pinned is the stylesheet that produces it — that it
 * is mounted, that the height it declares is HUD_BAR_HEIGHT and not a second
 * copy of 50 free to drift from it, and that the three rules the layout stands
 * on (the twins hidden, the height redeclared, the touch override doubled up)
 * are inside the media blocks they belong to. The measurements themselves are
 * the manual pass in docs/TESTING.md.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameHUD, HUD_CSS } from '../../src/ui/GameHUD.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { THEMES } from '../../src/renderer/themes.js';
import { HUD_BAR_HEIGHT } from '../../src/renderer/constants.js';
import { contrast, surface, WCAG } from '../helpers/contrast.js';

let container;

function makeGameState() {
  return {
    turnOrder: [0, 1, 2],
    currentPlayerIndex: 0,
    players: [
      { id: 0, territoryCount: 5, stock: 2, eliminated: false },
      { id: 1, territoryCount: 3, stock: 0, eliminated: false },
      { id: 2, territoryCount: 0, stock: 0, eliminated: true },
    ],
  };
}

function renderHUD({ onQuit, onRules, gameState = makeGameState() } = {}) {
  const store = createGameStore({ screen: 'playing', gameState });

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(GameHUD, { store, onQuit, onRules }), container);
  });

  return { store };
}

const quitBtn = () => container.querySelector('button[aria-label="Quit to title"]');
const rulesBtn = () => container.querySelector('button[aria-label="Rules: how to play"]');
/** The hidden width-matched twins that keep the chips optically centered. */
const twins = () => [...container.querySelectorAll('span[aria-hidden="true"]')];
const quitTwin = () => twins().find(el => el.textContent.trim() === 'QUIT');
/** The chips row — the only <div> child of the HUD bar. */
const playersRow = () => Array.from(container.firstChild.children).find(el => el.tagName === 'DIV');

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('GameHUD', () => {
  it('shows one chip per surviving player', () => {
    renderHUD();
    expect(container.textContent).toContain('5');
    expect(container.textContent).toContain('+2');
    // The eliminated player is dropped from the bar.
    expect(playersRow().children.length).toBe(2);
  });

  it('renders no QUIT control without a handler (game over keeps its own way out)', () => {
    renderHUD();
    expect(quitBtn()).toBeNull();
    // No button, no twin — nothing to balance, and the chips stay centered.
    expect(quitTwin()).toBeUndefined();
    expect(twins()).toHaveLength(0);
  });

  it('renders QUIT as a muted text control and reports clicks', () => {
    const onQuit = vi.fn();
    renderHUD({ onQuit });

    const button = quitBtn();
    expect(button).toBeTruthy();
    expect(button.textContent.trim()).toBe('QUIT');
    // .dw-opt is the bare-text idiom; .dw-btn would make it a primary action.
    // .dw-hud-opt rides along so the touch override can outrank it (#222).
    expect(button.classList.contains('dw-opt')).toBe(true);
    expect(button.classList.contains('dw-hud-opt')).toBe(true);

    // Same text in the same classes on the other side, so the two ends of the
    // bar measure the same and the chips sit centered rather than pushed right.
    const twin = quitTwin();
    expect(twin).toBeTruthy();
    expect(twin.textContent.trim()).toBe('QUIT');
    expect(twin.classList.contains('dw-opt')).toBe(true);

    act(() => button.click());
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it('renders RULES as a muted text control and reports clicks', () => {
    const onRules = vi.fn();
    renderHUD({ onRules });

    const button = rulesBtn();
    expect(button).toBeTruthy();
    expect(button.textContent.trim()).toBe('RULES');
    // Bare text like QUIT: the way through the game (END TURN) stays the button.
    expect(button.classList.contains('dw-opt')).toBe(true);
    expect(button.classList.contains('dw-hud-opt')).toBe(true);

    act(() => button.click());
    expect(onRules).toHaveBeenCalledTimes(1);
  });

  it('renders no RULES control without a handler', () => {
    renderHUD({ onQuit: vi.fn() });
    expect(rulesBtn()).toBeNull();
  });

  /*
   * On anything wider than a phone the bar is one row that must not wrap, so
   * both ends have to measure the same or the chips drift off centre: every
   * left-hand control gets a hidden twin on the right, mirrored (the twins run
   * in reverse order). Under the breakpoint the chips have the whole width and
   * the twins are hidden by CSS instead — they stay in the DOM, so this
   * mirroring is what the desktop layout is still built out of.
   */
  it('mirrors both controls with hidden twins so the chips stay centered', () => {
    renderHUD({ onQuit: vi.fn(), onRules: vi.fn() });

    expect(twins().map(s => s.textContent.trim())).toEqual(['RULES', 'QUIT']);
    for (const twin of twins()) {
      expect(twin.classList.contains('dw-opt')).toBe(true);
      expect(twin.classList.contains('dw-hud-twin')).toBe(true);
      expect(twin.style.visibility).toBe('hidden');
    }
  });

  it('renders nothing without a game state', () => {
    renderHUD({ gameState: null });
    expect(container.innerHTML).toBe('');
  });
});

describe('GameHUD — current-player ring (#220)', () => {
  /** The chips, in seat order (the eliminated seat 2 renders nothing). */
  const chips = () => [...playersRow().children];

  it('rings the current chip in the text color, and only that chip', () => {
    renderHUD();
    expect(chips()[0].style.outline).toBe('2px solid var(--ui-text)');
    expect(chips()[1].style.outline).toBe('');
  });

  /*
   * The ring used to be a literal white, which the dark theme's black bar
   * made invisible to nobody and the light theme's 85%-white bar made
   * invisible to everybody (1.03:1). Measure the token it now uses against
   * the bar it sits on — flattened over the page, since the bar is
   * translucent — in both themes, at WCAG's non-text minimum.
   */
  it.each(['dark', 'light'])('the %s ring clears 3:1 against the bar', name => {
    const theme = THEMES[name];
    const bar = surface(theme.bodyBg, theme.uiBg);
    expect(contrast(theme.uiText, bar)).toBeGreaterThanOrEqual(WCAG.AA_NON_TEXT);
  });
});

describe('GameHUD — seat swatch hairline (#220)', () => {
  /*
   * The hairline separating a seat color from the bar was a fixed 30% white,
   * which the light theme's 85%-white bar swallowed (1.01:1). It is decoration
   * — the fill is the information — so the bar it has to clear is visibility in
   * both themes, not the 3:1 a control would owe.
   */
  it('draws the swatch hairline in the border token', () => {
    renderHUD();
    const swatch = playersRow().children[0].firstElementChild;
    expect(swatch.style.border).toBe('1px solid var(--ui-border)');
  });

  it.each(['dark', 'light'])('leaves the %s hairline visible against the bar', name => {
    const theme = THEMES[name];
    const bar = surface(theme.bodyBg, theme.uiBg);
    expect(contrast(theme.uiBorder, bar)).toBeGreaterThan(2);
  });
});

/*
 * The phone layout (#222). At 390px with eight seats the single row measured
 * 589px against 374px of bar, so chips 7 and 8 sat past the right edge with
 * `overflow: hidden` on the page to make sure nobody could scroll them back.
 * Under 560px the bar is two rows instead, and taller — which the renderer and
 * the overlay have to know about, hence --hud-bar-height.
 */
describe('GameHUD — phone layout and the bar-height contract (#222)', () => {
  /** One `@media` block, brace-matched out of the sheet. */
  function mediaBlock(condition) {
    const start = HUD_CSS.indexOf(`@media ${condition} {`);
    if (start === -1) throw new Error(`no @media ${condition} block in HUD_CSS`);
    let depth = 0;
    for (let i = HUD_CSS.indexOf('{', start); i < HUD_CSS.length; i += 1) {
      if (HUD_CSS[i] === '{') depth += 1;
      else if (HUD_CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) return HUD_CSS.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated @media ${condition}`);
  }

  const phone = () => mediaBlock('(max-width: 560px)');
  const coarse = () => mediaBlock('(pointer: coarse)');
  /** The sheet with both media blocks removed — what applies at every width. */
  const base = () => HUD_CSS.replace(phone(), '').replace(coarse(), '');
  const declaredHeight = css => {
    const match = css.match(/:root\s*\{[^}]*--hud-bar-height:\s*([\d.]+)px/);
    return match ? Number(match[1]) : null;
  };

  it('mounts its stylesheet, with or without the two controls', () => {
    renderHUD();
    const sheets = () => [...container.querySelectorAll('style')].map(el => el.textContent);
    // No handlers: no CHROME_CSS, but the chips still need their own layout
    // and the renderer still needs the height.
    expect(sheets()).toContain(HUD_CSS);

    act(() => render(null, container));
    act(() => {
      render(
        h(GameHUD, { store: createGameStore({ gameState: makeGameState() }), onQuit: vi.fn() }),
        container
      );
    });
    expect(sheets()).toContain(HUD_CSS);
  });

  /*
   * The one that keeps the contract honest: HUD_BAR_HEIGHT is what
   * GameRenderer and HexGridRenderer size themselves against, so the sheet has
   * to interpolate it rather than carry its own copy of 50.
   */
  it('declares the default bar height as HUD_BAR_HEIGHT itself', () => {
    expect(declaredHeight(base())).toBe(HUD_BAR_HEIGHT);
  });

  it('redeclares a taller bar under the phone breakpoint', () => {
    const phoneHeight = declaredHeight(phone());
    expect(phoneHeight).not.toBeNull();
    // Two rows plus the row gap: taller than the one-row default, by definition.
    expect(phoneHeight).toBeGreaterThan(HUD_BAR_HEIGHT);
  });

  it('drops the centering twins under the phone breakpoint', () => {
    // Centering is moot once the chips have the whole width — and left in, the
    // twins would claim a third row.
    expect(phone()).toMatch(/\.dw-hud-twin\s*\{\s*display:\s*none/);
  });

  it('gives the chips their own row, left-aligned and scrollable', () => {
    const block = phone();
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    expect(block).toMatch(/flex:\s*1 1 100%/);
    // 'safe center': centered overflow would put the first chips out of reach.
    expect(block).toMatch(/justify-content:\s*flex-start/);
    expect(block).toMatch(/overflow-x:\s*auto/);
    expect(block).toMatch(/\.dw-hud-chip:first-child\s*\{\s*margin-left:\s*auto/);
    expect(block).toMatch(/\.dw-hud-chip:last-child\s*\{\s*margin-right:\s*auto/);
  });

  /*
   * #222 item 4 gives every `.dw-opt` a 40px hit area on touch. These two live
   * in a bar whose height is a contract, so they take the same hit area as
   * overhang instead — and the override has to beat the generic rule on
   * specificity, because CHROME_CSS mounts a second copy of itself after this
   * sheet on hub screens and source order would go the other way.
   */
  it('overrides the touch hit area with a doubled class, not source order', () => {
    const block = coarse();
    expect(block).toContain('.dw-opt.dw-hud-opt');
    // Every property the generic rule sets, or the generic one wins that one.
    expect(block).toMatch(/padding:/);
    expect(block).toMatch(/margin:\s*-/);
    expect(block).toMatch(/min-height:\s*0/);
  });

  it('puts the touch override outside the phone breakpoint', () => {
    // A tablet is a coarse pointer on a wide screen: it needs the hit area
    // without the two-row layout.
    expect(phone()).not.toContain('dw-hud-opt');
  });
});
