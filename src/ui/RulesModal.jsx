/**
 * Rules Modal — "How to play"
 *
 * The always-reachable rules reference. Early playtesters could not tell what
 * the game wanted from them (which territory is clickable, why an attack
 * failed, where the new dice come from), so every screen carries a way into
 * this one card: HOW TO PLAY on the title screen and the game-over screen,
 * RULES in the in-game HUD.
 *
 * It is a reference, not a tutorial: five sections in the order a player meets
 * them (goal → attack → battle → reinforce → tips), each one a figure plus two
 * lines of copy, scannable in about half a minute. The numbers in the copy are
 * the engine's own (BattleResolver's ties-to-the-defender, MAX_DICE, the
 * largest-connected-group reinforcement), not the docs'.
 *
 * Built from the menu chrome like QuitConfirm, and mounted by App outside the
 * screen switch so it opens over any screen.
 *
 * Escape layering. While the card is up it owns Escape, and the mechanism that
 * makes that true is the capture phase: this listener is registered on `window`
 * with `capture: true`, which runs before every bubble-phase listener in the
 * document — KeyboardController and the settings dropdown (both on `document`),
 * and QuitConfirm (`window`, bubble) alike. Registration order between
 * components therefore does not matter at all. Consuming the key means
 * preventDefault(): QuitConfirm and the settings dropdown each skip an Escape
 * that was already claimed, and KeyboardController arrives at the same place by
 * standing down while `rulesOpen` is set. QuitConfirm reads that flag too — the
 * belt to this braces, a guard that holds even if this effect has not
 * registered yet on the frame the key arrives.
 *
 * @module ui/RulesModal
 */

import { useCallback, useEffect, useRef } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS, MENU_STYLE } from './menuChrome.jsx';
import {
  GoalFigure,
  AttackFigure,
  BattleFigure,
  ReinforceFigure,
  TipsFigure,
} from './rulesArt.jsx';

/**
 * The reference itself. `body` is a paragraph; `bullets` is a list. Kept here
 * rather than inline in the JSX so the copy can be read (and re-tuned after a
 * playtest) in one place.
 */
export const RULES_SECTIONS = [
  {
    id: 'goal',
    eyebrow: 'Goal',
    heading: 'Take the whole board',
    Figure: GoalFigure,
    body: 'Conquer every territory on the map. The last player left standing wins — and if nobody has won by the turn limit, the game ends in a draw.',
  },
  {
    id: 'attack',
    eyebrow: 'Attack',
    heading: 'Two clicks to attack',
    Figure: AttackFigure,
    body: 'Click one of your territories with 2 or more dice, then click an adjacent enemy territory. Attack as many times as you like, then end your turn.',
  },
  {
    id: 'battle',
    eyebrow: 'Battle',
    heading: 'Highest total wins',
    Figure: BattleFigure,
    body: 'Both sides roll all their dice and add them up. You need the higher total — ties go to the defender. Win and the territory is yours: every die but one moves in, and one stays behind. Lose and your attacking territory drops to a single die.',
  },
  {
    id: 'reinforce',
    eyebrow: 'Reinforce',
    heading: 'Stay connected',
    Figure: ReinforceFigure,
    body: 'Ending your turn earns you one new die for every territory in your largest connected group, dropped on your land at random. A territory holds 8 dice at most; the rest wait in your stockpile — the +N in the bottom bar — for later turns.',
  },
  {
    id: 'tips',
    eyebrow: 'Tips',
    heading: 'Play the odds',
    Figure: TipsFigure,
    bullets: [
      'Keep your territories connected: one big group earns far more dice than two small ones.',
      "Don't leave a 1-die territory on a border facing an enemy — it can't attack, and it falls to anything.",
      'Bigger stacks win more often. 8 against 8 is barely better than a coin flip; 8 against 3 almost never loses.',
      'Under Custom difficulty, "Your luck" tilts the dice your way: you roll extra dice and drop as many of the lowest, attacking and defending.',
    ],
  },
];

/** Everything inside the card that Tab should visit, in DOM order. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Hand focus back on close.
 *
 * Normally that is whatever opened the card. When that control is gone — the
 * game ended behind the card and took the HUD's RULES button with it — falling
 * through to `<body>` would strand a keyboard user at the top of the document,
 * so aim at the first real control still on screen instead. Best-effort by
 * design: this runs in an effect cleanup, where a throw would take the unmount
 * with it, and there is nothing a player could do about a failure anyway.
 *
 * @param {Element|null} previous - The element that had focus when it opened
 * @param {Element|null} dialog - The card, so its own controls are skipped
 */
