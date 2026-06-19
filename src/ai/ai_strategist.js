/**
 * Strategist — expected-value strategy built on exact battle probabilities
 * and the economics of connectivity.
 *
 * Authored by Claude Opus 4.8.
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
 * Bank-aware endgame aggression breaks all-8s stalemates. The cost of losing an
 * attack — burned dice and a weakened source — is largely an illusion when the
 * player holds a reinforcement reserve, because that reserve plus its income
 * refills the holes at the end of the same turn, before any opponent can act. So
 * once the field narrows to a few players, an attack's refundable cost is
 * discounted by how completely the reserve will patch it, and a player trailing
 * the leader with a real reserve will spend it chipping the leader down rather
 * than turtling into a slow loss. (Kept to the endgame on purpose: with many
 * players alive, patient play is stronger and the arena confirms it.)
 *
 * Fully deterministic: no randomness; ties break toward the lowest area index.
 */

/*
 * Exact battle odds live in one shared module. Re-exported here because tests
 * and tooling import winProbability from this strategy.
 */
import { MAX_DICE, WIN_TABLE, winProbability } from './diceOdds.js';
import { getPlayerCount } from './playerCount.js';

export { winProbability };

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

// --- Bank-aware aggression & trailing-leader disruption ---
const ENDGAME_PLAYERS = 3; // unlock bank-aware aggression only once the field narrows to this many
const REFILL_EFFICIENCY = 0.85; // fraction of an attack's refundable cost the reserve neutralizes
const DISRUPT_MIN_BANK = MAX_DICE; // banked dice before gunning for the leader at a loss (~one full stack)
const DISRUPT_MIN_P = 0.4; // only swing at the leader on coin-flip-or-better odds (8v8 = 0.471)
const DISRUPT_BONUS = 0.6; // extra pull toward the leader when trailing with a reserve to spend
const DISRUPT_THRESHOLD = -0.8; // accept a moderately negative swing at the leader to break a stalemate

