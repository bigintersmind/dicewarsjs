// @vitest-environment jsdom
/**
 * Leaderboard tests — the broken-bot flag badge (#92 item 2), whose flag decision lives in
 * the JS layer (reportBotErrors) so this component only displays the `flagged` prop, and
 * the phone layout (#222 item 2). jsdom does no layout and evaluates no media queries, so
 * the phone block pins the structure and the stylesheet text rather than measuring widths.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { Leaderboard, LEADERBOARD_CSS } from '../../src/ui/Leaderboard.jsx';
import { applyThemeVars, hexToRgba } from '../../src/ui/applyThemeVars.js';
import { THEMES } from '../../src/renderer/themes.js';
import { contrast, surface, WCAG } from '../helpers/contrast.js';

let container;

function renderLeaderboard(props) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => render(h(Leaderboard, props), container));
}

function row(name) {
  return [...container.querySelectorAll('tbody tr')].find(tr => tr.textContent.includes(name));
}

const bots = [
  { name: 'Healthy', elo: 1300, wins: 20, gamesPlayed: 40, avgPlacement: 2.1, attackWinRate: 0.55 },
  { name: 'Broken', elo: 900, wins: 0, gamesPlayed: 40, avgPlacement: 6.9, attackWinRate: 0 },
];

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('Leaderboard flag badge', () => {
  it('renders no badge when nothing is flagged', () => {
    renderLeaderboard({ bots });
    expect(container.textContent).not.toContain('⚠');
  });

  it('renders no badge when flagged is omitted entirely', () => {
    renderLeaderboard({ bots });
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).not.toContain('error turn');
  });

  it('badges a flagged bot with its error-turn count and leaves healthy rows unmarked', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, errorFraction: 1 }],
    });

    const broken = row('Broken');
    expect(broken.textContent).toContain('⚠');
    expect(broken.textContent).toContain('30 error turns');

    expect(row('Healthy').textContent).not.toContain('⚠');
  });

  it('describes an invalid-move-only flag by its invalid-move count, not "0 error turns"', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 0, invalidMoves: 12, errorFraction: 1 }],
    });

    const broken = row('Broken');
    expect(broken.textContent).toContain('12 invalid moves');
    expect(broken.textContent).not.toContain('error turns');
  });

  it('gives a flagged row a distinct background so it reads as unreliable', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, errorFraction: 1 }],
    });
    // The exact wash is pinned in the danger-color describe below; here just assert the
    // flagged row is styled and the healthy one is not.
    expect(row('Broken').style.background).not.toBe('');
    expect(row('Healthy').style.background).toBe('');
  });
});

describe('Leaderboard flag badge — danger color (#220)', () => {
  /** The badge is the only element in a row carrying the explanatory tooltip. */
  const badge = name => row(name).querySelector('span[title]');

  const flagOne = () =>
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, errorFraction: 1 }],
    });

  it('paints the badge from the theme token, not a literal red', () => {
    flagOne();
    expect(badge('Broken').style.color).toBe('var(--ui-danger)');
    expect(badge('Broken').style.border).toBe('1px solid var(--ui-danger)');
  });

  it('keeps the dark theme looking exactly as it shipped', () => {
    expect(THEMES.dark.uiDanger).toBe('#e5534b');
  });

  /*
   * The badge is 11px bold — body text as far as WCAG is concerned — so 4.5:1 is the bar,
   * and every surface it can land on is translucent: flatten them over the page first. The
   * flagged row's own wash sits on top of the panel, so measure that stack too — it is the
   * surface the badge actually sits on, and the thinnest margin of the four. The row paints
   * the wash as `var(--ui-danger-soft)`, so the measurable value comes from applying the
   * theme and reading the var back — the same composition the browser resolves.
   */
  it.each(['dark', 'light'])('the %s danger color clears 4.5:1 wherever it is used', name => {
    flagOne();
    // Pin the coupling too: the row must reference the token, not a copy of one theme's red.
    expect(row('Broken').style.background).toBe('var(--ui-danger-soft)');

    // Own root and body so applying a theme here doesn't restyle the shared document.
    const el = document.createElement('div');
    applyThemeVars(name, { root: el, body: document.createElement('div') });
    const rowWash = el.style.getPropertyValue('--ui-danger-soft');

    const theme = THEMES[name];
    const panel = surface(theme.bodyBg, theme.uiOverlayBg);
    const surfaces = [
      panel,
      surface(theme.bodyBg, theme.uiScrim),
      surface(theme.bodyBg, theme.uiBg),
      surface(theme.bodyBg, theme.uiOverlayBg, rowWash),
    ];
    for (const bg of surfaces) {
      expect(contrast(theme.uiDanger, bg)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
    }
    // Danger must never collapse back into the accent, which the rank column of that very
    // row is painted in.
    expect(theme.uiDanger).not.toBe(theme.uiAccent);
  });

  it('separates the light danger red from the light accent, its nearest neighbour', () => {
    /*
     * The light accent is a crimson barely a dozen degrees of hue off a plain red, so the
     * light danger is pushed darker as well as warmer — a lightness step still reads at
     * badge size where a hue step alone might not. The dark pair is separated by hue only
     * (1.03:1); that is the shipped look and stays untouched.
     */
    expect(contrast(THEMES.light.uiDanger, THEMES.light.uiAccent)).toBeGreaterThan(1.1);
  });
});

/*
 * The flagged row's wash is the token's only consumer, so its plumbing is pinned here,
 * beside the contrast measurements it exists for, rather than in the shared theming tests.
 */
