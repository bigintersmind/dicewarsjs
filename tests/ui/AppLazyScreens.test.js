// @vitest-environment jsdom
/**
 * App lazy-screen routing (issue #51).
 *
 * Arena & Tournament are code-split behind `lazy()` + `<Suspense>` so the bot registry
 * and its ~0.5 MB packed policy weights stay out of the eager bundle chunk. This asserts
 * the runtime wiring actually works: routing to either screen first shows the Suspense
 * fallback, then resolves the dynamic import and mounts the real screen without throwing.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { App } from '../../src/ui/App.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
    container = null;
  }
});

function renderAppAt(screen) {
  const store = createGameStore();
  store.setState({ screen });
  const controller = { goToTitle: vi.fn(), goToReplay: vi.fn() };

  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(App, { store, controller }), container);
  });
  return { store, controller };
}

const heading = () => container.querySelector('h1')?.textContent;

describe('App lazy-loaded Arena/Tournament screens', () => {
  it('shows the Suspense fallback, then mounts the Arena screen', async () => {
    renderAppAt('arena');

    // The lazy chunk has not resolved yet → the fallback is on screen, ARENA is not.
    expect(container.textContent).toContain('Loading');
    expect(heading()).toBeUndefined();

    // Once the dynamic import resolves, Suspense swaps in the real screen.
    await vi.waitFor(() => expect(heading()).toBe('ARENA'), { timeout: 3000 });
    expect(container.textContent).not.toContain('Loading');
  });

  it('mounts the Tournament screen the same way', async () => {
    renderAppAt('tournament');
    expect(container.textContent).toContain('Loading');

    await vi.waitFor(() => expect(heading()).toBe('TOURNAMENT'), { timeout: 3000 });
    expect(container.textContent).not.toContain('Loading');
  });
});
