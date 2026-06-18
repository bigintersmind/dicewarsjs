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

const BOT_GUIDE_URL =
  'https://github.com/bigintersmind/dicewarsjs/blob/master/docs/BOT_GUIDE.md#submitting-your-bot';

const STYLE = {
  container: {
    width: '100%',
    maxWidth: '500px',
    padding: '0.9rem 1rem',
    background: 'rgba(78, 204, 163, 0.08)',
    border: '1px solid #4ecca3',
    borderRadius: '6px',
    textAlign: 'center',
  },
  label: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    color: '#4ecca3',
    marginBottom: '0.4rem',
    display: 'block',
    letterSpacing: '0.05em',
  },
  text: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    color: 'var(--ui-text-muted)',
    lineHeight: 1.4,
    marginBottom: '0.7rem',
  },
  link: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '0.9rem',
    letterSpacing: '0.05em',
    display: 'inline-block',
    padding: '0.35rem 1.1rem',
    background: '#4ecca3',
    color: '#15212b',
    borderRadius: '4px',
    textDecoration: 'none',
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
      <a style={STYLE.link} href={BOT_GUIDE_URL} target="_blank" rel="noopener noreferrer">
        SUBMIT A BOT ON GITHUB →
      </a>
    </div>
  );
}
