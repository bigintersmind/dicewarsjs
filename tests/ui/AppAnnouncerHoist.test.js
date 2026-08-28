// @vitest-environment jsdom
/**
 * App screen-reader live region placement (#211 item 9).
 *
 * useAnnouncer.test.js proves the region says the right thing for a given store;
 * it renders ScreenReaderAnnouncer on its own and so cannot see where App put
 * it. That placement is the whole bug: the announcer used to be rendered inside
 * the `playing` and `gameOver` branches of the screen switch, under an
 * ErrorBoundary keyed by screen, so the region was destroyed and rebuilt on the
 * playing → gameOver transition — and a live region that is inserted already
 * carrying its text is frequently not announced at all, which is why the "Game
 * over…" line has been unreliable. One stable node, mounted for the whole
 * session, is the standard requirement; these tests pin it as an identity, not
 * as a lookup that happens to find something.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

/* The real settings die, as in AppRulesWiring: App's persistent chrome is what
   the region is now a peer of, so mount the rest of it. */
const preferencesManager = { set: vi.fn(), get: vi.fn(), getAll: vi.fn(() => ({})) };

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    container.remove();
    container = null;
  }
});

function makeGameState(extra = {}) {
  return {
    turnOrder: [0, 1],
    currentPlayerIndex: 0,
    /* The playing screen renders BoardFocus, which walks the board (#211), so
       a bare two-seat fixture needs territories to walk. */
    areas: {
      0: null,
      1: { owner: 0, dice: 3, neighborAreaIds: [2] },
      2: { owner: 1, dice: 2, neighborAreaIds: [1] },
    },
    players: [
      { id: 0, territoryCount: 5, stock: 1, eliminated: false },
      { id: 1, territoryCount: 4, stock: 0, eliminated: false },
    ],
    ...extra,
  };
}

function renderApp(overrides = {}) {
  const store = createGameStore();
  store.setState({
    gameState: makeGameState(),
    humanPlayerIndex: 0,
    awaitingInput: 'selectFrom',
    playerNames: ['You', 'Blitz'],
    ...overrides,
  });
  const controller = {
    openRules: vi.fn(),
    closeRules: vi.fn(),
    openQuitConfirm: vi.fn(),
    closeQuitConfirm: vi.fn(),
    goToTitle: vi.fn(),
    startNewGame: vi.fn(),
    startSpectate: vi.fn(),
    endHumanTurn: vi.fn(),
    handleTerritoryClick: vi.fn(),
    goToArena: vi.fn(),
    goToTournament: vi.fn(),
    goToOnlineLeaderboard: vi.fn(),
  };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller, preferencesManager }), container);
  });
  return { store, controller };
}

/* Not [aria-live] alone: TitleScreen carries live regions of its own (the
   difficulty hint, the luck blurb) on the very screen one of these tests looks
   at. Not [role="status"] either, though — these three tests are about WHERE the
   region is mounted and how long the node lives, so keying them to the role
   would fail all three, with a count assertion for a message, the day someone
   revised the role. `.sr-only` is what actually separates the announcer from
   TitleScreen's two: those carry .dw-mode-hint and .dw-luck-hint and are meant
   to be read. The role is asserted, once, in useAnnouncer.test.js. */
const regions = () => Array.from(container.querySelectorAll('.sr-only[aria-live]'));

describe('App screen-reader live region placement', () => {
  it('mounts exactly one live region on the playing screen', () => {
    renderApp({ screen: 'playing' });

    expect(regions()).toHaveLength(1);
    expect(regions()[0].textContent).toContain('Your turn');
  });

  /*
   * The regression itself. The assertion is node identity: a fresh region
   * holding the right text would pass a textContent-only check while being
   * exactly the silent case this fix exists to remove.
   */
  it('keeps the same region node across playing → game over', () => {
    const { store } = renderApp({ screen: 'playing' });
    const region = regions()[0];
    expect(region.textContent).toContain('Your turn');

    act(() =>
      store.setState({
        screen: 'gameOver',
        awaitingInput: null,
        gameState: makeGameState({ winner: 0 }),
      })
    );

    expect(regions()).toHaveLength(1);
    expect(regions()[0]).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toBe('Game over. You win!');
  });

  /*
   * Present before a game starts, too — that is what "one node for the session"
   * means, and it is what lets the region be empty when the next game's first
   * line arrives rather than being inserted already carrying it.
   */
  it('mounts the region on the title screen as well, empty', () => {
    renderApp({ screen: 'title', gameState: null, awaitingInput: null });

    expect(regions()).toHaveLength(1);
    expect(regions()[0].textContent).toBe('');
  });
});
