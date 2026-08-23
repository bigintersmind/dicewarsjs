/**
 * Title Screen
 *
 * The landing page, styled after the original 2001 GAMEDESIGN title screen:
 * the decoded original wordmark + starburst-dice logo (see titleArt.jsx) over
 * the live attract-mode board (TitleAttractMode draws on the canvas behind
 * this screen; the container's `--ui-scrim` tint keeps the UI legible on top
 * of it). Options follow the original's bare-text language — player counts as
 * a 4/3 grid of Anton text, red when selected — and START is the original's
 * white double-rimmed button. Modern additions (map size, difficulty row,
 * per-slot bot picker with its luck row, the AI vs AI text link) share those
 * idioms rather than introducing new chrome.
 *
 * Hierarchy (#182, playtest feedback): the page has one happy path — setup →
 * START — so START is its only filled control (AI vs AI is a bare .dw-opt
 * beside it), a one-line caption names that path, and the bot-author screens
 * (Arena / Tournament / Leaderboard) are footer material: menuChrome's
 * FooterNav at the foot of the page, not the mode rail App shows on the other
 * hub screens. This is still the rail's "Battle" tab — every other hub
 * screen's rail leads back here. The footer is that link row and nothing
 * else: the original game's copyright line and the repo link that rode it
 * are gone — the source is credited in the repository and the settings panel
 * links "Source on GitHub", so the landing page ends on its own controls.
 *
 * @module ui/TitleScreen
 */

import { useState } from 'preact/hooks';
import {
  DEFAULT_MAP_SIZE,
  DEFAULT_LUCK,
  LUCK_LEVELS,
  LUCK_DIFFICULTY,
  resolveLuck,
} from '../utils/config.js';
import { DIFFICULTY_MODES, lineupForMode } from '../ai/difficultyModes.js';
import { getAIStrategiesByCategory } from '../ai/aiConfig.js';
import { getCommunityBotList } from '../arena/communityBots.js';
import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS, MENU_STYLE, FooterNav } from './menuChrome.jsx';
import { TitleWordmark, TitleLogo } from './titleArt.jsx';
import {
  PLAYER_COLORS_CSS,
  COLORBLIND_PLAYER_COLORS_CSS,
  PLAYER_COLOR_NAMES,
  COLORBLIND_PLAYER_COLOR_NAMES,
} from '../renderer/constants.js';

/**
 * Map-size options shown on the title screen. `value` keys must match
 * MAP_SIZE_PRESETS in src/utils/config.js (the controller resolves them to
 * concrete grid dimensions at game-creation time).
 */
const MAP_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

/*
 * Built-in AI strategies for the per-slot picker, split into two sections: the
 * learned neural personas (Self-Play) shown above the hand-written heuristics
 * (General). Community bots form a third section (below).
 */
const { selfPlay: SELF_PLAY_OPTIONS, general: GENERAL_OPTIONS } = getAIStrategiesByCategory();

/*
 * Curated community bots offered alongside the built-ins. Their option values
 * are namespaced with `community:` so the controller can tell them apart from
 * built-in `ai_*` ids and route them through the modern-bot adapter.
 */
const COMMUNITY_OPTIONS = getCommunityBotList();

/*
 * The classic-button (.dw-btn), option-text (.dw-opt), and entrance-animation
 * styles are shared with the other menu screens via menuChrome.jsx
 * (CHROME_CSS, prepended to this screen's CSS below). Only the title screen's
 * own hero layout lives here.
 */
const CSS = `
.dw-hero { display: flex; align-items: center; justify-content: center; }
.dw-panel { display: flex; flex-direction: column; align-items: flex-start; }
@media (max-width: 760px) {
  .dw-hero { flex-direction: column; gap: 1rem; }
  .dw-panel { align-items: center; }
  .dw-panel .dw-rows { justify-content: center; }
  /* Labels and the caption follow their (now centered) rows; the players
     eyebrow in particular would otherwise sit at the far left edge, since a
     wrapping row is as wide as the panel. */
  .dw-panel .dw-eyebrow, .dw-panel .dw-hint, .dw-panel .dw-luck-hint, .dw-panel .dw-mode-hint { text-align: center; }
}
`;

