/**
 * Leaderboard Component
 *
 * Sortable table displaying bot rankings from arena results. Arena results, tournament
 * results and the online leaderboard all drop this straight into `MENU_STYLE.panel`, so
 * the table has to fit a phone from inside the component or none of the three do (#222).
 *
 * Two things keep it inside that panel — a scroller around the table, and a phone
 * breakpoint that drops two of the eight columns. The scroller is there because an
 * overflowing table breaks the panel's border and runs off screen, where nothing can bring
 * it back (`html, body` are `overflow: hidden`). The two columns to lose are Avg Place and
 * Atk%: secondary reads that `npm run benchmark-bot` also reports, where #/Bot/ELO/W/GP/Win%
 * are the ranking itself. Without them the remaining six fit the panel's content width, so
 * the scroller stays a safety net for the unusual case — a long community-bot name, a column
 * added later — rather than the everyday experience. How each is wired: `STYLE.scroll` and
 * LEADERBOARD_CSS below.
 *
 * Known limitation: `sortKey` can point at a column the phone hides — sort by Atk% in
 * landscape, rotate to portrait, and the rows keep that order with no visible header or
 * ▲▼ to explain it. Left as it is, because the sort headers are being reworked for the
 * keyboard and `aria-sort` under #221 item 2, which is where the fix belongs.
 *
 * @module ui/Leaderboard
 */

import { useState } from 'preact/hooks';
import { PLAYER_COLORS_CSS } from '../renderer/constants.js';

/*
 * Warning red for the broken-bot flag. `--ui-danger` is the DOM theme's danger color: it
 * exists so flag styling (the row/badge here, the exclusion note on
 * OnlineLeaderboardScreen) never has to borrow `--ui-accent`, the brand hue that error
 * banners already reuse. The token is tuned per theme, because a single red can't clear
 * AA on both a near-black overlay and a near-white one — the old literal was the dark
 * value and measured 3.2:1 on the light panel (#220). Exported so that note shares it (#137).
 */
export const FLAG_COLOR = 'var(--ui-danger)';
/*
 * The flagged row's wash: the same warning red at 10% alpha, so the tint under the badge is
 * the badge's own hue. It is a derived var (`--ui-danger-soft`, composed in applyThemeVars
 * beside `--ui-accent-soft`) rather than an rgba() literal here, because a literal can only
 * be one theme's red: it washed light-theme rows in the dark coral while the badge and
 * border on top were the light red, and it would have stayed on the old hue if `uiDanger`
 * ever moved. The badge and row text clear AA over it in both themes (pinned in the tests).
 */
const FLAG_ROW_BG = 'var(--ui-danger-soft)';

/*
 * Phone rules for the table, mounted inside the scroll wrapper the way every menu screen
 * mounts its own stylesheet (MenuScreen with CHROME_CSS, TopNav with NAV_CSS) — so the
 * component is self-contained wherever it is dropped.
 *
 * The breakpoint is the mode rail's 560px: NAV_CSS in menuChrome.jsx already tightens the
 * rail above this panel at exactly that width, and matching the chrome the table sits under
 * beats inventing a number here.
 *
 * `--dw-lb-pad-x` exists because the cells are styled inline and no class rule can outrank
 * an inline declaration. The wide-screen value then rides in the `var()` fallback at the two
 * use sites, rather than in a second `.dw-lb-scroll` rule (or, worse, inline on the wrapper,
 * where it would be out of this block's reach entirely) — leaving this the variable's only
 * declaration and the media query unambiguously the thing that changes it.
 */
export const LEADERBOARD_CSS = `
@media (max-width: 560px) {
  .dw-lb-scroll { --dw-lb-pad-x: 0.3rem; }
  .dw-lb-derived { display: none; }
}
`;

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
  /*
   * The table's own scroller: `width: 100%` pins it to the panel's content box, so when
   * the table inside is wider this is what scrolls — not the panel, and not the page.
   */
  scroll: {
    width: '100%',
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: 'Roboto, monospace',
    fontSize: '0.85rem',
  },
  th: {
    padding: '0.4rem var(--dw-lb-pad-x, 0.6rem)',
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
    padding: '0.35rem var(--dw-lb-pad-x, 0.6rem)',
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

/**
 * `derived: true` marks a column the phone layout drops (see LEADERBOARD_CSS). Its header
 * carries the class from here; its cells are written out by hand in the row below and
 * carry it there, so the two have to be kept in step.
 */
const COLUMNS = [
  { key: 'rank', label: '#', sortable: false },
  { key: 'name', label: 'Bot', sortable: true },
  { key: 'elo', label: 'ELO', sortable: true },
  { key: 'wins', label: 'W', sortable: true },
  { key: 'gamesPlayed', label: 'GP', sortable: true },
  { key: 'winRate', label: 'Win%', sortable: true },
  { key: 'avgPlacement', label: 'Avg Place', sortable: true, derived: true },
  { key: 'attackWinRate', label: 'Atk%', sortable: true, derived: true },
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
    <div className="dw-lb-scroll" style={STYLE.scroll}>
      <style>{LEADERBOARD_CSS}</style>
      <table style={STYLE.table}>
        <thead>
          <tr>
            {COLUMNS.map(col => (
              <th
                key={col.key}
                className={col.derived ? 'dw-lb-derived' : undefined}
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
                        "This bot's win% / ELO is not a meaningful measurement. It errored " +
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
                <td className="dw-lb-derived" style={STYLE.td}>
                  {bot.avgPlacement}
                </td>
                <td className="dw-lb-derived" style={STYLE.td}>
                  {(bot.attackWinRate * 100).toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
