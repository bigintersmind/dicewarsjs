/**
 * Arena Screen
 *
 * Bot selection, configuration, and match execution UI.
 * Manages its own state — only uses the store for screen navigation.
 *
 * @module ui/ArenaScreen
 */

import { useState, useCallback } from 'preact/hooks';
import { runMatch } from '../arena/matchRunner.js';
import { updateEloRatings, DEFAULT_RATING } from '../arena/elo.js';
import { reportBotErrors } from '../arena/botErrorReport.js';
import { PLAYER_VISIBLE_BOTS } from '../arena/builtInBots.js';
import { createReplay } from '../arena/replayFormat.js';
import { Leaderboard } from './Leaderboard.jsx';
import { AddBotViaGithub } from './AddBotViaGithub.jsx';

const GAME_COUNT_OPTIONS = [5, 10, 25, 50, 100];

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
    border: '2px solid var(--ui-border)',
    color: 'var(--ui-text)',
    cursor: 'pointer',
    borderRadius: '4px',
    transition: 'all 0.15s',
  },
  botBtnActive: {
    color: 'var(--ui-accent)',
    borderColor: 'var(--ui-accent)',
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
    border: '2px solid var(--ui-border)',
    color: 'var(--ui-text)',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  optionBtnActive: {
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
  progress: {
    width: '100%',
    maxWidth: '500px',
    height: '6px',
    background: 'var(--ui-border)',
    borderRadius: '3px',
    marginBottom: '1rem',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    background: 'var(--ui-accent)',
    transition: 'width 0.1s',
    borderRadius: '3px',
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
 * @param {() => void} props.onBack - Navigate back to title screen
 * @param {(replay: Object) => void} [props.onViewReplay] - Navigate to replay viewer
 */
export function ArenaScreen({ onBack, onViewReplay }) {
  const [selectedBots, setSelectedBots] = useState(new Set(PLAYER_VISIBLE_BOTS.map(b => b.id)));
  const [gameCount, setGameCount] = useState(25);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
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
    setProgress(0);
    setResult(null);
    setReplays([]);
    setError(null);

    const bots = PLAYER_VISIBLE_BOTS.filter(b => selectedBots.has(b.id)).map(b => ({
      name: b.name,
      fn: b.fn,
    }));

    // Per-bot accumulators
    const ratings = {};
    const accum = {};
    for (const bot of bots) {
      ratings[bot.name] = DEFAULT_RATING;
      accum[bot.name] = {
        wins: 0,
        gamesPlayed: 0,
        totalPlacement: 0,
        totalTerritories: 0,
        totalAttacks: 0,
        totalAttackWins: 0,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      };
    }

    const matches = [];
    let totalTurns = 0;
    let failedGames = 0;
    const baseSeed = Date.now();

    const finalize = () => {
      const botStats = bots.map(bot => {
        const a = accum[bot.name];
        return {
          name: bot.name,
          wins: a.wins,
          gamesPlayed: a.gamesPlayed,
          avgPlacement: a.gamesPlayed > 0 ? +(a.totalPlacement / a.gamesPlayed).toFixed(2) : 0,
          avgTerritories: a.gamesPlayed > 0 ? +(a.totalTerritories / a.gamesPlayed).toFixed(1) : 0,
          avgAttacks: a.gamesPlayed > 0 ? +(a.totalAttacks / a.gamesPlayed).toFixed(1) : 0,
          attackWinRate: a.totalAttacks > 0 ? +(a.totalAttackWins / a.totalAttacks).toFixed(3) : 0,
          elo: ratings[bot.name],
          errors: a.errors,
          invalidMoves: a.invalidMoves,
          maxMovesHit: a.maxMovesHit,
        };
      });

      /*
       * Warn loudly if any bot errored on most of its turns — its win%/ELO in the table
       * below is not a meaningful measurement, it's a broken/mis-registered bot. This
       * screen runs its own arena loop (not runArena), so it must call this itself. (#53)
       */
      reportBotErrors(
        bots.map(bot => ({
          name: bot.name,
          errors: accum[bot.name].errors,
          attacks: accum[bot.name].totalAttacks,
          invalidMoves: accum[bot.name].invalidMoves,
          maxMovesHit: accum[bot.name].maxMovesHit,
        })),
        { label: '[Arena]' }
      );

      botStats.sort((a, b) => b.elo - a.elo);

      setResult({
        bots: botStats,
        totalGames: matches.length,
        failedGames,
        avgTurns: matches.length > 0 ? +(totalTurns / matches.length).toFixed(1) : 0,
      });
      setProgress(1);
      setRunning(false);
    };

    // Run one game per macrotask so Preact can paint progress updates
    const runNextGame = i => {
      if (i >= gameCount) {
        finalize();
        return;
      }

      try {
        let matchResult;
        try {
          matchResult = runMatch({ bots, seed: baseSeed + i, maxTurns: 500 });
        } catch (err) {
          console.error(`[Arena] Match ${i} failed (seed ${baseSeed + i}):`, err.message);
          failedGames++;
          setProgress((i + 1) / gameCount);
          setTimeout(() => runNextGame(i + 1), 0);
          return;
        }

        matches.push(matchResult);
        totalTurns += matchResult.turnCount;

        try {
          const botNames = bots.map(b => b.name);
          const replay = createReplay(matchResult, botNames);
          setReplays(prev => [...prev.slice(-9), replay]);
        } catch (err) {
          console.warn(`[Arena] Replay creation failed for match ${i}:`, err.message);
        }

        for (const stat of matchResult.botStats) {
          const a = accum[stat.name];
          a.gamesPlayed++;
          a.totalPlacement += stat.placement;
          a.totalTerritories += stat.finalTerritories;
          a.totalAttacks += stat.attacksMade;
          a.totalAttackWins += stat.attacksWon;
          a.errors += stat.errors;
          a.invalidMoves += stat.invalidMoves;
          a.maxMovesHit += stat.maxMovesHit;
          if (matchResult.winner === stat.playerIndex) {
            a.wins++;
          }
        }

        const eloPlayers = matchResult.placements.map(playerIdx => {
          const botStat = matchResult.botStats.find(s => s.playerIndex === playerIdx);
          return { name: botStat.name, elo: ratings[botStat.name] };
        });
        const updatedRatings = updateEloRatings(eloPlayers);
        for (const r of updatedRatings) {
          ratings[r.name] = r.elo;
        }

        setProgress((i + 1) / gameCount);
        setTimeout(() => runNextGame(i + 1), 0);
      } catch (err) {
        console.error('[Arena] Fatal error during game processing:', err);
        setError(err.message || 'Arena run failed');
        setRunning(false);
      }
    };

    // Defer first game to let "RUNNING..." state paint
    setTimeout(() => runNextGame(0), 50);
  }, [canRun, selectedBots, gameCount]);

  const renderBotButton = bot => (
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
  );

  return (
    <div style={STYLE.container}>
      <h1 style={STYLE.title}>ARENA</h1>

      {error && <div style={STYLE.errorBanner}>{error}</div>}

      <div style={STYLE.section}>
        <span style={STYLE.label}>SELECT BOTS (min 2)</span>
        <span style={STYLE.groupLabel}>Self-Play</span>
        <div style={STYLE.botRow}>{SELF_PLAY_BOTS.map(renderBotButton)}</div>
        <span style={STYLE.groupLabel}>General</span>
        <div style={STYLE.botRow}>{GENERAL_BOTS.map(renderBotButton)}</div>
      </div>

      <div style={STYLE.section}>
        <AddBotViaGithub />
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
            {result.totalGames} games played
            {result.failedGames > 0 && ` (${result.failedGames} failed)`} — avg {result.avgTurns}{' '}
            turns/game
          </div>
          <Leaderboard bots={result.bots} />
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
