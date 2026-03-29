/**
 * Replay Viewer
 *
 * Step-through replay viewer with play/pause, speed control, and URL sharing.
 * Reconstructs game state from a compact replay using the engine.
 *
 * @module ui/ReplayViewer
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { replayToState, getReplayLength, serializeReplay } from '../arena/replayFormat.js';

const SPEEDS = [1, 2, 4, 8];

const STYLE = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
    pointerEvents: 'auto',
    userSelect: 'none',
    padding: '2rem',
  },
  title: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '2rem',
    color: '#e94560',
    marginBottom: '1rem',
  },
  info: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: '#aaa',
    marginBottom: '1rem',
    textAlign: 'center',
  },
  controls: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  btn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    padding: '0.3rem 0.8rem',
    background: 'transparent',
    border: '2px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  btnActive: {
    background: '#e94560',
    color: '#fff',
  },
  speedBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    padding: '0.2rem 0.5rem',
    background: 'transparent',
    border: '1px solid #555',
    color: '#ccc',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  speedBtnActive: {
    borderColor: '#e94560',
    color: '#e94560',
  },
  slider: {
    width: '300px',
    accentColor: '#e94560',
  },
  counter: {
    fontFamily: 'Roboto, monospace',
    fontSize: '0.85rem',
    color: '#ccc',
    minWidth: '100px',
    textAlign: 'center',
  },
  backBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    padding: '0.4rem 1.5rem',
    background: 'transparent',
    border: '2px solid #e94560',
    color: '#e94560',
    cursor: 'pointer',
    borderRadius: '6px',
    marginTop: '1rem',
  },
  shareBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    padding: '0.2rem 0.6rem',
    background: 'transparent',
    border: '1px solid #555',
    color: '#aaa',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  copied: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    color: '#e94560',
    marginLeft: '0.5rem',
  },
};

/**
 * @param {Object} props
 * @param {import('../arena/replayFormat.js').Replay} props.replay - Replay data
 * @param {Function} [props.onStateChange] - Called with game state on each step
 * @param {() => void} props.onBack - Navigate back
 */
export function ReplayViewer({ replay, onStateChange, onBack }) {
  const totalActions = getReplayLength(replay);
  const [actionIndex, setActionIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef(null);
  const stateCache = useRef(new Map());

  // Reconstruct state at current index (with caching)
  const getState = useCallback(
    idx => {
      if (stateCache.current.has(idx)) {
        return stateCache.current.get(idx);
      }

      /*
       * Find nearest cached state before the target index.
       * Cache snapshots every 50 actions for scrub performance.
       */
      const state = replayToState(replay, idx);

      if (idx % 50 === 0 || idx === totalActions) {
        stateCache.current.set(idx, state);
      }

      return state;
    },
    [replay, totalActions]
  );

  // Notify parent of state changes
  useEffect(() => {
    if (onStateChange) {
      const state = getState(actionIndex);
      onStateChange(state);
    }
  }, [actionIndex, getState, onStateChange]);

  // Auto-play interval
  useEffect(() => {
    if (playing) {
      const ms = Math.max(50, 500 / speed);
      intervalRef.current = setInterval(() => {
        setActionIndex(prev => {
          if (prev >= totalActions) {
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, ms);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, totalActions]);

  const handlePlayPause = () => setPlaying(p => !p);
  const handleStepBack = () => {
    setPlaying(false);
    setActionIndex(i => Math.max(0, i - 1));
  };
  const handleStepForward = () => {
    setPlaying(false);
    setActionIndex(i => Math.min(totalActions, i + 1));
  };
  const handleReset = () => {
    setPlaying(false);
    setActionIndex(0);
  };
  const handleSlider = e => {
    setPlaying(false);
    setActionIndex(Number(e.target.value));
  };

  const handleShare = async () => {
    try {
      const encoded = serializeReplay(replay);
      const url = `${window.location.origin}${window.location.pathname}#replay=${encoded}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const { metadata } = replay;

  return (
    <div style={STYLE.container}>
      <h2 style={STYLE.title}>REPLAY</h2>

      <div style={STYLE.info}>
        {metadata.bots.join(' vs ')} — {metadata.turnCount} turns
        {metadata.winner !== null &&
          ` — Winner: ${metadata.bots[metadata.winner] || `Player ${metadata.winner}`}`}
      </div>

      <div style={STYLE.controls}>
        <button style={STYLE.btn} onClick={handleReset}>
          &#x23EE;
        </button>
        <button style={STYLE.btn} onClick={handleStepBack}>
          &#x23EA;
        </button>
        <button
          style={{ ...STYLE.btn, ...(playing ? STYLE.btnActive : {}) }}
          onClick={handlePlayPause}
        >
          {playing ? '\u23F8' : '\u25B6'}
        </button>
        <button style={STYLE.btn} onClick={handleStepForward}>
          &#x23E9;
        </button>
      </div>

      <input
        type="range"
        min="0"
        max={totalActions}
        value={actionIndex}
        onInput={handleSlider}
        style={STYLE.slider}
      />

      <div style={STYLE.counter}>
        Action {actionIndex} / {totalActions}
      </div>

      <div style={STYLE.controls}>
        {SPEEDS.map(s => (
          <button
            key={s}
            style={{
              ...STYLE.speedBtn,
              ...(s === speed ? STYLE.speedBtnActive : {}),
            }}
            onClick={() => setSpeed(s)}
          >
            {s}x
          </button>
        ))}
        <button style={STYLE.shareBtn} onClick={handleShare}>
          Share
        </button>
        {copied && <span style={STYLE.copied}>Copied!</span>}
      </div>

      <button style={STYLE.backBtn} onClick={onBack}>
        BACK
      </button>
    </div>
  );
}
