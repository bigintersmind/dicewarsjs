// @vitest-environment jsdom
/**
 * MapPreview tests
 *
 * Covers the "Play this board?" gate and the bot-load notice banner that warns,
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

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(MapPreview, { store, onAccept, onReject }), container);
  });

  return { store, onAccept, onReject };
}

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

  it('surfaces aiLoadWarnings as an alert banner so the fallback is not silent', () => {
    const message =
      'Player 2: community bot "broken/bot" could not load — using Default AI instead.';
    renderPreview({ aiLoadWarnings: [message] });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('broken/bot');
  });
});
