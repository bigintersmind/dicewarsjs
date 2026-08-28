/**
 * Quit Confirm
 *
 * The "Abandon this game?" gate between the in-game QUIT control and
 * `controller.goToTitle()` (#181). A game in progress used to be a dead end —
 * the only way out was reloading the page — but quitting by accident is worse
 * than staying, so the way out goes through one modal question.
 *
 * Built from the menu chrome so it reads as the same game as the screens it
 * returns you to: scrimmed backdrop, translucent panel, the white double-rimmed
 * button for the thing you came to do (QUIT) and bare muted Anton text for the
 * way back (KEEP PLAYING) — the map preview's PLAY / ← BACK weighting. Native
 * `window.confirm` is deliberately not used; nothing else in src/ does.
 *
 * This component is mounted for the whole `playing` screen, dialog or not,
 * because it also owns Escape: pressed with nothing else to cancel, Escape
 * raises the dialog; pressed again, it closes it. The listener sits on `window`
 * (MapPreview's idiom), which is deliberately last — every `document` listener
 * on a bubbling keydown runs before any `window` one. So the settings dropdown,
 * whose Escape handler is on `document` and stops propagation, keeps the key
 * while it is open: the event never reaches `window`, and the dialog cannot
 * open behind the dropdown. KeyboardController (also `document`, so likewise
 * ahead of this handler) gets first refusal, and preventDefault()s Escape only
 * when it actually cancelled a half-made attack. This handler honors
 * defaultPrevented, so one Escape does exactly one thing.
 *
 * RulesModal, the one Escape owner that also sits on `window`, gets ahead of
 * this handler by registering in the CAPTURE phase — which beats every
 * bubble-phase listener in the document regardless of mount order — and
 * preventDefault()s the press it consumes, which the check above honors. That
 * is the mechanism. The `rulesOpen` check below is the belt to its braces: a
 * guard that does not depend on the card's effect having registered yet.
 *
 * @module ui/QuitConfirm
 */

import { useCallback, useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS, MENU_STYLE } from './menuChrome.jsx';

/* Entrance only — a modal that has to be dismissed should never animate out. */
const QUIT_CSS = `
@keyframes dw-quit-in {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: none; }
}
.dw-quit-card-anim { animation: dw-quit-in 0.12s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .dw-quit-card-anim { animation: none; }
}
`;

const STYLE = {
  /*
   * Above the settings die (z-index 1000) as well as the board: while the
   * question is up it is the only thing that answers a click.
   */
  scrim: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    background: 'var(--ui-scrim)',
    pointerEvents: 'auto',
  },
  card: {
    ...MENU_STYLE.panel,
    width: 'auto',
    maxWidth: '360px',
    padding: '1.2rem 1.4rem',
    textAlign: 'center',
    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.35)',
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.4rem',
    letterSpacing: '0.04em',
    color: 'var(--ui-text)',
    margin: '0 0 0.4rem',
  },
  body: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text-muted)',
    margin: '0 0 1.1rem',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
  },
  keepBtn: {
    fontSize: '1rem',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore: `quitConfirmOpen` and the motion preference
 * @param {() => void} props.onOpen - Escape with nothing else to cancel: raise the dialog
 * @param {() => void} props.onCancel - KEEP PLAYING / Escape / backdrop: dismiss it
 * @param {() => void} props.onConfirm - QUIT: abandon the game and return to the title
 */
export function QuitConfirm({ store, onOpen, onCancel, onConfirm }) {
  const open = useGameStore(store, s => s.quitConfirmOpen);
  const prefs = useGameStore(store, s => s.preferences);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  /** Element that had focus when the dialog opened, restored when it closes. */
  const returnFocusRef = useRef(null);

  useEffect(() => {
    const handleKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      /*
       * The rules card layers above this dialog and owns Escape while it is
       * up. Its capture-phase listener claims the press before this one runs,
       * which the check above already honors — but read the flag too, so the
       * dialog cannot appear behind the card on a frame where that listener is
       * not registered yet.
       */
      if (store.getState().rulesOpen) return;
      if (open) onCancel();
      else onOpen();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [store, open, onOpen, onCancel]);

  /*
   * KEEP PLAYING takes focus on open — the safe answer is the one a stray
   * Enter picks — and focus goes back where it came from on close (the QUIT
   * button, or nothing at all when Escape opened the dialog). After a confirm
   * the whole screen is gone, hence the isConnected check.
   */
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      const previous = returnFocusRef.current;
      returnFocusRef.current = null;
      if (previous && previous.isConnected) previous.focus?.();
    };
  }, [open]);

  /**
   * Keep Tab inside the dialog: two buttons, so it just alternates.
   *
   * The handler hangs off the card, so it only ever sees a Tab pressed with
   * focus inside it — which is why the card is a `tabindex="-1"` focus target
   * below. Press the card's own chrome (the title, the body copy, the gap
   * between the buttons) and there is nothing focusable under the pointer; the
   * browser's mousedown fixup then focuses the nearest focusable ancestor,
   * which without that tabindex is nothing at all, so focus lands on `<body>`,
   * out of this handler's reach, and the next Tab walks the page under the
   * scrim. RulesModal.handleTab documents the same trap for the same reason —
   * this is that fix, not a second mechanism. Nothing resets the card's
   * outline, there as here: focus arriving by that fixup is not
   * `:focus-visible`, so a mouse-focused card shows no ring.
   *
   * Focus on the card itself indexes as -1, which the arithmetic below already
   * turns into the first button on Tab and the last on Shift+Tab.
   */
  const handleTab = useCallback(event => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const buttons = [cancelRef.current, confirmRef.current].filter(Boolean);
    if (buttons.length < 2) return;
    const current = buttons.indexOf(document.activeElement);
    const next = event.shiftKey
      ? (current <= 0 ? buttons.length : current) - 1
      : (current + 1) % buttons.length;
    buttons[next]?.focus();
  }, []);

  const handleScrimClick = useCallback(
    event => {
      if (event.target === event.currentTarget) onCancel();
    },
    [onCancel]
  );

  if (!open) return null;

  // The system-level preference is handled in CSS; this honors an explicit "on".
  const animate = prefs?.reducedMotion !== 'on';

  return (
    <div style={STYLE.scrim} onClick={handleScrimClick}>
      {/* The dialog carries its own copy of the shared chrome so it is
          self-contained — SettingsPanel happens to mount one on every screen,
          but nothing here leans on that, and a standalone render (a test) still
          gets .dw-opt/.dw-btn. Duplicate mounts are harmless: identical rules. */}
      <style>{CHROME_CSS + QUIT_CSS}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dw-quit-title"
        className={animate ? 'dw-quit-card-anim' : undefined}
        style={STYLE.card}
        tabIndex={-1}
        onKeyDown={handleTab}
      >
        <h2 id="dw-quit-title" style={STYLE.title}>
          Abandon this game?
        </h2>
        <p style={STYLE.body}>The board is discarded and you go back to the setup screen.</p>
        <div style={STYLE.row}>
          <button
            type="button"
            className="dw-opt"
            style={STYLE.keepBtn}
            onClick={onCancel}
            ref={cancelRef}
          >
            KEEP PLAYING
          </button>
          <button
            type="button"
            className="dw-btn"
            style={MENU_STYLE.secondaryBtn}
            onClick={onConfirm}
            ref={confirmRef}
          >
            QUIT
          </button>
        </div>
      </div>
    </div>
  );
}