const STYLE = {
  container: {
    position: 'relative',
    /* A definite height, not min-height: `#app` is overflow-visible and
       `html, body` are `overflow: hidden`, so a box that merely grows to fit
       its content never scrolls — on a short viewport (landscape phone,
       844×390) START and the footer row would be painted off-screen with no
       way to reach them by wheel or touch. A definite size still lets the auto
       margins center the page when the content is short, and makes overflowY
       scroll when it isn't. (MENU_STYLE.container does the same.) */
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    overflowY: 'auto',
    /* Top padding clears the fixed settings die: `.dw-set-die` is 36px square
       at top: 0.75rem (SettingsPanel.jsx), so its bottom edge lands at exactly
       3rem and 3.25rem leaves a little air. There is no mode rail on this
       screen (#182). */
    padding: '3.25rem 1rem 1.2rem',
    background: 'var(--ui-scrim)',
    pointerEvents: 'auto',
    userSelect: 'none',
    color: 'var(--ui-text)',
  },
  /*
   * Two auto margins split the free vertical space (this one and STYLE.footer's):
   * the spacer centers the main block in the space above the footer — the
   * More-game-modes link row — which stays pinned to the viewport bottom. On
   * short viewports both collapse to zero and the screen scrolls normally.
   */
  topSpacer: {
    marginTop: 'auto',
  },
  wordmark: {
    width: 'min(92vw, 600px)',
    height: 'auto',
    /* As a column-flex item the wordmark gives up height when the setup
       column outgrows a short viewport (Custom open at 7 players), which is
       the intended graceful step-down — but unfloored it shrinks all the way
       to nothing. Below this the container scrolls instead. */
    minHeight: '3rem',
    filter: 'drop-shadow(0 5px 14px rgba(0, 0, 0, 0.3))',
  },
  hero: {
    gap: '2.5rem',
    flexWrap: 'wrap',
    margin: '1.2rem 0 0',
  },
  logo: {
    width: 'min(60vw, 250px)',
    height: 'auto',
    flexShrink: 0,
  },
  panel: {
    gap: '0.9rem',
  },
  optionRows: {
    display: 'flex',
    flexWrap: 'wrap',
    maxWidth: '440px',
    rowGap: '0.15rem',
  },
  playerOpt: {
    fontSize: '1.25rem',
  },
  sizeOpt: {
    fontSize: '1rem',
    textTransform: 'uppercase',
  },
  /*
   * "Your luck" (#179) is the last block of the Custom panel, under the
   * per-slot picker: a hairline above it separates "who plays" from "how the
   * dice roll" without a second box. Presets never show it — they always
   * mean fair dice, so the rung is only offered where the player is already
   * hand-tuning the game.
   */
  luckSection: {
    marginTop: '0.6rem',
    paddingTop: '0.6rem',
    borderTop: '1px solid var(--ui-border)',
  },
  /*
   * The selected luck rung's one-line explanation. A touch device has no hover,
   * so the row's meaning has to be on the page rather than in a `title`; muted
   * Roboto keeps it helper text rather than a fourth option. Wraps on the
   * Custom panel's own width.
   */
  luckBlurb: {
    ...MENU_STYLE.caption,
    marginTop: '0.1rem',
  },
  /*
   * One line under the Difficulty row saying where luck lives. The presets
   * hide the luck row, so without this nothing on the page says the option
   * exists — or that picking a preset put the dice back to fair. Always
   * mounted (its text swaps, not the element), so the aria-live announcement
   * actually fires when a preset click unmounts the luck row's own live region.
   */
  modeHint: {
    ...MENU_STYLE.caption,
    marginTop: '0.1rem',
    /* Matches optionRows, so the sentence wraps on the row's own width. */
    maxWidth: '440px',
  },
  eyebrow: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.65rem',
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--ui-text-muted)',
    textShadow: 'var(--ui-text-halo)',
    marginBottom: '0.15rem',
  },
  /*
   * The one line of onboarding copy on the page: names the happy path right
   * where it ends. MENU_STYLE.caption's Roboto helper idiom, sitting flush on
   * the button row below it.
   */
  hint: {
    ...MENU_STYLE.caption,
    marginTop: 0,
    marginBottom: '0.15rem',
  },
  buttonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
    marginTop: '0.4rem',
  },
  /*
   * Tertiary by design (the map preview's ← BACK idiom): bare muted Anton
   * beside the one filled button, so START is the decision and this reads as
   * the side door. Sized to the map-size/difficulty option text (a step under
   * the player counts) so it never competes with the setup rows either.
   */
  aiLink: {
    fontSize: '1rem',
  },
  /*
   * Footer, pinned to the viewport floor by the auto margin (see topSpacer):
   * just the More-game-modes link row, centered so it stays balanced if a
   * narrow viewport forces it to wrap. The bottom padding keeps the row off
   * the floor (on top of the container's own).
   */
  footer: {
    marginTop: 'auto',
    padding: '2rem 0 0.6rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  errorBanner: {
    background: 'var(--ui-accent-soft)',
    border: '1px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    padding: '0.6rem 1.2rem',
    borderRadius: '6px',
    margin: '1rem 0 0',
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.95rem',
    maxWidth: '400px',
    textAlign: 'center',
  },
  customizePanel: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: '340px',
    padding: '0.8rem 1rem',
    background: 'var(--ui-overlay-bg)',
    border: '1px solid var(--ui-border)',
    borderRadius: '10px',
  },
  /*
   * Only the slot list scrolls; the luck row below it stays pinned to the
   * panel's floor. Capping the whole panel instead would push the luck row
   * past the fold at 6+ players, with nothing to say it is there — the one
   * place the rung is offered would be invisible exactly where it matters.
   */
  slotList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    maxHeight: '30vh',
    overflowY: 'auto',
  },
  slotRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.8rem',
  },
  slotIdentity: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  swatch: {
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: '1px solid rgba(255, 255, 255, 0.3)',
    flexShrink: 0,
  },
  slotLabel: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.9rem',
    color: 'var(--ui-text)',
  },
  humanTag: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.9rem',
    color: 'var(--ui-accent)',
  },
  select: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.9rem',
    padding: '0.3rem 0.5rem',
    background: 'var(--ui-overlay-bg)',
    color: 'var(--ui-text)',
    border: '2px solid var(--ui-border)',
    borderRadius: '4px',
    cursor: 'pointer',
    minWidth: '160px',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore, used to seed the setup controls (player count,
 *   map size, difficulty, bot lineup — plus the luck rung when the stored difficulty is
 *   Custom) from the last game's persisted config
 * @param {string | null} [props.error] - Error message to display
 * @param {(config: { playerCount: number, spectator: boolean, mapSize: string, difficulty: string, aiAssignments: (string | null)[], luck: number }) => void} props.onStart
 * @param {(screenId: string) => void} [props.onNavigate] - Footer link row
 *   (Arena / Tournament / Leaderboard): called with the tapped screen id, as
 *   the mode rail's onNavigate is. Omitted only in isolated renders — App
 *   always supplies it — and the footer is left out without it.
 */
