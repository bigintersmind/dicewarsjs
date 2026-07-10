// @vitest-environment jsdom
/**
 * Mode rail (TopNav) tests
 *
 * The persistent top tab bar across the hub screens (Battle / Arena /
 * Tournament / Leaderboard) that replaced the title screen's bottom nav links
 * and the per-screen BACK buttons. Covers the component contract (tab order,
 * aria-current, the onNavigate callback) and the App wiring (rail present on
 * hub screens routing to the right controller method, absent from the game
 * flow).
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { TopNav } from '../../src/ui/menuChrome.jsx';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  container = null;
});

const tabs = () => [...container.querySelectorAll('.dw-tab')];
const tab = label => tabs().find(b => b.textContent === label);

describe('TopNav', () => {
  it('renders the four hub tabs in rail order, Battle first', () => {
    render(h(TopNav, { active: 'title', onNavigate: vi.fn() }), container);
    expect(tabs().map(b => b.textContent)).toEqual([
      'Battle',
      'Arena',
      'Tournament',
      'Leaderboard',
    ]);
  });

  it('marks only the active tab with aria-current="page"', () => {
    render(h(TopNav, { active: 'arena', onNavigate: vi.fn() }), container);
    expect(tab('Arena').getAttribute('aria-current')).toBe('page');
    tabs()
      .filter(b => b !== tab('Arena'))
      .forEach(b => expect(b.hasAttribute('aria-current')).toBe(false));
  });

  it('reports the tapped screen id through onNavigate', () => {
    const onNavigate = vi.fn();
    render(h(TopNav, { active: 'title', onNavigate }), container);
    tab('Leaderboard').click();
    expect(onNavigate).toHaveBeenCalledWith('onlineLeaderboard');
  });

  it('ignores taps on the already-active tab', () => {
    const onNavigate = vi.fn();
    render(h(TopNav, { active: 'title', onNavigate }), container);
    tab('Battle').click();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('App mode-rail wiring', () => {
  function renderAppAt(screen) {
    const store = createGameStore();
    store.setState({ screen });
    const controller = {
      goToTitle: vi.fn(),
      goToArena: vi.fn(),
      goToTournament: vi.fn(),
      goToOnlineLeaderboard: vi.fn(),
      goToReplay: vi.fn(),
    };
    act(() => {
      render(h(App, { store, controller }), container);
    });
    return { store, controller };
  }

  it('mounts the rail on the title screen with Battle as the current tab', () => {
    renderAppAt('title');
    expect(container.querySelector('nav[aria-label="Game screens"]')).toBeTruthy();
    expect(tab('Battle').getAttribute('aria-current')).toBe('page');
  });

  it('routes each tab to its controller navigation method', () => {
    const { controller } = renderAppAt('title');
    act(() => tab('Tournament').click());
    expect(controller.goToTournament).toHaveBeenCalledTimes(1);
    // The mock controller never moves the store off 'title', so the rail is
    // still mounted with Battle active — the next tap exercises another route.
    act(() => tab('Leaderboard').click());
    expect(controller.goToOnlineLeaderboard).toHaveBeenCalledTimes(1);
  });

  it('keeps the rail out of the game flow (map preview renders no rail)', () => {
    renderAppAt('mapPreview');
    expect(container.querySelector('nav[aria-label="Game screens"]')).toBeNull();
  });
});
