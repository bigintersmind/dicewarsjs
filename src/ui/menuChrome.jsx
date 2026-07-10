/**
 * Shared Menu Chrome
 *
 * The title screen's visual language, extracted so every menu screen (Arena,
 * Tournament, Leaderboard) is built from the same parts instead of inventing
 * its own: the original 2001 art's white double-rimmed button (`.dw-btn`,
 * after BT_GRAPH: #fff face, #ccc inner edge, #333 rim) and bare Anton text
 * option (`.dw-opt`), the wordmark-style bevel headline
 * (`.dw-screen-title`, set in the logotype's exact layer palette), the Roboto
 * eyebrow label, and the translucent panel that carries dense data over the
 * live attract-mode board. All of it floats on `var(--ui-scrim)` — the same
 * tint the title screen uses over the background game.
 *
 * The white button and the headline bevel keep fixed colors across themes:
 * like the wordmark itself, they're part of the game's identity and read well
 * over the scrimmed board in both dark and light. Everything theme-dependent
 * goes through var(--ui-*).
 *
 * @module ui/menuChrome
 */

/*
 * Interactive states (hover/active/focus/disabled) can't be done with inline
 * styles, so the shared classes live in this stylesheet. Rendered by
 * MenuScreen and by TitleScreen — only one screen mounts at a time, and the
 * rules are identical either way.
 */
export const CHROME_CSS = `
.dw-btn {
  font-family: Anton, sans-serif;
  color: #111111;
  background: #ffffff;
  border: 3px solid #333333;
  border-radius: 12px;
  box-shadow: inset 0 0 0 3px #cccccc, 0 4px 0 rgba(0, 0, 0, 0.3);
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: transform 0.08s ease, box-shadow 0.08s ease, border-color 0.12s ease;
}
.dw-btn:hover { border-color: #7a7a7a; }
.dw-btn:active {
  transform: translateY(3px);
  box-shadow: inset 0 0 0 3px #cccccc, 0 1px 0 rgba(0, 0, 0, 0.3);
}
.dw-btn:focus-visible { outline: 3px solid var(--ui-accent); outline-offset: 3px; }
.dw-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
  box-shadow: inset 0 0 0 3px #cccccc, 0 4px 0 rgba(0, 0, 0, 0.3);
}
a.dw-btn { display: inline-block; text-decoration: none; }

.dw-opt {
  font-family: Anton, sans-serif;
  background: transparent;
  border: none;
  padding: 0.1rem 0.4rem;
  color: var(--ui-text-muted);
  text-shadow: 0 1px 4px var(--ui-bg);
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: color 0.12s ease;
}
.dw-opt:hover { color: var(--ui-text); }
.dw-opt[aria-pressed='true'] { color: var(--ui-accent); }
.dw-opt:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.dw-opt:disabled { opacity: 0.5; cursor: not-allowed; }

/*
 * Screen headline in the DICE WARS logotype's own bevel: yellow rim light
 * up-left, orange face, and the wordmark's brown layer stack extruded
 * down-right (#C57900 → #875300 → #4A2D00 are titleArt.jsx's exact values),
 * over a soft drop shadow like the one TitleScreen puts under the wordmark.
 */
.dw-screen-title {
  font-family: Anton, sans-serif;
  font-size: clamp(2.3rem, 6vw, 3rem);
  letter-spacing: 0.08em;
  color: #ff9c00;
  text-shadow:
    -2px -2px 0 #ffff33,
    2px 2px 0 #c57900,
    3px 3px 0 #875300,
    5px 5px 0 #4a2d00,
    4px 9px 16px rgba(0, 0, 0, 0.4);
}

@keyframes dw-rise {
  from { opacity: 0; transform: translateY(-14px); }
  to { opacity: 1; transform: none; }
}
@keyframes dw-pop {
  0% { opacity: 0; transform: scale(0.82) rotate(-3deg); }
  70% { transform: scale(1.04) rotate(0.5deg); }
  100% { opacity: 1; transform: none; }
}
@keyframes dw-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dw-anim-rise { animation: dw-rise 0.4s ease-out both; }
.dw-anim-pop { animation: dw-pop 0.45s ease-out 0.1s both; }
.dw-anim-fade { animation: dw-fade 0.35s ease-out 0.2s both; }
@media (prefers-reduced-motion: reduce) {
  .dw-anim-rise, .dw-anim-pop, .dw-anim-fade { animation: none; }
}
`;

/** Shared inline-style fragments for menu screens. */
export const MENU_STYLE = {
  /** Full-viewport scroll column over the scrimmed live board. */
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
    overflowY: 'auto',
    padding: '2rem 1rem 2rem',
    background: 'var(--ui-scrim)',
    pointerEvents: 'auto',
    userSelect: 'none',
    color: 'var(--ui-text)',
  },
  screenTitle: {
    margin: '0 0 1.3rem',
    textAlign: 'center',
  },
  /** One centered content block (an option group, a panel, results). */
  section: {
    width: '100%',
    maxWidth: '560px',
    marginBottom: '1.1rem',
    textAlign: 'center',
  },
  /** Roboto meta label above an option row — the title's "MAP SIZE" idiom. */
  eyebrow: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.68rem',
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--ui-text-muted)',
    textShadow: '0 1px 4px var(--ui-bg)',
    marginBottom: '0.2rem',
  },
  /** Small helper line under an option group. */
  caption: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    color: 'var(--ui-text-muted)',
    textShadow: '0 1px 4px var(--ui-bg)',
    marginTop: '0.35rem',
  },
  /** Wrapping row of .dw-opt toggles. */
  optRow: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: '0.15rem',
  },
  buttonRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
    margin: '0.5rem 0 1.4rem',
  },
  primaryBtn: {
    fontSize: '1.25rem',
    padding: '0.6rem 2.2rem',
  },
  secondaryBtn: {
    fontSize: '0.95rem',
    padding: '0.55rem 1.2rem',
  },
  /** Translucent card for dense data — the title's customizePanel idiom. */
  panel: {
    width: '100%',
    padding: '0.9rem 1rem',
    background: 'var(--ui-overlay-bg)',
    border: '1px solid var(--ui-border)',
    borderRadius: '10px',
  },
  statsRow: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text-muted)',
    textShadow: '0 1px 4px var(--ui-bg)',
    marginBottom: '0.8rem',
    textAlign: 'center',
  },
  errorBanner: {
    background: 'var(--ui-accent-soft)',
    border: '1px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    padding: '0.6rem 1.2rem',
    borderRadius: '6px',
    margin: '0 0 1.2rem',
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.95rem',
    maxWidth: '440px',
    textAlign: 'center',
  },
};

/**
 * Scrimmed container + bevel headline shared by every menu screen. Children
 * flow as centered sections below the title.
 *
 * @param {Object} props
 * @param {string} props.title - Headline text (rendered in the wordmark bevel)
 * @param {import('preact').ComponentChildren} props.children
 */
export function MenuScreen({ title, children }) {
  return (
    <div style={MENU_STYLE.container}>
      <style>{CHROME_CSS}</style>
      <h1 className="dw-screen-title dw-anim-rise" style={MENU_STYLE.screenTitle}>
        {title}
      </h1>
      {children}
    </div>
  );
}
