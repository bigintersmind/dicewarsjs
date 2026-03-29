/**
 * Custom Bot Input
 *
 * Textarea for bot source code with validation and compilation.
 *
 * @module ui/CustomBotInput
 */

import { useState, useCallback } from 'preact/hooks';
import { compileCustomBot } from '../arena/customBotCompiler.js';

const PLACEHOLDER = `// Your bot receives a \`state\` object and should return
// { from: areaId, to: areaId } to attack, or null to end turn.
//
// WARNING: Bots run on the main thread. Avoid infinite loops
// (while(true), for(;;)) — they will freeze the browser tab.
//
// state.myAreas    - territories you own (id, dice, neighbors)
// state.allAreas   - all territories on the board
// state.myPlayer   - your player index
// state.players    - all player stats
// state.turnNumber - current turn number
// state.gamePhase  - 'early', 'mid', or 'late'

for (const area of state.myAreas) {
  if (area.dice <= 1) continue;
  const enemy = area.neighbors.find(id => {
    const target = state.allAreas.find(a => a.id === id);
    return target && target.owner !== state.myPlayer;
  });
  if (enemy !== undefined) return { from: area.id, to: enemy };
}
return null;`;

const STYLE = {
  container: {
    width: '100%',
    maxWidth: '500px',
    marginBottom: '1rem',
  },
  label: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    color: '#aaa',
    marginBottom: '0.5rem',
    display: 'block',
    letterSpacing: '0.05em',
  },
  nameRow: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '0.5rem',
  },
  nameInput: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.85rem',
    padding: '0.3rem 0.6rem',
    background: '#1a1a2e',
    border: '2px solid #555',
    color: '#eee',
    borderRadius: '4px',
    flex: 1,
  },
  textarea: {
    fontFamily: "'Courier New', monospace",
    fontSize: '0.8rem',
    width: '100%',
    minHeight: '180px',
    padding: '0.6rem',
    background: '#1a1a2e',
    border: '2px solid #555',
    color: '#eee',
    borderRadius: '4px',
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  btnRow: {
    display: 'flex',
    gap: '0.5rem',
    marginTop: '0.5rem',
  },
  addBtn: {
    fontFamily: 'Anton, sans-serif',
    fontSize: '0.85rem',
    padding: '0.3rem 1rem',
    background: '#e94560',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    borderRadius: '4px',
    letterSpacing: '0.05em',
  },
  addBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  status: {
    fontFamily: 'Roboto, sans-serif',
    fontSize: '0.8rem',
    marginTop: '0.4rem',
    padding: '0.3rem 0.6rem',
    borderRadius: '4px',
  },
  statusError: {
    color: '#e94560',
    background: 'rgba(233, 69, 96, 0.1)',
  },
  statusSuccess: {
    color: '#4ecca3',
    background: 'rgba(78, 204, 163, 0.1)',
  },
  statusWarning: {
    color: '#f0a500',
    background: 'rgba(240, 165, 0, 0.1)',
  },
};

/**
 * @param {Object} props
 * @param {(bot: { name: string, fn: Function, source: string }) => void} props.onBotReady
 * @param {string[]} [props.existingNames] - Names already taken (built-in + custom)
 */
export function CustomBotInput({ onBotReady, existingNames = [] }) {
  const [source, setSource] = useState('');
  const [name, setName] = useState('Custom Bot');
  const [status, setStatus] = useState(null); // { type: 'error'|'success'|'warning', message }
  const [validating, setValidating] = useState(false);

  const handleValidateAndAdd = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatus({ type: 'error', message: 'Bot name cannot be empty' });
      return;
    }

    if (existingNames.includes(trimmedName)) {
      setStatus({ type: 'error', message: `Name "${trimmedName}" is already taken` });
      return;
    }

    const code = source || PLACEHOLDER;

    setValidating(true);
    setStatus(null);

    // Defer to let UI update
    setTimeout(() => {
      let fn, warnings;
      try {
        ({ fn, warnings } = compileCustomBot(code, trimmedName));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ type: 'error', message });
        setValidating(false);
        return;
      }

      if (warnings.length > 0) {
        setStatus({ type: 'warning', message: `Added with warning: ${warnings[0]}` });
      } else {
        setStatus({ type: 'success', message: `"${trimmedName}" validated and added` });
      }

      try {
        onBotReady({ name: trimmedName, fn, source: code });
      } catch (err) {
        console.error('[CustomBotInput] onBotReady callback failed:', err);
        setStatus({ type: 'error', message: 'Failed to register bot. Please try again.' });
      } finally {
        setValidating(false);
      }
    }, 0);
  }, [source, name, existingNames, onBotReady]);

  return (
    <div style={STYLE.container}>
      <span style={STYLE.label}>CUSTOM BOT</span>
      <div style={STYLE.nameRow}>
        <input
          style={STYLE.nameInput}
          type="text"
          value={name}
          onInput={e => setName(e.target.value)}
          placeholder="Bot name"
        />
      </div>
      <textarea
        style={STYLE.textarea}
        value={source}
        onInput={e => setSource(e.target.value)}
        placeholder={PLACEHOLDER}
        spellcheck={false}
      />
      <div style={STYLE.btnRow}>
        <button
          style={{
            ...STYLE.addBtn,
            ...(validating ? STYLE.addBtnDisabled : {}),
          }}
          onClick={handleValidateAndAdd}
          disabled={validating}
        >
          {validating ? 'VALIDATING...' : 'VALIDATE & ADD'}
        </button>
      </div>
      {status && (
        <div
          style={{
            ...STYLE.status,
            ...(status.type === 'error'
              ? STYLE.statusError
              : status.type === 'success'
                ? STYLE.statusSuccess
                : STYLE.statusWarning),
          }}
        >
          {status.message}
        </div>
      )}
    </div>
  );
}
