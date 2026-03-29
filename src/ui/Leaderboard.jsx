/**
 * Leaderboard Component
 *
 * Sortable table displaying bot rankings from arena results.
 *
 * @module ui/Leaderboard
 */

import { useState } from 'preact/hooks';
import { PLAYER_COLORS_CSS } from '../renderer/constants.js';

const STYLE = {
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: 'Roboto, monospace',
    fontSize: '0.85rem',
  },
  th: {
    padding: '0.4rem 0.6rem',
    borderBottom: '2px solid #444',
    color: '#aaa',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  thActive: {
    color: '#e94560',
  },
  td: {
    padding: '0.35rem 0.6rem',
    borderBottom: '1px solid #333',
    color: '#ccc',
  },
  colorDot: {
    display: 'inline-block',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    marginRight: '0.4rem',
    verticalAlign: 'middle',
  },
  rank: {
    fontWeight: 'bold',
    color: '#e94560',
  },
};

const COLUMNS = [
  { key: 'rank', label: '#', sortable: false },
  { key: 'name', label: 'Bot', sortable: true },
  { key: 'elo', label: 'ELO', sortable: true },
  { key: 'wins', label: 'W', sortable: true },
  { key: 'gamesPlayed', label: 'GP', sortable: true },
  { key: 'winRate', label: 'Win%', sortable: true },
  { key: 'avgPlacement', label: 'Avg Place', sortable: true },
  { key: 'attackWinRate', label: 'Atk%', sortable: true },
];

/**
 * @param {Object} props
 * @param {import('../arena/arenaRunner.js').ArenaBotStat[]} props.bots - Bot statistics
 */
export function Leaderboard({ bots }) {
  const [sortKey, setSortKey] = useState('elo');
  const [sortAsc, setSortAsc] = useState(false);

  if (!bots || bots.length === 0) return null;

  const handleSort = key => {
    if (key === sortKey) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(key === 'name' || key === 'avgPlacement');
    }
  };

  const sorted = [...bots]
    .map(b => ({
      ...b,
      winRate: b.gamesPlayed > 0 ? b.wins / b.gamesPlayed : 0,
    }))
    .sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (typeof aVal === 'string') {
        return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortAsc ? aVal - bVal : bVal - aVal;
    });

  return (
    <table style={STYLE.table}>
      <thead>
        <tr>
          {COLUMNS.map(col => (
            <th
              key={col.key}
              style={{
                ...STYLE.th,
                ...(col.key === sortKey ? STYLE.thActive : {}),
                cursor: col.sortable ? 'pointer' : 'default',
              }}
              onClick={() => col.sortable && handleSort(col.key)}
            >
              {col.label}
              {col.key === sortKey && (sortAsc ? ' \u25B2' : ' \u25BC')}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((bot, i) => (
          <tr key={bot.name}>
            <td style={{ ...STYLE.td, ...STYLE.rank }}>{i + 1}</td>
            <td style={STYLE.td}>
              <span
                style={{
                  ...STYLE.colorDot,
                  background: PLAYER_COLORS_CSS[i % PLAYER_COLORS_CSS.length],
                }}
              />
              {bot.name}
            </td>
            <td style={STYLE.td}>{bot.elo}</td>
            <td style={STYLE.td}>{bot.wins}</td>
            <td style={STYLE.td}>{bot.gamesPlayed}</td>
            <td style={STYLE.td}>{(bot.winRate * 100).toFixed(1)}%</td>
            <td style={STYLE.td}>{bot.avgPlacement}</td>
            <td style={STYLE.td}>{(bot.attackWinRate * 100).toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
