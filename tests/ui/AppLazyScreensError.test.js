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

describe('App lazy-screen chunk-load failure', () => {
  it('surfaces the reload recovery UI when the Arena chunk fails to load', async () => {
    const store = createGameStore();
    store.setState({ screen: 'arena' });
    const controller = { goToTitle: vi.fn(), goToReplay: vi.fn() };

    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      render(h(App, { store, controller }), container);
    });

    // The Suspense fallback shows for the tick before the (doomed) import rejects.
    expect(container.textContent).toContain('Loading');

    // Then the rejection propagates and the ErrorBoundary swaps in the reload affordance.
    // (The mode rail's tabs precede it in the DOM — the rail lives in its own boundary
    // and must survive a screen-chunk failure — so search all buttons, not the first.)
    const reloadBtn = () =>
      [...container.querySelectorAll('button')].find(b => b.textContent === 'Reload');
    await vi.waitFor(() => expect(reloadBtn()).toBeTruthy(), { timeout: 5000 });
    expect(container.textContent).toContain('reload');
    expect(container.textContent).not.toContain('Try Again');
  });
});
