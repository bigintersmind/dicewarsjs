/**
 * Title Screen
 *
 * Player count selection, START and AI vs AI buttons.
 *
 * @module ui/TitleScreen
 */

import { useState } from 'preact/hooks';
import { useGameStore } from './hooks/useGameStore.js';
import { getTheme } from '../renderer/themes.js';
import { DEFAULT_MAP_SIZE } from '../utils/config.js';

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

const STYLE = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100%',
    overflowY: 'auto',
    pointerEvents: 'auto',
    userSelect: 'none',
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '4rem',
    color: '#e94560',
    textShadow: '2px 2px 8px rgba(0, 0, 0, 0.5)',
    letterSpacing: '0.1em',
    marginBottom: '2rem',
  },
  playerRow: {
    display: 'flex',
    gap: '0.8rem',
    marginBottom: '1.2rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  sectionLabel: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    marginBottom: '0.5rem',
  },
  sizeRow: {
    display: 'flex',
    gap: '0.8rem',
    marginBottom: '2rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  playerBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.4rem 1rem',
    background: 'transparent',
    border: '2px solid #555',
    color: '#cccccc',
    cursor: 'pointer',
    borderRadius: '4px',
    transition: 'all 0.15s',
  },
  playerBtnActive: {
    color: '#e94560',
    borderColor: '#e94560',
  },
  buttonRow: {
    display: 'flex',
    gap: '1rem',
    marginTop: '1rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  startBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    padding: '0.6rem 2.5rem',
    background: '#e94560',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    borderRadius: '6px',
    letterSpacing: '0.05em',
    transition: 'background 0.15s',
  },
  aiBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.2rem',
    padding: '0.6rem 1.5rem',
    background: 'transparent',
    border: '2px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '6px',
    letterSpacing: '0.05em',
    transition: 'all 0.15s',
  },
  copyright: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    color: '#aaaaaa',
    marginTop: '3rem',
  },
  errorBanner: {
    background: 'rgba(233, 69, 96, 0.15)',
    border: '1px solid #e94560',
    color: '#e94560',
    padding: '0.6rem 1.2rem',
    borderRadius: '6px',
    marginBottom: '1.5rem',
    fontSize: '0.95rem',
    maxWidth: '400px',
    textAlign: 'center',
  },
};

/**
 * @param {Object} props
 * @param {string | null} [props.error] - Error message to display
 * @param {(config: { playerCount: number, spectator: boolean, mapSize: string }) => void} props.onStart
 * @param {() => void} [props.onArena] - Navigate to arena screen
 * @param {() => void} [props.onTournament] - Navigate to tournament screen
 * @param {() => void} [props.onLeaderboard] - Navigate to online leaderboard screen
 */
export function TitleScreen({ store, error, onStart, onArena, onTournament, onLeaderboard }) {
  const [playerCount, setPlayerCount] = useState(7);
  const [mapSize, setMapSize] = useState(DEFAULT_MAP_SIZE);
  const themeName = useGameStore(store, s => s.preferences?.theme) || 'dark';
  const theme = getTheme(themeName);

  const handleStart = () => {
    onStart({ playerCount, spectator: false, mapSize });
  };

  const handleAIvsAI = () => {
    onStart({ playerCount, spectator: true, mapSize });
  };

  return (
    <div style={{ ...STYLE.container, color: theme.uiText }}>
      <h1 style={{ ...STYLE.title, color: theme.uiAccent }}>DICE WARS</h1>

      {error && (
        <div
          style={{
            ...STYLE.errorBanner,
            color: theme.uiAccent,
            borderColor: theme.uiAccent,
            background: `${theme.uiAccent}22`,
          }}
        >
          {error}
        </div>
      )}

      <span style={{ ...STYLE.sectionLabel, color: theme.uiTextMuted }}>Players</span>
      <div style={STYLE.playerRow}>
        {[2, 3, 4, 5, 6, 7, 8].map(n => (
          <button
            key={n}
            type="button"
            aria-label={`Play with ${n} players`}
            aria-pressed={n === playerCount}
            style={{
              ...STYLE.playerBtn,
              color: n === playerCount ? theme.uiAccent : theme.uiTextMuted,
              borderColor: n === playerCount ? theme.uiAccent : theme.uiBorder,
            }}
            onClick={() => setPlayerCount(n)}
          >
            {n} players
          </button>
        ))}
      </div>

      <span style={{ ...STYLE.sectionLabel, color: theme.uiTextMuted }}>Map size</span>
      <div style={STYLE.sizeRow}>
        {MAP_SIZE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            aria-label={`${opt.label} map`}
            aria-pressed={opt.value === mapSize}
            style={{
              ...STYLE.playerBtn,
              color: opt.value === mapSize ? theme.uiAccent : theme.uiTextMuted,
              borderColor: opt.value === mapSize ? theme.uiAccent : theme.uiBorder,
            }}
            onClick={() => setMapSize(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div style={STYLE.buttonRow}>
        <button style={{ ...STYLE.startBtn, background: theme.uiAccent }} onClick={handleStart}>
          START
        </button>
        <button
          style={{ ...STYLE.aiBtn, borderColor: theme.uiAccent, color: theme.uiAccent }}
          onClick={handleAIvsAI}
        >
          AI vs AI
        </button>
        {onArena && (
          <button
            style={{ ...STYLE.aiBtn, borderColor: theme.uiAccent, color: theme.uiAccent }}
            onClick={onArena}
          >
            ARENA
          </button>
        )}
        {onTournament && (
          <button
            style={{ ...STYLE.aiBtn, borderColor: theme.uiAccent, color: theme.uiAccent }}
            onClick={onTournament}
          >
            TOURNAMENT
          </button>
        )}
        {onLeaderboard && (
          <button
            style={{ ...STYLE.aiBtn, borderColor: theme.uiAccent, color: theme.uiAccent }}
            onClick={onLeaderboard}
          >
            LEADERBOARD
          </button>
        )}
      </div>

      <p style={{ ...STYLE.copyright, color: theme.uiTextMuted }}>Copyright (C) 2001 GAMEDESIGN</p>
    </div>
  );
}
