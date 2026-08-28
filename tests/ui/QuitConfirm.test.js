// @vitest-environment jsdom
/**
 * QuitConfirm tests
 *
 * Covers the "Abandon this game?" gate between the in-game QUIT control and
 * goToTitle (#181): the dialog only exists while the store says so, Escape
 * opens and closes it, the safe answer takes focus, and every dismissal path
 * (KEEP PLAYING, Escape, backdrop) cancels rather than quits.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { QuitConfirm } from '../../src/ui/QuitConfirm.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;
/** Stand-in for the HUD's QUIT button — whatever had focus before the dialog. */
let opener;

function renderConfirm(overrides = {}) {
  const store = createGameStore({ screen: 'playing', ...overrides });
  const onOpen = vi.fn(() => store.setState({ quitConfirmOpen: true }));
  const onCancel = vi.fn(() => store.setState({ quitConfirmOpen: false }));
  const onConfirm = vi.fn();

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(QuitConfirm, { store, onOpen, onCancel, onConfirm }), container);
  });

  return { store, onOpen, onCancel, onConfirm };
}

const dialog = () => container.querySelector('[role="dialog"]');
const buttonByText = text =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent.trim() === text);

/** Escape as the browser fires it: bubbling and cancelable. */
function pressEscape({ defaultPrevented = false } = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  if (defaultPrevented) event.preventDefault();
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

/** Tab as the browser fires it, from whatever holds focus at the time. */
function pressTab(shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.activeElement.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
  // Cleaned up here, not inline, so a failed assertion can't leak it into the
  // next test's document.
  if (opener) {
    opener.remove();
    opener = null;
  }
});

describe('QuitConfirm', () => {
  it('renders nothing until the store says the dialog is open', () => {
    const { store } = renderConfirm();
    expect(dialog()).toBeNull();

    act(() => store.setState({ quitConfirmOpen: true }));
    expect(dialog()).toBeTruthy();
  });

  it('is a labelled modal dialog with both answers', () => {
    renderConfirm({ quitConfirmOpen: true });

    const el = dialog();
    expect(el.getAttribute('aria-modal')).toBe('true');
    const heading = container.querySelector(`#${el.getAttribute('aria-labelledby')}`);
    expect(heading.textContent).toMatch(/abandon this game/i);
    expect(buttonByText('QUIT')).toBeTruthy();
    expect(buttonByText('KEEP PLAYING')).toBeTruthy();
    /*
     * The card is a focus target itself, so that pressing its unfocusable
     * chrome (the title, the body copy, the gap between the buttons) lands
     * focus here rather than on <body>, where the trap's keydown handler could
     * not see the next Tab. The attribute, not `el.tabIndex`: jsdom reports -1
     * for any div, so reading the property would pass with no tabindex at all.
     */
    expect(el.getAttribute('tabindex')).toBe('-1');
  });

  it('QUIT confirms', () => {
    const { onConfirm, onCancel } = renderConfirm({ quitConfirmOpen: true });

    act(() => buttonByText('QUIT').click());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('KEEP PLAYING cancels and dismisses the dialog', () => {
    const { onConfirm, onCancel } = renderConfirm({ quitConfirmOpen: true });

    act(() => buttonByText('KEEP PLAYING').click());

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('cancels on a backdrop click but not on a click inside the card', () => {
    const { onCancel } = renderConfirm({ quitConfirmOpen: true });

    act(() => dialog().click());
    expect(onCancel).not.toHaveBeenCalled();

    act(() => dialog().parentNode.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape opens the dialog, and Escape again cancels it', () => {
    const { onOpen, onCancel, onConfirm } = renderConfirm();

    pressEscape();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();

    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('ignores an Escape another handler already claimed', () => {
    const { onOpen } = renderConfirm();

    // KeyboardController cancels a half-made attack this way (#181).
    pressEscape({ defaultPrevented: true });

    expect(onOpen).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('focuses KEEP PLAYING on open and hands focus back on close', () => {
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { store } = renderConfirm();
    act(() => store.setState({ quitConfirmOpen: true }));
    expect(document.activeElement).toBe(buttonByText('KEEP PLAYING'));

    act(() => store.setState({ quitConfirmOpen: false }));
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog', () => {
    renderConfirm({ quitConfirmOpen: true });
    const keep = buttonByText('KEEP PLAYING');
    const quit = buttonByText('QUIT');

    /*
     * The focus assertions alone can't see a lost preventDefault() — jsdom
     * never moves focus on Tab, so the handler's own focus() call would still
     * land. Assert the cancellation too, or the real browser would move focus
     * a second time and hop straight out of the dialog.
     */
    expect(document.activeElement).toBe(keep);
    expect(pressTab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(quit);
    pressTab();
    expect(document.activeElement).toBe(keep);
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(quit);
  });

  it('keeps Tab inside the dialog from the card itself', () => {
    renderConfirm({ quitConfirmOpen: true });

    /*
     * The state a press on the card's own chrome leaves behind. The browser
     * half is a DOM fact taken on trust — jsdom does not model the mousedown
     * focus fixup, so the focus it would perform is spelled out here: with the
     * card focusable the fixup walks up to it, and without the tabindex there
     * is no focusable ancestor and focus falls to <body>, outside the handler
     * below. What this test can pin is that the trap survives the resulting
     * state, and that the card takes focus at all.
     */
    act(() => dialog().focus());
    expect(document.activeElement).toBe(dialog());

    // Neither button is the current stop, so Tab starts the cycle at the safe
    // answer and Shift+Tab enters it from the other end.
    expect(pressTab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttonByText('KEEP PLAYING'));

    act(() => dialog().focus());
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttonByText('QUIT'));
  });

  it('drops the entrance animation when reduced motion is on', () => {
    renderConfirm({ quitConfirmOpen: true, preferences: { reducedMotion: 'on' } });
    expect(dialog().className).toBe('');
  });

  it('plays the entrance otherwise', () => {
    renderConfirm({ quitConfirmOpen: true, preferences: { reducedMotion: 'system' } });
    expect(dialog().className).toContain('dw-quit-card-anim');
  });
});
