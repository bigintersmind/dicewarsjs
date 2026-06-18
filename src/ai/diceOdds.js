/**
 * Exact Dice Wars battle odds — a single source of truth shared by the
 * expected-value AIs (ai_strategist, ai_lookahead).
 *
 * WIN_TABLE[a][d] = P(sum of `a` six-sided dice > sum of `d` six-sided dice),
 * with ties awarded to the defender. Computed once at module load via
 * convolution of the d6 distributions.
 */

export const MAX_DICE = 8;

const buildWinTable = () => {
  // dists[n][s] = P(sum of n dice equals s)
  const dists = [null];
  for (let n = 1; n <= MAX_DICE; n++) {
    const cur = new Array(6 * n + 1).fill(0);
    if (n === 1) {
      for (let face = 1; face <= 6; face++) cur[face] = 1 / 6;
    } else {
      const prev = dists[n - 1];
      for (let s = n - 1; s <= 6 * (n - 1); s++) {
        if (prev[s] === 0) continue;
        for (let face = 1; face <= 6; face++) {
          cur[s + face] += prev[s] / 6;
        }
      }
    }
    dists[n] = cur;
  }

  const table = Array.from({ length: MAX_DICE + 1 }, () => new Array(MAX_DICE + 1).fill(0));
  for (let a = 1; a <= MAX_DICE; a++) {
    // cumA[s] = P(sum of a dice <= s)
    const distA = dists[a];
    const cumA = new Array(distA.length).fill(0);
    let acc = 0;
    for (let s = 0; s < distA.length; s++) {
      acc += distA[s];
      cumA[s] = acc;
    }
    for (let d = 1; d <= MAX_DICE; d++) {
      const distD = dists[d];
      let p = 0;
      for (let sd = d; sd <= 6 * d; sd++) {
        const pAttackerHigher = sd < cumA.length ? 1 - cumA[sd] : 0;
        p += distD[sd] * pAttackerHigher;
      }
      table[a][d] = p;
    }
  }
  return table;
};

export const WIN_TABLE = buildWinTable();

/**
 * Exact probability that an attack with `attackerDice` beats `defenderDice`.
 * Inputs are clamped to [1, MAX_DICE]; out-of-range (< 1) returns 0.
 *
 * @param {number} attackerDice - 1..8
 * @param {number} defenderDice - 1..8
 * @returns {number} Probability in [0, 1]
 */
export const winProbability = (attackerDice, defenderDice) => {
  if (attackerDice < 1 || defenderDice < 1) return 0;
  const a = Math.min(attackerDice, MAX_DICE);
  const d = Math.min(defenderDice, MAX_DICE);
  return WIN_TABLE[a][d];
};
