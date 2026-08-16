/**
 * Add Bot Via GitHub
 *
 * Small informational panel that points contributors to the GitHub bot
 * submission flow. Replaces the in-browser "paste JavaScript" custom bot
 * input — bots now compete in the daily online tournament after being
 * merged via a pull request.
 *
 * @module ui/AddBotViaGithub
 */

import { REPO_URL } from './menuChrome.jsx';

const BOT_GUIDE_URL = `${REPO_URL}/blob/master/docs/BOT_GUIDE.md#submitting-your-bot`;

/*
 * Styled with the shared menu-chrome idioms (overlay panel + classic white
 * button); the host screen renders CHROME_CSS, so the `dw-btn` class rules
 * are always present wherever this panel appears.
 */
const STYLE = {
  container: {
    width: '100%',
    padding: '0.9rem 1rem 1rem',
    background: 'var(--ui-overlay-bg)',
    border: '1px solid var(--ui-border)',
    borderRadius: '10px',
    textAlign: 'center',
  },
  label: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    color: 'var(--ui-text)',
    marginBottom: '0.4rem',
    display: 'block',
    letterSpacing: '0.05em',
  },
  text: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text-muted)',
    lineHeight: 1.4,
    marginBottom: '0.8rem',
  },
  link: {
    fontSize: '0.85rem',
    padding: '0.4rem 1.1rem',
    borderRadius: '10px',
  },
};

/**
 * Panel directing users to add their own bot through GitHub.
 */
export function AddBotViaGithub() {
  return (
    <div style={STYLE.container}>
      <span style={STYLE.label}>ADD YOUR OWN BOT</span>
      <p style={STYLE.text}>
        Custom bots are submitted through GitHub and compete in the daily online tournament with ELO
        rankings. Write a single function, open a pull request, and CI validates it automatically.
      </p>
      <a
        className="dw-btn"
        style={STYLE.link}
        href={BOT_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        SUBMIT A BOT ON GITHUB →
      </a>
    </div>
  );
}
