// @vitest-environment jsdom
/**
 * Leaderboard tests — focus on the broken-bot flag badge (#92 item 2). The flag decision
 * lives in the JS layer (reportBotErrors); this component only displays the `flagged` prop.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { Leaderboard } from '../../src/ui/Leaderboard.jsx';
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
    // jsdom normalizes the rgba() background; just assert it differs from the unstyled row.
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
   * surface the badge actually sits on, and the thinnest margin of the four. The wash comes
   * from the rendered row rather than a copy of the literal, so the two can't drift apart.
   */
  it.each(['dark', 'light'])('the %s danger color clears 4.5:1 wherever it is used', name => {
    flagOne();
    const rowWash = row('Broken').style.background;
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
