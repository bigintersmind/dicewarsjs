/**
 * Leaderboard Component
 *
 * Sortable table displaying bot rankings from arena results.
 *
 * @module ui/Leaderboard
 */

import { useState } from 'preact/hooks';
import { PLAYER_COLORS_CSS } from '../renderer/constants.js';

/*
 * Warning red for the broken-bot flag. The DOM theme (applyThemeVars) has no danger
 * color — `--ui-accent` is the app's brand hue and is reused for error banners — so a
 * flagged row uses a self-contained desaturated red that reads on both light and dark
 * themes rather than colliding with the accent.
 */
export const FLAG_COLOR = '#e5534b';
const FLAG_ROW_BG = 'rgba(229, 83, 75, 0.1)';

/**
 * Short badge text for a flagged bot: lead with whichever forced-end signal actually
 * fired so an author sees the failure mode (threw vs. submitted illegal moves), not a
 * misleading "0 error turns" when the flag came from invalid moves.
 *
 * Exported so OnlineLeaderboardScreen's "excluded this run" note (#137) speaks with the
 * same voice as the in-table badge.
 *
 * @param {import('../arena/botErrorReport.js').FlaggedBot} f
 * @returns {string}
 */
export function flagBadgeText(f) {
  if (f.errors > 0) return `⚠ ${f.errors} error turn${f.errors === 1 ? '' : 's'}`;
  if (f.invalidMoves > 0)
    return `⚠ ${f.invalidMoves} invalid move${f.invalidMoves === 1 ? '' : 's'}`;
  return '⚠ unreliable';
}

const STYLE = {
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: 'Roboto, monospace',
    fontSize: '0.85rem',
  },
  th: {
    padding: '0.4rem 0.6rem',
    borderBottom: '2px solid var(--ui-border)',
    color: 'var(--ui-text-muted)',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    fontSize: '0.75rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  thActive: {
    color: 'var(--ui-accent)',
  },
  td: {
    padding: '0.35rem 0.6rem',
    borderBottom: '1px solid var(--ui-border)',
    color: 'var(--ui-text)',
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
    color: 'var(--ui-accent)',
  },
  flaggedRow: {
    background: FLAG_ROW_BG,
  },
  badge: {
    display: 'inline-block',
    marginLeft: '0.4rem',
    padding: '0 0.3rem',
    borderRadius: '4px',
    border: `1px solid ${FLAG_COLOR}`,
    color: FLAG_COLOR,
    fontSize: '0.7rem',
    fontWeight: 'bold',
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
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
 * @param {import('../arena/botErrorReport.js').FlaggedBot[]} [props.flagged] - Bots whose
 *   win%/ELO is not a meaningful measurement (errored on most of their turns). Rendered as
 *   a per-row warning badge so a broken bot can't masquerade as a real ranking. The flag
 *   decision stays in the JS layer (reportBotErrors) — this component only displays it.
 */
export function Leaderboard({ bots, flagged }) {
  const [sortKey, setSortKey] = useState('elo');
  const [sortAsc, setSortAsc] = useState(false);

  if (!bots || bots.length === 0) return null;

  const flaggedByName = new Map((flagged || []).map(f => [f.name, f]));

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
        {sorted.map((bot, i) => {
          const flag = flaggedByName.get(bot.name);
          return (
            <tr key={bot.name} style={flag ? STYLE.flaggedRow : undefined}>
              <td style={{ ...STYLE.td, ...STYLE.rank }}>{i + 1}</td>
              <td style={STYLE.td}>
                <span
                  style={{
                    ...STYLE.colorDot,
                    background: PLAYER_COLORS_CSS[i % PLAYER_COLORS_CSS.length],
                  }}
                />
                {bot.name}
                {flag && (
                  <span
                    style={STYLE.badge}
                    title={
                      "This bot's win% / ELO is not a meaningful measurement — it errored " +
                      'on most of its turns, so it looks broken or mis-registered rather than ' +
                      'legitimately losing.'
                    }
                  >
                    {flagBadgeText(flag)}
                  </span>
                )}
              </td>
              <td style={STYLE.td}>{bot.elo}</td>
              <td style={STYLE.td}>{bot.wins}</td>
              <td style={STYLE.td}>{bot.gamesPlayed}</td>
              <td style={STYLE.td}>{(bot.winRate * 100).toFixed(1)}%</td>
              <td style={STYLE.td}>{bot.avgPlacement}</td>
              <td style={STYLE.td}>{(bot.attackWinRate * 100).toFixed(1)}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