export const ai_strategist = game => {
  const pn = game.get_pn();
  const { adat, AREA_MAX } = game;

  const exists = i => {
    const area = adat[i];
    return area !== undefined && area !== null && area.size !== 0;
  };

  // --- Board census ---
  const pmax = getPlayerCount(game);
  const diceByPlayer = new Array(pmax).fill(0);
  const areasByPlayer = new Array(pmax).fill(0);
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
  for (let i = 0; i < pmax; i++) {
    if (diceByPlayer[i] > totalDice * DOMINANCE_SHARE) {
      dominantPlayer = i;
      break;
    }
  }
  const activePlayers = areasByPlayer.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);
  const myShare = totalDice > 0 ? diceByPlayer[pn] / totalDice : 0;
  const bestRivalDice = Math.max(...diceByPlayer.map((d, i) => (i === pn ? 0 : d)));

  // Strongest rival by dice — the "leader" for anti-runaway and trailing disruption.
  let leader = -1;
  let leaderDice = -1;
  for (let i = 0; i < pmax; i++) {
    if (i !== pn && areasByPlayer[i] > 0 && diceByPlayer[i] > leaderDice) {
      leaderDice = diceByPlayer[i];
      leader = i;
    }
  }

  let threshold = BASE_THRESHOLD;
  if (myShare > 0.38 || (activePlayers === 2 && diceByPlayer[pn] > bestRivalDice)) {
    // Winning position: keep the pressure on rather than stalling
    threshold = PRESS_THRESHOLD;
  } else if (myShare < 0.15 && activePlayers > 2) {
    // Weak position: only take clearly profitable fights
    threshold = BASE_THRESHOLD + 0.15;
  }

  /*
   * Bank-aware aggression. `stock` is the player's banked reinforcements; each
   * end of turn it also earns income equal to its largest connected group. Both
   * pour into the player's non-maxed cells at the END of this turn — before any
   * opponent moves — so the holes an attack opens (a weakened source, a freshly
   * taken cell) are largely refilled before they can be punished. A player
   * sitting on a full board with a big reserve is effectively wasting income
   * every turn it does not attack (the reserve caps out), which is exactly what
   * freezes an all-8s board into a turtling stalemate.
   */
  const stock = game.player[pn] ? game.player[pn].stock || 0 : 0;
  const refillPool = stock + myLargestGroup;
  let myVacancy = 0;
  for (let i = 1; i < AREA_MAX; i++) {
    if (exists(i) && adat[i].arm === pn) myVacancy += MAX_DICE - adat[i].dice;
  }
  /*
   * Only relax into bank-aware aggression in the endgame. With many players
   * still alive, patient play is genuinely strong — let rivals spend themselves
   * fighting. Once the field narrows, turtling at all-8s just hands a slow win to
   * the leader, so this is where spending the reserve to break the stalemate (and
   * to chip the leader) pays off. ENDGAME_PLAYERS gates both behaviors.
   */
  const endgame = activePlayers <= ENDGAME_PLAYERS;
  const iAmTrailing = leader >= 0 && leaderDice > diceByPlayer[pn];
  const disruptActive = endgame && iAmTrailing && stock >= DISRUPT_MIN_BANK;

  // --- Evaluate every legal attack ---
  let bestFrom = -1;
  let bestTo = -1;
  let bestScore = -Infinity;
  // Best coin-flip-or-better swing aimed at the leader (the disruption fallback).
  let bestLeaderFrom = -1;
  let bestLeaderTo = -1;
  let bestLeaderScore = -Infinity;

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
      // Trailing the leader with a reserve: extra pull toward chipping it down.
      if (disruptActive && defender.arm === leader) gains += DISRUPT_BONUS;

      /*
       * Refill discount: the fraction of the holes this attack opens that my
       * reserve + income will patch this end of turn, before opponents act.
       * `myVacancy` already reflects holes opened by earlier attacks this turn,
       * so the discount fades as I spend down — I press while banked, then
       * fortify once the reserve can no longer cover another swing.
       */
      const refillFactor =
        !endgame || refillPool <= 0
          ? 0
          : Math.min(1, refillPool / Math.max(1, myVacancy + (a - 1)));
      const refund = REFILL_EFFICIENCY * refillFactor;

      /*
       * Discount gains by the chance the conquered cell is retaken — but it is
       * topped back up toward MAX_DICE by the refill before opponents move — and
       * charge for leaving the source at 1 die (plus the income lost if a
       * chokepoint source falls), net of the refill that patches it first.
       */
      const fromStake = EXPOSURE_WEIGHT + INCOME_WEIGHT * 0.5 * incomeLossIfCaptured(from);
      const heldDice = Math.round(a - 1 + refund * (MAX_DICE - (a - 1)));
      const recaptureP = captureThreat(to, Math.max(1, heldDice), from);
      const exposureWin = captureThreat(from, 1, to) * (1 - refund);
      const exposureLoss = captureThreat(from, 1, -1) * (1 - refund);

      const winValue = gains * (1 - HOLD_DISCOUNT * recaptureP) - fromStake * exposureWin;
      // Dice burned on a failed attack are refilled from the reserve next turn.
      const lossCost = LOSS_WEIGHT * (a - 1) * (1 - refund) + fromStake * exposureLoss;

      const score = p * winValue - (1 - p) * lossCost;

      if (score > bestScore) {
        bestScore = score;
        bestFrom = from;
        bestTo = to;
      }
      if (
        disruptActive &&
        defender.arm === leader &&
        p >= DISRUPT_MIN_P &&
        score > bestLeaderScore
      ) {
        bestLeaderScore = score;
        bestLeaderFrom = from;
        bestLeaderTo = to;
      }
    }
  }

  if (bestFrom !== -1 && bestScore > threshold) {
    game.area_from = bestFrom;
    game.area_to = bestTo;
    return;
  }

  /*
   * Stuck behind the leader but holding a reserve: rather than turtling into a
   * slow loss, take the best even-odds-or-better swing at the leader. The refill
   * discount keeps these swings cheap precisely because the reserve patches the
   * holes they open before the leader can exploit them.
   */
  if (disruptActive && bestLeaderFrom !== -1 && bestLeaderScore > DISRUPT_THRESHOLD) {
    game.area_from = bestLeaderFrom;
    game.area_to = bestLeaderTo;
    return;
  }

  return 0;
};
