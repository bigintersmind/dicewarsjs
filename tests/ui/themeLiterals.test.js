/**
 * Theme-blind color literal guard (#220)
 *
 * The DOM UI is themed entirely through `var(--ui-*)` custom properties, so a
 * hard-coded black or white in a `STYLE` object silently pins one theme's
 * assumptions into a screen: a dark text shadow that turns into a smudge under
 * the light theme's navy text, a 30%-white hairline that the light theme's pale
 * bar swallows whole. Those read fine in the dark theme, which is the one
 * everybody develops in, so they only surface when someone flips the switch.
 *
 * This is the tripwire. Every `.js` and `.jsx` file under `src/ui/` is scanned
 * for the pure black/white literals, comments excluded, and compared against an
 * explicit allowance. `.js` is in scope because the theming layer itself lives
 * there — `applyThemeVars.js` is what writes the `--ui-*` values every other
 * file reads, so it is the last place a literal should go unwatched.
 *
 * Two checks hold an allowance to its file. The per-file comparison is `<=`, so
 * *retiring* a literal never fails with a confusing "too many" message; the
 * ratchet below fails instead, and says "lower max". Together they make every
 * entry an exact count rather than a ceiling with room in it: a new literal
 * fails, and a removed one fails until the number follows it down.
 *
 * Everything in ALLOWED is a literal that is genuinely theme-independent — art,
 * the classic-button identity face, an offset+blur drop shadow — or is somebody
 * else's open item, noted as such. It is not a list of things to get around to.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const UI_DIR = resolve(process.cwd(), 'src/ui');

/*
 * Pure black and white only, in every spelling that reaches CSS: 3- and 6-digit
 * hex with an optional alpha nibble or pair (`#fff8`, `#00000080` — the modern
 * spelling of exactly the `rgba(0,0,0,0.6)` literals this guard was written
 * for), `rgb()` alongside `rgba()` (opaque black is no more theme-aware than
 * translucent black), and the `white` / `black` keywords.
 *
 * A longer hex that merely starts with the same digits (`#fff3b0`, `#000a1f`)
 * is excluded by the trailing lookahead, and longest-first alternation makes
 * `#ffffff` one hit rather than `#fff` plus a tail. The keywords are matched
 * only where CSS takes a value — after a colon or a quote, or after a length or
 * `solid` inside a shadow or border — so the words in JSX text or an aria-label
 * are left alone, and `(?![\w-])` keeps the `white-space` property (not a
 * color) out of it.
 */
const BANNED =
  /#(?:ffffff|fff)(?:[0-9a-f]{2}|[0-9a-f])?(?![0-9a-f])|#(?:000000|000)(?:[0-9a-f]{2}|[0-9a-f])?(?![0-9a-f])|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)]|(?::\s*|['"`]|\d(?:px|em|rem|%)\s+|\bsolid\s+)(?:white|black)(?![\w-])/gi;

/**
 * What each file is allowed to carry, and why. `max` is the file's exact count,
 * held there from both sides by the per-file check and the ratchet — so a
 * literal that goes away takes its number down with it.
 */
const ALLOWED = {
  'ErrorBoundary.jsx': {
    max: 1,
    why: 'White on the accent recovery button. #224 owns this screen’s palette.',
  },
  'GameOverlay.jsx': {
    max: 1,
    why: 'White END TURN ink on the accent fill — measured in GameOverlay.test.js, same value in both themes.',
  },
  'OnlineLeaderboardScreen.jsx': {
    max: 1,
    why: 'The compact .dw-btn face: its drop edge is part of the classic-button identity, fixed across themes.',
  },
  'QuitConfirm.jsx': {
    max: 1,
    why: 'Offset+blur drop shadow lifting the card off the scrim — a shadow, not a surface color.',
  },
  'ReplayViewer.jsx': {
    max: 1,
    why: 'White on the accent control. #224 owns the replay viewer.',
  },
  'RulesModal.jsx': {
    max: 3,
    why: 'Two mask-image gradient stops (opacity, not paint) plus the card’s drop shadow.',
  },
  'SettingsPanel.jsx': {
    max: 3,
    why: 'The chrome die’s black pips and the panel’s drop shadow, plus the heading bevel until #228 tokenizes it.',
  },
  'TitleScreen.jsx': {
    max: 1,
    why: 'Offset+blur drop shadow under the wordmark.',
  },
  'menuChrome.jsx': {
    max: 6,
    why: 'The .dw-btn white face and its three drop edges (rest, active, disabled) — deliberate identity chrome — plus the screen-headline and active-tab bevels until #228 tokenizes them.',
  },
  'rulesArt.jsx': {
    max: 1,
    why: 'Drawn art: the dice numeral inside the accent-filled hex of the rules diagram.',
  },
  'titleArt.jsx': {
    max: 5,
    why: 'The wordmark SVG art, deliberately identical in both themes.',
  },
};

/** Every .js and .jsx under src/ui, recursively, as absolute paths. */
function uiFiles(dir = UI_DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return uiFiles(path);
    return /\.jsx?$/.test(entry.name) ? [path] : [];
  });
}

/*
 * Blank out comments while preserving line numbers, so a failure can point at
 * the line. A prose comment explaining why a literal was retired must not
 * itself count as the literal. Line comments are only recognised when the `//`
 * isn't preceded by a colon, so a `https://` inside a string survives intact.
 */
