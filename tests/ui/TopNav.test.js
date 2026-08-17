// @vitest-environment jsdom
/**
 * Mode rail (TopNav) + title footer row (FooterNav) tests
 *
 * The top tab bar across the hub screens (Battle / Arena / Tournament /
 * Leaderboard) that replaced the per-screen BACK buttons, and its footer-row
 * counterpart on the title screen (#182: the landing page demotes the
 * bot-author screens to footer material and carries no rail). Covers both
 * components' contracts (order, aria-current, the onNavigate callback) and the
 * App wiring: rail on every hub screen but the title, footer row on the title,
 * each routing to the right controller method; neither in the game flow.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { TopNav, FooterNav, NAV_TABS } from '../../src/ui/menuChrome.jsx';
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
const rail = () => container.querySelector('nav[aria-label="Game screens"]');
const footerNav = () => container.querySelector('nav[aria-label="More game modes"]');
const footLinks = () => [...container.querySelectorAll('.dw-footlink')];
const footLink = label => footLinks().find(b => b.textContent === label);

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

  // The hub chrome belongs exactly where the live attract board runs behind
  // it; both lists' comments say "must stay in sync" — this makes it so.
  it('keeps NAV_TABS in sync with ATTRACT_SCREENS', () => {
    expect(NAV_TABS.map(t => t.id)).toEqual(ATTRACT_SCREENS);
  });
});

describe('FooterNav (#182)', () => {
  it('lists the non-Battle hub screens in rail order — Battle is the screen it sits on', () => {
    render(h(FooterNav, { onNavigate: vi.fn() }), container);
    expect(footLinks().map(b => b.textContent)).toEqual(['Arena', 'Tournament', 'Leaderboard']);
    // Same source list as the rail, so a new hub screen shows up in both.
    expect(footLinks().map(b => b.textContent)).toEqual(
      NAV_TABS.filter(t => t.id !== 'title').map(t => t.label)
    );
  });

  it('reports the tapped screen id through onNavigate', () => {
    const onNavigate = vi.fn();
    render(h(FooterNav, { onNavigate }), container);
    footLink('Tournament').click();
    expect(onNavigate).toHaveBeenCalledWith('tournament');
  });

  it('is a labelled nav landmark whose separators are hidden from assistive tech', () => {
    render(h(FooterNav, { onNavigate: vi.fn() }), container);
    expect(footerNav()).toBeTruthy();
    const seps = [...footerNav().querySelectorAll('[aria-hidden="true"]')];
    expect(seps).toHaveLength(2);
    // Nothing focusable but the three links.
    expect(footerNav().querySelectorAll('button, a')).toHaveLength(3);
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
  // presence on every hub screen but the title is load-bearing: an id drift
  // between store.screen and NAV_TABS would silently strand the user.
  it.each(NAV_TABS.filter(t => t.id !== 'title'))(
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
      expect(rail()).toBeTruthy();
      expect(tab(label).getAttribute('aria-current')).toBe('page');
      // …and the footer row is the title's alone.
      expect(footerNav()).toBeNull();

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

  // #182: the landing page's scan (and tab) path is setup → START; the
  // bot-author screens are reached from the footer, not a rail above the
  // setup. Battle is not offered — it is the screen you are on.
  it('carries the footer row instead of the rail on the title screen', () => {
    renderAppAt('title');
    expect(rail()).toBeNull();
    expect(footerNav()).toBeTruthy();
    expect(footLinks().map(b => b.textContent)).toEqual(['Arena', 'Tournament', 'Leaderboard']);
  });

  it('routes each footer link to its controller navigation method', () => {
    const { controller } = renderAppAt('title');
    act(() => footLink('Arena').click());
    expect(controller.goToArena).toHaveBeenCalledTimes(1);
    // The mock controller never moves the store off 'title', so the footer
    // is still mounted — each tap exercises another route.
    act(() => footLink('Tournament').click());
    expect(controller.goToTournament).toHaveBeenCalledTimes(1);
    act(() => footLink('Leaderboard').click());
    expect(controller.goToOnlineLeaderboard).toHaveBeenCalledTimes(1);
    expect(controller.goToTitle).not.toHaveBeenCalled();
  });

  // The rail on the other hub screens is how you get back to Battle.
  it('routes each rail tab to its controller navigation method', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503 }))
    );
    const { controller } = renderAppAt('onlineLeaderboard');
    act(() => tab('Battle').click());
    expect(controller.goToTitle).toHaveBeenCalledTimes(1);
    // The mock controller never moves the store off the leaderboard, so the
    // rail is still mounted with Leaderboard active — each tap exercises
    // another route.
    act(() => tab('Arena').click());
    expect(controller.goToArena).toHaveBeenCalledTimes(1);
    act(() => tab('Tournament').click());
    expect(controller.goToTournament).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it('keeps both out of the game flow (map preview renders neither)', () => {
    renderAppAt('mapPreview');
    expect(rail()).toBeNull();
    expect(footerNav()).toBeNull();
  });
});
