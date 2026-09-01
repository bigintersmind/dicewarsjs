/**
 * Coarse-pointer touch targets (#222 item 4)
 *
 * The 2026-08-31 audit measured the menus in Chromium at 390x844 with touch
 * emulation and found the bare-text idiom's hit areas running 22-33px tall:
 * option rows 28-33px, the settings dropdown's options 27px, the title
 * screen's footer links 25px, the leaderboard's compact WATCH button 59x28.
 * WCAG 2.5.8 puts the floor at 24px; both platform guidelines ask for 44px.
 * The fix keeps the type exactly as it is and grows the box around it to 40px,
 * entirely inside `@media (pointer: coarse)` so a mouse sees the sheet it
 * always saw.
 *
 * There is no browser-level harness in this repo, so nothing here measures a
 * rendered box — these are text pins on the three stylesheets, in the style of
 * themeLiterals.test.js. They hold the three things a later edit could quietly
 * undo: that the rules exist and say 40px, that CHROME_CSS's coarse block
 * stays LAST (source order is the only reason its `.dw-opt` outranks the base
 * rule of identical specificity), and that nothing grew on the desktop side.
 *
 * The two rules that deliberately escape the generic `.dw-opt` — the settings
 * dropdown's `.dw-opt.dw-set-opt` and the HUD's `.dw-opt.dw-hud-opt` — do it on
 * specificity, so their own sizing is pinned where it lives (this file covers
 * the settings one; the HUD's is #222 item 1's).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHROME_CSS } from '../../src/ui/menuChrome.jsx';

const MENU_CHROME_SRC = resolve(process.cwd(), 'src/ui/menuChrome.jsx');
const SETTINGS_SRC = resolve(process.cwd(), 'src/ui/SettingsPanel.jsx');

const COARSE = '@media (pointer: coarse)';

/** Drop `/* … *\/` comments so prose about a declaration never reads as one. */
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The `{ … }` starting at `openIndex`, brace-matched.
 *
 * @param {string} css
 * @param {number} openIndex - Index of the opening brace
 * @returns {{ body: string, end: number }} Block contents and the index just
 *   past its closing brace
 */
function blockAt(css, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: css.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  throw new Error(`unbalanced braces from index ${openIndex}`);
}

/**
 * Flatten a sheet into `{ selector, body, media }` rules. Conditional at-rules
 * recurse so a rule inside `@media (pointer: coarse)` is reported with that
 * condition attached; `@keyframes` is left whole (it declares no selectors we
 * care about, and its `from`/`to` are not rules).
 *
 * @param {string} css - Comment-stripped stylesheet text
 * @param {string | null} [media] - Enclosing at-rule prelude, if any
 * @returns {{ selector: string, body: string, media: string | null }[]}
 */
function rules(css, media = null) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const selector = css.slice(i, open).trim();
    const { body, end } = blockAt(css, open);
    if (/^@(?:media|supports)\b/.test(selector)) out.push(...rules(body, selector));
    else out.push({ selector, body: body.trim(), media });
    i = end;
  }
  return out;
}

/**
 * One declaration's value, or undefined. Anchored to a `;` or the block start
 * so `height` never reads out of `min-height`.
 *
 * @param {string} body - Rule body
 * @param {string} prop - Property name
 * @returns {string | undefined}
 */
function decl(body, prop) {
  const match = body.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`));
  return match ? match[1].trim() : undefined;
}

/**
 * A module-private stylesheet, read out of its source file. FOOTER_NAV_CSS and
 * SETTINGS_CSS are not exported and should not become exports just to be
 * tested; the sheets carry no backtick, so the literal ends at the first one.
 *
 * @param {string} path - Absolute path to the source file
 * @param {string} name - `const` name of the template literal
 * @returns {string}
 */
function sheetFromSource(path, name) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf(`const ${name} = \``);
  if (start === -1) throw new Error(`${name} not found in ${path}`);
  const open = source.indexOf('`', start);
  const close = source.indexOf('`', open + 1);
  if (close === -1) throw new Error(`${name} literal is unterminated in ${path}`);
  return source.slice(open + 1, close);
}

const FOOTER_NAV_CSS = sheetFromSource(MENU_CHROME_SRC, 'FOOTER_NAV_CSS');
const SETTINGS_CSS = sheetFromSource(SETTINGS_SRC, 'SETTINGS_CSS');

const SHEETS = {
  CHROME_CSS,
  FOOTER_NAV_CSS,
  SETTINGS_CSS,
};

/** The coarse-pointer rules of one sheet, by selector. */
function coarseRules(sheet) {
  return rules(stripComments(sheet)).filter(rule => rule.media === COARSE);
}

/** The rules of one sheet that are NOT behind a coarse-pointer query. */
function nonCoarseRules(sheet) {
  return rules(stripComments(sheet)).filter(rule => rule.media !== COARSE);
}

describe('the stylesheet reader', () => {
  /*
   * The private sheets are only as trustworthy as this extraction, and
   * CHROME_CSS is the one sheet where the exported value can check it.
   */
  it('reads a template literal back exactly as the module exports it', () => {
    expect(sheetFromSource(MENU_CHROME_SRC, 'CHROME_CSS')).toBe(CHROME_CSS);
  });

  it('finds all three sheets', () => {
    const empty = Object.entries(SHEETS)
      .filter(([, sheet]) => sheet.length < 200)
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });
});

