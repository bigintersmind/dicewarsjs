// @vitest-environment jsdom
/**
 * D-27 UI regression: the Arena and Tournament bot-selection screens must render
 * the *player-visible* roster only.
 *
 * The whole point of [D-27] is that players see the three self-play personas and
 * NOT the internal dev-harness nets (`BC`/`PPO`). `builtInBotsRegistry.test.js`
 * pins the DATA contract (`PLAYER_VISIBLE_BOTS` composition), but the screens could
 * still regress at the UI seam: both were rerouted `BUILT_IN_BOTS` →
 * `PLAYER_VISIBLE_BOTS`, and swapping that one import back would re-leak BC/PPO into
 * the picker with every data-layer test still green. These render tests assert the
 * actual rendered buttons, so that regression turns red here.
 *
 * Selection state on these pickers is conveyed solely by `aria-pressed`
 * (menuChrome's `.dw-opt` styling keys off it), so its default + toggle wiring
 * is pinned here too.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ArenaScreen } from '../../src/ui/ArenaScreen.jsx';
import { TournamentScreen } from '../../src/ui/TournamentScreen.jsx';

let container;

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

function mount(Component) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(Component, { onViewReplay: vi.fn() }), container);
  });
  return container;
}

/** Trimmed text of every rendered button (bot buttons carry the bare bot name). */
const buttonLabels = () => [...container.querySelectorAll('button')].map(b => b.textContent.trim());

describe.each([
  ['Arena', ArenaScreen],
  ['Tournament', TournamentScreen],
])('%s bot picker roster (D-27)', (_label, Component) => {
  it('renders the three self-play personas as selectable bots', () => {
    mount(Component);
    const labels = buttonLabels();
    for (const persona of ['Conqueror', 'Blitz', 'Survivor']) {
      expect(labels).toContain(persona);
    }
  });

  it('never renders the hidden dev-harness nets (BC/PPO) as bots', () => {
    mount(Component);
    const labels = buttonLabels();
    // Exact-match (not substring) so a "BC"/"PPO" bot button re-leaking here fails,
    // while incidental copy that merely contains those letters does not.
    expect(labels).not.toContain('BC');
    expect(labels).not.toContain('PPO');
  });

  it('groups the personas under Self-play bots, apart from General bots', () => {
    mount(Component);
    const selfPlay = container.querySelector('[role="group"][aria-label="Self-play bots"]');
    const general = container.querySelector('[role="group"][aria-label="General bots"]');
    expect(selfPlay).not.toBeNull();
    expect(general).not.toBeNull();
    // The Self-play group holds exactly the three personas — a fourth entry or a
    // stray general bot landing here should be a conscious roster decision.
    const personas = [...selfPlay.querySelectorAll('button')].map(b => b.textContent.trim());
    expect(personas).toEqual(['Conqueror', 'Blitz', 'Survivor']);
  });

  it('marks selection with aria-pressed and toggles it on click', () => {
    mount(Component);
    const conqueror = () =>
      [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'Conqueror');
    // Every player-visible bot starts selected.
    expect(conqueror().getAttribute('aria-pressed')).toBe('true');

    act(() => conqueror().click());
    expect(conqueror().getAttribute('aria-pressed')).toBe('false');

    act(() => conqueror().click());
    expect(conqueror().getAttribute('aria-pressed')).toBe('true');
  });

  it('renders the General group strongest-first without the trimmed bots (#164)', () => {
    mount(Component);
    const general = container.querySelector('[role="group"][aria-label="General bots"]');
    const names = [...general.querySelectorAll('button')].map(b => b.textContent.trim());
    expect(names).toEqual(['Lookahead', 'Strategist', 'Adaptive', 'Default']);
  });

  it('never renders the hidden trimmed bots (Example/Defensive/Expectimax) (#164)', () => {
    mount(Component);
    const labels = buttonLabels();
    for (const name of ['Example', 'Defensive', 'Expectimax']) {
      expect(labels).not.toContain(name);
    }
  });
});
