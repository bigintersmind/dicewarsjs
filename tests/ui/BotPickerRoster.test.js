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
    render(h(Component, { onBack: vi.fn(), onViewReplay: vi.fn() }), container);
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

  it('groups the roster into Self-Play and General sections', () => {
    mount(Component);
    expect(container.textContent).toContain('Self-play bots');
    expect(container.textContent).toContain('General bots');
  });
});
