/**
 * Preact Error Boundary
 *
 * Catches render errors in child components and displays a recovery UI
 * instead of leaving the user with a blank screen.
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

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(err) {
    return { error: err.message || 'An unexpected error occurred' };
  }

  componentDidCatch(err) {
    console.error('[UI] Render error:', err);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={STYLE.container}>
          <p>Something went wrong.</p>
          <button style={STYLE.button} onClick={() => this.setState({ error: null })}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
