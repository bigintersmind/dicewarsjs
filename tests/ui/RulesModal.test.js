// @vitest-environment jsdom
/**
 * RulesModal tests
 *
 * Covers the "How to play" reference card: it only exists while the store says
 * so, every dismissal path (the close button, GOT IT, Escape, the backdrop)
 * reports one close, Escape is claimed so the quit confirm behind it stays
 * shut, Tab stays inside the card, and focus goes back to whatever opened it.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { RulesModal, RULES_SECTIONS } from '../../src/ui/RulesModal.jsx';
import { createGameStore } from '../../src/store/GameStore.js';

let container;
/** Stand-in for the HUD's RULES button — whatever had focus before the card. */
let opener;

function renderModal(overrides = {}) {
  const store = createGameStore(overrides);
  const onClose = vi.fn(() => store.setState({ rulesOpen: false }));

  container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    render(h(RulesModal, { store, onClose }), container);
  });

  return { store, onClose };
}

const dialog = () => container.querySelector('[role="dialog"]');
const closeBtn = () => container.querySelector('button[aria-label="Close how to play"]');
const buttonByText = text =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent.trim() === text);
const scrollRegion = () => container.querySelector('.dw-rules-scroll');

/** Escape as the browser fires it: bubbling and cancelable. */
function pressEscape({ defaultPrevented = false } = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (defaultPrevented) event.preventDefault();
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
  if (opener) {
    opener.remove();
    opener = null;
  }
});

describe('RulesModal', () => {
  it('renders nothing until the store says the card is open', () => {
    const { store } = renderModal();
    expect(dialog()).toBeNull();

    act(() => store.setState({ rulesOpen: true }));
    expect(dialog()).toBeTruthy();
  });

  it('is a labelled modal dialog', () => {
    renderModal({ rulesOpen: true });

    const el = dialog();
    expect(el.getAttribute('aria-modal')).toBe('true');
    const heading = container.querySelector(`#${el.getAttribute('aria-labelledby')}`);
    expect(heading.textContent).toMatch(/how to play/i);
  });

  it('shows every section, each with a figure', () => {
    renderModal({ rulesOpen: true });

    const sections = container.querySelectorAll('.dw-rules-sec');
    expect(sections.length).toBe(RULES_SECTIONS.length);
    for (const section of sections) {
      expect(section.querySelector('svg')).toBeTruthy();
    }
    // The engine's own numbers, not the docs': ties, the 8-dice cap, the cap on
    // long games. A copy edit that drops one of these should fail here.
    expect(container.textContent).toMatch(/ties go to the defender/i);
    expect(container.textContent).toMatch(/8 dice at most/i);
    expect(container.textContent).toMatch(/turn limit/i);
  });

  it('closes from the close button', () => {
    const { onClose } = renderModal({ rulesOpen: true });

    act(() => closeBtn().click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('closes from GOT IT', () => {
    const { onClose } = renderModal({ rulesOpen: true });

    act(() => buttonByText('GOT IT').click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('closes on a backdrop click but not on a click inside the card', () => {
    const { onClose } = renderModal({ rulesOpen: true });

    act(() => dialog().click());
    expect(onClose).not.toHaveBeenCalled();

    act(() => dialog().parentNode.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and claims the key so nothing else acts on it', () => {
    const { onClose } = renderModal({ rulesOpen: true });

    const event = pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
    // QuitConfirm's handler is on `window` too and skips a claimed Escape.
    expect(event.defaultPrevented).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('leaves Escape alone while closed — the quit confirm still owns it', () => {
    const { onClose } = renderModal();

    const event = pressEscape();

    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores an Escape another handler already claimed', () => {
    const { onClose } = renderModal({ rulesOpen: true });

    // KeyboardController cancels a half-made attack this way (#181).
    pressEscape({ defaultPrevented: true });

    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });

  it('focuses the scroll region on open and hands focus back on close', () => {
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { store } = renderModal();
    act(() => store.setState({ rulesOpen: true }));
    expect(document.activeElement).toBe(scrollRegion());

    act(() => store.setState({ rulesOpen: false }));
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the card', () => {
    renderModal({ rulesOpen: true });

    const tab = (shiftKey = false) => {
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
    };

    /*
     * jsdom never moves focus on Tab, so the focus assertions alone can't see a
     * lost preventDefault(): assert the cancellation too, or a real browser
     * would move focus again and hop straight out of the card.
     */
    const stops = [closeBtn(), scrollRegion(), buttonByText('GOT IT')];
    expect(document.activeElement).toBe(stops[1]);
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[2]);
    tab();
    // Wraps round to the first stop rather than escaping to the page.
    expect(document.activeElement).toBe(stops[0]);
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(stops[2]);
  });

  it('drops the entrance animation when reduced motion is on', () => {
    renderModal({ rulesOpen: true, preferences: { reducedMotion: 'on' } });
    expect(dialog().className).toBe('');
  });

  it('plays the entrance otherwise', () => {
    renderModal({ rulesOpen: true, preferences: { reducedMotion: 'system' } });
    expect(dialog().className).toContain('dw-rules-card-anim');
  });
});
