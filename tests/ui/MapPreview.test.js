// @vitest-environment jsdom
/**
 * MapPreview tests
 *
 * Covers the PLAY / NEW MAP / ← BACK action dock (three verbs replacing the
 * old "Play this board? YES / NO" gate), the setup eyebrow, the way back out to
 * the title/setup screen (#180 — button + Escape), and the bot-load notice
 * banner that warns, before the player commits to the board, when a chosen
 * community bot failed to load and was replaced by the default AI.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { MapPreview, describeSetup } from '../../src/ui/MapPreview.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

function renderPreview(overrides = {}) {
  const store = createGameStore(overrides);
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const onBack = vi.fn();

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(MapPreview, { store, onAccept, onReject, onBack }), container);
  });

  return { store, onAccept, onReject, onBack };
}

const backBtn = () => container.querySelector('button[aria-label="Back to setup"]');
const buttonByText = text =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent.trim() === text);

/** Escape as the browser fires it: bubbling and cancelable. */
const pressEscape = (target = window) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
  });

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('describeSetup', () => {
  it('names players, map size and difficulty preset in plain case', () => {
    expect(describeSetup({ playerCount: 7, mapSize: 'medium', difficulty: 'hard' })).toBe(
      '7 players · medium map · hard'
    );
  });

  it('says "custom" for a hand-picked lineup', () => {
    expect(describeSetup({ playerCount: 4, mapSize: 'small', difficulty: 'custom' })).toBe(
      '4 players · small map · custom'
    );
  });

  it('leaves out anything missing or unrecognised rather than printing junk', () => {
    expect(describeSetup({ playerCount: 5 })).toBe('5 players');
    expect(describeSetup({ mapSize: 'large', difficulty: 'nightmare' })).toBe('large map');
    expect(describeSetup({ playerCount: '7', mapSize: 42 })).toBe('');
    expect(describeSetup()).toBe('');
  });

  /*
   * The luck part is read off the engine's resolved handicap, not the store's
   * remembered rung: they differ for a spectator game, which keeps the pick but
   * derives no handicap (see the render cases below).
   */
  const SETUP = { playerCount: 7, mapSize: 'medium', difficulty: 'custom' };

  it('names the luck rung the game is actually being played at (#179)', () => {
    expect(describeSetup(SETUP, { playerId: 0, level: 1 })).toBe(
      '7 players · medium map · custom · lucky'
    );
    expect(describeSetup(SETUP, { playerId: 0, level: 2 })).toBe(
      '7 players · medium map · custom · very lucky'
    );
  });

  it('says nothing about luck without a handicap', () => {
    const plain = '7 players · medium map · custom';
    expect(describeSetup(SETUP, null)).toBe(plain);
    expect(describeSetup(SETUP)).toBe(plain);
    // The remembered rung alone never prints — only the engine's handicap does.
    expect(describeSetup({ ...SETUP, luck: 2 }, null)).toBe(plain);
  });

  /*
   * The engine accepts levels the ladder doesn't name (up to MAX_HANDICAP_LEVEL).
   * An active handicap must still show up — printing nothing would make the line
   * identical to a fair game's, which is a false claim, not a missing detail.
   */
  it('still flags an active handicap whose level the ladder cannot name', () => {
    expect(describeSetup(SETUP, { playerId: 0, level: 8 })).toBe(
      '7 players · medium map · custom · luck level 8'
    );
  });
});

describe('MapPreview', () => {
  it('shows PLAY, NEW MAP and BACK — no yes/no question, no alert banner by default', () => {
    renderPreview();
    expect(buttonByText('PLAY')).toBeTruthy();
    expect(buttonByText('NEW MAP')).toBeTruthy();
    expect(backBtn()).toBeTruthy();
    expect(container.textContent).not.toContain('Play this board?');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('describes the current setup above the buttons (what BACK would change)', () => {
    renderPreview({ config: { playerCount: 5, mapSize: 'large', difficulty: 'hard' } });
    expect(container.textContent).toContain('5 players · large map · hard');
  });

  it("describes the store's default setup", () => {
    renderPreview();
    expect(container.textContent).toContain('7 players · medium map · standard');
  });

  it("names the eyebrow's luck from the game being previewed (#179)", () => {
    renderPreview({
      config: { playerCount: 4, mapSize: 'medium', difficulty: 'hard', luck: 1 },
      gameState: { config: { handicap: { playerId: 0, level: 1 } } },
    });
    expect(container.textContent).toContain('lucky');
  });

  it('says nothing about luck on a spectator board that kept the rung', () => {
    /*
     * The controller stores the picked rung even for AI vs AI, where there is no
     * human seat, so the engine's handicap is null. Reading config.luck here
     * would label this board "very lucky" — it isn't.
     */
    renderPreview({
      config: { playerCount: 4, mapSize: 'medium', difficulty: 'hard', luck: 2 },
      gameState: { config: { handicap: null } },
    });
    expect(container.textContent).toContain('4 players · medium map · hard');
    expect(container.textContent).not.toContain('lucky');
  });

  it('PLAY starts the game and NEW MAP rerolls the board', () => {
    const { onAccept, onReject, onBack } = renderPreview();

    act(() => buttonByText('PLAY').click());
    expect(onAccept).toHaveBeenCalledTimes(1);

    act(() => buttonByText('NEW MAP').click());
    expect(onReject).toHaveBeenCalledTimes(1);

    expect(onBack).not.toHaveBeenCalled();
  });

  it('focuses PLAY on arrival so Enter carries straight through from START', () => {
    renderPreview();
    expect(document.activeElement).toBe(buttonByText('PLAY'));
  });

  it('offers a way back to the setup screen beside PLAY / NEW MAP', () => {
    const { onBack, onAccept, onReject } = renderPreview();

    const back = backBtn();
    expect(back).toBeTruthy();
    expect(back.textContent).toContain('BACK');
    act(() => back.click());

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('omits the BACK button when no onBack is supplied', () => {
    const store = createGameStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      render(h(MapPreview, { store, onAccept: vi.fn(), onReject: vi.fn() }), container);
    });
    expect(backBtn()).toBeNull();
    expect(buttonByText('PLAY')).toBeTruthy();
  });

  it('returns to the setup screen on Escape', () => {
    const { onBack } = renderPreview();
    pressEscape();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape another handler already consumed (open settings dropdown)', () => {
    const { onBack } = renderPreview();
    const consume = e => e.preventDefault();
    document.addEventListener('keydown', consume);
    try {
      pressEscape(document);
    } finally {
      document.removeEventListener('keydown', consume);
    }
    expect(onBack).not.toHaveBeenCalled();
  });

  it('ignores other keys and stops listening once unmounted', () => {
    const { onBack } = renderPreview();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onBack).not.toHaveBeenCalled();

    act(() => render(null, container));
    pressEscape();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('surfaces aiLoadWarnings as an alert banner so the fallback is not silent', () => {
    const message =
      'Player 2: community bot "broken/bot" could not load — using Default AI instead.';
    renderPreview({ aiLoadWarnings: [message] });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('broken/bot');
  });
});
