/**
 * Tournament Screen
 *
 * Tournament type selection, bot configuration, and results display.
 *
 * @module ui/TournamentScreen
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { runRoundRobin, runSingleElimination } from '../arena/tournament.js';
import { PLAYER_VISIBLE_BOTS } from '../arena/builtInBots.js';
import { createReplay } from '../arena/replayFormat.js';
import { Leaderboard } from './Leaderboard.jsx';
import { AddBotViaGithub } from './AddBotViaGithub.jsx';
import { MenuScreen, MENU_STYLE } from './menuChrome.jsx';

/*
 * The visible built-ins split into the two sections the Title Screen picker also
 * shows: the learned neural personas (Self-Play) above the hand-written heuristics
 * (General). `persona` is the same flag builtInBots.js tags them with.
 */
const SELF_PLAY_BOTS = PLAYER_VISIBLE_BOTS.filter(b => b.persona);
const GENERAL_BOTS = PLAYER_VISIBLE_BOTS.filter(b => !b.persona);

/* Screen-specific styles; everything shared comes from MENU_STYLE / dw-* classes. */
const STYLE = {
  formatOpt: {
    fontSize: '1rem',
    textTransform: 'uppercase',
  },
  botOpt: {
    fontSize: '1.05rem',
  },
  countOpt: {
    fontSize: '1rem',
  },
  groupGap: {
    marginTop: '0.5rem',
  },
  champion: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.5rem',
    color: 'var(--ui-accent)',
    textShadow: 'var(--ui-text-halo)',
    textAlign: 'center',
    marginBottom: '0.8rem',
  },
  resultsSection: {
    maxWidth: '620px',
  },
  replayRow: {
    textAlign: 'center',
    marginTop: '1rem',
  },
};

/**
 * @param {Object} props
 * @param {(replay: Object) => void} [props.onViewReplay] - Navigate to replay viewer
 */
export function TournamentScreen({ onViewReplay }) {
  const [selectedBots, setSelectedBots] = useState(new Set(PLAYER_VISIBLE_BOTS.map(b => b.id)));
  const [tournamentType, setTournamentType] = useState('round-robin');
  const [gamesPerRound, setGamesPerRound] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [replays, setReplays] = useState([]);
  const [error, setError] = useState(null);

  /*
   * The mode rail can navigate away mid-run (the old BACK button was disabled
   * while running; the rail is not). The whole tournament runs in one deferred
   * macrotask — if the screen unmounts during the 50ms defer, skip it entirely
   * rather than computing a result nobody will see.
   */
  const cancelledRef = useRef(false);
  useEffect(
    () => () => {
      cancelledRef.current = true;
    },
    []
  );

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
      if (cancelledRef.current) return;
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

  // Map standings to the Leaderboard row shape. The broken-bot badge is NOT driven by these
  // rows — it comes from the separate `flagged={result.flagged}` prop below, which Leaderboard
  // matches to rows by name. Leaderboard has no error column, so the standings' error counts
  // aren't carried here (they live durably in the tournament result / history). (#92 item 2)
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
      type="button"
      className="dw-opt"
      style={STYLE.botOpt}
      aria-pressed={selectedBots.has(bot.id)}
      onClick={() => toggleBot(bot.id)}
    >
      {bot.name}
    </button>
  );

  return (
    <MenuScreen title="TOURNAMENT">
      {error && <div style={MENU_STYLE.errorBanner}>{error}</div>}

      <div className="dw-anim-fade" style={MENU_STYLE.section}>
        <div style={MENU_STYLE.eyebrow}>Format</div>
        <div style={MENU_STYLE.optRow} role="group" aria-label="Tournament format">
          {['round-robin', 'single-elimination'].map(type => (
            <button
              key={type}
              type="button"
              className="dw-opt"
              style={STYLE.formatOpt}
              aria-pressed={type === tournamentType}
              onClick={() => setTournamentType(type)}
            >
              {type === 'round-robin' ? 'Round Robin' : 'Elimination'}
            </button>
          ))}
        </div>
      </div>

      <div className="dw-anim-fade" style={MENU_STYLE.section}>
        <div style={MENU_STYLE.eyebrow}>Self-play bots</div>
        <div style={MENU_STYLE.optRow} role="group" aria-label="Self-play bots">
          {SELF_PLAY_BOTS.map(renderBotButton)}
        </div>
        <div style={{ ...MENU_STYLE.eyebrow, ...STYLE.groupGap }}>General bots</div>
        <div style={MENU_STYLE.optRow} role="group" aria-label="General bots">
          {GENERAL_BOTS.map(renderBotButton)}
        </div>
        <div style={MENU_STYLE.caption}>Pick at least two.</div>
      </div>

      <div className="dw-anim-fade" style={MENU_STYLE.section}>
        <div style={MENU_STYLE.eyebrow}>Games per matchup</div>
        <div style={MENU_STYLE.optRow} role="group" aria-label="Games per matchup">
          {[1, 3, 5, 7].map(n => (
            <button
              key={n}
              type="button"
              className="dw-opt"
              style={STYLE.countOpt}
              aria-pressed={n === gamesPerRound}
              onClick={() => setGamesPerRound(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="dw-anim-fade" style={MENU_STYLE.buttonRow}>
        <button
          className="dw-btn"
          style={MENU_STYLE.primaryBtn}
          onClick={handleRun}
          disabled={!canRun}
        >
          {running ? 'RUNNING...' : 'START TOURNAMENT'}
        </button>
      </div>

      {result && (
        <div className="dw-anim-fade" style={{ ...MENU_STYLE.section, ...STYLE.resultsSection }}>
          {result.champion && <div style={STYLE.champion}>Champion: {result.champion}</div>}
          <div style={MENU_STYLE.statsRow}>
            {result.type} · {result.totalGames} games played
          </div>
          {leaderboardBots && (
            <div style={MENU_STYLE.panel}>
              <Leaderboard bots={leaderboardBots} flagged={result.flagged} />
            </div>
          )}
          {replays.length > 0 && onViewReplay && (
            <div style={STYLE.replayRow}>
              <button
                className="dw-btn"
                style={MENU_STYLE.secondaryBtn}
                onClick={() => onViewReplay(replays[replays.length - 1])}
              >
                VIEW LAST REPLAY
              </button>
            </div>
          )}
        </div>
      )}

      <div style={MENU_STYLE.section}>
        <AddBotViaGithub />
      </div>
    </MenuScreen>
  );
}
