/**
 * Tournament Screen
 *
 * Tournament type selection, bot configuration, and results display.
 *
 * @module ui/TournamentScreen
 */

import { useState, useCallback } from 'preact/hooks';
import { runRoundRobin, runSingleElimination } from '../arena/tournament.js';
import { BUILT_IN_BOTS } from '../arena/builtInBots.js';
import { Leaderboard } from './Leaderboard.jsx';

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
  row: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  btn: {
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
  btnActive: {
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
  champion: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    color: '#e94560',
    textAlign: 'center',
    marginBottom: '1rem',
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
  errorBanner: {
    background: 'rgba(233, 69, 96, 0.15)',
    border: '1px solid #e94560',
    color: '#e94560',
    padding: '0.6rem 1.2rem',
    borderRadius: '6px',
    marginBottom: '1.5rem',
    fontSize: '0.95rem',
    maxWidth: '500px',
    textAlign: 'center',
  },
};

/**
 * @param {Object} props
 * @param {() => void} props.onBack
 */
export function TournamentScreen({ onBack }) {
  const [selectedBots, setSelectedBots] = useState(new Set(BUILT_IN_BOTS.map(b => b.id)));
  const [tournamentType, setTournamentType] = useState('round-robin');
  const [gamesPerRound, setGamesPerRound] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

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
    setResult(null);
    setError(null);

    const bots = BUILT_IN_BOTS.filter(b => selectedBots.has(b.id));

    setTimeout(() => {
      try {
        const config = {
          bots,
          gamesPerRound,
          gamesPerPairing: gamesPerRound,
          baseSeed: Date.now(),
        };

        const tournamentResult =
          tournamentType === 'round-robin' ? runRoundRobin(config) : runSingleElimination(config);

        setResult(tournamentResult);
      } catch (err) {
        console.error('[Tournament] Run failed:', err);
        setError(err.message || 'Tournament run failed');
      } finally {
        setRunning(false);
      }
    }, 50);
  }, [canRun, selectedBots, tournamentType, gamesPerRound]);

  // Map standings to leaderboard format
  const leaderboardBots = result
    ? result.standings.map(s => ({
        name: s.name,
        wins: s.wins,
        gamesPlayed: s.gamesPlayed,
        avgPlacement: 0,
        avgTerritories: 0,
        avgAttacks: 0,
        attackWinRate: 0,
        elo: s.elo,
      }))
    : null;

  return (
    <div style={STYLE.container}>
      <h1 style={STYLE.title}>TOURNAMENT</h1>

      {error && <div style={STYLE.errorBanner}>{error}</div>}

      <div style={STYLE.section}>
        <span style={STYLE.label}>FORMAT</span>
        <div style={STYLE.row}>
          {['round-robin', 'single-elimination'].map(type => (
            <button
              key={type}
              style={{
                ...STYLE.btn,
                ...(type === tournamentType ? STYLE.btnActive : {}),
              }}
              onClick={() => setTournamentType(type)}
            >
              {type === 'round-robin' ? 'Round Robin' : 'Elimination'}
            </button>
          ))}
        </div>
      </div>

      <div style={STYLE.section}>
        <span style={STYLE.label}>SELECT BOTS (min 2)</span>
        <div style={STYLE.row}>
          {BUILT_IN_BOTS.map(bot => (
            <button
              key={bot.id}
              style={{
                ...STYLE.btn,
                ...(selectedBots.has(bot.id) ? STYLE.btnActive : {}),
              }}
              onClick={() => toggleBot(bot.id)}
            >
              {bot.name}
            </button>
          ))}
        </div>
      </div>

      <div style={STYLE.section}>
        <span style={STYLE.label}>GAMES PER MATCHUP</span>
        <div style={STYLE.row}>
          {[1, 3, 5, 7].map(n => (
            <button
              key={n}
              style={{
                ...STYLE.btn,
                ...(n === gamesPerRound ? STYLE.btnActive : {}),
              }}
              onClick={() => setGamesPerRound(n)}
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
          {running ? 'RUNNING...' : 'START TOURNAMENT'}
        </button>
        <button style={STYLE.backBtn} onClick={onBack} disabled={running}>
          BACK
        </button>
      </div>

      {result && (
        <div style={STYLE.resultsContainer}>
          {result.champion && <div style={STYLE.champion}>Champion: {result.champion}</div>}
          <div style={STYLE.statsRow}>
            {result.type} — {result.totalGames} games played
          </div>
          {leaderboardBots && <Leaderboard bots={leaderboardBots} />}
        </div>
      )}
    </div>
  );
}
