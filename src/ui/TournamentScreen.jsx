/**
 * Tournament Screen
 *
 * Tournament type selection, bot configuration, and results display.
 *
 * @module ui/TournamentScreen
 */

import { useState, useCallback } from 'preact/hooks';
import { runRoundRobin, runSingleElimination } from '../arena/tournament.js';
import { PLAYER_VISIBLE_BOTS } from '../arena/builtInBots.js';
import { createReplay } from '../arena/replayFormat.js';
import { Leaderboard } from './Leaderboard.jsx';
import { AddBotViaGithub } from './AddBotViaGithub.jsx';

/*
 * The visible built-ins split into the two sections the Title Screen picker also
 * shows: the learned neural personas (Self-Play) above the hand-written heuristics
 * (General). `persona` is the same flag builtInBots.js tags them with.
 */
const SELF_PLAY_BOTS = PLAYER_VISIBLE_BOTS.filter(b => b.persona);
const GENERAL_BOTS = PLAYER_VISIBLE_BOTS.filter(b => !b.persona);

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
    color: 'var(--ui-accent)',
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
    color: 'var(--ui-text-muted)',
    marginBottom: '0.5rem',
    display: 'block',
    letterSpacing: '0.05em',
  },
  groupLabel: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    color: 'var(--ui-text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    display: 'block',
    margin: '0.5rem 0 0.35rem',
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
    border: '2px solid var(--ui-border)',
    color: 'var(--ui-text)',
    cursor: 'pointer',
    borderRadius: '4px',
    transition: 'all 0.15s',
  },
  btnActive: {
    color: 'var(--ui-accent)',
    borderColor: 'var(--ui-accent)',
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
    background: 'var(--ui-accent)',
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
    border: '2px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    cursor: 'pointer',
    borderRadius: '6px',
  },
  champion: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    color: 'var(--ui-accent)',
    textAlign: 'center',
    marginBottom: '1rem',
  },
  statsRow: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text-muted)',
    marginBottom: '1rem',
    textAlign: 'center',
  },
  resultsContainer: {
    width: '100%',
    maxWidth: '600px',
  },
  errorBanner: {
    background: 'var(--ui-accent-soft)',
    border: '1px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
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
 * @param {(replay: Object) => void} [props.onViewReplay] - Navigate to replay viewer
 */
export function TournamentScreen({ onBack, onViewReplay }) {
  const [selectedBots, setSelectedBots] = useState(new Set(PLAYER_VISIBLE_BOTS.map(b => b.id)));
  const [tournamentType, setTournamentType] = useState('round-robin');
  const [gamesPerRound, setGamesPerRound] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [replays, setReplays] = useState([]);
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
    setReplays([]);
    setError(null);

    const bots = PLAYER_VISIBLE_BOTS.filter(b => selectedBots.has(b.id));

    setTimeout(() => {
      try {
        const collectedReplays = [];
        const config = {
          bots,
          gamesPerRound,
          gamesPerPairing: gamesPerRound,
          baseSeed: Date.now(),
          onMatchComplete: (roundIdx, matchIdx, matchResult) => {
            try {
              const botNames = matchResult.botStats.map(s => s.name);
              const replay = createReplay(matchResult, botNames);
              collectedReplays.push(replay);
            } catch (err) {
              console.warn(
                `[Tournament] Replay creation failed (round ${roundIdx}, match ${matchIdx}):`,
                err.message
              );
            }
          },
        };

        const tournamentResult =
          tournamentType === 'round-robin' ? runRoundRobin(config) : runSingleElimination(config);

        setResult(tournamentResult);
        setReplays(collectedReplays.slice(-10));
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

  const renderBotButton = bot => (
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
  );

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
        <span style={STYLE.groupLabel}>Self-Play</span>
        <div style={STYLE.row}>{SELF_PLAY_BOTS.map(renderBotButton)}</div>
        <span style={STYLE.groupLabel}>General</span>
        <div style={STYLE.row}>{GENERAL_BOTS.map(renderBotButton)}</div>
      </div>

      <div style={STYLE.section}>
        <AddBotViaGithub />
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
          {replays.length > 0 && onViewReplay && (
            <div style={{ textAlign: 'center', marginTop: '1rem' }}>
              <button
                style={STYLE.backBtn}
                onClick={() => onViewReplay(replays[replays.length - 1])}
              >
                VIEW LAST REPLAY
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
