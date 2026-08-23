/**
 * Replay Viewer
 *
 * Step-through replay viewer with play/pause, speed control, and URL sharing.
 * Reconstructs game state from a compact replay using the engine.
 *
 * Supports two layout modes:
 * - Default: full-screen centered layout (for screens without a canvas)
 * - Overlay: compact bottom bar over the PixiJS canvas
 *
 * @module ui/ReplayViewer
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { replayToState, getReplayLength, serializeReplay } from '../arena/replayFormat.js';
import { replayGame } from '../engine/GameRunner.js';

const SPEEDS = [1, 2, 4, 8];

const STYLE = {
  /* ---- full-screen (default) layout ---- */
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
    color: 'var(--ui-accent)',
    marginBottom: '1rem',
  },
  info: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text-muted)',
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
    border: '2px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    cursor: 'pointer',
    borderRadius: '4px',
  },
  btnActive: {
    background: 'var(--ui-accent)',
    color: '#fff',
  },
  speedBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    padding: '0.2rem 0.5rem',
    background: 'transparent',
    border: '1px solid var(--ui-border)',
    color: 'var(--ui-text)',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  speedBtnActive: {
    borderColor: 'var(--ui-accent)',
    color: 'var(--ui-accent)',
  },
  slider: {
    width: '300px',
    accentColor: 'var(--ui-accent)',
  },
  counter: {
    fontFamily: 'Roboto, monospace',
    fontSize: '0.85rem',
    color: 'var(--ui-text)',
    minWidth: '100px',
    textAlign: 'center',
  },
  backBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    padding: '0.4rem 1.5rem',
    background: 'transparent',
    border: '2px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    cursor: 'pointer',
    borderRadius: '6px',
    marginTop: '1rem',
  },
  shareBtn: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    padding: '0.2rem 0.6rem',
    background: 'transparent',
    border: '1px solid var(--ui-border)',
    color: 'var(--ui-text-muted)',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  errorBanner: {
    background: 'var(--ui-accent-soft)',
    border: '1px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    padding: '0.6rem 1.2rem',
    borderRadius: '6px',
    marginBottom: '1rem',
    fontSize: '0.85rem',
    textAlign: 'center',
    maxWidth: '400px',
  },
  copied: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    color: 'var(--ui-accent)',
    marginLeft: '0.5rem',
  },

  /* ---- overlay layout ---- */
  overlayContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    background: 'var(--ui-overlay-bg)',
    padding: '0.6rem 1rem 0.8rem',
    pointerEvents: 'auto',
    userSelect: 'none',
    gap: '0.4rem',
  },
  overlayInfo: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.75rem',
    color: 'var(--ui-text-muted)',
    textAlign: 'center',
  },
  overlayControls: {
    display: 'flex',
    gap: '0.4rem',
    alignItems: 'center',
  },
  overlaySlider: {
    width: '220px',
    accentColor: 'var(--ui-accent)',
  },
  overlayBackBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '0.85rem',
    padding: '0.2rem 1rem',
    background: 'transparent',
    border: '2px solid var(--ui-accent)',
    color: 'var(--ui-accent)',
    cursor: 'pointer',
    borderRadius: '4px',
  },
};

/**
 * @param {Object} props
 * @param {import('../arena/replayFormat.js').Replay} props.replay - Replay data
 * @param {Function} [props.onStateChange] - Called with game state on each step
 * @param {() => void} props.onBack - Navigate back
 * @param {boolean} [props.overlay] - Use compact bottom-bar layout over canvas
 */
export function ReplayViewer({ replay, onStateChange, onBack, overlay = false }) {
  const totalActions = getReplayLength(replay);
  const [actionIndex, setActionIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState(null);
  const [replayError, setReplayError] = useState(null);
  const intervalRef = useRef(null);
  const stateCache = useRef(new Map());

  // Clear cache when replay changes
  useEffect(() => {
    stateCache.current = new Map();
    setActionIndex(0);
  }, [replay]);

  /*
   * Reconstruct state at current index, using nearest cached checkpoint
   * to avoid replaying from action 0 every time. Caches every 50 actions.
   */
  const getState = useCallback(
    idx => {
      if (stateCache.current.has(idx)) {
        return stateCache.current.get(idx);
      }

      // Find nearest cached checkpoint at or below idx
      let bestCachedIdx = -1;
      for (const cachedIdx of stateCache.current.keys()) {
        if (cachedIdx <= idx && cachedIdx > bestCachedIdx) {
          bestCachedIdx = cachedIdx;
        }
      }

      let state;
      if (bestCachedIdx >= 0) {
        const baseState = stateCache.current.get(bestCachedIdx);
        const actions = replay.actions.slice(bestCachedIdx, idx);
        if (actions.length > 0) {
          try {
            state = replayGame(baseState, actions);
          } catch (err) {
            throw new Error(`Replay failed at action ${idx}: ${err.message}`);
          }
        } else {
          state = baseState;
        }
      } else {
        state = replayToState(replay, idx);
      }

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
      try {
        const state = getState(actionIndex);
        onStateChange(state);
        setReplayError(null);
      } catch (err) {
        console.error('[ReplayViewer] State reconstruction failed:', err);
        setReplayError(err.message);
      }
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
    setShareError(null);
    try {
      const encoded = serializeReplay(replay);
      const url = `${window.location.origin}${window.location.pathname}#replay=${encoded}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[ReplayViewer] Share failed:', err);
      setShareError('Could not copy link');
      setTimeout(() => setShareError(null), 3000);
    }
  };

  const { metadata } = replay;

  if (overlay) {
    return (
      <div style={STYLE.overlayContainer}>
        {replayError && <div style={STYLE.errorBanner}>Replay error: {replayError}</div>}

        <div style={STYLE.overlayInfo}>
          {metadata.bots.join(' vs ')} · {metadata.turnCount} turns
          {metadata.winner !== null &&
            ` · Winner: ${metadata.bots[metadata.winner] || `Player ${metadata.winner}`}`}
        </div>

        <div style={STYLE.overlayControls}>
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

          <input
            type="range"
            min="0"
            max={totalActions}
            value={actionIndex}
            onInput={handleSlider}
            style={STYLE.overlaySlider}
          />

          <span style={STYLE.counter}>
            {actionIndex} / {totalActions}
          </span>

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
          {shareError && <span style={STYLE.copied}>{shareError}</span>}
        </div>

        <button style={STYLE.overlayBackBtn} onClick={onBack}>
          BACK
        </button>
      </div>
    );
  }

  // Default full-screen layout
  return (
    <div style={STYLE.container}>
      <h2 style={STYLE.title}>REPLAY</h2>

      {replayError && <div style={STYLE.errorBanner}>Replay error: {replayError}</div>}

      <div style={STYLE.info}>
        {metadata.bots.join(' vs ')} · {metadata.turnCount} turns
        {metadata.winner !== null &&
          ` · Winner: ${metadata.bots[metadata.winner] || `Player ${metadata.winner}`}`}
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
        {shareError && <span style={STYLE.copied}>{shareError}</span>}
      </div>

      <button style={STYLE.backBtn} onClick={onBack}>
        BACK
      </button>
    </div>
  );
}
