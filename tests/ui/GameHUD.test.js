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
 * is mounted, that the bar's floor is HUD_BAR_HEIGHT and not a second copy of
 * 50 free to drift from it, and that the rules the layout stands on (the twins
 * hidden, the chips row scrollable and left-aligned, the touch override doubled
 * up) are inside the media blocks they belong to — plus the publish effect,
 * which IS observable: it reads a measurement and writes a custom property.
 * The measurements themselves are the manual pass in docs/TESTING.md.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameHUD, HUD_CSS } from '../../src/ui/GameHUD.jsx';
import { CHROME_CSS } from '../../src/ui/menuChrome.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { THEMES } from '../../src/renderer/themes.js';
import { HUD_BAR_HEIGHT, HUD_BAR_HEIGHT_VAR } from '../../src/renderer/constants.js';
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

/** Unmount the HUD — also how the publish effect's cleanup is exercised. */
function unmountHUD() {
  if (!container) return;
  act(() => render(null, container));
  if (container.parentNode) document.body.removeChild(container);
  container = null;
}

const quitBtn = () => container.querySelector('button[aria-label="Quit to title"]');
const rulesBtn = () => container.querySelector('button[aria-label="Rules: how to play"]');
/** The hidden width-matched twins that keep the chips optically centered. */
const twins = () => [...container.querySelectorAll('span[aria-hidden="true"]')];
const quitTwin = () => twins().find(el => el.textContent.trim() === 'QUIT');
/** The chips row — the only <div> child of the HUD bar. */
const playersRow = () => Array.from(container.firstChild.children).find(el => el.tagName === 'DIV');
/** The inline properties an element actually declares (jsdom's style is array-like). */
const inlineProps = el => Array.from({ length: el.style.length }, (_, i) => el.style.item(i));