describe('coarse-pointer touch targets (#222 item 4)', () => {
  it.each(Object.keys(SHEETS))('%s scopes its touch sizing to a coarse pointer', name => {
    expect(SHEETS[name]).toContain(`${COARSE} {`);
  });

  it('grows the option text to a 40px box with padding around the glyphs', () => {
    const opt = coarseRules(CHROME_CSS).find(rule => rule.selector === '.dw-opt');
    expect(opt).toBeDefined();
    expect(decl(opt.body, 'min-height')).toBe('40px');
    // The padding is what widens the hit area; the exact value is design, the
    // presence of one is the contract.
    expect(decl(opt.body, 'padding')).toBe('0.45rem 0.6rem');
  });

  it('lifts the compact classic button to the same 40px floor', () => {
    const btn = coarseRules(CHROME_CSS).find(rule => rule.selector === '.dw-btn');
    expect(btn).toBeDefined();
    expect(decl(btn.body, 'min-height')).toBe('40px');
    /*
     * No padding here on purpose: the leaderboard's WATCH sets its own inline,
     * and the hero buttons (START / PLAY / RUN) already clear 40px, so this
     * rule is a floor rather than a resize.
     */
    expect(decl(btn.body, 'padding')).toBeUndefined();
  });

  /*
   * The whole reason the generic rule works: `.dw-opt` in the coarse block and
   * `.dw-opt` in the base sheet are both (0,1,0), so the cascade falls through
   * to source order. Move the block up and the base padding silently wins back.
   */
  it('keeps the coarse block after the base .dw-opt rule in CHROME_CSS', () => {
    const base = CHROME_CSS.indexOf('.dw-opt {');
    const coarse = CHROME_CSS.indexOf(COARSE);
    expect(base).toBeGreaterThan(-1);
    expect(coarse).toBeGreaterThan(base);
    // And nothing may follow it: it has to be the sheet's last block.
    const { end } = blockAt(CHROME_CSS, CHROME_CSS.indexOf('{', coarse));
    expect(CHROME_CSS.slice(end).trim()).toBe('');
  });

  it('grows the title screen footer links', () => {
    const link = coarseRules(FOOTER_NAV_CSS).find(rule => rule.selector === '.dw-footlink');
    expect(link).toBeDefined();
    expect(decl(link.body, 'min-height')).toBe('40px');
    expect(decl(link.body, 'padding')).toBe('0.5rem 0.6rem');
  });

  it('grows the settings options through the doubled selector, not the bare class', () => {
    const coarse = coarseRules(SETTINGS_CSS);
    const opt = coarse.find(rule => rule.selector === '.dw-opt.dw-set-opt');
    expect(opt).toBeDefined();
    expect(decl(opt.body, 'min-height')).toBe('40px');
    /*
     * A single `.dw-opt` here would tie with CHROME_CSS's coarse rule at
     * (0,1,0) and let mount order decide, which is exactly what the base
     * `.dw-opt.dw-set-opt` comment above it exists to prevent.
     */
    expect(coarse.map(rule => rule.selector)).not.toContain('.dw-opt');
  });

  /*
   * `.dw-set-row` offsets the option row by `-0.45rem` so option text
   * left-aligns with its eyebrow inside the 236px card. The coarse rule may
   * only grow the vertical padding: any other horizontal value breaks that
   * alignment (and pushes the four-up SPEED row into a second line).
   */
  it('leaves the settings options horizontal padding matched to the row offset', () => {
    const opt = coarseRules(SETTINGS_CSS).find(rule => rule.selector === '.dw-opt.dw-set-opt');
    const [vertical, horizontal] = decl(opt.body, 'padding').split(/\s+/);
    expect(horizontal).toBe('0.45rem');
    expect(SETTINGS_CSS).toContain('margin: 0 -0.45rem;');
    // The vertical is what does the growing, so it must not be the base value.
    expect(vertical).not.toBe('0.12rem');
  });
});

/*
 * The other half of the promise: "desktop layout unchanged". Every rule
 * outside a coarse-pointer query that touches one of the three classes is
 * listed here with the size it had before #222 — a new `min-height` or a
 * changed `padding` anywhere else fails, whichever sheet it lands in.
 */
const BASE_BOXES = {
  '.dw-opt': '0.1rem 0.4rem',
  '.dw-footlink': '0.15rem 0.45rem',
  '.dw-opt.dw-set-opt': '0.12rem 0.45rem',
};

const TOUCHED_CLASSES = /\.dw-(?:opt|btn|footlink)\b/;

describe('the desktop layout is untouched (#222 item 4)', () => {
  it('adds no min-height outside a coarse-pointer query', () => {
    const strays = Object.entries(SHEETS).flatMap(([name, sheet]) =>
      nonCoarseRules(sheet)
        .filter(rule => TOUCHED_CLASSES.test(rule.selector) && decl(rule.body, 'min-height'))
        .map(rule => `${name} ${rule.selector} { min-height: ${decl(rule.body, 'min-height')} }`)
    );
    expect(strays).toEqual([]);
  });

  it('leaves every base padding at its pre-#222 value', () => {
    const changed = Object.entries(SHEETS).flatMap(([name, sheet]) =>
      nonCoarseRules(sheet)
        .filter(rule => TOUCHED_CLASSES.test(rule.selector) && decl(rule.body, 'padding'))
        .filter(rule => decl(rule.body, 'padding') !== BASE_BOXES[rule.selector])
        .map(rule => `${name} ${rule.selector} { padding: ${decl(rule.body, 'padding')} }`)
    );
    expect(changed).toEqual([]);
  });

  /*
   * And the same list from the other side: an entry above that stops matching
   * anything is slack, and would quietly stop guarding its rule.
   */
  it('has a live rule behind every listed base padding', () => {
    const all = Object.values(SHEETS).flatMap(sheet => nonCoarseRules(sheet));
    const orphans = Object.keys(BASE_BOXES).filter(
      selector => !all.some(rule => rule.selector === selector && decl(rule.body, 'padding'))
    );
    expect(orphans).toEqual([]);
  });
});
