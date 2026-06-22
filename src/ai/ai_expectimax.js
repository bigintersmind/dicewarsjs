/**
 * Expectimax — chance-node search over the exact battle distribution.
 *
 * Authored as the "search-first" baseline of the ML-bot initiative
 * (see docs/ml-bot/). Where ai_strategist scores each candidate attack with a
 * one-ply heuristic EV, this bot performs a genuine chance-node expectimax: it
 * applies each attack's two real outcomes (win / loss) to copies of the board,
 * scores the *resulting positions* with a positional evaluation, and weights
 * them by the exact win probability:
 *
 *   EV(attack) = P(win) * search(boardAfterWin) + P(loss) * search(boardAfterLoss)
 *
 * A Dice Wars turn is a *sequence* of single attacks ended by stopping, so the
 * search recurses on both outcome boards (a failed attack does not end the
 * turn) up to SEARCH_DEPTH plies. This lets it plan combos a greedy scorer
 * misses — e.g. take a low-EV cell now because it unlocks a high-value capture
 * next. Opponent replies (which only happen after the turn ends) are proxied by
 * the evaluation's border-vulnerability and rival-income terms.
 *
 * The bot is re-invoked once per attack decision, so it only commits the first
 * move of the best plan and re-searches on the next call.
 *
 * Fully deterministic: no randomness; ties break toward the lowest area index
 * (sort by score, then `from`, then `to`).
 *
 * NOTE: the evaluation weights below are a principled first pass aligned with
 * ai_strategist's units. They are meant to be tuned against
 * `npm run arena:sweep` vs the current ai_strategist (see docs/ml-bot/RESULTS.md).
 */

import { MAX_DICE, WIN_TABLE } from './diceOdds.js';
import { getPlayerCount } from './playerCount.js';

// --- Search shape ---
const SEARCH_DEPTH = 2; // plies of attack lookahead within the turn
const TOP_K = 6; // attacks recursed into per internal node (depth > 1); leaves score all
const ATTACK_THRESHOLD = 0.05; // best attack must beat stopping by at least this EV

// --- Evaluation weights (dice-equivalent units, aligned with ai_strategist) ---
const INCOME_WEIGHT = 1.1; // value of +1 reinforcement/turn = +1 to largest group
const TERRITORY_VALUE = 1.0; // value of holding one more territory
const DICE_WEIGHT = 0.5; // value per die I own; also the cost of dice burned on a loss
const THREAT_WEIGHT = 0.45; // cost of border cells an enemy can plausibly take
const RIVAL_INCOME_WEIGHT = 0.5; // value of suppressing the strongest rival's income
const ACTIVE_RIVAL_WEIGHT = 0.4; // value of every rival eliminated from the board

const clampDie = n => (n > MAX_DICE ? MAX_DICE : n);

/**
 * Positional value of a board for `me`, in dice-equivalent units.
 *
 * Captures the same economics ai_strategist optimizes: reinforcement income is
 * the size of my largest connected group (the real currency), plus territory
 * count and striking dice, minus the exposure of takeable border cells and the
 * income/standing of my strongest surviving rival.
 *
 * Ownership and dice come from the (mutated) `owner`/`dice` arrays; `alive` and
 * `adj` are static across a search (capturing changes ownership, not which
 * territories exist or how they connect).
 */
function evaluateBoard(owner, dice, alive, adj, areaMax, me, pmax) {
  const largest = new Array(pmax).fill(0);
  const territory = new Array(pmax).fill(0);
  const diceTotal = new Array(pmax).fill(0);

  for (let i = 1; i < areaMax; i++) {
    if (!alive[i]) continue;
    const o = owner[i];
    territory[o] += 1;
    diceTotal[o] += dice[i];
  }

  // Single all-owner connected-component pass → each player's largest group.
  const comp = new Array(areaMax).fill(false);
  for (let i = 1; i < areaMax; i++) {
    if (!alive[i] || comp[i]) continue;
    const o = owner[i];
    const stack = [i];
    comp[i] = true;
    let size = 0;
    while (stack.length > 0) {
      const cur = stack.pop();
      size += 1;
      const ns = adj[cur];
      for (let k = 0; k < ns.length; k++) {
        const j = ns[k];
        if (!comp[j] && owner[j] === o) {
          comp[j] = true;
          stack.push(j);
        }
      }
    }
    if (size > largest[o]) largest[o] = size;
  }

  /*
   * Exposure: for each of my border cells, the best chance an enemy neighbor
   * has of taking it. Rewards strong borders, punishes weak exposed cells.
   */
  let vulnerability = 0;
  for (let i = 1; i < areaMax; i++) {
    if (!alive[i] || owner[i] !== me) continue;
    const ns = adj[i];
    let worst = 0;
    const myDie = clampDie(dice[i]);
    for (let k = 0; k < ns.length; k++) {
      const j = ns[k];
      if (owner[j] === me) continue;
      const ed = dice[j];
      if (ed <= 1) continue;
      const p = WIN_TABLE[clampDie(ed)][myDie];
      if (p > worst) worst = p;
    }
    vulnerability += worst;
  }

  let bestRivalIncome = 0;
  let activeRivals = 0;
  for (let pl = 0; pl < pmax; pl++) {
    if (pl === me) continue;
    if (territory[pl] > 0) activeRivals += 1;
    if (largest[pl] > bestRivalIncome) bestRivalIncome = largest[pl];
  }

  return (
    INCOME_WEIGHT * largest[me] +
    TERRITORY_VALUE * territory[me] +
    DICE_WEIGHT * diceTotal[me] -
    THREAT_WEIGHT * vulnerability -
    RIVAL_INCOME_WEIGHT * bestRivalIncome -
    ACTIVE_RIVAL_WEIGHT * activeRivals
  );
}

