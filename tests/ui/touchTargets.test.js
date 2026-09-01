/**
 * Coarse-pointer touch targets (#222 item 4)
 *
 * The 2026-08-31 audit measured the menus in Chromium at 390x844 with touch
 * emulation and found the bare-text idiom's hit areas running 22-33px tall:
 * option rows 28-33px, the settings dropdown's options 27px, the title
 * screen's footer links 25px, the leaderboard's compact WATCH button 59x28.
 * WCAG 2.5.8 puts the floor at 24px; Apple's guidelines ask for 44pt and
 * Material's for 48dp. The fix keeps the type exactly as it is and grows the
 * box around it to 40px, entirely inside `@media (pointer: coarse)` so a mouse
 * sees the sheet it always saw.
 *
 * There is no browser-level harness in this repo, so nothing here measures a
 * rendered box — these are text pins on the four stylesheets, in the style of
 * themeLiterals.test.js. They hold the things a later edit could quietly undo:
 * that the rules exist and say 40px, that the coarse blocks of CHROME_CSS and
 * FOOTER_NAV_CSS stay LAST in their sheets (source order is the only reason
 * their `.dw-opt`, `a.dw-btn` and `.dw-footlink` outrank base rules of
 * identical specificity), that each coarse rule declares exactly the property
 * set the opt-outs below know to override, and that nothing grew on the
 * desktop side.
 *
 * The rules that deliberately escape the generic `.dw-opt` do it on
 * specificity, by doubling their class, so each is pinned where it lives: the
 * settings dropdown's `.dw-opt.dw-set-opt` and the how-to-play card's
 * `.dw-opt.dw-rules-close` are in this file, the in-game bar's
 * `.dw-opt.dw-hud-opt` is #222 item 1's.
 */

import { assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHROME_CSS } from '../../src/ui/menuChrome.jsx';

const MENU_CHROME_SRC = resolve(process.cwd(), 'src/ui/menuChrome.jsx');
const SETTINGS_SRC = resolve(process.cwd(), 'src/ui/SettingsPanel.jsx');
const RULES_SRC = resolve(process.cwd(), 'src/ui/RulesModal.jsx');

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
 * Every property name a rule body declares, in source order. The closed-list
 * pins below compare against this rather than asking after one property at a
 * time, so a property nobody thought about still fails.
 *
 * @param {string} body - Rule body
 * @returns {string[]}
 */
function props(body) {
  return body
    .split(';')
    .map(part => part.split(':')[0].trim())
    .filter(Boolean);
}

/**
 * A module-private stylesheet, read out of its source file. FOOTER_NAV_CSS,
 * SETTINGS_CSS and RULES_CSS are not exported and should not become exports
 * just to be tested; the sheets carry no backtick, so the literal ends at the
 * first one — which is checked rather than assumed, because a `${…}` or a
 * stray backtick added later would close the slice early and quietly put a
 * partial sheet under test.
 *
 * @param {string} path - Absolute path to the source file
 * @param {string} name - `const` name of the template literal
 * @returns {string}
 */
function sheetFromSource(path, name) {
  return sheetFromText(readFileSync(path, 'utf8'), name, path);
}

/**
 * The reader itself, over source text rather than a path, so its guard can be
 * tested without a fixture file.
 *
 * @param {string} source - Source file contents
 * @param {string} name - `const` name of the template literal
 * @param {string} path - Only for error messages
 * @returns {string}
 */
function sheetFromText(source, name, path) {
  const start = source.indexOf(`const ${name} = \``);
  if (start === -1) throw new Error(`${name} not found in ${path}`);
  const open = source.indexOf('`', start);
  const close = source.indexOf('`', open + 1);
  if (close === -1) throw new Error(`${name} literal is unterminated in ${path}`);
  // Every sheet is `const NAME = ` … `;` — anything else means we stopped early.
  if (source[close + 1] !== ';') {
    throw new Error(
      `${name} in ${path} does not end at the first backtick (found ` +
        `${JSON.stringify(source.slice(close + 1, close + 20))} after it). An interpolation ` +
        `or a stray backtick inside the sheet would put only part of it under test.`
    );
  }
  return source.slice(open + 1, close);
}

const FOOTER_NAV_CSS = sheetFromSource(MENU_CHROME_SRC, 'FOOTER_NAV_CSS');
const SETTINGS_CSS = sheetFromSource(SETTINGS_SRC, 'SETTINGS_CSS');
const RULES_CSS = sheetFromSource(RULES_SRC, 'RULES_CSS');

const SHEETS = {
  CHROME_CSS,
  FOOTER_NAV_CSS,
  SETTINGS_CSS,
  RULES_CSS,
};

/**
 * The class list the how-to-play close button actually carries. A doubled
 * selector only matches if the element is in both classes, and that half of it
 * lives in the JSX rather than in the sheet.
 *
 * @returns {string}
 */
