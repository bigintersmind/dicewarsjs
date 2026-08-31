// @vitest-environment jsdom
/**
 * SeatSwatch tests
 *
 * The chip that carries a seat's board color beside a status line, so the words
 * themselves never have to (#220). Three things make that work: it fills with
 * the seat color, it keeps a rim in the theme's border token so a pale seat
 * still has an edge on a pale panel, and it is hidden from assistive tech and
 * from `textContent` — the name beside it already says which seat this is.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { SeatSwatch } from '../../src/ui/SeatSwatch.jsx';
import { PLAYER_COLORS_CSS } from '../../src/renderer/constants.js';

let container;

function renderSwatch(color) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    render(h(SeatSwatch, { color }), container);
  });
  return container.firstChild;
}

/** jsdom normalizes hex colors to rgb(); compare against the same normalization. */
function cssColor(hex) {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
}

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    container.remove();
    container = null;
  }
});

describe('SeatSwatch', () => {
  it('fills with the seat color', () => {
    const el = renderSwatch(PLAYER_COLORS_CSS[6]); // yellow: 1.07:1 as text on the light panel
    expect(el.style.background).toBe(cssColor(PLAYER_COLORS_CSS[6]));
    // The color is a fill, never ink: nothing here sets a text color.
    expect(el.style.color).toBe('');
  });

  it('keeps a rim in the border token, so a pale seat still has an edge', () => {
    const el = renderSwatch(PLAYER_COLORS_CSS[0]);
    expect(el.getAttribute('style')).toContain('border: 1px solid var(--ui-border)');
  });

  // Sized in em rather than px so one component fits both the 19px thinking
  // line and the 24px game-over subtitle.
  it('sizes itself against the text beside it', () => {
    const el = renderSwatch(PLAYER_COLORS_CSS[0]);
    expect(el.style.width).toBe('0.8em');
    expect(el.style.height).toBe('0.8em');
  });

  it('is hidden from assistive tech and contributes no text', () => {
    const el = renderSwatch(PLAYER_COLORS_CSS[0]);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe('');
  });
});
