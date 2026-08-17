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
 * Also home to the mode rail (`TopNav`): the tab bar App mounts across the
 * hub screens (NAV_TABS — Battle, Arena, Tournament, Leaderboard). It replaced
 * the per-screen BACK buttons, so on Arena / Tournament / Leaderboard it is
 * the only way around (and back to Battle); the current tab is set in the
 * logotype bevel at miniature scale, so "where you are" is always written in
 * the game's own lettering. The title screen itself does NOT carry the rail:
 * playtesting found it gave the bot-author screens the same weight as
 * starting a game (#182), so there the same destinations sit in a footer link
 * row (`FooterNav`) beside the credits, and the landing page's scan path is
 * setup → START.
 *
 * The white button, the headline bevel, and the rail's active-tab bevel keep
 * fixed colors across themes: like the wordmark itself, they're part of the
 * game's identity and read well over the scrimmed board in both dark and
 * light. Everything theme-dependent goes through var(--ui-*).
 *
 * @module ui/menuChrome
 */

import { Fragment } from 'preact';

/*
 * Interactive states (hover/active/focus/disabled) can't be done with inline
 * styles, so the shared classes live in this stylesheet. Everything that uses
 * the classes mounts its own copy — MenuScreen, TitleScreen, MapPreview,
 * SettingsPanel, GameHUD, QuitConfirm — so each is self-contained instead of
 * relying on some other component happening to be on screen. Several are
 * therefore mounted at once (SettingsPanel rides along on every screen, and the
 * quit confirm sits on top of the HUD), which is harmless: the rules are
 * identical, so whichever copy wins declares the same thing. The one rule any
 * of them overrides — SettingsPanel's `.dw-opt.dw-set-opt` padding — is doubled
 * up to win on specificity rather than source order, so mount order never
 * decides anything.
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
  text-shadow: var(--ui-text-halo);
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
  /**
   * Full-viewport scroll column over the scrimmed live board. The top padding
   * clears the fixed mode rail (~55px) plus breathing room.
   */
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
    overflowY: 'auto',
    padding: '4.6rem 1rem 2rem',
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
    textShadow: 'var(--ui-text-halo)',
    marginBottom: '0.2rem',
  },
  /** Small helper line under an option group. */
  caption: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    color: 'var(--ui-text-muted)',
    textShadow: 'var(--ui-text-halo)',
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
  /*
   * The biggest button in the game and its smaller sibling: the title's START
   * and the map preview's PLAY / NEW MAP share these so the two screens read as
   * one flow (START → PLAY) instead of drifting apart. The title's AI vs AI
   * used to be the second one; since #182 it is a bare .dw-opt text link so
   * START is the landing page's single filled control.
   */
  heroBtn: {
    fontSize: 'clamp(1.35rem, 3vw, 1.6rem)',
    padding: '0.7rem 2.8rem',
  },
  heroSecondaryBtn: {
    fontSize: '1.05rem',
    padding: '0.6rem 1.3rem',
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
    textShadow: 'var(--ui-text-halo)',
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

/**
 * Canonical URL of the project's source repository. Single source of truth for
 * every in-app GitHub link (the title screen's footer, the settings panel's
 * footer, and AddBotViaGithub's deep link into docs/BOT_GUIDE.md), so the repo
 * can move without hunting down hardcoded URLs.
 */
export const REPO_URL = 'https://github.com/bigintersmind/dicewarsjs';

/**
 * The hub screens, in rail order. `id` values are `store.screen` names; this
 * list is also how App decides where the hub chrome shows — the rail on every
 * hub screen but the title, FooterNav on the title — and so must stay in sync
 * with ATTRACT_SCREENS in TitleAttractMode.js (the chrome belongs exactly
 * where the live attract board runs behind it).
 */
export const NAV_TABS = [
  { id: 'title', label: 'Battle' },
  { id: 'arena', label: 'Arena' },
  { id: 'tournament', label: 'Tournament' },
  { id: 'onlineLeaderboard', label: 'Leaderboard' },
];

/*
 * Self-contained (not part of CHROME_CSS): the rail is mounted by App outside
 * the screen switch, so it must stay styled while a lazy screen chunk is still
 * loading and no screen stylesheet is mounted. The rail band adds a second
 * layer of --ui-scrim on top of the screen's own, reading as a slightly deeper
 * strip of the same tint. The active tab is CSS-only: `aria-current="page"`
 * carries both the semantics and the bevel (declared after :hover so the bevel
 * wins on an active tab). Fixed bevel colors are titleArt.jsx's wordmark
 * palette — identity, not theme.
 */
const NAV_CSS = `
.dw-topnav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 900;
  display: flex;
  overflow-x: auto;
  background: var(--ui-scrim);
  border-bottom: 1px solid var(--ui-border);
  pointer-events: auto;
  user-select: none;
}
/* margin:auto centers the rail but still yields to the scroll edge when the
   tabs outgrow a narrow viewport (a flex 'safe center' that works everywhere).
   The side padding keeps the last tab clear of the settings die. */
.dw-topnav-rail {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
  margin: 0 auto;
  padding: 0 3.4rem;
}
.dw-tab {
  font-family: Anton, sans-serif;
  font-size: 0.95rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: transparent;
  border: none;
  padding: 1rem 0.7rem;
  color: var(--ui-text-muted);
  text-shadow: var(--ui-text-halo);
  cursor: pointer;
  transition: color 0.12s ease;
  white-space: nowrap;
}
.dw-tab:hover { color: var(--ui-text); }
.dw-tab:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
  border-radius: 4px;
}
/* The logotype bevel, miniaturized. No yellow rim-light at this scale — a
   15px glyph's strokes are as thin as the rim, which turns it to mush; the
   orange face + tight brown extrusion is the smallest treatment that still
   reads as the wordmark (and the dark extrusion keeps it legible over the
   light theme's pale scrim, exactly like the headline). */
.dw-tab[aria-current='page'] {
  color: #ff9c00;
  text-shadow:
    1px 1px 0 #875300,
    2px 2px 0 #4a2d00,
    1px 3px 6px rgba(0, 0, 0, 0.35);
  cursor: default;
}
@keyframes dw-nav-drop {
  from { opacity: 0; transform: translateY(-100%); }
  to { opacity: 1; transform: none; }
}
.dw-topnav-drop { animation: dw-nav-drop 0.4s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .dw-topnav-drop { animation: none; }
}
/* Phones: tighten until all four tabs fit beside the settings die at 360px.
   Only the right side needs die-button clearance. */
@media (max-width: 560px) {
  .dw-tab { font-size: 0.78rem; padding: 1rem 0.35rem; }
  .dw-topnav-rail { gap: 0.15rem; padding: 0 3rem 0 0.75rem; }
}
`;

/**
 * Mode rail across the hub screens other than the title (which carries
 * FooterNav instead, #182). Pure: the current screen comes in as a prop and
 * taps report the target screen id back through onNavigate — App owns the
 * actual controller navigation.
 *
 * @param {Object} props
 * @param {string} props.active - `store.screen` id of the current hub screen
 * @param {(screenId: string) => void} props.onNavigate - Called with the
 *   tapped tab's screen id (never the active one)
 * @param {boolean} [props.animate] - Play the one-time drop-in entrance
 *   (disabled for the in-app reduced-motion preference; the system-level
 *   preference is handled in CSS)
 */
export function TopNav({ active, onNavigate, animate = true }) {
  return (
    <nav className={animate ? 'dw-topnav dw-topnav-drop' : 'dw-topnav'} aria-label="Game screens">
      <style>{NAV_CSS}</style>
      <div className="dw-topnav-rail">
        {NAV_TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            className="dw-tab"
            aria-current={tab.id === active ? 'page' : undefined}
            onClick={tab.id === active ? undefined : () => onNavigate(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

/*
 * Self-contained like NAV_CSS: the footer row is a sibling of the credits at
 * the foot of the title screen and must read the same whether or not any
 * other chrome stylesheet is mounted. Anton, not the credits' Roboto, on
 * purpose — the title's rule is Anton for in-game actions (option text,
 * START, tabs) and Roboto for meta text (eyebrows, captions, credits, links
 * out) — but small, muted and unbevelled, so it reads as the way to the bot
 * screens rather than as a peer of the game setup.
 */
const FOOTER_NAV_CSS = `
.dw-footnav {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  pointer-events: auto;
  user-select: none;
}
.dw-footlink {
  font-family: Anton, sans-serif;
  font-size: 0.85rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: transparent;
  border: none;
  padding: 0.15rem 0.45rem;
  color: var(--ui-text-muted);
  text-shadow: var(--ui-text-halo);
  cursor: pointer;
  transition: color 0.12s ease;
  white-space: nowrap;
}
.dw-footlink:hover { color: var(--ui-text); }
.dw-footlink:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.dw-footnav-sep {
  font-size: 0.85rem;
  color: var(--ui-text-muted);
  text-shadow: var(--ui-text-halo);
}
`;

/**
 * The title screen's footer link row — Arena · Tournament · Leaderboard, i.e.
 * NAV_TABS minus Battle, which is the screen it sits on. Same contract as
 * TopNav: taps report the target screen id through onNavigate and App owns
 * the navigation. Placed at the foot of the page beside the credits (#182):
 * these are the bot-author screens, footer material, and the rail on each of
 * them is the way back to Battle.
 *
 * @param {Object} props
 * @param {(screenId: string) => void} props.onNavigate - Called with the
 *   tapped link's screen id
 */
export function FooterNav({ onNavigate }) {
  const links = NAV_TABS.filter(tab => tab.id !== 'title');
  return (
    <nav className="dw-footnav" aria-label="More game modes">
      <style>{FOOTER_NAV_CSS}</style>
      {links.map((tab, i) => (
        <Fragment key={tab.id}>
          {i > 0 && (
            <span className="dw-footnav-sep" aria-hidden="true">
              &middot;
            </span>
          )}
          <button type="button" className="dw-footlink" onClick={() => onNavigate(tab.id)}>
            {tab.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
