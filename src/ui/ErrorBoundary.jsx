/**
 * Preact Error Boundary
 *
 * Catches render errors in child components and displays a recovery UI
 * instead of leaving the user with a blank screen.
 *
 * Two recovery modes:
 *   - Generic render error → "Try Again" clears the boundary and re-renders the
 *     children (works when the failure was transient state, not a bad module).
 *   - Dynamic-import / chunk-load failure → "Reload" (`location.reload()`). Arena &
 *     Tournament are code-split behind `lazy()` (issue #51); a failed chunk fetch (a
 *     deploy rotating chunk hashes, or a network blip) is caught here, but preact's
 *     `lazy` CACHES the rejection, so re-rendering the same lazy component just
 *     re-throws the cached error forever — "Try Again" can never recover it. Only a
 *     full page reload re-fetches the (now current-hash) chunk, so for these errors we
 *     surface that as the affordance instead (issue #93).
 *
 * @module ui/ErrorBoundary
 */

import { Component } from 'preact';

const STYLE = {
  container: {
    color: 'var(--ui-accent)',
    padding: '2rem',
    fontFamily: 'sans-serif',
    textAlign: 'center',
    /*
     * #app is pointer-events:none (clicks fall through to the Pixi canvas);
     * every interactive surface must opt back in, or the recovery buttons
     * render but silently swallow clicks.
     */
    pointerEvents: 'auto',
  },
  button: {
    marginTop: '1rem',
    padding: '0.5rem 1.5rem',
    fontSize: '1rem',
    cursor: 'pointer',
    background: 'var(--ui-accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
  },
};

/*
 * Signatures of a failed dynamic import across bundlers/browsers: Vite emits "Failed to
 * fetch dynamically imported module", Chrome/Firefox "error loading dynamically imported
 * module", Safari "Importing a module script failed", and webpack throws a `ChunkLoadError`
 * with a "Loading chunk N failed" message. Any of these means the JS never arrived —
 * re-rendering can't help; only a reload can.
 */
const CHUNK_LOAD_RE =
  /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError/i;

/**
 * Whether an error is a code-split chunk fetch failure (reload-recoverable, not re-render).
 * Walks the `Error.cause` chain, since a bundler/runtime (or a test's module mock) can wrap
 * the underlying fetch failure as the `cause` of an outer error. Bounded depth guards against
 * a self-referential cause.
 */
export function isChunkLoadError(err, depth = 0) {
  if (!err || depth > 3) return false;
  if (err.name === 'ChunkLoadError') return true;
  const msg = typeof err === 'string' ? err : err.message || '';
  if (CHUNK_LOAD_RE.test(msg)) return true;
  return isChunkLoadError(err.cause, depth + 1);
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    // Keep the whole error so render() can classify it (chunk-load vs generic).
    this.state = { error: null };
  }

  static getDerivedStateFromError(err) {
    return { error: err || new Error('An unexpected error occurred') };
  }

  componentDidCatch(err) {
    console.error('[UI] Render error:', err);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (isChunkLoadError(error)) {
      return (
        <div style={STYLE.container}>
          <p>Couldn&apos;t load this screen.</p>
          <p>The app was likely updated in the background — reload to get the latest version.</p>
          <button style={STYLE.button} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }

    return (
      <div style={STYLE.container}>
        <p>Something went wrong.</p>
        <button style={STYLE.button} onClick={() => this.setState({ error: null })}>
          Try Again
        </button>
      </div>
    );
  }
}
