// @vitest-environment jsdom
/**
 * GameOverScreen tests
 *
 * Covers the subtitle the screen shows for each terminal outcome, in particular the
 * turn-cap draw (winner null + gameOverReason 'turnLimit') introduced with the browser
 * stalemate guard — a game that reached the turn cap with no conqueror. Also the
 * rule that neither the heading nor the subtitle is ever set in a seat's board
 * color (#220): the winner's seat rides beside the words as a swatch.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { GameOverScreen } from '../../src/ui/GameOverScreen.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { PLAYER_COLORS_CSS, COLORBLIND_PLAYER_COLORS_CSS } from '../../src/renderer/constants.js';
import { THEMES } from '../../src/renderer/themes.js';
import { contrast, surface, WCAG } from '../helpers/contrast.js';
import { createDailyChallenge } from '../../src/game/dailyChallenge.js';
import { formatDailyShare } from '../../src/game/dailyShare.js';
import { isLeaderboardEnabled } from '../../src/game/dailyLeaderboard.js';
import { createMatchJournal, finishMatchJournal } from '../../src/game/matchJournal.js';
import { createGame } from '../../src/engine/index.js';

/*
 * Agent A's modules. The share text's own wording is pinned in tests/game; what
 * this screen owes is that it composes the right arguments and puts the result
 * where a player can get at it.
 */
vi.mock('../../src/game/dailyShare.js', () => ({
  GAME_URL: 'https://ivanlay.com/dicewarsjs/',
  formatDailyShare: vi.fn(() => 'SHARE TEXT'),
}));

/* Only the on/off switch is faked: `normalizeName` is the rule the confirmation
   and the remembered prefill are held to, so this screen has to run the real one. */
vi.mock('../../src/game/dailyLeaderboard.js', async importOriginal => ({
  ...(await importOriginal()),
  isLeaderboardEnabled: vi.fn(() => false),
}));

let container;
/*
 * A button outside the screen to park focus on. Removed in afterEach rather
 * than inline, so a failing assertion cannot leak a focused control into the
 * next test.
 */
let anchor;

function parkFocusOutside() {
  anchor = document.createElement('button');
  document.body.appendChild(anchor);
  anchor.focus();
  return anchor;
}

/** Render GameOverScreen against a store seeded with the given terminal state. */
function renderGameOver(overrides = {}) {
  const store = createGameStore();
  store.setState({
    gameState: { winner: null, ...overrides.gameState },
    humanPlayerIndex: overrides.humanPlayerIndex ?? null,
    humanEliminated: overrides.humanEliminated ?? false,
    gameOverReason: overrides.gameOverReason ?? null,
    playerNames: overrides.playerNames ?? ['You', 'Blitz', 'Conqueror'],
    rulesOpen: overrides.rulesOpen ?? false,
    // Only when a test asks: setState shallow-merges, so an unconditional key
    // would overwrite the store's own default preferences with a stub. Tested
    // for `undefined` rather than truthiness — `{}` is a deliberate ask for an
    // empty preference set, and reads as truthy anyway.
    ...(overrides.preferences !== undefined ? { preferences: overrides.preferences } : {}),
    ...(overrides.dailyChallenge !== undefined ? { dailyChallenge: overrides.dailyChallenge } : {}),
    ...(overrides.dailyResult !== undefined ? { dailyResult: overrides.dailyResult } : {}),
    ...(overrides.matchJournal !== undefined ? { matchJournal: overrides.matchJournal } : {}),
  });

  const onTitle = overrides.onTitle ?? vi.fn();
  const { onHistory, onSpectate, onRules, onRetry, onSubmitScore } = overrides;
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(
      h(GameOverScreen, {
        store,
        onTitle,
        onHistory,
        onSpectate,
        onRules,
        onRetry,
        onSubmitScore,
      }),
      container
    );
  });
  return { store, container };
}

/** jsdom normalizes hex colors to rgb(); compare against the same normalization. */
function cssColor(hex) {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
}

beforeEach(() => {
  localStorage.clear();
  isLeaderboardEnabled.mockReturnValue(false);
  formatDailyShare.mockReturnValue('SHARE TEXT');
});

afterEach(() => {
  anchor?.remove();
  anchor = null;
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
  vi.restoreAllMocks();
});

