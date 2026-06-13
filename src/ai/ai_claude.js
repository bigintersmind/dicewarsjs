/**
 * Claude AI — expected-value strategy built on exact battle probabilities
 * and the economics of connectivity.
 *
 * Core insight: reinforcements equal the size of a player's largest connected
 * territory group, so the real currency of Dice Wars is connectivity, not raw
 * territory count. Every candidate attack is scored as an expected value:
 *
 *   EV = P(win) * (value of winning) - P(loss) * (cost of losing)
 *
 * Value of winning includes:
 * - The territory itself and the defender's dice destroyed
 * - Income gained by merging my connected groups through the captured cell
 * - Income destroyed by cutting the defender's largest group
 * - A large bonus for eliminating a player outright
 * - Discounted by the probability the conquered cell is immediately retaken
 *
 * Cost of losing is the attacker's dice burned down to 1 plus the exposure
 * of the now-weak source cell.
 *
 * Strategic posture modulates the attack threshold:
 * - Gang up on a dominant leader (anti-runaway, like the original AI)
 * - Press harder when dominant or in a winning heads-up endgame
 * - Demand higher-EV attacks when weak
 *
 * Fully deterministic: no randomness; ties break toward the lowest area index.
 */

const MAX_DICE = 8;

/**
 * Build the exact win-probability table for attacker vs defender dice pools.
 * WIN_TABLE[a][d] = P(sum of a d6 > sum of d d6) — ties go to the defender.
 * Computed once at module load via convolution of d6 distributions.
 */
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

const WIN_TABLE = buildWinTable();

