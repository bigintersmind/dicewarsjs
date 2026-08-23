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
 * Roll `count + advantage` dice and keep the `count` highest ("advantage dice").
 *
 * The luck handicap (issue #179): a handicapped seat rolls extra dice and drops
 * the lowest ones, on both attack and defense. The mechanism is deliberately
 * *visually honest* — the kept `values` are real faces that sum to `total`, so
 * the battle animation can render them unchanged.
 *
 * Determinism: exactly `count + advantage` draws are consumed from `rng`, so the
 * draw count is a pure function of (count, advantage) and a replay that carries
 * the same handicap config reproduces the game exactly.
 *
 * Kept dice are returned in their original roll order (not sorted), which keeps
 * the animation stable; ties among the lowest values drop the earliest-rolled
 * die first, so the split is deterministic for any input.
 *
 * `dropped` is part of the return even though nothing renders it today: it is the
 * only record of what the handicap actually bought, and the battle animation may
 * show the dropped die falling away (an open question on issue #179). Computing
 * it here is free — the split already exists — and it is what the odds-calibration
 * tests assert the drop rule against.
 *
 * @param {number} count     - Number of dice to keep (must be an integer >= 1)
 * @param {number} advantage - Number of extra dice to roll and drop (integer >= 0)
 * @param {Object} rng       - Seeded RNG instance (from createRng)
 * @returns {{values: number[], total: number, dropped: number[]}} Kept values (roll
 *   order) and their sum, plus the dropped values (roll order; `[]` when advantage is 0).
 */
export function rollAdvantage(count, advantage, rng) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`rollAdvantage: count must be an integer >= 1, got ${count}`);
  }
  if (!Number.isInteger(advantage) || advantage < 0) {
    throw new RangeError(`rollAdvantage: advantage must be an integer >= 0, got ${advantage}`);
  }

  /*
   * Allocation fast path: with advantage 0 the general path below would yield
   * the same values, the same total and the same number of draws — this just
   * skips the index sort and its scratch arrays.
   */
  if (advantage === 0) {
    const { values, total } = rollDice(count, rng);
    return { values, total, dropped: [] };
  }

  const rolled = new Array(count + advantage);
  for (let i = 0; i < rolled.length; i++) {
    rolled[i] = rng.nextInt(1, 6);
  }

  /*
   * Pick the `advantage` lowest dice to drop: sort the *indices* (value asc,
   * then index asc) and mark the first `advantage` of them, which leaves both
   * output arrays in original roll order.
   */
  const order = rolled.map((_, i) => i);
  order.sort((a, b) => rolled[a] - rolled[b] || a - b);
  const isDropped = new Array(rolled.length).fill(false);
  for (let i = 0; i < advantage; i++) {
    isDropped[order[i]] = true;
  }

  const values = [];
  const dropped = [];
  let total = 0;
  for (let i = 0; i < rolled.length; i++) {
    if (isDropped[i]) {
      dropped.push(rolled[i]);
    } else {
      values.push(rolled[i]);
      total += rolled[i];
    }
  }
  return { values, total, dropped };
}

/**
 * Resolve a battle between attacker and defender dice pools.
 * Ties go to the defender (attacker must strictly exceed defender total to win).
 *
 * @param {number} attackerDice - Number of attacker dice (1-8)
 * @param {number} defenderDice - Number of defender dice (1-8)
 * @param {Object} rng          - Seeded RNG instance
 * @param {Object|null} [options] - Luck handicap (issue #179); omit or pass null for an even fight
 * @param {number} [options.attackerAdvantage=0] - Extra dice the attacker rolls and drops
 * @param {number} [options.defenderAdvantage=0] - Extra dice the defender rolls and drops
 * @returns {import('./types.js').BattleResult}
 */
export function resolveBattle(attackerDice, defenderDice, rng, options = {}) {
  if (attackerDice < 1 || defenderDice < 1) {
    throw new RangeError(
      `resolveBattle: dice counts must be positive, got attacker=${attackerDice}, defender=${defenderDice}`
    );
  }
  /*
   * `= {}` only covers an omitted/undefined argument; `?? {}` also covers an
   * explicit null, which callers that thread an optional options object through
   * do pass — destructuring that would throw an opaque TypeError instead of
   * simply meaning "no handicap".
   */
  const { attackerAdvantage = 0, defenderAdvantage = 0 } = options ?? {};
  const attackerRoll = rollAdvantage(attackerDice, attackerAdvantage, rng);
  const defenderRoll = rollAdvantage(defenderDice, defenderAdvantage, rng);
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
