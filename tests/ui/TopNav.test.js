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
import { TopNav, NAV_TABS } from '../../src/ui/menuChrome.jsx';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';
import { ATTRACT_SCREENS } from '../../src/controller/TitleAttractMode.js';

let container;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
  container = null;
  vi.unstubAllGlobals();
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

  // The rail belongs exactly where the live attract board runs behind the
  // chrome; both lists' comments say "must stay in sync" — this makes it so.
  it('keeps NAV_TABS in sync with ATTRACT_SCREENS', () => {
    expect(NAV_TABS.map(t => t.id)).toEqual(ATTRACT_SCREENS);
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

  // The rail is each hub screen's only exit (BACK buttons are gone), so its
  // presence on every hub screen is load-bearing: an id drift between
  // store.screen and NAV_TABS would silently strand the user.
  it.each(NAV_TABS)(
    'mounts the rail on the $id screen with $label current',
    async ({ id, label }) => {
      // onlineLeaderboard fetches on mount; give it a fast, settled failure.
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: false, status: 503 }))
      );
      renderAppAt(id);

      // The rail lives outside the screen boundary, so it's present immediately
      // — even while a lazy screen chunk is still loading.
      expect(container.querySelector('nav[aria-label="Game screens"]')).toBeTruthy();
      expect(tab(label).getAttribute('aria-current')).toBe('page');

      // Let the lazy Arena/Tournament chunks (and the leaderboard fetch) settle
      // before teardown so nothing resolves into an unmounted tree.
      if (id === 'arena' || id === 'tournament') {
        await vi.waitFor(() => expect(container.textContent).not.toContain('Loading'), {
          timeout: 5000,
        });
      } else {
        await act(async () => {});
      }
    }
  );

  it('routes each tab to its controller navigation method', () => {
    const { controller } = renderAppAt('title');
    act(() => tab('Arena').click());
    expect(controller.goToArena).toHaveBeenCalledTimes(1);
    // The mock controller never moves the store off 'title', so the rail is
    // still mounted with Battle active — each tap exercises another route.
    act(() => tab('Tournament').click());
    expect(controller.goToTournament).toHaveBeenCalledTimes(1);
    act(() => tab('Leaderboard').click());
    expect(controller.goToOnlineLeaderboard).toHaveBeenCalledTimes(1);
  });

  it('keeps the rail out of the game flow (map preview renders no rail)', () => {
    renderAppAt('mapPreview');
    expect(container.querySelector('nav[aria-label="Game screens"]')).toBeNull();
  });
});
