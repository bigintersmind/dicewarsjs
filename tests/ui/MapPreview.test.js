// @vitest-environment jsdom
/**
 * MapPreview tests
 *
 * Covers the "Play this board?" gate, the way back out to the title/options
 * screen (#180 — button + Escape), and the bot-load notice banner that warns,
 * before the player commits to the board, when a chosen community bot failed to
 * load and was replaced by the default AI.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { MapPreview } from '../../src/ui/MapPreview.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;

function renderPreview(overrides = {}) {
  const store = createGameStore(overrides);
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const onBack = vi.fn();

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(MapPreview, { store, onAccept, onReject, onBack }), container);
  });

  return { store, onAccept, onReject, onBack };
}

const backBtn = () => container.querySelector('button[aria-label="Back to options"]');

/** Escape as the browser fires it: bubbling and cancelable. */
const pressEscape = (target = window) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
  });

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('MapPreview', () => {
  it('shows the YES/NO gate and no alert banner by default', () => {
    renderPreview();
    expect(container.textContent).toContain('Play this board?');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers a way back to the options screen next to YES/NO', () => {
    const { onBack, onAccept, onReject } = renderPreview();

    const back = backBtn();
    expect(back).toBeTruthy();
    act(() => back.click());

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('returns to the options screen on Escape', () => {
    const { onBack } = renderPreview();
    pressEscape();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores an Escape another handler already consumed (open settings dropdown)', () => {
    const { onBack } = renderPreview();
    const consume = e => e.preventDefault();
    document.addEventListener('keydown', consume);
    try {
      pressEscape(document);
    } finally {
      document.removeEventListener('keydown', consume);
    }
    expect(onBack).not.toHaveBeenCalled();
  });

  it('ignores other keys and stops listening once unmounted', () => {
    const { onBack } = renderPreview();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onBack).not.toHaveBeenCalled();

    act(() => render(null, container));
    pressEscape();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('surfaces aiLoadWarnings as an alert banner so the fallback is not silent', () => {
    const message =
      'Player 2: community bot "broken/bot" could not load — using Default AI instead.';
    renderPreview({ aiLoadWarnings: [message] });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('broken/bot');
  });
});