describe('GameOverScreen', () => {
  it('shows a draw subtitle when the game ended on the turn cap', () => {
    renderGameOver({ gameState: { winner: null }, gameOverReason: 'turnLimit' });
    expect(container.textContent).toContain('turn limit reached');
  });

  it('names the winning bot when there is a winner', () => {
    renderGameOver({ gameState: { winner: 2 }, humanPlayerIndex: 0 });
    expect(container.textContent).toContain('Conqueror wins');
    expect(container.textContent).not.toContain('Player 3');
    expect(container.textContent).not.toContain('turn limit reached');
  });

  // The human seat's recorded name is "You": the win heading carries a human
  // win, and the generic "<name> wins!" subtitle must not render "You wins!".
  it('shows the win heading, and no "You wins!" subtitle, when the human wins', () => {
    renderGameOver({ gameState: { winner: 0 }, humanPlayerIndex: 0 });
    expect(container.textContent).toContain('W I N');
    expect(container.textContent).not.toContain('wins!');
  });

  // A store that never went through startNewGame (no lineup recorded) still
  // gets a readable subtitle — the seat number, as before bots were named.
  it('falls back to the seat number when no player names are recorded', () => {
    renderGameOver({ gameState: { winner: 2 }, humanPlayerIndex: 0, playerNames: [] });
    expect(container.textContent).toContain('Player 3 wins');
  });

  it('shows the elimination subtitle (not a draw) when the human was eliminated', () => {
    renderGameOver({ gameState: { winner: null }, humanEliminated: true });
    expect(container.textContent).toContain('You were eliminated');
    expect(container.textContent).not.toContain('turn limit reached');
  });

  it('shows no draw subtitle for a normal game-over with no draw reason', () => {
    renderGameOver({ gameState: { winner: null }, gameOverReason: null });
    expect(container.textContent).not.toContain('turn limit reached');
  });

  // The exit button says HOME — it names the destination, and routes through
  // onTitle. The rail's name for that screen is the Battle tab (NAV_TABS in
  // menuChrome.jsx), a label a player who only plays never sees: since #182 the
  // rail is hidden on the landing page, and the title's FooterNav filters that tab out.
  it('labels the exit button HOME, first in its row and named by its own text, and routes it through onTitle', () => {
    const onTitle = vi.fn();
    // With HISTORY and the reference button up too — the row a real game over
    // shows — so "first" has neighbours to be first of.
    renderGameOver({ gameState: { winner: 2 }, onTitle, onHistory: vi.fn(), onRules: vi.fn() });
    const home = [...container.querySelectorAll('button')].find(b => b.textContent === 'HOME');
    expect(home).toBeTruthy();
    expect(home.getAttribute('aria-label')).toBeNull(); // spoken name is the visible name
    // Primary, and first in this screen's own row (App's settings die still precedes it).
    expect([...container.querySelectorAll('button')][0]).toBe(home);
    act(() => home.click());
    expect(onTitle).toHaveBeenCalledTimes(1);
  });

  // Locks the subtitle branch precedence: a real winner must win over a lingering
  // 'turnLimit' reason. gameOverReason is a sticky store field (see GameStore
  // DEFAULT_STATE); if a future reorder let it shadow `winner !== null`, a decisive
  // game could wrongly read "Draw" — this guards against that.
  it('prefers the winner subtitle over a stale turnLimit reason', () => {
    renderGameOver({ gameState: { winner: 2 }, gameOverReason: 'turnLimit' });
    expect(container.textContent).toContain('Conqueror wins');
    expect(container.textContent).not.toContain('turn limit reached');
  });

  /*
   * The heading and the subtitle used to be set in the winner's board color,
   * which the light theme's near-white panel made unreadable — yellow 1.07:1,
   * cyan 1.02:1, and seat 0's lavender (the human's seat, so the "YOU WIN!"
   * heading) 2.47:1, short of even the large-text 3:1 (#220). Words are the
   * theme's ink now; the seat rides beside them as a swatch.
   */
  describe('seat color beside the words, never in them (#220)', () => {
    const heading = () => container.querySelector('h1');
    const subtitleLine = () => [...container.querySelectorAll('p')].find(el => el.textContent);
    const seatSwatch = () => subtitleLine().querySelector('span[aria-hidden="true"]');

    // `undefined`, not `{}`: the default row wants the store's real preferences,
    // and a stub would be the one place colorBlindMode came from nowhere.
    const palettes = [
      ['default', PLAYER_COLORS_CSS, undefined],
      ['color-blind', COLORBLIND_PLAYER_COLORS_CSS, { colorBlindMode: true }],
    ];

    // The human win is the case that used to take seat 0's lavender.
    it.each(palettes)('sets the win heading in the text color (%s)', (_l, _p, preferences) => {
      renderGameOver({ gameState: { winner: 0 }, humanPlayerIndex: 0, preferences });
      expect(heading().textContent).toContain('W I N');
      expect(heading().style.color).toBe('var(--ui-text)');
    });

    it.each(palettes)('sets the loss heading in the text color (%s)', (_l, _p, preferences) => {
      renderGameOver({ gameState: { winner: 2 }, humanPlayerIndex: 0, preferences });
      expect(heading().textContent).toContain('O V E R');
      expect(heading().style.color).toBe('var(--ui-text)');
    });

    it.each(palettes)('gives the winner subtitle a %s swatch', (_label, palette, preferences) => {
      renderGameOver({ gameState: { winner: 2 }, humanPlayerIndex: 0, preferences });
      expect(subtitleLine().textContent).toBe('Conqueror wins!');
      expect(seatSwatch().style.background).toBe(cssColor(palette[2]));
      expect(subtitleLine().style.color).toBe('var(--ui-text)');
    });

    /*
     * The two subtitles that name no seat, so neither may carry a swatch. The
     * elimination one needs a live `winner` beside it to be worth anything: the
     * ordinary loss (someone did win, but the line is about you) is the case
     * where a seat is in hand and must still be left out, and without it a
     * `subtitleSeat = winner` would sail through green.
     */
    it('gives the eliminated subtitle no swatch, even when another seat won', () => {
      renderGameOver({ gameState: { winner: 2 }, humanPlayerIndex: 0, humanEliminated: true });
      expect(subtitleLine().textContent).toBe('You were eliminated!');
      expect(seatSwatch()).toBeNull();
    });

    it('gives the draw subtitle no swatch', () => {
      renderGameOver({ gameState: { winner: null }, gameOverReason: 'turnLimit' });
      expect(subtitleLine().textContent).toBe('Draw: turn limit reached');
      expect(seatSwatch()).toBeNull();
    });

    /*
     * Walk everything rendered, not just the two lines: a future line reaching
     * for a seat color as text should fail here as well. Over every terminal
     * outcome the screen can show, not the winner one alone — the walk is a net
     * for lines that do not exist yet, and it can only catch them on the branch
     * it happens to render.
     */
    const outcomes = [
      ['a human win', { gameState: { winner: 0 }, humanPlayerIndex: 0 }],
      ['an AI win', { gameState: { winner: 2 }, humanPlayerIndex: 0 }],
      ['an elimination', { gameState: { winner: 2 }, humanPlayerIndex: 0, humanEliminated: true }],
      ['a draw', { gameState: { winner: null }, gameOverReason: 'turnLimit' }],
    ];
    const paletteOutcomes = palettes.flatMap(([label, palette, preferences]) =>
      outcomes.map(([outcome, fixture]) => [label, outcome, palette, preferences, fixture])
    );

    it.each(paletteOutcomes)(
      'sets no text in a %s palette color after %s',
      (_label, _outcome, palette, preferences, fixture) => {
        renderGameOver({ ...fixture, preferences });
        // The walk is vacuous on an empty container, so pin that it rendered.
        expect(heading().textContent).toBeTruthy();
        const seatColors = palette.map(cssColor);
        for (const el of container.querySelectorAll('*')) {
          expect(seatColors).not.toContain(el.style.color);
        }
      }
    );

    /*
     * And the ink the words use does read: measured against this screen's own
     * panel — the overlay flattened over the page, since it is translucent.
     */
    it.each(['dark', 'light'])('clears 4.5:1 in the %s theme', name => {
      const theme = THEMES[name];
      const panel = surface(theme.bodyBg, theme.uiOverlayBg);
      expect(contrast(theme.uiText, panel)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
    });
  });

  /*
   * The rules reference, reachable from the end of a game — where a rule you
   * only half-understood is worth looking up. Quieter than its neighbours:
   * HOME is what you came here to press.
   */
  describe('how to play button', () => {
    const rulesBtn = () =>
      container.querySelector('button[aria-label="How to play: the rules in one card"]');

    it('reports its clicks without leaving the screen', () => {
      const onRules = vi.fn();
      const onTitle = vi.fn();
      renderGameOver({ gameState: { winner: 2 }, onRules, onTitle });

      const button = rulesBtn();
      expect(button.textContent.trim()).toBe('HOW TO PLAY');
      act(() => button.click());

      expect(onRules).toHaveBeenCalledTimes(1);
      expect(onTitle).not.toHaveBeenCalled();
    });

    it('is left out when no handler is supplied', () => {
      renderGameOver({ gameState: { winner: 2 } });
      expect(rulesBtn()).toBeNull();
    });
  });

  // #189: the game ends on its own, so focus is on the canvas or nowhere —
  // this screen has to take it, and HOME is its primary action.
  it('moves focus onto HOME when it mounts', () => {
    renderGameOver({ gameState: { winner: 2 } });
    const home = [...container.querySelectorAll('button')].find(b => b.textContent === 'HOME');
    expect(document.activeElement).toBe(home);
  });

  /*
   * ...and lets the browser scroll it into view. The card scrolls now
   * (`overflowY: auto`, and on a daily it carries the match report and the
   * share block above the buttons), so on a short window HOME can start below
   * the fold — where `preventScroll` would leave the keyboard on a control
   * nobody can see. The flag belongs to the screens whose primary control is
   * always already visible, and this stopped being one of them.
   */
  it('claims HOME without refusing to scroll it into view', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderGameOver({ gameState: { winner: 2 } });
    expect(focus).toHaveBeenCalled();
    expect(focus.mock.calls.at(-1)).toEqual([]);
  });

  /*
   * ...unless the card carries a scored daily result. Then the report and the
   * share block sit ABOVE the button row, HOME is the last thing in the DOM,
   * and claiming it there put COPY RESULT, the name field and POST behind a
   * Shift+Tab — while the focus scroll pushed the result itself off the top of
   * a phone screen. The one claim goes to the block's first control instead.
   */
  it('claims the share block’s first control after a scored daily', () => {
    const store = createGameStore();
    store.setState({
      gameState: { winner: 0 },
      humanPlayerIndex: 0,
      dailyChallenge: createDailyChallenge('2026-09-07'),
      dailyResult: {
        available: true,
        official: true,
        streak: 3,
        outcome: { won: true, drew: false, turns: 9, attacks: 37, captures: 36 },
        record: { official: { won: true, turns: 9, submission: null }, practice: 0 },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => render(h(GameOverScreen, { store, onTitle: vi.fn() }), container));

    const copy = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'COPY RESULT'
    );
    expect(document.activeElement).toBe(copy);
    // Still exactly one claim, and still not `preventScroll` — the card
    // scrolls, so refusing to scroll would strand the keyboard off screen.
  });

  /* A practice run has no share block, so HOME is the primary action again. */
  it('keeps HOME for a practice daily run', () => {
    renderGameOver({
      gameState: { winner: 2 },
      humanPlayerIndex: 0,
      dailyChallenge: { ...createDailyChallenge('2026-09-07'), practice: true },
      dailyResult: { available: true, official: false, streak: 3, record: null },
    });
    const home = [...container.querySelectorAll('button')].find(b => b.textContent === 'HOME');
    expect(document.activeElement).toBe(home);
  });

  // The "How to play" card survives the game ending behind it and owns focus
  // while it is up; mounting under its scrim must not pull focus out of it.
  it('leaves focus alone when it mounts behind an open rules card', () => {
    const parked = parkFocusOutside();

    renderGameOver({ gameState: { winner: 2 }, rulesOpen: true });
    expect(document.activeElement).toBe(parked);
  });

  // ...and takes HOME the moment that card closes: the one claim, deferred.
  it('claims HOME once the rules card closes', () => {
    parkFocusOutside();
    const { store } = renderGameOver({ gameState: { winner: 2 }, rulesOpen: true });

    act(() => store.setState({ rulesOpen: false }));
    const home = [...container.querySelectorAll('button')].find(b => b.textContent === 'HOME');
    expect(document.activeElement).toBe(home);
  });

  // Exactly once: a card opened afterwards from this screen hands focus back
  // to whatever opened it (RulesModal's job), and this effect must not
  // second-guess that by grabbing HOME again.
  it('does not take HOME a second time when a later card closes', () => {
    const { store } = renderGameOver({ gameState: { winner: 2 } });
    const parked = parkFocusOutside();

    act(() => store.setState({ rulesOpen: true }));
    act(() => store.setState({ rulesOpen: false }));
    expect(document.activeElement).toBe(parked);
  });
});

describe('GameOverScreen — heading legibility (#220)', () => {
  /*
   * This heading sits on the screen's own overlay, not the board, so its shadow
   * is depth rather than legibility — but it was a fixed dark one, which the
   * light theme turned into a smudge under navy text. The halo token is the
   * theme-aware version: dark ink under white, near-invisible pale ink in the
   * light theme, whose own ink is pale.
   */
  it('draws the heading shadow from the halo token', () => {
    renderGameOver({ gameState: { winner: 2 } });
    expect(container.querySelector('h1').style.textShadow).toBe('var(--ui-text-halo)');
  });

  // What actually carries the heading, shadow or no shadow: the overlay it sits
  // on, flattened over the page since it is translucent.
  it.each(['dark', 'light'])('reads at 4.5:1 on the %s overlay', name => {
    const theme = THEMES[name];
    const backing = surface(theme.bodyBg, theme.uiOverlayBg);
    expect(contrast(theme.uiText, backing)).toBeGreaterThanOrEqual(WCAG.AA_TEXT);
  });
});

/*
 * The end of a Daily Conquest run — the only screen where the scored result is
 * in the player's hands. Two decisions are on trial here: that the FIRST
 * finished attempt is the scored one (so the replay button says PRACTICE
 * AGAIN, not TRY AGAIN, and a later run says outright that it is not scored),
 * and that the result can leave the browser — copied, shared, posted — without
 * the page ever depending on a clipboard or a network that might not be there.
 */
describe('GameOverScreen — a scored daily result', () => {
  const DAILY = createDailyChallenge('2026-09-07');

  const finishedJournal = () => {
    const state = createGame({ seed: 17, playerCount: 4 });
    return finishMatchJournal(createMatchJournal(state, 0), { ...state, winner: 0 });
  };

  /**
   * A store at the end of the day's scored attempt.
   *
   * `outcome` is the controller's frozen verdict for THIS attempt and the only
   * thing the share text reads; `record` is what storage kept, and is consulted
   * only for the leaderboard `submission`. They are separate arguments here
   * because the screen must not confuse them — and because `record` can be null
   * (a browser that refuses storage) while `outcome` is still perfectly good.
   */
  const officialResult = (outcome = {}, { official = {}, record, ...extra } = {}) => ({
    available: true,
    official: true,
    streak: 3,
    outcome: { won: true, drew: false, turns: 9, attacks: 37, captures: 36, ...outcome },
    record:
      record === null
        ? null
        : {
            official: {
              won: true,
              turns: 9,
              attacks: 37,
              captures: 36,
              submission: null,
              ...official,
            },
            practice: 0,
          },
    ...extra,
  });

  const renderDaily = (overrides = {}) =>
    renderGameOver({
      gameState: { winner: 0 },
      humanPlayerIndex: 0,
      dailyChallenge: DAILY,
      dailyResult: officialResult(),
      matchJournal: finishedJournal(),
      ...overrides,
    });

  const btn = label =>
    [...container.querySelectorAll('button')].find(b => b.textContent.startsWith(label));

  describe('the button row', () => {
    it('labels the replay button PRACTICE AGAIN on a daily, and puts HOME first', () => {
      const onRetry = vi.fn();
      renderDaily({ onRetry, onHistory: vi.fn(), onRules: vi.fn() });

      const labels = [...container.querySelectorAll('button')]
        .map(b => b.textContent.trim())
        .filter(label => !label.startsWith('COPY') && label !== 'SHARE' && label !== 'POST');
      expect(labels).toEqual(['HOME', 'PRACTICE AGAIN', 'HISTORY', 'HOW TO PLAY']);

      act(() => btn('PRACTICE AGAIN').click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps TRY AGAIN for an ordinary game', () => {
      const onRetry = vi.fn();
      renderGameOver({ gameState: { winner: 2 }, onRetry });

      expect(btn('TRY AGAIN')).toBeTruthy();
      expect(btn('PRACTICE AGAIN')).toBeUndefined();
      act(() => btn('TRY AGAIN').click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('the share block', () => {
    it('composes the share text from the controller’s frozen outcome', () => {
      renderDaily();
      expect(formatDailyShare).toHaveBeenCalledWith({
        date: '2026-09-07',
        won: true,
        turns: 9,
        attacks: 37,
        captures: 36,
        streak: 3,
        drew: false,
      });
    });

    /* The draw flag is the controller's, computed at game over from this
       attempt's journal and the draw reason. */
    it('marks a turn-cap draw as a draw', () => {
      renderDaily({
        gameState: { winner: null },
        gameOverReason: 'turnLimit',
        dailyResult: officialResult({ won: false, drew: true, turns: 40 }),
      });
      expect(formatDailyShare).toHaveBeenCalledWith(expect.objectContaining({ drew: true }));
    });

    /*
     * ...and NOT recomputed here from `winner`/`gameOverReason`. A player who
     * was eliminated and then spectated on watches the survivors reach the turn
     * cap, so the screen's own state says "winner: null, turnLimit" — while the
     * record, the title card and the leaderboard all say eliminated. The share
     * text is the copy of the four that gets pasted somewhere public, so it
     * follows the frozen outcome rather than the board it happens to be over.
     */
    it('does not call a spectated turn-cap ending a draw for an eliminated player', () => {
      renderDaily({
        gameState: { winner: null },
        gameOverReason: 'turnLimit',
        humanEliminated: true,
        dailyResult: officialResult({ won: false, drew: false, turns: 12 }),
      });
      expect(formatDailyShare).toHaveBeenCalledWith(
        expect.objectContaining({ drew: false, won: false, turns: 12 })
      );
    });

    /*
     * Storage and sharing are independent. `submitDailyScore` needs the
     * challenge, the verdict and the replay — none of which live in the record —
     * so a browser that refuses storage must still be able to copy and post the
     * result it just earned. The block used to be gated on `record.official`,
     * and vanished entirely in private mode.
     */
    it('still offers the result when storage refused to keep it', () => {
      isLeaderboardEnabled.mockReturnValue(true);
      renderDaily({
        dailyResult: officialResult({}, { record: null, available: false }),
        onSubmitScore: vi.fn(),
      });

      expect(btn('COPY RESULT')).toBeTruthy();
      expect(btn('POST')).toBeTruthy();
      expect(formatDailyShare).toHaveBeenCalledWith(expect.objectContaining({ turns: 9 }));
    });

    /* No verdict from the controller means nothing to share. */
    it('shows no block at all without an outcome', () => {
      renderDaily({ dailyResult: { available: true, official: true, streak: 3, record: null } });
      expect(btn('COPY RESULT')).toBeUndefined();
    });

    /*
     * The confirmation is a SIBLING of the buttons, not part of one's name. It
     * used to be a live span inside COPY RESULT, which mutates the accessible
     * name of the control the player is standing on — a change screen readers
     * announce inconsistently, and one that leaves the button called "COPY
     * RESULT · Copied" for as long as it is up. The live element is also
     * present and empty BEFORE the copy: a region that only appears once there
     * is something to say is not reliably announced at all.
     */
    it('confirms the copy in a live region beside the buttons, not inside one', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      renderDaily();

      const live = container.querySelector('[aria-live]');
      expect(live).toBeTruthy();
      expect(live.textContent).toBe('');
      expect(live.closest('button')).toBeNull();

      await act(async () => {
        btn('COPY RESULT').click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith('SHARE TEXT');
      expect(container.querySelector('[aria-live]').textContent).toContain('Copied');
      // Visible, unlike the post confirmation: no other control shows it.
      expect(container.querySelector('[aria-live] span').className).toBeFalsy();
      expect(btn('COPY RESULT').textContent).toBe('COPY RESULT');
      // Exactly one, and it is not a second `role="status"`: this screen already
      // has one live region of that kind and it is App's ScreenReaderAnnouncer.
      expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
      expect(container.querySelector('[role="status"]')).toBeNull();
      vi.unstubAllGlobals();
    });

    /* No clipboard (an insecure context) must not mean no result: the text
       itself is offered, selectable, in a readonly field. */
    it('falls back to a selectable field when there is no clipboard', () => {
      vi.stubGlobal('navigator', {});
      renderDaily();

      act(() => btn('COPY RESULT').click());

      const field = container.querySelector('textarea');
      expect(field.value).toBe('SHARE TEXT');
      expect(field.readOnly).toBe(true);
      vi.unstubAllGlobals();
    });

    it('falls back the same way when writeText rejects', async () => {
      vi.stubGlobal('navigator', {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      });
      renderDaily();

      await act(async () => {
        btn('COPY RESULT').click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(container.querySelector('textarea')?.value).toBe('SHARE TEXT');
      expect(container.textContent).not.toContain('denied');
      vi.unstubAllGlobals();
    });

    it('offers SHARE only where the platform has a share sheet', () => {
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
      renderDaily();
      expect(btn('SHARE')).toBeUndefined();
      act(() => render(null, container));

      const share = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { share, clipboard: { writeText: vi.fn() } });
      renderDaily();
      act(() => btn('SHARE').click());
      expect(share).toHaveBeenCalledWith({ text: 'SHARE TEXT' });
      vi.unstubAllGlobals();
    });

    /* Dismissing the share sheet is the user saying no, and gets no answer. */
    it('says nothing when the share sheet is cancelled', async () => {
      const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
      vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(abort) });
      renderDaily();

      await act(async () => {
        btn('SHARE').click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(container.querySelector('textarea')).toBeNull();
      expect(container.querySelector('[aria-live]').textContent).toBe('');
      vi.unstubAllGlobals();
    });

    /* Anything else IS a failure, and the result must still be reachable — the
       same readonly field the clipboard falls back to. Swallowing every
       rejection alike left the button looking like it had worked. */
    it('falls back to the selectable field when the share sheet fails', async () => {
      vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new Error('no target')) });
      renderDaily();

      await act(async () => {
        btn('SHARE').click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(container.querySelector('textarea')?.value).toBe('SHARE TEXT');
      expect(container.textContent).not.toContain('no target');
      vi.unstubAllGlobals();
    });
  });

  describe('the leaderboard form', () => {
    beforeEach(() => isLeaderboardEnabled.mockReturnValue(true));

    it('is absent entirely when no leaderboard is configured', () => {
      isLeaderboardEnabled.mockReturnValue(false);
      renderDaily({ onSubmitScore: vi.fn() });
      expect(btn('POST')).toBeUndefined();
      expect(container.querySelector('input')).toBeNull();
    });

    /** Type into the name field, the way the player does. */
    const typeName = value => {
      const input = container.querySelector('input');
      input.value = value;
      act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
      return input;
    };

    /*
     * The row STAYS. It used to be replaced by a static sentence on success,
     * which unmounted the button the player had just pressed: focus fell to the
     * body, and nothing was announced — the two failures compounding, since a
     * screen reader user was left with no focus AND no message. The button
     * becomes the confirmation instead, the field goes read-only beside it, and
     * the live region says what happened.
     */
    it('posts the typed name, keeps focus, and announces the rank', async () => {
      const onSubmitScore = vi.fn().mockResolvedValue({ accepted: true, rank: 4 });
      renderDaily({ onSubmitScore });

      typeName('ACE');
      const posting = btn('POST');
      posting.focus();
      await act(async () => {
        posting.click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(onSubmitScore).toHaveBeenCalledWith('ACE');
      // Same element, new content — so focus never went anywhere.
      expect(document.activeElement).toBe(posting);
      expect(posting.textContent).toBe('Posted as ACE · #4');
      expect(posting.getAttribute('aria-disabled')).toBe('true');
      expect(container.querySelector('input').disabled).toBe(true);
      // ...and the outcome is announced from the live element beside it, whose
      // text is clipped rather than printed: the button already shows this
      // line, and the card should not say it twice.
      expect(container.querySelector('[aria-live]').textContent).toBe('Posted as ACE · #4');
      expect(container.querySelector('[aria-live] span').className).toBe('sr-only');
      // ...and the name is remembered for tomorrow's run.
      expect(localStorage.getItem('dicewars_daily_name')).toBe('ACE');
    });

    /*
     * The server trims and collapses whitespace before it stores a name, so the
     * confirmation and the remembered prefill have to be the NORMALIZED form —
     * otherwise tomorrow's field is prefilled with something the leaderboard
     * never shows. The raw value is still what gets submitted: rejecting it here
     * would duplicate the controller's own validation and its coded message.
     */
    it('confirms and remembers the normalized name, not the raw input', async () => {
      const onSubmitScore = vi.fn().mockResolvedValue({ rank: 2 });
      renderDaily({ onSubmitScore });

      typeName('  big   ace  ');
      await act(async () => {
        btn('POST').click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(onSubmitScore).toHaveBeenCalledWith('  big   ace  ');
      expect(container.textContent).toContain('Posted as big ace · #2');
      expect(localStorage.getItem('dicewars_daily_name')).toBe('big ace');
      expect(container.querySelector('input').value).toBe('big ace');
    });

    /* Enter in a one-field form is how the field is submitted everywhere else
       on the web; it used to do nothing here. */
    it('posts on Enter in the name field', async () => {
      const onSubmitScore = vi.fn().mockResolvedValue({ rank: 7 });
      renderDaily({ onSubmitScore });

      typeName('ACE');
      const form = container.querySelector('form');
      expect(btn('POST').getAttribute('type')).toBe('submit');
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      expect(onSubmitScore).toHaveBeenCalledWith('ACE');
      expect(container.textContent).toContain('Posted as ACE · #7');
    });

    /*
     * A failure was rendered as an ordinary `<p>` — muted helper type, silent
     * to a screen reader, sitting under a form that still looked ready. It goes
     * to the same live region as every other outcome, and in the danger color.
     */
    it('announces the error’s own message in the danger color and leaves the form up', async () => {
      const onSubmitScore = vi.fn().mockRejectedValue(new Error('That name is taken.'));
      renderDaily({ onSubmitScore });

      await act(async () => {
        btn('POST').click();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });

      const live = container.querySelector('[aria-live]');
      expect(live.textContent).toBe('That name is taken.');
      expect(live.className).toContain('dw-daily-live-error');
      expect(container.querySelector('style').textContent).toContain(
        '.dw-daily-live-error { color: var(--ui-danger); }'
      );
      // Still postable: the name may just need changing.
      expect(btn('POST')).toBeTruthy();
      expect(container.querySelector('input').disabled).toBe(false);
    });

    /* A double-tap must not post twice; the control stays in the tab order
       while it is unavailable (aria-disabled, not disabled). */
    it('refuses a second post while the first is in flight', () => {
      let settle;
      const onSubmitScore = vi.fn(
        () =>
          new Promise(resolve => {
            settle = resolve;
          })
      );
      renderDaily({ onSubmitScore });

      act(() => btn('POST').click());
      const posting = btn('POSTING');
      expect(posting.getAttribute('aria-disabled')).toBe('true');
      expect(posting.hasAttribute('disabled')).toBe(false);
      act(() => posting.click());
      expect(onSubmitScore).toHaveBeenCalledTimes(1);
      settle({ rank: 1 });
    });

    it('prefills the name last posted, and caps it at 16 characters', () => {
      localStorage.setItem('dicewars_daily_name', 'REMEMBERED');
      renderDaily({ onSubmitScore: vi.fn() });

      const input = container.querySelector('input');
      expect(input.value).toBe('REMEMBERED');
      expect(input.maxLength).toBe(16);
      expect(container.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
    });

    it('survives a browser that refuses storage', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      renderDaily({ onSubmitScore: vi.fn() });
      expect(container.querySelector('input').value).toBe('');
    });

    /* An already-submitted result comes back as the confirmation, on the same
       row, with the field read-only — never a second chance to post. */
    it('shows the recorded submission in place of the POST action', () => {
      renderDaily({
        dailyResult: officialResult({}, { official: { submission: { name: 'ACE', rank: 4 } } }),
        onSubmitScore: vi.fn(),
      });
      expect(container.textContent).toContain('Posted as ACE · #4');
      expect(btn('POST')).toBeUndefined();
      expect(container.querySelector('input').disabled).toBe(true);
      expect(container.querySelector('input').value).toBe('ACE');
    });

    /* ...and pressing it anyway posts nothing. */
    it('refuses a second post of a result already on the board', () => {
      const onSubmitScore = vi.fn();
      renderDaily({
        dailyResult: officialResult({}, { official: { submission: { name: 'ACE', rank: 4 } } }),
        onSubmitScore,
      });
      act(() => container.querySelector('form').querySelector('button').click());
      expect(onSubmitScore).not.toHaveBeenCalled();
    });
  });

  describe('a practice run', () => {
    it('says it is not scored, and offers neither share nor post', () => {
      isLeaderboardEnabled.mockReturnValue(true);
      renderDaily({
        dailyChallenge: { ...DAILY, practice: true },
        dailyResult: { available: true, official: false, streak: 3, record: null },
        onRetry: vi.fn(),
      });

      expect(container.textContent).toContain('Practice run · not scored');
      expect(btn('COPY RESULT')).toBeUndefined();
      expect(btn('POST')).toBeUndefined();
      expect(btn('PRACTICE AGAIN')).toBeTruthy();
    });
  });
});