function restoreFocus(previous, dialog) {
  try {
    if (previous?.isConnected) {
      previous.focus?.();
      return;
    }
    const scope = document.getElementById('app') || document.body;
    const anchor = Array.from(scope?.querySelectorAll('button:not([disabled])') || []).find(
      button => !dialog?.contains(button)
    );
    (anchor || document.body)?.focus?.();
  } catch {
    // Focus is a nicety; losing it must not break tearing the card down.
  }
}

/* Entrance only, like QuitConfirm: a modal being dismissed should not linger. */
const RULES_CSS = `
@keyframes dw-rules-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: none; }
}
.dw-rules-card-anim { animation: dw-rules-in 0.14s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .dw-rules-card-anim { animation: none; }
}

/* The deck is taller than the card on most windows, so fade its bottom edge:
   the cut-off section says "there is more below" far better than a scrollbar
   that a trackpad hides. The scroll region's own bottom padding is what sits
   under the fade once you reach the end, so no line is ever left greyed out. */
.dw-rules-scroll {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
}

/* The scroll region is a tab stop so it can be reached — and arrow-scrolled —
   without a mouse (WCAG 2.1.1); the inset outline keeps that visible without
   the card clipping it. */
.dw-rules-scroll:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
  border-radius: 6px;
}

.dw-rules-sec {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 0.7rem 0;
  border-top: 1px solid var(--ui-border);
}
.dw-rules-sec:first-child { border-top: none; padding-top: 0.15rem; }
.dw-rules-fig {
  flex: 0 0 104px;
  width: 104px;
  color: var(--ui-text-muted);
}
.dw-rules-fig svg { display: block; width: 100%; height: auto; }

.dw-rules-close {
  font-size: 1.35rem;
  line-height: 1;
  padding: 0.1rem 0.5rem;
}

/* Narrow phones: the figure stacks over its copy rather than squeezing it. */
@media (max-width: 520px) {
  .dw-rules-sec { flex-direction: column; align-items: center; text-align: center; gap: 0.4rem; }
  .dw-rules-fig { flex: 0 0 auto; }
}
`;

