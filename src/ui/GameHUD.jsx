/**
 * Player Status HUD
 *
 * Shows player stats at the bottom of the screen.
 *
 * @module ui/GameHUD
 */

import { useGameStore } from './hooks/useGameStore.js';
import { PLAYER_COLORS_CSS } from '../renderer/constants.js';

const STYLE = {
  bar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'center',
    gap: '0.5rem',
    padding: '0.5rem',
    background: 'rgba(0, 0, 0, 0.5)',
    pointerEvents: 'auto',
  },
  player: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
    padding: '0.3rem 0.6rem',
    borderRadius: '4px',
    fontFamily: 'Anton, sans-serif',
    fontSize: '1rem',
    color: '#fff',
    transition: 'opacity 0.3s',
  },
  swatch: {
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: '1px solid rgba(255,255,255,0.3)',
    flexShrink: 0,
  },
  current: {
    outline: '2px solid #fff',
    outlineOffset: '2px',
  },
  stock: {
    fontSize: '0.75rem',
    color: '#aaa',
    marginLeft: '0.2rem',
  },
};

/**
 * @param {Object} props
 * @param {Object} props.store - GameStore instance
 */
export function GameHUD({ store }) {
  const gameState = useGameStore(store, s => s.gameState);
  if (!gameState) return null;

  const { players, turnOrder, currentPlayerIndex } = gameState;
  const currentPlayerId = turnOrder[currentPlayerIndex];

  return (
    <div style={STYLE.bar}>
      {players.map(p => {
        if (p.eliminated) return null;
        const isCurrent = p.id === currentPlayerId;
        const color = PLAYER_COLORS_CSS[p.id % PLAYER_COLORS_CSS.length];
        return (
          <div
            key={p.id}
            style={{
              ...STYLE.player,
              ...(isCurrent ? STYLE.current : {}),
            }}
          >
            <span style={{ ...STYLE.swatch, background: color }} />
            <span>{p.territoryCount}</span>
            {p.stock > 0 && <span style={STYLE.stock}>+{p.stock}</span>}
          </div>
        );
      })}
    </div>
  );
}
