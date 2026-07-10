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
import {
  createArenaAccumulator,
  accumulateMatch,
  finalizeArenaStats,
} from '../arena/arenaAccumulator.js';
import { PLAYER_VISIBLE_BOTS } from '../arena/builtInBots.js';
import { createReplay } from '../arena/replayFormat.js';
import { Leaderboard } from './Leaderboard.jsx';
import { AddBotViaGithub } from './AddBotViaGithub.jsx';
import { MenuScreen, MENU_STYLE } from './menuChrome.jsx';

const GAME_COUNT_OPTIONS = [5, 10, 25, 50, 100];

/*
 * The visible built-ins split into the two sections the Title Screen picker also
 * shows: the learned neural personas (Self-Play) above the hand-written heuristics
 * (General). `persona` is the same flag builtInBots.js tags them with.
 */
const SELF_PLAY_BOTS = PLAYER_VISIBLE_BOTS.filter(b => b.persona);
const GENERAL_BOTS = PLAYER_VISIBLE_BOTS.filter(b => !b.persona);

/* Screen-specific styles; everything shared comes from MENU_STYLE / dw-* classes. */
const STYLE = {
  botOpt: {
    fontSize: '1.05rem',
  },
  countOpt: {
    fontSize: '1rem',
  },
  groupGap: {
    marginTop: '0.5rem',
  },
  progress: {
    width: '100%',
    maxWidth: '560px',
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

    /*
     * ELO ratings + per-bot stat accumulators. This screen runs its own arena loop
     * (one game per macrotask, so Preact can paint progress) rather than runArena, but
     * the per-match bookkeeping + broken-bot flag pass are the shared arenaAccumulator
     * helpers — so the two loops can't drift apart. (#53, #92 item 3)
     */
    const acc = createArenaAccumulator(bots);

    const matches = [];
    let totalTurns = 0;
    let failedGames = 0;
    const baseSeed = Date.now();

    const finalize = () => {
      // finalizeArenaStats warns loudly about any bot that errored on most of its turns
      // and returns the flagged list, which we thread into the table below as a badge.
      const { bots: botStats, flagged } = finalizeArenaStats(acc, bots, { label: '[Arena]' });

      setResult({
        bots: botStats,
        flagged,
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

        accumulateMatch(acc, matchResult);

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
    <MenuScreen title="ARENA">
      {error && <div style={MENU_STYLE.errorBanner}>{error}</div>}

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
        <div style={MENU_STYLE.eyebrow}>Games</div>
        <div style={MENU_STYLE.optRow} role="group" aria-label="Number of games">
          {GAME_COUNT_OPTIONS.map(n => (
            <button
              key={n}
              type="button"
              className="dw-opt"
              style={STYLE.countOpt}
              aria-pressed={n === gameCount}
              onClick={() => setGameCount(n)}
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
          {running ? 'RUNNING...' : 'RUN ARENA'}
        </button>
        <button
          className="dw-btn"
          style={MENU_STYLE.secondaryBtn}
          onClick={onBack}
          disabled={running}
        >
          BACK
        </button>
      </div>

      {running && (
        <div style={STYLE.progress}>
          <div style={{ ...STYLE.progressBar, width: `${progress * 100}%` }} />
        </div>
      )}

      {result && (
        <div className="dw-anim-fade" style={{ ...MENU_STYLE.section, ...STYLE.resultsSection }}>
          <div style={MENU_STYLE.statsRow}>
            {result.totalGames} games played
            {result.failedGames > 0 && ` (${result.failedGames} failed)`} — avg {result.avgTurns}{' '}
            turns/game
          </div>
          <div style={MENU_STYLE.panel}>
            <Leaderboard bots={result.bots} flagged={result.flagged} />
          </div>
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
