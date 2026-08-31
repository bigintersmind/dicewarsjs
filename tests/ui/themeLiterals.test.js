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
 * This is the tripwire. Every `.jsx` file under `src/ui/` is scanned for the
 * pure black/white literals, comments excluded, and compared against an explicit
 * allowance. The comparison is `<=`, not `===`: a new literal fails, while
 * retiring one passes — so a branch that removes a literal doesn't have to
 * update a count it never touched.
 *
 * Everything in ALLOWED is a literal that is genuinely theme-independent — art,
 * the classic-button identity face, an offset+blur drop shadow — or is somebody
 * else's open item, noted as such. It is not a list of things to get around to.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const UI_DIR = resolve(process.cwd(), 'src/ui');

/*
 * Pure black and white only. Word-bounded by a negative lookahead so a longer
 * hex that merely starts with the same digits (`#fff3b0`, `#000a1f`) isn't
 * caught, and longest-first so `#ffffff` counts once rather than as `#fff`
 * plus a tail. `rgb()` is included alongside `rgba()`: opaque black is no more
 * theme-aware than translucent black.
 */
const BANNED =
  /#(?:ffffff|fff)(?![0-9a-f])|#(?:000000|000)(?![0-9a-f])|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)]/gi;

/**
 * What each file is allowed to carry, and why. `max` is a ceiling, never a
 * target. Note that `menuChrome.jsx` and `SettingsPanel.jsx` are being thinned
 * by sibling #220 branches as this lands, so their allowances are today's
 * counts and are expected to fall — under `<=` semantics that needs no edit
 * here.
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
    why: 'The die art’s pips plus panel/bevel drop shadows. Being thinned by a sibling #220 branch.',
  },
  'TitleScreen.jsx': {
    max: 1,
    why: 'Offset+blur drop shadow under the wordmark.',
  },
  'menuChrome.jsx': {
    max: 6,
    why: 'The .dw-btn white face and its drop edges, plus the headline bevel — deliberate identity chrome. Being thinned by a sibling #220 branch.',
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

/** Every .jsx under src/ui, recursively, as absolute paths. */
function uiFiles(dir = UI_DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return uiFiles(path);
    return entry.name.endsWith('.jsx') ? [path] : [];
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

  it('gives every allowlist entry a reason', () => {
    const unexplained = Object.entries(ALLOWED)
      .filter(([, entry]) => !entry.why)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });
});