/**
 * Exact probability that an attack with `attackerDice` beats `defenderDice`.
 * Exported for tests and tooling.
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

// --- Scoring weights (dice-equivalent units, tuned via the bot arena) ---
const TERRITORY_VALUE = 1.0; // base value of holding one more territory
const INCOME_WEIGHT = 1.1; // value of +1 reinforcement per turn (compounds)
const DESTROY_WEIGHT = 0.25; // value per defender die destroyed
const LOSS_WEIGHT = 0.5; // cost per own die burned on a failed attack
const HOLD_DISCOUNT = 0.6; // how much recapture risk discounts the gains
const EXPOSURE_WEIGHT = 0.35; // cost of leaving the source cell at 1 die on a border
const ELIMINATION_BONUS = 3.0; // capturing a player's last territory
const GANG_UP_BONUS = 0.6; // extra value for attacking a dominant leader
const OFF_TARGET_PENALTY = 0.15; // attacking minor players while a leader runs away
const DOMINANCE_SHARE = 0.4; // dice share that marks a player as dominant
const BASE_THRESHOLD = 0.05; // minimum EV to bother attacking
const PRESS_THRESHOLD = -0.6; // accept negative-EV attacks to close out a win

export const ai_claude = game => {
  const pn = game.get_pn();
  const { adat, AREA_MAX } = game;

  const exists = i => {
    const area = adat[i];
    return area !== undefined && area !== null && area.size !== 0;
  };

  // --- Board census ---
  const diceByPlayer = new Array(8).fill(0);
  const areasByPlayer = new Array(8).fill(0);
  let totalDice = 0;
  for (let i = 1; i < AREA_MAX; i++) {
    if (!exists(i)) continue;
    const { arm, dice } = adat[i];
    diceByPlayer[arm] += dice;
    areasByPlayer[arm] += 1;
    totalDice += dice;
  }

  if (areasByPlayer[pn] === 0) return 0;

  // --- Connected-component labeling for one owner ---
  const labelComponents = owner => {
    const compId = new Array(AREA_MAX).fill(-1);
    const compSize = [];
    for (let i = 1; i < AREA_MAX; i++) {
      if (!exists(i) || adat[i].arm !== owner || compId[i] !== -1) continue;
      const id = compSize.length;
      const stack = [i];
      compId[i] = id;
      let size = 0;
      while (stack.length > 0) {
        const cur = stack.pop();
        size += 1;
        const { join } = adat[cur];
        for (let j = 1; j < AREA_MAX; j++) {
          if (join[j] && compId[j] === -1 && exists(j) && adat[j].arm === owner) {
            compId[j] = id;
            stack.push(j);
          }
        }
      }
      compSize.push(size);
    }
    return { compId, compSize };
  };

  const myComps = labelComponents(pn);
  const myLargestGroup = myComps.compSize.length > 0 ? Math.max(...myComps.compSize) : 0;

  const enemyCompsCache = new Map();
  const compsFor = owner => {
    if (!enemyCompsCache.has(owner)) enemyCompsCache.set(owner, labelComponents(owner));
    return enemyCompsCache.get(owner);
  };

  /**
   * Income I gain if I capture `to`: capturing merges every one of my
   * components adjacent to `to` into a single group of (sum of sizes + 1).
   */
  const myIncomeGain = to => {
    const seen = new Set();
    let merged = 1;
    const { join } = adat[to];
    for (let j = 1; j < AREA_MAX; j++) {
      if (!join[j] || !exists(j) || adat[j].arm !== pn) continue;
      const id = myComps.compId[j];
      if (!seen.has(id)) {
        seen.add(id);
        merged += myComps.compSize[id];
      }
    }
    return Math.max(0, merged - myLargestGroup);
  };

  /**
   * Reinforcement income `owner` loses if `cell` is captured: nonzero only
   * when `cell` sits in (one of) their largest group(s), where its removal
   * may also split the group. Used both for the defender's target cell and
   * for my own source cell (chokepoint awareness). Memoized.
   */
  const incomeLossCache = new Map();
  const incomeLossIfCaptured = cell => {
    if (incomeLossCache.has(cell)) return incomeLossCache.get(cell);
    const owner = adat[cell].arm;
    const comps = owner === pn ? myComps : compsFor(owner);
    const before = comps.compSize.length > 0 ? Math.max(...comps.compSize) : 0;
    let loss = 0;
    if (comps.compSize[comps.compId[cell]] === before) {
      // Recompute the owner's largest group with `cell` removed
      const visited = new Array(AREA_MAX).fill(false);
      visited[cell] = true;
      let after = 0;
      for (let i = 1; i < AREA_MAX; i++) {
        if (!exists(i) || adat[i].arm !== owner || visited[i]) continue;
        const stack = [i];
        visited[i] = true;
        let size = 0;
        while (stack.length > 0) {
          const cur = stack.pop();
          size += 1;
          const { join } = adat[cur];
          for (let j = 1; j < AREA_MAX; j++) {
            if (join[j] && !visited[j] && exists(j) && adat[j].arm === owner) {
              visited[j] = true;
              stack.push(j);
            }
          }
        }
        if (size > after) after = size;
      }
      loss = before - after;
    }
    incomeLossCache.set(cell, loss);
    return loss;
  };

  /**
   * Probability that at least one enemy adjacent to `cell` could take it
   * when it holds `dice` dice (complement product over all threats).
   * `friendlyOverride` treats that area as mine (the cell I am capturing).
   */
  const captureThreat = (cell, dice, friendlyOverride) => {
    let survive = 1;
    const { join } = adat[cell];
    for (let j = 1; j < AREA_MAX; j++) {
      if (!join[j] || !exists(j) || j === friendlyOverride) continue;
      const enemy = adat[j];
      if (enemy.arm === pn || enemy.dice <= 1) continue;
      survive *= 1 - WIN_TABLE[Math.min(enemy.dice, MAX_DICE)][Math.min(dice, MAX_DICE)];
    }
    return 1 - survive;
  };

  // --- Strategic posture ---
  let dominantPlayer = -1;
  for (let i = 0; i < 8; i++) {
    if (diceByPlayer[i] > totalDice * DOMINANCE_SHARE) {
      dominantPlayer = i;
      break;
    }
  }
  const activePlayers = areasByPlayer.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);
  const myShare = totalDice > 0 ? diceByPlayer[pn] / totalDice : 0;
  const bestRivalDice = Math.max(...diceByPlayer.map((d, i) => (i === pn ? 0 : d)));

  let threshold = BASE_THRESHOLD;
  if (myShare > 0.38 || (activePlayers === 2 && diceByPlayer[pn] > bestRivalDice)) {
    // Winning position: keep the pressure on rather than stalling
    threshold = PRESS_THRESHOLD;
  } else if (myShare < 0.15 && activePlayers > 2) {
    // Weak position: only take clearly profitable fights
    threshold = BASE_THRESHOLD + 0.15;
  }

  // Reinforcements arriving at end of turn soften end-of-turn exposure
  const stock = game.player[pn] ? game.player[pn].stock || 0 : 0;
  const riskRelief = 1 / (1 + 0.04 * Math.min(stock, 16));

  // --- Evaluate every legal attack ---
  let bestFrom = -1;
  let bestTo = -1;
  let bestScore = -Infinity;

  for (let from = 1; from < AREA_MAX; from++) {
    if (!exists(from)) continue;
    const attacker = adat[from];
    if (attacker.arm !== pn || attacker.dice <= 1) continue;

    for (let to = 1; to < AREA_MAX; to++) {
      if (!attacker.join[to] || !exists(to)) continue;
      const defender = adat[to];
      if (defender.arm === pn) continue;

      const a = attacker.dice;
      const d = defender.dice;
      const p = WIN_TABLE[Math.min(a, MAX_DICE)][Math.min(d, MAX_DICE)];

      // Gains if the attack lands
      let gains =
        TERRITORY_VALUE +
        INCOME_WEIGHT * (myIncomeGain(to) + incomeLossIfCaptured(to)) +
        DESTROY_WEIGHT * d;
      if (areasByPlayer[defender.arm] === 1) gains += ELIMINATION_BONUS;

      // Anti-runaway: focus a dominant leader, don't soften minor players
      if (dominantPlayer >= 0 && dominantPlayer !== pn) {
        if (defender.arm === dominantPlayer) gains += GANG_UP_BONUS;
        else gains -= OFF_TARGET_PENALTY;
      }

      /*
       * Discount gains by the chance the conquered cell is retaken (it will
       * hold a-1 dice), and charge for leaving the source cell at 1 die —
       * including the income I lose if a chokepoint source then falls.
       */
      const fromStake = EXPOSURE_WEIGHT + INCOME_WEIGHT * 0.5 * incomeLossIfCaptured(from);
      const recaptureP = captureThreat(to, Math.max(1, a - 1), from) * riskRelief;
      const exposureWin = captureThreat(from, 1, to) * riskRelief;
      const exposureLoss = captureThreat(from, 1, -1) * riskRelief;

      const winValue = gains * (1 - HOLD_DISCOUNT * recaptureP) - fromStake * exposureWin;
      const lossCost = LOSS_WEIGHT * (a - 1) + fromStake * exposureLoss;

      const score = p * winValue - (1 - p) * lossCost;

      if (score > bestScore) {
        bestScore = score;
        bestFrom = from;
        bestTo = to;
      }
    }
  }

  if (bestFrom === -1 || bestScore <= threshold) return 0;

  game.area_from = bestFrom;
  game.area_to = bestTo;
};