const STYLE = {
  /*
   * Above QuitConfirm (1100) and the settings die (1000): the reference can be
   * opened from the HUD while the quit dialog is closed, and whatever else is
   * on screen, this card is what answers a click while it is up.
   */
  scrim: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
    background: 'var(--ui-scrim)',
    pointerEvents: 'auto',
  },
  card: {
    ...MENU_STYLE.panel,
    width: 'min(660px, 100%)',
    maxHeight: '82vh',
    display: 'flex',
    flexDirection: 'column',
    padding: '0.9rem 1.1rem 1rem',
    overflow: 'hidden',
    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.35)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    flexShrink: 0,
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    letterSpacing: '0.06em',
    color: 'var(--ui-text)',
    margin: 0,
  },
  /* Flex child that scrolls: min-height 0 or the content wins and the card grows. */
  scroll: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    margin: '0.5rem 0 0.7rem',
    padding: '0 0.2rem 1.4rem 0',
  },
  /* The menu eyebrow, minus the ink halo: this one sits on a panel, not on the
     live board, so the halo would only smudge it. */
  eyebrow: {
    ...MENU_STYLE.eyebrow,
    textShadow: 'none',
  },
  heading: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.05rem',
    letterSpacing: '0.03em',
    color: 'var(--ui-text)',
    margin: '0 0 0.2rem',
  },
  body: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    lineHeight: 1.45,
    color: 'var(--ui-text-muted)',
    margin: 0,
  },
  bullets: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    lineHeight: 1.45,
    color: 'var(--ui-text-muted)',
    margin: 0,
    paddingLeft: '1.1rem',
  },
  footer: {
    display: 'flex',
    justifyContent: 'center',
    flexShrink: 0,
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore: `rulesOpen` and the motion preference
 * @param {() => void} props.onClose - Close button / GOT IT / Escape / backdrop
 */
export function RulesModal({ store, onClose }) {
  const open = useGameStore(store, s => s.rulesOpen);
  const prefs = useGameStore(store, s => s.preferences);
  const dialogRef = useRef(null);
  const scrollRef = useRef(null);
  /** Element that had focus when the card opened, restored when it closes. */
  const returnFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      /*
       * Claim the key. QuitConfirm and the settings dropdown both skip an
       * Escape that was already claimed, so preventDefault() here is what stops
       * "Abandon this game?" opening behind this card — and the dropdown from
       * closing on the same press.
       */
      event.preventDefault();
      onClose();
    };
    /*
     * Capture on `window`: the first listener in the document to see the key,
     * whatever mounted when. Registered and removed with the same `true`, or
     * the removal silently misses (capture and bubble are separate lists).
     */
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [open, onClose]);

  /*
   * Focus lands in the scroll region rather than on a button: the card is
   * something to read, so arrow keys should scroll it straight away, and a
   * screen reader announces the dialog and its title on the way in. On close it
   * goes back to whatever opened the card, or to a still-mounted control when
   * that opener has gone (see restoreFocus).
   */
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    scrollRef.current?.focus();
    return () => {
      const previous = returnFocusRef.current;
      returnFocusRef.current = null;
      restoreFocus(previous, dialogRef.current);
    };
  }, [open]);

  /**
   * Keep Tab inside the card. Unlike QuitConfirm's two fixed buttons this one
   * has a variable set (close, the scroll region, GOT IT), so collect them
   * from the DOM rather than from refs.
   *
   * The handler hangs off the card, so it only ever sees a Tab pressed with
   * focus inside it — which is why the card itself is a tabindex="-1" focus
   * target: clicking its unfocusable chrome (the title, a gap, the footer row)
   * would otherwise drop focus to `<body>`, out of this handler's reach, and
   * the next Tab would walk the page under the scrim.
   */
  const handleTab = useCallback(event => {
    if (event.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || []);
    event.preventDefault();
    if (items.length === 0) {
      // Nothing to cycle: park on the card rather than letting Tab out of it.
      dialogRef.current?.focus?.();
      return;
    }
    const current = items.indexOf(document.activeElement);
    // current === -1 (focus on the card itself) falls through to first/last.
    const next = event.shiftKey
      ? (current <= 0 ? items.length : current) - 1
      : (current + 1) % items.length;
    items[next]?.focus();
  }, []);

  const handleScrimClick = useCallback(
    event => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose]
  );

  if (!open) return null;

  // The system-level preference is handled in CSS; this honors an explicit "on".
  const animate = prefs?.reducedMotion !== 'on';

  return (
    <div style={STYLE.scrim} onClick={handleScrimClick}>
      {/* Self-contained chrome, as everywhere else: a standalone render (a
          test, a screen without the settings die) still gets .dw-opt/.dw-btn.
          Duplicate mounts are harmless — identical rules. */}
      <style>{CHROME_CSS + RULES_CSS}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dw-rules-title"
        className={animate ? 'dw-rules-card-anim' : undefined}
        style={STYLE.card}
        tabIndex={-1}
        onKeyDown={handleTab}
      >
        <div style={STYLE.header}>
          <h2 id="dw-rules-title" style={STYLE.title}>
            HOW TO PLAY
          </h2>
          <button
            type="button"
            className="dw-opt dw-rules-close"
            onClick={onClose}
            aria-label="Close how to play"
          >
            &times;
          </button>
        </div>

        <div
          ref={scrollRef}
          className="dw-rules-scroll"
          style={STYLE.scroll}
          /* A named region, not a bare div: without the role the label below is
             not exposed to a screen reader, and the tab stop lands on nothing. */
          role="region"
          tabIndex={0}
          aria-label="The rules, in five parts"
        >
          {RULES_SECTIONS.map(section => (
            <section key={section.id} className="dw-rules-sec">
              <div className="dw-rules-fig">
                <section.Figure />
              </div>
              <div>
                <div style={STYLE.eyebrow}>{section.eyebrow}</div>
                <h3 style={STYLE.heading}>{section.heading}</h3>
                {section.body && <p style={STYLE.body}>{section.body}</p>}
                {section.bullets && (
                  <ul style={STYLE.bullets}>
                    {section.bullets.map(tip => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          ))}
        </div>

        <div style={STYLE.footer}>
          <button
            type="button"
            className="dw-btn"
            style={MENU_STYLE.secondaryBtn}
            onClick={onClose}
          >
            GOT IT
          </button>
        </div>
      </div>
    </div>
  );
}
