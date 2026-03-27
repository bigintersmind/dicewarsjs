/**
 * Battle Resolution (Pure Functions)
 *
 * Dice rolling and battle outcome computation.
 * No event emissions, no game state mutation — just dice counts in, result out.
 *
 * @module engine/BattleResolver
 */

/**
 * Roll a number of six-sided dice.
 *
 * @param {number} count - Number of dice to roll (must be >= 0)
 * @param {Object} rng   - Seeded RNG instance (from createRng)
 * @returns {{values: number[], total: number}}
 */
export function rollDice(count, rng) {
  if (count <= 0) return { values: [], total: 0 };

  const values = new Array(count);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const v = rng.nextInt(1, 6);
    values[i] = v;
    total += v;
  }
  return { values, total };
}

/**
 * Resolve a battle between attacker and defender dice pools.
 * Ties go to the defender (attacker must strictly exceed defender total to win).
 *
 * @param {number} attackerDice - Number of attacker dice (1-8)
 * @param {number} defenderDice - Number of defender dice (1-8)
 * @param {Object} rng          - Seeded RNG instance
 * @returns {import('./types.js').BattleResult}
 */
export function resolveBattle(attackerDice, defenderDice, rng) {
  if (attackerDice < 1 || defenderDice < 1) {
    throw new RangeError(
      `resolveBattle: dice counts must be positive, got attacker=${attackerDice}, defender=${defenderDice}`
    );
  }
  const attackerRoll = rollDice(attackerDice, rng);
  const defenderRoll = rollDice(defenderDice, rng);
  return {
    attackerRoll,
    defenderRoll,
    success: attackerRoll.total > defenderRoll.total,
  };
}

/**
 * Estimate the probability of the attacker winning.
 *
 * Uses a sigmoid approximation based on the dice ratio.
 * Pure math — no RNG needed.
 *
 * @param {number} attackerDice
 * @param {number} defenderDice
 * @returns {number} Probability in [0, 1]
 */
export function calculateAttackProbability(attackerDice, defenderDice) {
  if (attackerDice <= 0 || defenderDice <= 0) return 0;
  if (attackerDice >= defenderDice * 3) return 0.95;
  if (defenderDice >= attackerDice * 3) return 0.05;

  const ratio = attackerDice / defenderDice;
  return 1 / (1 + Math.exp(-2 * (ratio - 1)));
}