/**
 * Every legal attack `me` can make on this board, with the exact win
 * probability and both pre-built outcome boards cached for reuse.
 *
 * Win board: defender cell becomes mine with (a-1) dice, source drops to 1.
 * Loss board: only the source drops to 1 (ownership unchanged, so it shares the
 * caller's `owner` array — no copy needed).
 */
function enumerateAttacks(owner, dice, alive, adj, areaMax, me) {
  const moves = [];
  for (let from = 1; from < areaMax; from++) {
    if (!alive[from] || owner[from] !== me || dice[from] <= 1) continue;
    const a = dice[from];
    const ns = adj[from];
    for (let k = 0; k < ns.length; k++) {
      const to = ns[k];
      if (owner[to] === me) continue;
      const p = WIN_TABLE[clampDie(a)][clampDie(dice[to])];

      const winOwner = owner.slice();
      const winDice = dice.slice();
      winOwner[to] = me;
      winDice[to] = a - 1;
      winDice[from] = 1;

      const lossDice = dice.slice();
      lossDice[from] = 1;

      moves.push({ from, to, p, winOwner, winDice, lossDice });
    }
  }
  return moves;
}

/**
 * Chance-node expectimax. Returns the best continuation value for `me` from
 * this board and the first attack that achieves it (`from === -1` ⇒ stop).
 *
 * At every node `me` may stop (value = evaluateBoard) or attack; each attack is
 * a chance node mixing its win/loss continuations by the exact odds. Internal
 * nodes (depth > 1) recurse into only the TOP_K attacks ranked by their one-ply
 * EV, bounding the branching of the otherwise quadratic-per-ply search; leaf
 * nodes (depth === 1) score every attack by that one-ply EV without recursing.
 */
function search(owner, dice, alive, adj, areaMax, me, pmax, depth) {
  const stopValue = evaluateBoard(owner, dice, alive, adj, areaMax, me, pmax);
  if (depth <= 0) return { value: stopValue, from: -1, to: -1 };

  const moves = enumerateAttacks(owner, dice, alive, adj, areaMax, me);
  if (moves.length === 0) return { value: stopValue, from: -1, to: -1 };

  // One-ply EV of each attack: weight the two outcome positions by the odds.
  for (const m of moves) {
    const vWin = evaluateBoard(m.winOwner, m.winDice, alive, adj, areaMax, me, pmax);
    const vLoss = evaluateBoard(owner, m.lossDice, alive, adj, areaMax, me, pmax);
    m.immediate = m.p * vWin + (1 - m.p) * vLoss;
  }

  let candidates;
  if (depth === 1) {
    // Leaf decision: the one-ply EV is the value.
    for (const m of moves) m.value = m.immediate;
    candidates = moves;
  } else {
    // Expand only the most promising attacks one ply deeper.
    moves.sort((x, y) => y.immediate - x.immediate || x.from - y.from || x.to - y.to);
    candidates = moves.slice(0, TOP_K);
    for (const m of candidates) {
      const win = search(m.winOwner, m.winDice, alive, adj, areaMax, me, pmax, depth - 1);
      const loss = search(owner, m.lossDice, alive, adj, areaMax, me, pmax, depth - 1);
      m.value = m.p * win.value + (1 - m.p) * loss.value;
    }
  }

  // Deterministic best: highest value, then lowest from, then lowest to.
  candidates.sort((x, y) => y.value - x.value || x.from - y.from || x.to - y.to);
  const best = candidates[0];

  if (best.value > stopValue + ATTACK_THRESHOLD) {
    return { value: best.value, from: best.from, to: best.to };
  }
  return { value: stopValue, from: -1, to: -1 };
}

/**
 * Expectimax AI entry point (legacy convention): reads the mutable game view,
 * sets `game.area_from` / `game.area_to` for the chosen attack, and returns 0
 * to end the turn when stopping is best.
 *
 * @param {Object} game - Legacy game view (get_pn, adat[], AREA_MAX, ...).
 * @returns {0|undefined} 0 to end the turn; otherwise sets the attack in place.
 */
export const ai_expectimax = game => {
  const me = game.get_pn();
  const { adat, AREA_MAX } = game;
  const pmax = getPlayerCount(game);

  /*
   * Build a compact, search-friendly snapshot once: ownership, dice, liveness,
   * and adjacency restricted to live territories (all static under capture).
   */
  const alive = new Array(AREA_MAX).fill(false);
  const owner = new Array(AREA_MAX).fill(-1);
  const dice = new Array(AREA_MAX).fill(0);
  const adj = new Array(AREA_MAX);
  let myTerritories = 0;

  for (let i = 1; i < AREA_MAX; i++) {
    const area = adat[i];
    if (!area || area.size === 0) {
      adj[i] = [];
      continue;
    }
    alive[i] = true;
    owner[i] = area.arm;
    dice[i] = area.dice;
    if (area.arm === me) myTerritories += 1;
    const list = [];
    const { join } = area;
    for (let j = 1; j < AREA_MAX; j++) {
      if (join[j] && adat[j] && adat[j].size !== 0) list.push(j);
    }
    adj[i] = list;
  }

  if (myTerritories === 0) return 0;

  const best = search(owner, dice, alive, adj, AREA_MAX, me, pmax, SEARCH_DEPTH);
  if (best.from === -1) return 0;

  game.area_from = best.from;
  game.area_to = best.to;
  return undefined;
};
