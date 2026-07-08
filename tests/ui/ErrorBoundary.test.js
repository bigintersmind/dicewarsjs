// @vitest-environment jsdom
/**
 * ErrorBoundary recovery-UI tests (issue #93).
 *
 * The boundary has two recovery modes. A generic render error offers "Try Again" (reset +
 * re-render), which recovers when the failure was transient. A dynamic-import / chunk-load
 * failure — the Arena/Tournament code-split chunks (issue #51) failing to fetch — offers a
 * full page reload instead, because preact's `lazy` caches the rejection so "Try Again"
 * would re-throw the same cached error forever; only a reload re-fetches the chunk.
 */
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ErrorBoundary, isChunkLoadError } from '../../src/ui/ErrorBoundary.jsx';

let container;

/** A child that throws the given error during render (exercises the boundary). */
function Boom({ error }) {
  throw error;
}

function renderBoundary(child) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(ErrorBoundary, null, child), container);
  });
}

beforeEach(() => {
  // componentDidCatch logs the caught error; silence it so the run output stays clean.
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

describe('isChunkLoadError', () => {
  it('recognizes the failed-dynamic-import signatures across bundlers/browsers', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /x.js'))).toBe(
      true
    );
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    const named = new Error('boom');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('walks the Error.cause chain (wrapped chunk failure)', () => {
    // A wrapper hides the signature at the top level but carries it in `cause`.
    const wrapped = new Error('module load failed', {
      cause: new Error('Failed to fetch dynamically imported module: /x.js'),
    });
    expect(isChunkLoadError(wrapped)).toBe(true);
  });

  it('does not misclassify an ordinary render error', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    // A self-referential cause must terminate, not stack-overflow.
    const loop = new Error('boom');
    loop.cause = loop;
    expect(isChunkLoadError(loop)).toBe(false);
  });
});

describe('ErrorBoundary', () => {
  it('shows the generic recovery UI for an ordinary error', () => {
    renderBoundary(h(Boom, { error: new Error('kaboom') }));
    expect(container.textContent).toContain('Something went wrong');
    expect(container.querySelector('button').textContent).toBe('Try Again');
    // ...and does NOT cross-contaminate with the chunk-load reload affordance.
    expect(container.textContent).not.toContain('Reload');
  });

  it('recovers via Try Again once the child stops throwing', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('transient');
      return h('div', null, 'recovered');
    }
    renderBoundary(h(Flaky));
    expect(container.textContent).toContain('Something went wrong');

    shouldThrow = false;
    act(() => container.querySelector('button').click());
    expect(container.textContent).toContain('recovered');
  });

  it('offers a full reload for a chunk-load error and triggers it (issue #93)', () => {
    const reload = vi.fn();
    const savedLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    try {
      renderBoundary(
        h(Boom, {
          error: new Error(
            'Failed to fetch dynamically imported module: /assets/ArenaScreen-a1b2.js'
          ),
        })
      );
      // No "Try Again" (it would re-throw the cached rejection forever); a Reload instead.
      const btn = container.querySelector('button');
      expect(btn.textContent).toBe('Reload');
      expect(container.textContent).toContain('reload');

      act(() => btn.click());
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: savedLocation });
    }
  });
});
