/**
 * Online Leaderboard Screen
 *
 * Fetches leaderboard data from static JSON and displays bot rankings.
 * Lists notable replays and delegates viewing to the parent via onViewReplay.
 *
 * @module ui/OnlineLeaderboardScreen
 */

import { useState, useEffect } from 'preact/hooks';
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
    marginBottom: '0.5rem',
  },
  subtitle: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: '#888',
    marginBottom: '1.5rem',
    textAlign: 'center',
  },
  section: {
    marginBottom: '1.5rem',
    width: '100%',
    maxWidth: '600px',
  },
  sectionTitle: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.1rem',
    color: '#aaa',
    marginBottom: '0.5rem',
    letterSpacing: '0.05em',
  },
  backBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1.1rem',
    padding: '0.5rem 1.5rem',
    background: 'transparent',
    border: '2px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '6px',
    marginTop: '1rem',
    transition: 'all 0.15s',
  },
  replayList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  replayItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.4rem 0.6rem',
    borderBottom: '1px solid #333',
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: '#ccc',
  },
  replayBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    padding: '0.2rem 0.6rem',
    background: 'transparent',
    border: '1px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  loading: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '1rem',
    color: '#888',
    textAlign: 'center',
    marginTop: '2rem',
  },
  error: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.9rem',
    color: '#e94560',
    textAlign: 'center',
    marginTop: '2rem',
  },
};

/**
 * @param {Object} props
 * @param {() => void} props.onBack
 * @param {(replay: Object) => void} props.onViewReplay
 */
export function OnlineLeaderboardScreen({ onBack, onViewReplay }) {
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
      <div style={STYLE.container}>
        <h1 style={STYLE.title}>LEADERBOARD</h1>
        <p style={STYLE.error}>{error}</p>
        <button style={STYLE.backBtn} onClick={fetchLeaderboard}>
          RETRY
        </button>
        <button style={{ ...STYLE.backBtn, marginTop: '0.5rem' }} onClick={onBack}>
          BACK
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={STYLE.container}>
        <h1 style={STYLE.title}>LEADERBOARD</h1>
        <p style={STYLE.loading}>Loading...</p>
      </div>
    );
  }

  const hasResults = data.bots && data.bots.length > 0;

  return (
    <div style={STYLE.container}>
      <h1 style={STYLE.title}>LEADERBOARD</h1>

      {data.updatedAt && (
        <p style={STYLE.subtitle}>
          {data.tournamentCount} tournament{data.tournamentCount !== 1 ? 's' : ''} &middot;{' '}
          {data.totalGamesPlayed} games &middot; Updated{' '}
          {new Date(data.updatedAt).toLocaleDateString()}
        </p>
      )}

      {!hasResults && (
        <p style={STYLE.loading}>No tournament results yet. Check back after the first run!</p>
      )}

      {hasResults && (
        <div style={STYLE.section}>
          <Leaderboard bots={data.bots} />
        </div>
      )}

      {data.replays && data.replays.length > 0 && (
        <div style={STYLE.section}>
          <div style={STYLE.sectionTitle}>NOTABLE MATCHES</div>
          {replayError && <p style={STYLE.error}>{replayError}</p>}
          <ul style={STYLE.replayList}>
            {data.replays.map(r => (
              <li key={r.file} style={STYLE.replayItem}>
                <span>
                  {r.bots.join(' vs ')} &mdash; {r.turns} turns
                  {r.winner && ` (${r.winner} wins)`}
                </span>
                <button
                  style={STYLE.replayBtn}
                  disabled={loadingReplay === r.file}
                  onClick={() => handleViewReplay(r.file)}
                >
                  {loadingReplay === r.file ? '...' : 'Watch'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button style={STYLE.backBtn} onClick={onBack}>
        BACK
      </button>
    </div>
  );
}