function closeButtonClassName() {
  const source = readFileSync(RULES_SRC, 'utf8');
  const match = source.match(/className="([^"]*dw-rules-close[^"]*)"/);
  if (!match) throw new Error('no element carries dw-rules-close in RulesModal.jsx');
  return match[1];
}

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

  it('finds all four sheets', () => {
    const empty = Object.entries(SHEETS)
      .filter(([, sheet]) => sheet.length < 200)
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });

  /*
   * The slice runs to the first backtick after the declaration, so a sheet that
   * grew a `${…}` holding a nested literal would silently shrink to whatever
   * came before it. Rather than trust that, the reader checks the literal ends
   * where the slice stopped — here is a sheet where it does not.
   */
  it('refuses a literal that does not end at the first backtick', () => {
    const tick = '`';
    const source = [
      'const FAKE_CSS = ',
      tick,
      '.a { color: ',
      tick,
      'red',
      tick,
      '; }',
      tick,
      ';',
    ].join('');
    expect(() => sheetFromText(source, 'FAKE_CSS', 'fake.jsx')).toThrow(
      /does not end at the first backtick/
    );
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
     * No padding here on purpose: the filled buttons set their own inline and
     * already clear 40px — START and PLAY on MENU_STYLE.heroBtn, RUN ARENA and
     * RUN TOURNAMENT on primaryBtn — so this rule is a floor rather than a
     * resize. The two controls it does visibly lift (the leaderboard's WATCH
     * and the bot-guide link) keep their own inline padding too.
     */
    expect(decl(btn.body, 'padding')).toBeUndefined();
  });

  /*
   * `.dw-btn`'s floor grows the box; a <button> centers its label inside it for
   * free and an inline-block anchor does not, so the bot-guide link on Arena
   * and Tournament would sit at the top of a 40px pill with dead space beneath
   * it. Flex centering fixes that, on touch only — the base rule keeps
   * inline-block for the mouse.
   */
  it('centers the anchor button label inside the box the floor grew', () => {
    const anchor = coarseRules(CHROME_CSS).find(rule => rule.selector === 'a.dw-btn');
    expect(anchor).toBeDefined();
    expect(decl(anchor.body, 'display')).toBe('inline-flex');
    expect(decl(anchor.body, 'align-items')).toBe('center');
    expect(decl(anchor.body, 'justify-content')).toBe('center');
    // (0,1,1) against the base rule's (0,1,1): source order is the whole reason
    // it wins, so the base rule has to stay ahead of it.
    const base = CHROME_CSS.indexOf('a.dw-btn { display: inline-block');
    expect(base).toBeGreaterThan(-1);
    expect(CHROME_CSS.lastIndexOf('a.dw-btn {')).toBeGreaterThan(base);
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

  /*
   * FOOTER_NAV_CSS is the other sheet settled by order alone: its coarse
   * `.dw-footlink` ties with the base `.dw-footlink` above it at (0,1,0), and
   * the footer row mounts this sheet on its own, so nothing else in the
   * cascade is going to save it. (SETTINGS_CSS and RULES_CSS need no such pin:
   * their coarse rules are doubled, so they win on specificity wherever they
   * sit in their sheet.)
   */
  it('keeps the coarse block after the base .dw-footlink rule in FOOTER_NAV_CSS', () => {
    const base = FOOTER_NAV_CSS.indexOf('.dw-footlink {');
    const coarse = FOOTER_NAV_CSS.indexOf(COARSE);
    expect(base).toBeGreaterThan(-1);
    expect(coarse).toBeGreaterThan(base);
    // And nothing may follow it: it has to be the sheet's last block.
    const { end } = blockAt(FOOTER_NAV_CSS, FOOTER_NAV_CSS.indexOf('{', coarse));
    expect(FOOTER_NAV_CSS.slice(end).trim()).toBe('');
  });

  /*
   * Closed lists, not "declares at least": the coarse `.dw-opt` reaches three
   * rules that opt out of it by doubling their class, and a doubled selector
   * only overrides the properties it names. Adding a property here is therefore
   * a change to those three rules as well, and this is where that gets said.
   */
  const CLOSED_LISTS = [
    {
      selector: '.dw-opt',
      properties: ['padding', 'min-height'],
      why:
        'The coarse .dw-opt rule must declare exactly { padding, min-height }. Three doubled ' +
        'selectors opt out of it — .dw-opt.dw-set-opt (SettingsPanel), .dw-opt.dw-hud-opt ' +
        '(GameHUD) and .dw-opt.dw-rules-close (RulesModal) — and each only overrides the ' +
        'properties it names, so a property added here reaches all three whatever their own ' +
        'rules say. Add it to those overrides in the same change.',
    },
    {
      selector: '.dw-btn',
      properties: ['min-height'],
      why:
        'The coarse .dw-btn rule must declare exactly { min-height }: it is a floor, not a ' +
        'resize. Every button in the game sets its own type and padding inline, and anything ' +
        'beyond min-height here restyles all of them on a touch screen.',
    },
    {
      selector: 'a.dw-btn',
      properties: ['display', 'align-items', 'justify-content'],
      why:
        'The coarse a.dw-btn rule must declare exactly the three centering properties. It ties ' +
        'with the base a.dw-btn rule at (0,1,1) and wins on source order alone, so anything ' +
        'added here silently overrides that rule too.',
    },
  ];

  it.each(CLOSED_LISTS.map(entry => [entry.selector, entry]))(
    'declares exactly its own property set on the coarse %s rule',
    (selector, { properties, why }) => {
      const rule = coarseRules(CHROME_CSS).find(r => r.selector === selector);
      assert.ok(rule, `${selector} is missing from CHROME_CSS's coarse block`);
      // assert, not expect: `why` is the point of the pin, and eslint's
      // vitest/valid-expect rules out expect's message argument.
      assert.deepEqual([...props(rule.body)].sort(), [...properties].sort(), why);
    }
  );

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

  /*
   * RulesModal mounts CHROME_CSS and RULES_CSS in one <style>, so its close
   * button rule is not "another sheet" to the cascade — it is later text in the
   * same one. A bare `.dw-rules-close` would tie with the coarse `.dw-opt` at
   * (0,1,0) and take its tight padding straight back, an opt-out by
   * concatenation that the source-order pin above cannot see because that pin
   * is scoped to a single sheet. Doubling the class settles it on specificity.
   */
  it('doubles the how-to-play close button class rather than relying on order', () => {
    const close = rules(stripComments(RULES_CSS)).filter(rule =>
      rule.selector.includes('dw-rules-close')
    );
    // The base rule and the coarse one, both doubled.
    expect(close.map(rule => rule.selector)).toEqual([
      '.dw-opt.dw-rules-close',
      '.dw-opt.dw-rules-close',
    ]);
    expect(closeButtonClassName()).toContain('dw-opt');
  });

  it('gives the how-to-play close button a 40px box without widening its padding', () => {
    const close = coarseRules(RULES_CSS).find(rule => rule.selector === '.dw-opt.dw-rules-close');
    expect(close).toBeDefined();
    expect(decl(close.body, 'min-width')).toBe('40px');
    expect(decl(close.body, 'min-height')).toBe('40px');
    /*
     * Padding stays tight — it is a corner control beside the headline, and a
     * wide pill there would read as a second button — so min-width is what
     * makes the grown box square rather than a stretched one.
     */
    expect(decl(close.body, 'padding')).toBeUndefined();
  });
});