export function TitleScreen({ store, error, onStart, onNavigate }) {
  const prefs = useGameStore(store, s => s.preferences);
  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const colorNames = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLOR_NAMES : PLAYER_COLOR_NAMES;
  /*
   * The system-level preference is handled in CSS (prefers-reduced-motion);
   * this only needs to honor an explicit in-app "on".
   */
  const animate = prefs?.reducedMotion !== 'on';

  /*
   * Player count and map size are seeded from the store's persisted config —
   * the choices the player made for the last game — so a title -> map preview
   * -> back round-trip returns them exactly as they were left (#180). The
   * fallbacks match the store's own first-launch defaults (7 players, medium),
   * so a fresh load looks unchanged.
   */
  const [playerCount, setPlayerCount] = useState(() => store.getState().config.playerCount ?? 7);
  const [mapSize, setMapSize] = useState(() => store.getState().config.mapSize ?? DEFAULT_MAP_SIZE);
  const [difficulty, setDifficulty] = useState(
    () => store.getState().config.difficulty ?? 'standard'
  );
  /*
   * "Your luck" (#179) is part of Custom, like the per-slot lineup: the presets
   * always play fair dice, and a preset click resets the rung the same way it
   * replaces the lineup (handleSelectMode). So the seed goes through
   * resolveLuck — the same rule the controller applies when it builds the game —
   * and a stored rung under a preset is dropped: it has no row to show it, and
   * sending it would start a handicapped game behind a label that promises
   * otherwise. The controller never stores that pair, so the drop is named in
   * the console like the off-ladder case below — if it ever fires, some new
   * writer of `config.luck` forgot the rule.
   *
   * The seed is also checked against the ladder: a rung that isn't on it would
   * render a row with nothing pressed and no blurb, and START would hand the
   * controller a value luckToHandicap throws on. Fall back to Normal and name
   * the discarded value, since a stale/renamed rung is a bug worth seeing.
   */
  const [luck, setLuck] = useState(() => {
    const { difficulty: storedDifficulty, luck: stored } = store.getState().config;
    if (stored == null) return DEFAULT_LUCK;
    if (resolveLuck(storedDifficulty, stored) !== stored) {
      console.warn(
        `TitleScreen: ignoring stored luck rung ${JSON.stringify(stored)} — the stored difficulty is ${JSON.stringify(storedDifficulty)}, and only ${JSON.stringify(LUCK_DIFFICULTY)} plays a rung.`
      );
      return DEFAULT_LUCK;
    }
    if (LUCK_LEVELS.some(level => level.id === stored)) return stored;
    console.warn(
      `TitleScreen: ignoring luck rung ${JSON.stringify(stored)} — not on the LUCK_LEVELS ladder; falling back to Normal.`
    );
    return DEFAULT_LUCK;
  });
  /*
   * Per-slot AI strategy IDs (index = player slot). Seeded from the store's
   * current assignments — the last game's persisted lineup (possibly truncated
   * to its player count) or the Standard default on first launch. `store` is
   * required (the useGameStore call above already depends on it).
   */
  const [assignments, setAssignments] = useState(() =>
    (store.getState().config.aiAssignments ?? []).slice()
  );

  /*
   * A preset click replaces the whole lineup with the mode's and puts the dice
   * back to Normal — discarding any hand edits, so a preset's label is the
   * whole truth about the game it starts; Custom keeps the current lineup (the
   * last-selected preset, or the store-seeded assignments when picked first)
   * and reveals the per-slot picker and the luck row below.
   */
  const handleSelectMode = modeId => {
    setDifficulty(modeId);
    if (modeId !== LUCK_DIFFICULTY) {
      setAssignments([...DIFFICULTY_MODES[modeId].lineup]);
      setLuck(DEFAULT_LUCK);
    }
  };

  const handleAssign = (slot, aiId) => {
    setAssignments(prev => {
      const next = prev.slice();
      next[slot] = aiId;
      return next;
    });
  };

  /*
   * Build the lineup passed to the controller. Preset modes derive it from the
   * mode's own lineup — the seeded per-slot state may be truncated to a
   * previous game's player count, and padding it with defaults could silently
   * contradict the pressed preset's label. Custom uses the per-slot picker
   * state: slot 0 is always the human seat (null — the controller fills it
   * with a default bot in spectator mode), and every AI slot resolves to a
   * concrete strategy id so a null never gets mistaken for a human.
   */
  const buildAssignments = () =>
    difficulty === 'custom'
      ? Array.from({ length: playerCount }, (_, i) =>
          i === 0 ? null : assignments[i] || 'ai_default'
        )
      : lineupForMode(difficulty, playerCount);

  const handleStart = () => {
    onStart({
      playerCount,
      spectator: false,
      mapSize,
      difficulty,
      luck,
      aiAssignments: buildAssignments(),
    });
  };

  /*
   * The spectator payload carries `luck` too: there is no human seat to favour,
   * so the controller drops the handicap, but the store still remembers the
   * rung — an AI-vs-AI detour must not quietly reset the player's choice.
   */
  const handleAIvsAI = () => {
    onStart({
      playerCount,
      spectator: true,
      mapSize,
      difficulty,
      luck,
      aiAssignments: buildAssignments(),
    });
  };

  return (
    <div style={STYLE.container}>
      <style>{CHROME_CSS + CSS}</style>
      <div style={STYLE.topSpacer} />

      <TitleWordmark className={animate ? 'dw-anim-rise' : ''} style={STYLE.wordmark} />

      {error && <div style={STYLE.errorBanner}>{error}</div>}

      <div className="dw-hero" style={STYLE.hero}>
        <TitleLogo className={animate ? 'dw-anim-pop' : ''} style={STYLE.logo} />

        <div className={`dw-panel ${animate ? 'dw-anim-fade' : ''}`} style={STYLE.panel}>
          <div>
            <div className="dw-eyebrow" style={STYLE.eyebrow}>
              Players
            </div>
            <div className="dw-rows" role="group" aria-label="Players" style={STYLE.optionRows}>
              {[2, 3, 4, 5, 6, 7, 8].map(n => (
                <button
                  key={n}
                  type="button"
                  className="dw-opt"
                  aria-label={`Play with ${n} players`}
                  aria-pressed={n === playerCount}
                  style={STYLE.playerOpt}
                  onClick={() => setPlayerCount(n)}
                >
                  {n} players
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="dw-eyebrow" style={STYLE.eyebrow}>
              Map size
            </div>
            <div className="dw-rows" role="group" aria-label="Map size" style={STYLE.optionRows}>
              {MAP_SIZE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className="dw-opt"
                  aria-label={`${opt.label} map`}
                  aria-pressed={opt.value === mapSize}
                  style={STYLE.sizeOpt}
                  onClick={() => setMapSize(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="dw-eyebrow" style={STYLE.eyebrow}>
              Difficulty
            </div>
            <div
              className="dw-rows"
              role="group"
              aria-label="Difficulty"
              aria-describedby="dw-mode-hint"
              style={STYLE.optionRows}
            >
              {[...Object.values(DIFFICULTY_MODES), { id: 'custom', name: 'Custom' }].map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  className="dw-opt"
                  aria-label={`${mode.name} difficulty`}
                  aria-pressed={mode.id === difficulty}
                  style={STYLE.sizeOpt}
                  onClick={() => handleSelectMode(mode.id)}
                >
                  {mode.name}
                </button>
              ))}
            </div>
            <div
              id="dw-mode-hint"
              className="dw-mode-hint"
              aria-live="polite"
              style={STYLE.modeHint}
            >
              {difficulty === LUCK_DIFFICULTY
                ? 'Custom: pick your bots and your luck below.'
                : 'Presets roll fair dice — tune your luck under Custom.'}
            </div>
          </div>

          {difficulty === 'custom' && (
            <div style={STYLE.customizePanel}>
              <div style={STYLE.slotList}>
                {Array.from({ length: playerCount }, (_, i) => {
                  const colorName = colorNames[i % colorNames.length];
                  return (
                    <div key={i} style={STYLE.slotRow}>
                      <span style={STYLE.slotIdentity}>
                        <span
                          style={{
                            ...STYLE.swatch,
                            background: colorPalette[i % colorPalette.length],
                          }}
                        />
                        <span style={STYLE.slotLabel}>{colorName}</span>
                      </span>
                      {i === 0 ? (
                        <span style={STYLE.humanTag}>You (human)</span>
                      ) : (
                        <select
                          aria-label={`Bot for ${colorName} player`}
                          style={STYLE.select}
                          value={assignments[i] || 'ai_default'}
                          onChange={e => handleAssign(i, e.target.value)}
                        >
                          <optgroup label="Self-Play">
                            {SELF_PLAY_OPTIONS.map(ai => (
                              <option key={ai.id} value={ai.id} title={ai.description}>
                                {ai.name}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="General">
                            {GENERAL_OPTIONS.map(ai => (
                              <option key={ai.id} value={ai.id} title={ai.description}>
                                {ai.name}
                              </option>
                            ))}
                          </optgroup>
                          {COMMUNITY_OPTIONS.length > 0 && (
                            <optgroup label="Community">
                              {COMMUNITY_OPTIONS.map(bot => (
                                <option
                                  key={bot.id}
                                  value={`community:${bot.id}`}
                                  title={bot.description}
                                >
                                  {bot.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={STYLE.luckSection}>
                <div className="dw-eyebrow" style={STYLE.eyebrow}>
                  Your luck
                </div>
                <div
                  className="dw-rows"
                  role="group"
                  aria-label="Your luck"
                  aria-describedby="dw-luck-blurb"
                  style={STYLE.optionRows}
                >
                  {LUCK_LEVELS.map(level => (
                    <button
                      key={level.id}
                      type="button"
                      className="dw-opt"
                      /* "Lucky luck" would be the natural `${name} luck` phrasing;
                         the prefix form keeps the axis in the name without it. */
                      aria-label={`Luck: ${level.name}`}
                      aria-pressed={level.id === luck}
                      style={STYLE.sizeOpt}
                      onClick={() => setLuck(level.id)}
                    >
                      {level.name}
                    </button>
                  ))}
                </div>
                {/* Its own class, not .dw-hint: that one is the page's single
                    happy-path caption above START (#182). Both centre on a narrow
                    viewport, per the rule in CSS above.

                    aria-live: the group's aria-describedby is only announced on
                    entry, so without it a screen-reader user tabbing between rungs
                    hears the name change but never what it means. */}
                <div
                  id="dw-luck-blurb"
                  className="dw-luck-hint"
                  aria-live="polite"
                  style={STYLE.luckBlurb}
                >
                  {LUCK_LEVELS.find(level => level.id === luck)?.blurb}
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="dw-hint" style={STYLE.hint}>
              Pick your players, map and difficulty, then START.
            </div>
            <div className="dw-rows" style={STYLE.buttonRow}>
              <button className="dw-btn" style={MENU_STYLE.heroBtn} onClick={handleStart}>
                START
              </button>
              {/* The label alone doesn't say what it does, and `title` is
                  mouse-only; the aria-label spells it out for everyone else.
                  It opens with the visible text, so WCAG 2.5.3 label-in-name
                  still holds and voice control can say "AI vs AI". */}
              <button
                type="button"
                className="dw-opt"
                style={STYLE.aiLink}
                onClick={handleAIvsAI}
                aria-label="AI vs AI — watch the bots play your setup"
                title="Sit this one out and watch the bots play your setup"
              >
                AI vs AI
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* The footer is the link row alone, so it only mounts with it: an
          isolated render with no onNavigate gets no empty landmark. */}
      {onNavigate && (
        <footer className={animate ? 'dw-anim-fade' : ''} style={STYLE.footer}>
          <FooterNav onNavigate={onNavigate} />
        </footer>
      )}
    </div>
  );
}
