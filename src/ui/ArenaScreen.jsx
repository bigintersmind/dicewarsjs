/**
 * Arena Screen
 *
 * Bot selection, configuration, and match execution UI.
 * Manages its own state — only uses the store for screen navigation.
 *
 * @module ui/ArenaScreen
 */

import { useState, useCallback } from 'preact/hooks';
import { runArena } from '../arena/arenaRunner.js';
import { adaptLegacyBot } from '../arena/legacyBotAdapter.js';
import { ai_example } from '../ai/ai_example.js';
import { ai_default } from '../ai/ai_default.js';
import { ai_defensive } from '../ai/ai_defensive.js';
import { ai_adaptive } from '../ai/ai_adaptive.js';
import { Leaderboard } from './Leaderboard.jsx';

const BUILT_IN_BOTS = [
  { id: 'ai_example', name: 'Example', fn: adaptLegacyBot(ai_example, 'Example') },
  { id: 'ai_default', name: 'Default', fn: adaptLegacyBot(ai_default, 'Default') },
  { id: 'ai_defensive', name: 'Defensive', fn: adaptLegacyBot(ai_defensive, 'Defensive') },
  { id: 'ai_adaptive', name: 'Adaptive', fn: adaptLegacyBot(ai_adaptive, 'Adaptive') },
];

const GAME_COUNT_OPTIONS = [5, 10, 25, 50, 100];

const STYLE = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
    pointerEvents: 'auto',
    userSelect: 'none',
    padding: '2rem',
    overflowY: 'auto',
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '2.5rem',
    color: '#e94560',
    textShadow: '2px 2px 8px rgba(0, 0, 0, 0.5)',
    letterSpacing: '0.1em',
    marginBottom: '1.5rem',
  },
  section: {
    marginBottom: '1.5rem',
    width: '100%',
    maxWidth: '500px',
  },
  label: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    color: '#aaa',
    marginBottom: '0.5rem',
    display: 'block',
    letterSpacing: '0.05em',
  },
  botRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  botBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.9rem',
    padding: '0.3rem 0.8rem',
    background: 'transparent',
    border: '2px solid #555',
    color: '#ccc',
    cursor: 'pointer',
    borderRadius: '4px',
    transition: 'all 0.15s',
  },
  botBtnActive: {
    color: '#e94560',
    borderColor: '#e94560',
  },
  optionRow: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'center',
  },
  optionBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    padding: '0.25rem 0.6rem',
    background: 'transparent',
    border: '2px solid #555',
    color: '#ccc',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  optionBtnActive: {
    color: '#e94560',
    borderColor: '#e94560',
  },
  buttonRow: {
    display: 'flex',
    gap: '1rem',
    marginTop: '1rem',
    marginBottom: '1.5rem',
  },
  runBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.3rem',
    padding: '0.5rem 2rem',
    background: '#e94560',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    borderRadius: '6px',
    letterSpacing: '0.05em',
  },
  runBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  backBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    padding: '0.5rem 1.5rem',
    background: 'transparent',
    border: '2px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '6px',
  },
  progress: {
    width: '100%',
    maxWidth: '500px',
    height: '6px',
    background: '#333',
    borderRadius: '3px',
    marginBottom: '1rem',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    background: '#e94560',
    transition: 'width 0.1s',
    borderRadius: '3px',
  },
  statsRow: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: '#aaa',
    marginBottom: '1rem',
    textAlign: 'center',
  },
  resultsContainer: {
    width: '100%',
    maxWidth: '600px',
  },
};

/**
 * @param {Object} props
 * @param {() => void} props.onBack - Navigate back to title screen
 */
export function ArenaScreen({ onBack }) {
  const [selectedBots, setSelectedBots] = useState(new Set(BUILT_IN_BOTS.map(b => b.id)));
  const [gameCount, setGameCount] = useState(25);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);

  const toggleBot = useCallback(id => {
    setSelectedBots(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 2) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const canRun = selectedBots.size >= 2 && !running;

  const handleRun = useCallback(() => {
    if (!canRun) return;

    setRunning(true);
    setProgress(0);
    setResult(null);

    const bots = BUILT_IN_BOTS.filter(b => selectedBots.has(b.id)).map(b => ({
      name: b.name,
      fn: b.fn,
    }));

    // Use setTimeout to let the UI update before the blocking computation
    setTimeout(() => {
      const arenaResult = runArena({
        bots,
        gameCount,
        baseSeed: Date.now(),
        onGameComplete: i => {
          setProgress((i + 1) / gameCount);
        },
      });

      setResult(arenaResult);
      setRunning(false);
      setProgress(1);
    }, 50);
  }, [canRun, selectedBots, gameCount]);

  return (
    <div style={STYLE.container}>
      <h1 style={STYLE.title}>ARENA</h1>

      <div style={STYLE.section}>
        <span style={STYLE.label}>SELECT BOTS (min 2)</span>
        <div style={STYLE.botRow}>
          {BUILT_IN_BOTS.map(bot => (
            <button
              key={bot.id}
              style={{
                ...STYLE.botBtn,
                ...(selectedBots.has(bot.id) ? STYLE.botBtnActive : {}),
              }}
              onClick={() => toggleBot(bot.id)}
            >
              {bot.name}
            </button>
          ))}
        </div>
      </div>

      <div style={STYLE.section}>
        <span style={STYLE.label}>GAMES</span>
        <div style={STYLE.optionRow}>
          {GAME_COUNT_OPTIONS.map(n => (
            <button
              key={n}
              style={{
                ...STYLE.optionBtn,
                ...(n === gameCount ? STYLE.optionBtnActive : {}),
              }}
              onClick={() => setGameCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div style={STYLE.buttonRow}>
        <button
          style={{
            ...STYLE.runBtn,
            ...(!canRun ? STYLE.runBtnDisabled : {}),
          }}
          onClick={handleRun}
          disabled={!canRun}
        >
          {running ? 'RUNNING...' : 'RUN ARENA'}
        </button>
        <button style={STYLE.backBtn} onClick={onBack} disabled={running}>
          BACK
        </button>
      </div>

      {running && (
        <div style={STYLE.progress}>
          <div style={{ ...STYLE.progressBar, width: `${progress * 100}%` }} />
        </div>
      )}

      {result && (
        <div style={STYLE.resultsContainer}>
          <div style={STYLE.statsRow}>
            {result.totalGames} games played — avg {result.avgTurns} turns/game
          </div>
          <Leaderboard bots={result.bots} />
        </div>
      )}
    </div>
  );
}