/*
 * The other half of the promise: "desktop layout unchanged". Every rule
 * outside a coarse-pointer query that touches one of the three classes is
 * listed here with the size it had before #222 — a changed padding anywhere
 * else fails, whichever sheet it lands in.
 */
const BASE_BOXES = {
  '.dw-opt': '0.1rem 0.4rem',
  '.dw-footlink': '0.15rem 0.45rem',
  '.dw-opt.dw-set-opt': '0.12rem 0.45rem',
  '.dw-opt.dw-rules-close': '0.1rem 0.5rem',
};

/*
 * Padding is not the only way to make a row taller: `line-height: 3` on the
 * base `.dw-opt` sails past a padding-and-min-height scan. So every
 * declaration of these four properties outside a coarse query has to be one
 * that was already there, and the pre-#222 set is short — three type sizes and
 * one line-height, none of the guarded classes declaring a height at all.
 */
const GROWTH_PROPS = ['height', 'min-height', 'line-height', 'font-size'];

const BASE_GROWTH = {
  '.dw-footlink': { 'font-size': '0.85rem' },
  '.dw-opt.dw-set-opt': { 'font-size': '0.95rem' },
  '.dw-opt.dw-rules-close': { 'font-size': '1.35rem', 'line-height': '1' },
};

const TOUCHED_CLASSES = /\.dw-(?:opt|btn|footlink)\b/;

describe('the desktop layout is untouched (#222 item 4)', () => {
  it('grows no box outside a coarse-pointer query', () => {
    const strays = Object.entries(SHEETS).flatMap(([name, sheet]) =>
      nonCoarseRules(sheet)
        .filter(rule => TOUCHED_CLASSES.test(rule.selector))
        .flatMap(rule =>
          GROWTH_PROPS.map(prop => ({ prop, value: decl(rule.body, prop) }))
            .filter(
              ({ prop, value }) =>
                value !== undefined && BASE_GROWTH[rule.selector]?.[prop] !== value
            )
            .map(({ prop, value }) => `${name} ${rule.selector} { ${prop}: ${value} }`)
        )
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
   * And the same lists from the other side: an entry above that stops matching
   * anything is slack, and would quietly stop guarding its rule.
   */
  it('has a live rule behind every listed base declaration', () => {
    const all = Object.values(SHEETS).flatMap(sheet => nonCoarseRules(sheet));
    const listed = [
      ...Object.keys(BASE_BOXES).map(selector => [selector, 'padding']),
      ...Object.entries(BASE_GROWTH).flatMap(([selector, declarations]) =>
        Object.keys(declarations).map(prop => [selector, prop])
      ),
    ];
    const orphans = listed
      .filter(
        ([selector, prop]) =>
          !all.some(rule => rule.selector === selector && decl(rule.body, prop) !== undefined)
      )
      .map(([selector, prop]) => `${selector} { ${prop} }`);
    expect(orphans).toEqual([]);
  });
});
