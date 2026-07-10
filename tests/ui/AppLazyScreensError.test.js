// @vitest-environment jsdom
/**
 * App lazy-screen FAILURE path (issue #93) — sibling to AppLazyScreens.test.js (happy path).
 *
 * When a code-split screen chunk (Arena/Tournament, issue #51) fails to fetch — a deploy
 * rotating chunk hashes, or a persistent network failure — preact's `lazy` caches the
 * rejection, and the ErrorBoundary must surface a *reload* affordance (not the useless
 * "Try Again", which would re-throw the cached error forever).
 *
 * `vi.mock` is hoisted + file-scoped, so mocking ArenaScreen to throw lives in its own file
 * rather than breaking the happy-path Arena render in AppLazyScreens.test.js.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

// Make the Arena chunk's dynamic import reject, exactly like a failed chunk fetch.
vi.mock('../../src/ui/ArenaScreen.jsx', () => {
  throw new Error('Failed to fetch dynamically imported module: /assets/ArenaScreen-a1b2.js');
});

import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

beforeEach(() => {
  // preact + the boundary log the caught chunk error; silence it for a clean run.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
  vi.restoreAllMocks();
});

const reloadBtn = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent === 'Reload');

// The rejection propagates and the ErrorBoundary swaps in the reload affordance.
// (The mode rail's tabs precede it in the DOM — so search all buttons, not the first.)
const awaitReload = () => vi.waitFor(() => expect(reloadBtn()).toBeTruthy(), { timeout: 5000 });

/** Mount App at the (doomed) arena screen. */
function mountArenaApp() {
  const store = createGameStore();
  store.setState({ screen: 'arena' });
  const controller = { goToTitle: vi.fn(), goToReplay: vi.fn() };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller }), container);
  });
  return store;
}

describe('App lazy-screen chunk-load failure', () => {
  it('surfaces the reload recovery UI when the Arena chunk fails to load', async () => {
    mountArenaApp();

    // The Suspense fallback shows for the tick before the (doomed) import
    // rejects. First mount in this file only — preact's lazy caches the
    // rejection, so later mounts crash immediately with no fallback frame.
    expect(container.textContent).toContain('Loading');

    await awaitReload();
    expect(container.textContent).toContain('reload');
    expect(container.textContent).not.toContain('Try Again');
  });

  it('keeps the mode rail alive through the crash — the user can still navigate away', async () => {
    mountArenaApp();
    await awaitReload();
    // The rail lives in its own boundary outside the screen switch.
    expect(container.querySelector('nav[aria-label="Game screens"]')).toBeTruthy();
  });

  it('recovers on navigation — the crash never sticks to the next screen', async () => {
    const store = mountArenaApp();
    await awaitReload();

    // Navigate away, as a rail tap would. The screen boundary is keyed by
    // screen, so the caught error is discarded with the old boundary instance
    // and the title screen mounts clean.
    act(() => {
      store.setState({ screen: 'title' });
    });
    expect(reloadBtn()).toBeUndefined();
    expect(container.textContent).toContain('START');
  });
});
