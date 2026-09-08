/**
 * Spoiler-free, pasteable result text for a daily board.
 *
 * Three or four lines: what board, how it went, an optional streak, and the
 * link. No territory counts, no map, nothing that would tell somebody who has
 * not played today's board anything about it beyond how hard it was for you.
 *
 * @module game/dailyShare
 */

/** Where a reader of the shared text goes to play the same board. */
export const GAME_URL = 'https://ivanlay.com/dicewarsjs/';

/**
 * The board's UTC date with its year ("Sep 7, 2026"). Pinned to en-US rather
 * than the reader's locale, unlike the in-app `formatDailyDate`: this string is
 * pasted into a chat where the rest of the line is English copy, and the whole
 * message should read as one voice.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {string}
 */
function formatShareDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Format a finished daily attempt for sharing.
 *
 * @param {Object} result
 * @param {string} result.date - The board's UTC date, 'YYYY-MM-DD'.
 * @param {boolean} result.won
 * @param {number} result.turns - Human turns taken.
 * @param {number} result.attacks
 * @param {number} result.captures
 * @param {number} [result.streak] - Consecutive days played; the line is
 *   omitted below 2, where "Streak: 1 day" says nothing.
 * @param {boolean} [result.drew] - Turn-cap draw (neither won nor eliminated).
 * @returns {string}
 */
export function formatDailyShare({
  date,
  won,
  turns,
  attacks,
  captures,
  streak = 0,
  drew = false,
}) {
  const outcome = won
    ? `Won in ${plural(turns, 'turn')}`
    : drew
      ? `Draw after ${plural(turns, 'turn')}`
      : `Eliminated after ${plural(turns, 'turn')}`;

  const lines = [
    `Dice Wars Daily · ${formatShareDate(date)}`,
    `${outcome} · ${captures}/${attacks} attacks won`,
  ];
  if (streak >= 2) lines.push(`Streak: ${plural(streak, 'day')}`);
  lines.push(GAME_URL);
  return lines.join('\n');
}