describe('--ui-danger-soft plumbing (#220 item 5)', () => {
  it.each(['dark', 'light'])('applyThemeVars derives it from the %s danger color', name => {
    const el = document.createElement('div');
    applyThemeVars(name, { root: el, body: document.createElement('div') });
    const wash = el.style.getPropertyValue('--ui-danger-soft');
    expect(wash).not.toMatch(/undefined/);
    expect(wash).toBe(hexToRgba(THEMES[name].uiDanger, 0.1));
  });

  it('is seeded in the index.html :root block for the first paint', () => {
    /*
     * Resolve from the repo root (vitest's cwd); import.meta.url is not a file: URL under
     * the jsdom environment. index.html seeds the dark palette before main.jsx runs, so a
     * missing seed means flagged rows flash unwashed on load.
     */
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(indexHtml).toContain(`--ui-danger-soft: ${hexToRgba(THEMES.dark.uiDanger, 0.1)};`);
  });
});

/*
 * The table is dropped straight into `MENU_STYLE.panel` by three screens, so at 390px it
 * used to render 475px wide inside a 341px panel: the border broke, the last two columns
 * sat off screen, and `html, body { overflow: hidden }` meant nothing could scroll them
 * back. jsdom neither lays out nor evaluates `@media`, so these pin the two mechanisms
 * instead — the wrapper the overflow is confined to, and the rules that fire below 560px.
 */
describe('Leaderboard on a phone (#222 item 2)', () => {
  /** Header label with the sort indicator stripped — the sorted column carries ▲/▼. */
  const label = th => th.textContent.replace(/[\u25B2\u25BC]/g, '').trim();

  const wrapper = () => container.querySelector('.dw-lb-scroll');

  /** Positions of the phone-hidden cells within a `<tr>`'s or `<thead>`'s children. */
  const derivedIndices = els =>
    els.flatMap((el, i) => (el.classList.contains('dw-lb-derived') ? [i] : []));

  it('confines the table to a scroller of its own, so nothing escapes the panel', () => {
    renderLeaderboard({ bots });

    const scroll = wrapper();
    expect(scroll.style.overflowX).toBe('auto');
    expect(scroll.style.width).toBe('100%');
    // The table must be *inside* it: a sibling scroller would leave the panel to break.
    expect(container.querySelector('table').parentElement).toBe(scroll);
    // ...and the scroller must be what the panel wraps, not something further out.
    expect(scroll.parentElement).toBe(container);
  });

  it('mounts its own stylesheet inside that wrapper, like the other menu chrome', () => {
    renderLeaderboard({ bots });
    expect(wrapper().querySelector('style').textContent).toBe(LEADERBOARD_CSS);
  });

  it('marks exactly the two derived headers, leaving the ranking columns alone', () => {
    renderLeaderboard({ bots });

    const headers = [...container.querySelectorAll('thead th')];
    expect(headers.filter(th => th.classList.contains('dw-lb-derived')).map(label)).toEqual([
      'Avg Place',
      'Atk%',
    ]);
    expect(headers.filter(th => !th.classList.contains('dw-lb-derived')).map(label)).toEqual([
      '#',
      'Bot',
      'ELO',
      'W',
      'GP',
      'Win%',
    ]);
  });

  /*
   * The headers come from COLUMNS and carry the class from the `derived` flag; the cells are
   * written out by hand and carry it literally, so the two can drift apart. Check them
   * against each other rather than against hard-coded positions, so a failure names the
   * drift — a column added to COLUMNS with no `<td>`, or a `<td>` that forgets the class and
   * survives on a phone under a hidden header — instead of surfacing as a surprising label
   * list. Rendered with a flag so the badged row, whose Bot cell carries extra markup, is
   * covered by the same walk.
   */
  it('keeps every row in step with the header row it is hidden by', () => {
    renderLeaderboard({
      bots,
      flagged: [{ name: 'Broken', errors: 30, invalidMoves: 0, errorFraction: 1 }],
    });

    const headers = [...container.querySelectorAll('thead th')];
    const derived = derivedIndices(headers);
    // Guard the check against passing vacuously if the class ever disappears entirely.
    expect(derived.length).toBeGreaterThan(0);

    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(bots.length);
    for (const tr of rows) {
      const cells = [...tr.children];
      // A column added to COLUMNS needs a matching cell, or every row below is off by one.
      expect(cells).toHaveLength(headers.length);
      // ...and it has to hide with its header, or the phone shows a headless column.
      expect(derivedIndices(cells)).toEqual(derived);
    }
  });

  it('hides the derived columns and tightens the cells below the breakpoint', () => {
    const block = LEADERBOARD_CSS.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/\.dw-lb-derived\s*\{\s*display:\s*none;?\s*\}/);
    expect(block[1]).toMatch(/--dw-lb-pad-x:\s*0\.3rem;/);
  });

  it("reuses the mode rail's 560px breakpoint instead of inventing a second one", () => {
    // Read from disk rather than importing: NAV_CSS is private to menuChrome.jsx.
    const chrome = readFileSync(resolve(process.cwd(), 'src/ui/menuChrome.jsx'), 'utf8');
    expect(chrome).toContain('@media (max-width: 560px)');
  });

  it("routes the cells' horizontal padding through the variable the media block sets", () => {
    renderLeaderboard({ bots });

    // Inline styles outrank class rules, so the media block can only reach the padding
    // through a custom property. The fallback carries the wide-screen value.
    expect(container.querySelector('th').style.padding).toBe('0.4rem var(--dw-lb-pad-x, 0.6rem)');
    expect(container.querySelector('td').style.padding).toBe('0.35rem var(--dw-lb-pad-x, 0.6rem)');
    // And the wrapper must not declare the variable inline, which would out-specify the
    // media block and quietly pin the padding at its desktop value on a phone.
    expect(wrapper().style.getPropertyValue('--dw-lb-pad-x')).toBe('');
  });
});