afterEach(unmountHUD);

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
    /*
     * The exact set, not a contains(): .dw-opt is the bare-text idiom and
     * .dw-hud-opt is what lets the touch override outrank it (#222), but the
     * pin that matters is what is NOT here — adding .dw-btn would make the way
     * OUT of a game look like the way through it, and a contains() check would
     * let that through.
     */
    expect([...button.classList].sort()).toEqual(['dw-hud-opt', 'dw-opt']);

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
    expect([...button.classList].sort()).toEqual(['dw-hud-opt', 'dw-opt']);

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
      /*
       * .dw-hud-opt is load-bearing on the twins, not decoration copied off the
       * buttons: a coarse pointer WIDER than 560px (a tablet) shows them, and
       * without the class they would take CHROME_CSS's generic 40px hit area
       * — 6.4px wider than the buttons they exist to mirror (3.2px per side),
       * and enough extra height to push the bar to 56px. Pinned as an exact set
       * so neither the override hook nor the hide-me class can be dropped
       * silently.
       */
      expect([...twin.classList].sort()).toEqual(['dw-hud-opt', 'dw-hud-twin', 'dw-opt']);
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

  /*
   * Outline and nothing else. An inline style beats a stylesheet, so a box
   * property here (padding, margin, font-size) would out-specify the phone
   * block's `.dw-hud-chip` rule for exactly one chip — the current one —
   * and that chip would size differently from the rest of the row (#222).
   */
  it('declares only the ring inline, so the phone chip rule still owns the box', () => {
    renderHUD();
    expect(inlineProps(chips()[0]).sort()).toEqual(['outline', 'outline-offset']);
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
 * the overlay have to know about, hence the published --dw-hud-bar-height.
 */
describe('GameHUD — phone layout and the bar-height contract (#222)', () => {
  /*
   * Every pin below reads the sheet with its comments stripped. The comments
   * describe the declarations they sit next to, so a `toMatch(/overflow-x:
   * auto/)` over the raw sheet is satisfied by the prose alone — deleting the
   * declaration itself left this whole suite green.
   */
  const SHEET = HUD_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  /** One `@media` block, brace-matched out of the stripped sheet. */
  function mediaBlock(condition) {
    const start = SHEET.indexOf(`@media ${condition} {`);
    if (start === -1) throw new Error(`no @media ${condition} block in HUD_CSS`);
    let depth = 0;
    for (let i = SHEET.indexOf('{', start); i < SHEET.length; i += 1) {
      if (SHEET[i] === '{') depth += 1;
      else if (SHEET[i] === '}') {
        depth -= 1;
        if (depth === 0) return SHEET.slice(start, i + 1);
      }
    }
    throw new Error(`unterminated @media ${condition}`);
  }

  /** The declaration block of a single rule, so a pin can't match a neighbour. */
  function ruleBody(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`no ${selector} rule`);
    return match[1];
  }

  /** The property names a declaration block sets, in source order. */
  const declaredProps = body =>
    body
      .split(';')
      .map(decl => decl.split(':')[0].trim())
      .filter(Boolean);

  /** The first number in a declaration, e.g. `padding: 11px 0.4rem` → 11. */
  const firstNumber = (body, prop) => {
    const match = body.match(new RegExp(`(^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
    if (!match) throw new Error(`no px ${prop} in "${body.trim()}"`);
    return Number(match[2]);
  };

  /** The selectors a media block's rules declare, in source order. */
  const selectorsIn = block =>
    [...block.slice(block.indexOf('{') + 1).matchAll(/([^{}]+)\{[^}]*\}/g)].map(m => m[1].trim());

  /**
   * The property names CHROME_CSS's generic coarse `.dw-opt` rule declares —
   * the set this sheet's override has to cover — or null when CHROME_CSS has no
   * coarse block yet. That is the state of master until #222 item 4 lands, and
   * the two changes are separate PRs, so the pin has to survive the interim.
   */
  function chromeCoarseOptProps() {
    const css = CHROME_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = css.indexOf('@media (pointer: coarse) {');
    if (start === -1) return null;
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const match = css.slice(open + 1, i).match(/(^|\})\s*\.dw-opt\s*\{([^}]*)\}/);
          return match ? declaredProps(match[2]) : null;
        }
      }
    }
    throw new Error('unterminated @media (pointer: coarse) in CHROME_CSS');
  }

  const phone = () => mediaBlock('(max-width: 560px)');
  const coarse = () => mediaBlock('(pointer: coarse)');
  /** The sheet with both media blocks removed — what applies at every width. */
  const base = () => SHEET.replace(phone(), '').replace(coarse(), '');

  it('mounts its stylesheet, with or without the two controls', () => {
    renderHUD();
    const sheets = () => [...container.querySelectorAll('style')].map(el => el.textContent);
    // No handlers: no CHROME_CSS, but the chips still need their own layout.
    expect(sheets()).toContain(HUD_CSS);

    unmountHUD();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      render(
        h(GameHUD, { store: createGameStore({ gameState: makeGameState() }), onQuit: vi.fn() }),
        container
      );
    });
    expect(sheets()).toContain(HUD_CSS);
  });

  /*
   * The floor, and the one that keeps the contract honest: HUD_BAR_HEIGHT is
   * what GameRenderer reserves under the board with no HUD mounted, so the
   * desktop bar must never measure shorter than it — interpolated rather than a
   * second copy of 50 free to drift. border-box because the bar's 0.5rem
   * padding is inline on STYLE.bar: content-box would put the bar at 66px while
   * the renderer reserved 50, and the chips would sit under the board's edge.
   */
  it('floors the bar at HUD_BAR_HEIGHT itself, border-box', () => {
    const body = ruleBody(base(), '.dw-hud');
    expect(body).toMatch(new RegExp(`min-height:\\s*${HUD_BAR_HEIGHT}px`));
    expect(body).toMatch(/box-sizing:\s*border-box/);
  });

  /*
   * And the floor is a literal, not the published variable: read from
   * --dw-hud-bar-height it would be a feedback loop, and a bar measured at 80
   * in portrait could never shrink back to 50 after a rotation to landscape.
   * The sheet declares no height at all — the mounted HUD measures and
   * publishes one (see the publish suite below), which is the only way the
   * value can survive a big browser font or a scrollbar gutter.
   */
  it('declares no bar height in the sheet — the mounted HUD publishes the measured one', () => {
    expect(SHEET).not.toMatch(new RegExp(`${HUD_BAR_HEIGHT_VAR}\\s*:`));
    expect(ruleBody(base(), '.dw-hud')).not.toContain('var(');
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
   * The overflow valve must cost no height: a laid-out horizontal scrollbar
   * adds ~15px of gutter to the row on the engines that reserve one, which the
   * bar would then have to be that much taller to hold.
   */
  it('hides the chips row scrollbar in both engine dialects', () => {
    const block = phone();
    expect(ruleBody(block, '.dw-hud-players')).toMatch(/scrollbar-width:\s*none/);
    expect(block).toMatch(/\.dw-hud-players::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });

  /*
   * Padding on all four sides, not just top and bottom: it is the current
   * player's ring clearance (2px outline at 2px offset), and once the row
   * scrolls the auto margins resolve to 0, leaving the outermost chip's ring
   * against the edge of the overflow box with nothing to clip into.
   */
  it('keeps ring clearance on every side of the chips row', () => {
    const body = ruleBody(phone(), '.dw-hud-players');
    expect(body).toMatch(/padding:\s*4px\s*;/);
  });

  /*
   * CHROME_CSS's coarse-pointer block (#222 item 4) gives every `.dw-opt` a
   * 40px hit area on touch. These two live in a bar whose height is a contract,
   * so they take the same hit area as overhang instead — and the override has
   * to beat the generic rule on specificity, because GameHUD mounts CHROME_CSS
   * immediately after this sheet in its own subtree, so the generic rule always
   * comes later in document order and source order would go the other way.
   */
  it('overrides the touch hit area with a doubled class, not source order', () => {
    const block = coarse();
    expect(block).toContain('.dw-opt.dw-hud-opt');
    /*
     * A SUPERSET of whatever the generic rule declares, computed rather than
     * listed: any property it sets that this one does not is a property the
     * generic value still wins, and each of those grows the bar. The reverse
     * needs no pin — the negative margin is this override's own trick and has
     * no generic counterpart. `?? []` is the vacuous case: CHROME_CSS has no
     * coarse block at all until #222 item 4 lands, and this starts biting the
     * moment it does.
     */
    const props = declaredProps(ruleBody(block, '.dw-opt.dw-hud-opt'));
    expect(props).toEqual(expect.arrayContaining(chromeCoarseOptProps() ?? []));
  });

  /*
   * ...and the doubled selector is the ONLY thing this block styles. HUD_CSS
   * is mounted wherever the bar is, so a bare `.dw-opt` rule here would quietly
   * restyle every option on the screen — the settings dropdown, the footer
   * links — from a sheet named for the HUD that nobody would think to look in.
   */
  it('keeps a bare .dw-opt out of its own coarse block', () => {
    const selectors = selectorsIn(coarse());
    expect(selectors).not.toContain('.dw-opt');
    expect(selectors).toEqual(['.dw-opt.dw-hud-opt']);
  });

  /*
   * The arithmetic the trick stands on: the hit area is padding the flex line
   * never sees, because an equal negative margin cancels it. If the two numbers
   * ever drift apart the bar grows or the chips shift, and either way the
   * height contract silently stops holding.
   */
  it('cancels the overhang exactly — padding out, margin back in', () => {
    const body = ruleBody(coarse(), '.dw-opt.dw-hud-opt');
    const padding = firstNumber(body, 'padding');
    expect(padding).toBe(-firstNumber(body, 'margin'));
    /*
     * The box is stated, not inferred. Left to fall out of 11px around whatever
     * line box the text renders, the hit area would be ~41px only once Anton
     * has loaded — the fallback face during the swap is a ~14px line box, so
     * ~36px — and the bar's published height would move with the swap. As a
     * min-height it is 41 whatever face is loaded, and the negative margin
     * still takes 2x11 back out, so the flex line measures the same 19px the
     * desktop row is built around.
     */
    const box = firstNumber(body, 'min-height');
    expect(box).toBe(41);
    expect(box - 2 * padding).toBe(19);
  });

  /*
   * ...and the sum only holds because the shared control has no border to add
   * to it. CHROME_CSS is a different file on a different concern, so pin the
   * assumption here rather than trusting it to stay true.
   */
  it('assumes a borderless .dw-opt, and pins that assumption in CHROME_CSS', () => {
    const chromeOpt = CHROME_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(
      /(^|\})\s*\.dw-opt\s*\{([^}]*)\}/
    );
    expect(chromeOpt).not.toBeNull();
    expect(chromeOpt[2]).toMatch(/border:\s*none/);
  });

  it('puts the touch override outside the phone breakpoint', () => {
    // A tablet is a coarse pointer on a wide screen: it needs the hit area
    // without the two-row layout.
    expect(phone()).not.toContain('dw-hud-opt');
  });

  /*
   * The row's layout is entirely the stylesheet's, so it can be overridden by
   * a media query. An inline `justifyContent: 'center'` here would out-specify
   * the phone block and put the first chips back out of reach on a crowded
   * board — the exact bug #222 is about.
   */
  it('leaves the chips row with no inline style for the phone block to fight', () => {
    renderHUD();
    expect(playersRow().getAttribute('style')).toBeNull();
  });
});

/*
 * The height the renderer and the overlay size against is MEASURED, not
 * declared: under 560px it is content-driven (rem rows are taller at a big
 * browser default font, a scrollbar gutter moves it again), so the mounted HUD
 * reads its own box and publishes the result on the document root — the same
 * place applyThemeVars writes the --ui-* palette. The dispatched 'resize' is
 * the only way GameRenderer hears about it after startup: it re-reserves on
 * that event and, once, at init, and nothing fires one when the HUD mounts.
 */
describe('GameHUD — publishing the measured bar height (#222)', () => {
  const published = () => document.documentElement.style.getPropertyValue(HUD_BAR_HEIGHT_VAR);
  const stubHeight = height =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height });
  /** The bar itself — what the observer has to be watching. */
  const bar = () => container.querySelector('.dw-hud');

  let rootStyle;
  let onResize;

  beforeEach(() => {
    rootStyle = document.documentElement.getAttribute('style');
    onResize = vi.fn();
    window.addEventListener('resize', onResize);
  });

  afterEach(() => {
    // Unmount first: the cleanup path is part of what these tests exercise.
    unmountHUD();
    window.removeEventListener('resize', onResize);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (rootStyle === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', rootStyle);
  });

  /*
   * Everything else here reads the name off the constant, which is the point —
   * GameRenderer, GameOverlay and the manual pass in docs/TESTING.md all spell
   * it out, and a rename that only reached some of them would put phones back
   * on the 50px fallback with nothing failing. So pin the string exactly once.
   */
  it('publishes under the documented property name', () => {
    expect(HUD_BAR_HEIGHT_VAR).toBe('--dw-hud-bar-height');
  });

  it('publishes the measured height and asks for one re-layout', () => {
    stubHeight(80);
    renderHUD();

    expect(published()).toBe('80px');
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  // Rounded UP: a bar measured at 79.2 that reserved 79 would let the board's
  // bottom edge sit under it by the remaining fraction.
  it('rounds a fractional measurement up', () => {
    stubHeight(79.2);
    renderHUD();

    expect(published()).toBe('80px');
  });

  /*
   * A zero height is a bar that has not been laid out (a hidden subtree, a
   * browser mid-swap). Publishing it would reserve nothing at all, so the
   * property stays absent and both consumers keep their own fallback.
   */
  it('publishes nothing for an unmeasured bar', () => {
    stubHeight(0);
    renderHUD();

    expect(published()).toBe('');
    expect(onResize).not.toHaveBeenCalled();
  });

  it('publishes nothing when there is no game state to draw a bar for', () => {
    stubHeight(80);
    renderHUD({ gameState: null });

    expect(published()).toBe('');
  });

  /*
   * The bar's height is content-driven under 560px, so it moves after mount:
   * a rotation, the web font swapping in, a scrollbar gutter appearing. The
   * observer is what keeps the published value honest through all of that —
   * jsdom has none, so it is stubbed here, and the whole branch (observe the
   * bar, republish on a change, skip an unchanged pass, disconnect on unmount)
   * is otherwise never executed by this suite.
   */
  it('re-publishes through a ResizeObserver on the bar, and disconnects on unmount', () => {
    let notify = null;
    let observed = null;
    let disconnected = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback) {
          notify = callback;
        }

        observe(el) {
          observed = el;
        }

        disconnect() {
          disconnected += 1;
        }
      }
    );

    const rect = stubHeight(80);
    renderHUD();

    expect(typeof notify).toBe('function');
    expect(observed).toBe(bar());
    expect(published()).toBe('80px');
    expect(onResize).toHaveBeenCalledTimes(1);

    // The bar got taller (a font swap, a rotation into portrait): the property
    // follows it, and the renderer is asked to re-reserve against the new one.
    rect.mockReturnValue({ height: 96.2 });
    notify();
    expect(published()).toBe('97px');
    expect(onResize).toHaveBeenCalledTimes(2);

    // A layout pass that did not move the bar. The observer fires on plenty of
    // those, and each one would otherwise rescale the whole board.
    notify();
    expect(published()).toBe('97px');
    expect(onResize).toHaveBeenCalledTimes(2);

    unmountHUD();
    expect(disconnected).toBe(1);
    expect(published()).toBe('');
  });

  /*
   * Unmount hands the reservation back: the next screen without a HUD (the
   * title) must not keep reserving a phone bar's worth of board.
   */
  it('withdraws the property on unmount and asks for the re-layout again', () => {
    stubHeight(80);
    renderHUD();
    expect(published()).toBe('80px');

    unmountHUD();

    expect(published()).toBe('');
    expect(onResize).toHaveBeenCalledTimes(2);
  });
});
