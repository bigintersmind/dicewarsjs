/**
 * Online Leaderboard Screen
 *
 * Fetches leaderboard data from static JSON and displays bot rankings.
 * Surfaces the run's flagged (excluded) bots as a note, so an exclusion is visible
 * rather than silent (#137). Lists notable replays and delegates viewing to the
 * parent via onViewReplay.
 *
 * @module ui/OnlineLeaderboardScreen
 */

import { useState, useEffect } from 'preact/hooks';
import { Leaderboard, flagBadgeText, FLAG_COLOR } from './Leaderboard.jsx';
import { MenuScreen, MENU_STYLE } from './menuChrome.jsx';

/* Screen-specific styles; everything shared comes from MENU_STYLE / dw-* classes. */
const STYLE = {
  subtitle: {
    ...MENU_STYLE.statsRow,
    marginTop: '-0.6rem',
    marginBottom: '1.4rem',
  },
  tableSection: {
    maxWidth: '620px',
  },
  replayList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    textAlign: 'left',
  },
  replayItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '0.8rem',
    padding: '0.45rem 0.2rem',
    borderBottom: '1px solid var(--ui-border)',
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text)',
  },
  /* Compact classic button: thinner rim so the double edge survives the size. */
  watchBtn: {
    fontSize: '0.72rem',
    padding: '0.2rem 0.7rem',
    borderWidth: '2px',
    borderRadius: '8px',
    boxShadow: 'inset 0 0 0 2px #cccccc, 0 2px 0 rgba(0, 0, 0, 0.3)',
    flexShrink: 0,
  },
  message: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '1rem',
    color: 'var(--ui-text-muted)',
    textShadow: 'var(--ui-text-halo)',
    textAlign: 'center',
    margin: '1.5rem 0',
  },
  errorText: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.9rem',
    color: 'var(--ui-accent)',
    textAlign: 'center',
    margin: '0.5rem 0 1rem',
  },
  flaggedNote: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    color: 'var(--ui-text-muted)',
    textShadow: 'var(--ui-text-halo)',
    textAlign: 'left',
    margin: '0.5rem 0.2rem 0',
  },
  flaggedBot: {
    color: FLAG_COLOR,
    whiteSpace: 'nowrap',
  },
};

/**
 * @param {Object} props
 * @param {(replay: Object) => void} props.onViewReplay
 */
export function OnlineLeaderboardScreen({ onViewReplay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [replayError, setReplayError] = useState(null);
  const [loadingReplay, setLoadingReplay] = useState(null);

  const fetchLeaderboard = () => {
    setData(null);
    setError(null);
    fetch('data/leaderboard.json')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch(err => setError(`Could not load leaderboard: ${err.message}`));
  };

  useEffect(fetchLeaderboard, []);

  const handleViewReplay = async replayFile => {
    setReplayError(null);
    setLoadingReplay(replayFile);
    try {
      const res = await fetch(`data/replays/${replayFile}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const replay = await res.json();
      onViewReplay(replay);
    } catch (err) {
      setReplayError(`Could not load replay: ${err.message}`);
    } finally {
      setLoadingReplay(null);
    }
  };

  if (error) {
    return (
      <MenuScreen title="LEADERBOARD">
        <p style={STYLE.errorText}>{error}</p>
        <div style={MENU_STYLE.buttonRow}>
          <button className="dw-btn" style={MENU_STYLE.secondaryBtn} onClick={fetchLeaderboard}>
            RETRY
          </button>
        </div>
      </MenuScreen>
    );
  }

  if (!data) {
    return (
      <MenuScreen title="LEADERBOARD">
        <p style={STYLE.message}>Loading...</p>
      </MenuScreen>
    );
  }

  const hasResults = data.bots && data.bots.length > 0;
  // Read-side tolerance only: leaderboard.json published before #137 has no `flagged`
  // field. The write side (scripts/lib/online-tournament.mjs) still refuses to build
  // outputs without one — don't mirror this default there.
  const flagged = data.flagged || [];

  return (
    <MenuScreen title="LEADERBOARD">
      {data.updatedAt && (
        <p className="dw-anim-fade" style={STYLE.subtitle}>
          {data.tournamentCount} tournament{data.tournamentCount !== 1 ? 's' : ''} &middot;{' '}
          {data.totalGamesPlayed} games &middot; Updated{' '}
          {new Date(data.updatedAt).toLocaleDateString()}
        </p>
      )}

      {!hasResults && (
        <p style={STYLE.message}>No tournament results yet. Check back after the first run!</p>
      )}

      {hasResults && (
        <div className="dw-anim-fade" style={{ ...MENU_STYLE.section, ...STYLE.tableSection }}>
          <div style={MENU_STYLE.panel}>
            <Leaderboard bots={data.bots} />
          </div>
        </div>
      )}

      {/* Excluded bots get a note, not a ranked row: they're absent from `bots` by design
          (a broken bot's ELO is noise), so without this the exclusion is invisible here.
          Rendered outside the hasResults block so it survives an all-flagged run. */}
      {flagged.length > 0 && (
        <div className="dw-anim-fade" style={{ ...MENU_STYLE.section, ...STYLE.tableSection }}>
          <p
            style={STYLE.flaggedNote}
            title={
              'These bots errored on most of their turns this run, so their win% / ELO is ' +
              'not a meaningful measurement. They are excluded from the rankings (and from ' +
              'ELO carry-over) rather than ranked on noise.'
            }
          >
            Excluded this run as broken:{' '}
            {flagged.map((f, i) => (
              <span key={f.name}>
                {i > 0 && ', '}
                <span style={STYLE.flaggedBot}>
                  {f.name} ({flagBadgeText(f)})
                </span>
              </span>
            ))}
          </p>
        </div>
      )}

      {data.replays && data.replays.length > 0 && (
        <div className="dw-anim-fade" style={{ ...MENU_STYLE.section, ...STYLE.tableSection }}>
          <div style={MENU_STYLE.eyebrow}>Notable matches</div>
          {replayError && <p style={STYLE.errorText}>{replayError}</p>}
          <div style={MENU_STYLE.panel}>
            <ul style={STYLE.replayList}>
              {data.replays.map(r => (
                <li key={r.file} style={STYLE.replayItem}>
                  <span>
                    {r.bots.join(' vs ')} &mdash; {r.turns} turns
                    {r.winner && ` (${r.winner} wins)`}
                  </span>
                  <button
                    className="dw-btn"
                    style={STYLE.watchBtn}
                    disabled={loadingReplay === r.file}
                    onClick={() => handleViewReplay(r.file)}
                  >
                    {loadingReplay === r.file ? '...' : 'WATCH'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </MenuScreen>
  );
}