function stripComments(source) {
  const blank = text => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (match, lead) => lead + blank(match.slice(lead.length)));
}

/** Every banned literal in a file, as `literal (line N)` strings. */
function findLiterals(path) {
  const source = stripComments(readFileSync(path, 'utf8'));
  const hits = [];
  for (const match of source.matchAll(BANNED)) {
    const line = source.slice(0, match.index).split('\n').length;
    hits.push(`${match[0]} (line ${line})`);
  }
  return hits;
}

const FIX_HINT = [
  'Color it with a theme token instead:',
  'var(--ui-text-halo) for text sitting on the board,',
  'var(--ui-border) for hairlines,',
  'var(--ui-overlay-bg) for fills,',
  'var(--ui-text) / var(--ui-text-muted) for ink.',
  'If the literal really is theme-independent (drawn art, the .dw-btn face, an',
  'offset+blur drop shadow), add it to ALLOWED in this file with a reason.',
].join(' ');

describe('theme-blind color literals (#220)', () => {
  const files = uiFiles().sort();

  it('finds the src/ui tree to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map(path => [relative(UI_DIR, path), path]))(
    '%s carries no unallowed black/white literal',
    (name, path) => {
      const hits = findLiterals(path);
      const allowance = ALLOWED[name]?.max ?? 0;
      /*
       * The value under test is the report itself, empty when the file is
       * within its allowance: lint bars expect()'s message argument, so the
       * explanation has to travel as the compared value to reach whoever
       * broke this.
       */
      const report =
        hits.length <= allowance
          ? ''
          : `${name} has ${hits.length} theme-blind color literal(s) — ${hits.join(', ')} — ` +
            `against an allowance of ${allowance}. ${FIX_HINT}`;
      expect(report).toBe('');
    }
  );

  /*
   * The allowlist has to decay with the code it describes: a file renamed or
   * deleted leaves behind an entry that would silently grant its allowance to
   * nothing, and the reason it carried goes stale unread.
   */
  it('has no allowlist entry for a file that no longer exists', () => {
    const stale = Object.keys(ALLOWED).filter(name => !existsSync(join(UI_DIR, name)));
    expect(stale).toEqual([]);
  });

  /*
   * The other half of that decay, and the reason `<=` above is safe: an
   * allowance left standing after its literal was retired is slack, and slack
   * is room for exactly the literal this guard exists to stop — worst of all
   * in the file somebody just finished cleaning. Removing a literal means
   * lowering its `max` in the same breath. A vanished file is skipped rather
   * than read — that failure belongs to the stale-entry check above, which
   * names it properly instead of throwing ENOENT here.
   */
  it('has no allowlist entry looser than the file needs', () => {
    const slack = Object.entries(ALLOWED)
      .filter(([name]) => existsSync(join(UI_DIR, name)))
      .map(([name, { max }]) => ({ name, max, used: findLiterals(join(UI_DIR, name)).length }))
      .filter(({ max, used }) => max > used)
      .map(
        ({ name, max, used }) => `${name} allows ${max - used} more than it carries — max: ${used}`
      );
    expect(slack).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    const unexplained = Object.entries(ALLOWED)
      .filter(([, entry]) => !entry.why)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });
});

/*
 * The guard's own guard. Everything above is only as good as the pattern it
 * scans with, and a regex edit that quietly stops matching would leave every
 * file passing — the failure mode a tripwire cannot afford. BANNED is global
 * and therefore stateful, so each case gets its own copy.
 */
describe('the theme-blind literal pattern', () => {
  const matches = text => new RegExp(BANNED.source, BANNED.flags).test(text);

  it.each([
    "color: '#fff'",
    "color: '#FFFFFF'",
    "background: '#ffffff80'",
    "borderColor: '#fff8'",
    "boxShadow: '0 2px 4px #00000080'",
    "textShadow: '1px 1px 4px rgba(0,0,0,.6)'",
    "color: 'rgb(255,255,255)'",
    "borderColor: 'rgba( 255 , 255 , 255 , 0.3 )'",
    'color: white;',
    "color: 'black'",
    "border: '1px solid white'",
    "textShadow: '0 0 4px black'",
  ])('flags %s', text => {
    expect(matches(text)).toBe(true);
  });

  it.each([
    "color: '#fff3b0'",
    "color: '#fff5e0'",
    "color: '#000a1f'",
    "color: '#935a00'",
    "background: 'var(--ui-overlay-bg)'",
    '  white-space: nowrap;',
    "whiteSpace: 'nowrap'",
    'wrote it on a blackboard',
    'trailing whitespace',
  ])('ignores %s', text => {
    expect(matches(text)).toBe(false);
  });

  /*
   * The other half of a hit: a literal named in prose (this file's own ALLOWED
   * reasons, or a comment recording what a line used to be) must not count as
   * the literal, while a `https://` in live code has to survive the line-comment
   * pass intact.
   */
  it('blanks comments without moving the code around them', () => {
    const source = [
      '/* was #fff */',
      "const a = '#fff'; // now #fff",
      "const b = 'https://x';",
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped.split('\n').map(line => line.length)).toEqual(
      source.split('\n').map(line => line.length)
    );
    expect(stripped.split('\n')[0].trim()).toBe('');
    expect(stripped).toContain("const a = '#fff';");
    expect(stripped).toContain("const b = 'https://x';");
    expect(stripped.split('\n')[1]).not.toContain('now');
  });
});
