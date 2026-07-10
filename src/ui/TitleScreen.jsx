/**
 * Title Screen
 *
 * The landing page, styled after the original 2001 GAMEDESIGN title screen:
 * the decoded original wordmark + starburst-dice logo (see titleArt.jsx) over
 * the live attract-mode board (TitleAttractMode draws on the canvas behind
 * this screen; the container's `--ui-scrim` tint keeps the UI legible on top
 * of it). Options follow the original's bare-text language — player counts as
 * a 4/3 grid of Anton text, red when selected — and START / AI vs AI are the
 * original's white double-rimmed buttons. Modern additions (map size,
 * per-slot bot picker) share those idioms rather than introducing new chrome.
 * This is the "Battle" tab of the mode rail (menuChrome's TopNav, mounted by
 * App) — navigation to Arena/Tournament/Leaderboard lives there, not here.
 *
 * @module ui/TitleScreen
 */

import { useState } from 'preact/hooks';
import { DEFAULT_MAP_SIZE } from '../utils/config.js';
import { getAIStrategiesByCategory } from '../ai/aiConfig.js';
import { getCommunityBotList } from '../arena/communityBots.js';
import { useGameStore } from './hooks/useGameStore.js';
import { CHROME_CSS } from './menuChrome.jsx';
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
}
`;

const STYLE = {
  container: {
    position: 'relative',
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    overflowY: 'auto',
    /* Top padding clears the fixed mode rail (~50px). */
    padding: '4.6rem 1rem 1.2rem',
    background: 'var(--ui-scrim)',
    pointerEvents: 'auto',
    userSelect: 'none',
    color: 'var(--ui-text)',
  },
  /*
   * Two auto margins split the free vertical space: the spacer centers the
   * main block in the space above the copyright line, which stays pinned to
   * the viewport bottom. On short viewports both collapse to zero and the
   * screen scrolls normally.
   */
  topSpacer: {
    marginTop: 'auto',
  },
  wordmark: {
    width: 'min(92vw, 600px)',
    height: 'auto',
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
  eyebrow: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.65rem',
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--ui-text-muted)',
    marginBottom: '0.15rem',
  },
  buttonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
    marginTop: '0.4rem',
  },
  startBtn: {
    fontSize: 'clamp(1.35rem, 3vw, 1.6rem)',
    padding: '0.7rem 2.8rem',
  },
  aiBtn: {
    fontSize: '1.05rem',
    padding: '0.6rem 1.3rem',
  },
  copyright: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.78rem',
    color: 'var(--ui-text-muted)',
    textShadow: '0 1px 4px var(--ui-bg)',
    marginTop: 'auto',
    paddingTop: '2rem',
  },
  copyrightLink: {
    color: 'inherit',
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
  disclosureBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    background: 'transparent',
    border: 'none',
    color: 'var(--ui-text-muted)',
    textShadow: '0 1px 4px var(--ui-bg)',
    cursor: 'pointer',
    padding: '0.2rem 0.4rem',
  },
  customizePanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    width: '100%',
    maxWidth: '340px',
    maxHeight: '38vh',
    overflowY: 'auto',
    padding: '0.8rem 1rem',
    background: 'var(--ui-overlay-bg)',
    border: '1px solid var(--ui-border)',
    borderRadius: '10px',
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
 * @param {Object} props.store - GameStore, used to seed the default bot lineup
 * @param {string | null} [props.error] - Error message to display
 * @param {(config: { playerCount: number, spectator: boolean, mapSize: string, aiAssignments: (string | null)[] }) => void} props.onStart
 */
export function TitleScreen({ store, error, onStart }) {
  const prefs = useGameStore(store, s => s.preferences);
  const colorPalette = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLORS_CSS : PLAYER_COLORS_CSS;
  const colorNames = prefs?.colorBlindMode ? COLORBLIND_PLAYER_COLOR_NAMES : PLAYER_COLOR_NAMES;
  /*
   * The system-level preference is handled in CSS (prefers-reduced-motion);
   * this only needs to honor an explicit in-app "on".
   */
  const animate = prefs?.reducedMotion !== 'on';

  const [playerCount, setPlayerCount] = useState(7);
  const [mapSize, setMapSize] = useState(DEFAULT_MAP_SIZE);
  const [showCustomize, setShowCustomize] = useState(false);
  /*
   * Per-slot AI strategy IDs (index = player slot). Seeded from store defaults.
   * `store` is required (the useGameStore call above already depends on it).
   */
  const [assignments, setAssignments] = useState(() =>
    (store.getState().config.aiAssignments ?? []).slice()
  );

  const handleAssign = (slot, aiId) => {
    setAssignments(prev => {
      const next = prev.slice();
      next[slot] = aiId;
      return next;
    });
  };

  /*
   * Build the lineup passed to the controller: slot 0 is always the human seat
   * (null — the controller fills it with a default bot in spectator mode), and
   * every AI slot resolves to a concrete strategy id so a null never gets
   * mistaken for a human.
   */
  const buildAssignments = () =>
    Array.from({ length: playerCount }, (_, i) =>
      i === 0 ? null : assignments[i] || 'ai_default'
    );

  const handleStart = () => {
    onStart({ playerCount, spectator: false, mapSize, aiAssignments: buildAssignments() });
  };

  const handleAIvsAI = () => {
    onStart({ playerCount, spectator: true, mapSize, aiAssignments: buildAssignments() });
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

          <div>
            <div style={STYLE.eyebrow}>Map size</div>
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

          <button
            type="button"
            style={STYLE.disclosureBtn}
            aria-expanded={showCustomize}
            onClick={() => setShowCustomize(v => !v)}
          >
            {showCustomize ? '▾' : '▸'} Customize players
          </button>

          {showCustomize && (
            <div style={STYLE.customizePanel}>
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
                            <option key={ai.id} value={ai.id}>
                              {ai.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="General">
                          {GENERAL_OPTIONS.map(ai => (
                            <option key={ai.id} value={ai.id}>
                              {ai.name}
                            </option>
                          ))}
                        </optgroup>
                        {COMMUNITY_OPTIONS.length > 0 && (
                          <optgroup label="Community">
                            {COMMUNITY_OPTIONS.map(bot => (
                              <option key={bot.id} value={`community:${bot.id}`}>
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
          )}

          <div style={STYLE.buttonRow}>
            <button className="dw-btn" style={STYLE.startBtn} onClick={handleStart}>
              START
            </button>
            <button className="dw-btn" style={STYLE.aiBtn} onClick={handleAIvsAI}>
              AI vs AI
            </button>
          </div>
        </div>
      </div>

      <p className={animate ? 'dw-anim-fade' : ''} style={STYLE.copyright}>
        Copyright (C) 2001{' '}
        <a
          href="https://www.gamedesign.jp/"
          target="_blank"
          rel="noopener noreferrer"
          style={STYLE.copyrightLink}
        >
          GAMEDESIGN
        </a>
      </p>
    </div>
  );
}
