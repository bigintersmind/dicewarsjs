/**
 * ELO Rating System
 *
 * Multi-player ELO adapted for games with more than 2 players.
 * Each player is compared pairwise against every other player;
 * the K-factor is divided by (N-1) to normalize for the number of comparisons.
 *
 * @module arena/elo
 */

/** Default starting ELO rating */
export const DEFAULT_RATING = 1200;

/** Default K-factor (volatility of rating changes) */
export const DEFAULT_K = 32;

/**
 * Calculate the expected score of player A against player B.
 *
 * @param {number} ratingA - Player A's current rating
 * @param {number} ratingB - Player B's current rating
 * @returns {number} Expected score (0 to 1)
 */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Update ELO ratings after a multi-player game.
 *
 * Players are ordered by placement (index 0 = winner/1st place).
 * Each player is compared pairwise: higher placement = win (score 1),
 * lower placement = loss (score 0). Equal placement = draw (score 0.5).
 *
 * @param {Array<{ name: string, elo: number }>} players - Ordered by placement (0 = 1st)
 * @param {number} [kFactor=32] - K-factor for rating volatility
 * @returns {Array<{ name: string, elo: number, delta: number }>} Updated ratings
 */
export function updateEloRatings(players, kFactor = DEFAULT_K) {
  const n = players.length;
  if (n < 2) {
    return players.map(p => ({ name: p.name, elo: p.elo, delta: 0 }));
  }

  // K per comparison — normalize for number of pairwise matchups
  const kPerPair = kFactor / (n - 1);

  const deltas = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const expected_i = expectedScore(players[i].elo, players[j].elo);
      const expected_j = 1 - expected_i;

      // Player i has better placement (lower index = higher placement)
      const score_i = 1;
      const score_j = 0;

      deltas[i] += kPerPair * (score_i - expected_i);
      deltas[j] += kPerPair * (score_j - expected_j);
    }
  }

  return players.map((p, i) => ({
    name: p.name,
    elo: Math.round(p.elo + deltas[i]),
    delta: Math.round(deltas[i]),
  }));
}
