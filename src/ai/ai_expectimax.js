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
 * turn) up to `searchDepth` plies (DEFAULT_PARAMS.searchDepth). This lets it plan combos a greedy scorer
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
 * NOTE: the parameters below were tuned against `npm run arena:sweep` vs
 * ai_strategist in the ml-bot Phase 0 sweep (see docs/ml-bot/RESULTS.md). Tuning
 * `attackThreshold` (patience) and `threat` (exposure-aversion) lifted this bot
 * from the worst "smart" bot to Strategist-class: a significant ELO / head-to-head
 * placement edge, though Strategist still converts more games to outright wins.
 * Beating Strategist on win% (and chasing Lookahead) needs a *press-when-ahead*
 * mechanism — a posture-adaptive threshold — which a single fixed `attackThreshold`
 * cannot express; that is the next structural lever, not a weight to tune.
 */

import { MAX_DICE, WIN_TABLE } from './diceOdds.js';
import { getPlayerCount } from './playerCount.js';

/**
 * Default tunable parameters: search shape + evaluation weights.
 *
 * Exposed (with the `makeExpectimax` factory below) so these can be swept
 * against `npm run arena:sweep` without forking the search code — the shipped
 * `ai_expectimax` is just `makeExpectimax()` with these defaults. To "land" a
 * tuned configuration, change the values here. See docs/ml-bot/RESULTS.md.
 *
 * Weights are in dice-equivalent units, aligned with ai_strategist.
 */
export const DEFAULT_PARAMS = {
  // --- Search shape ---
  searchDepth: 2, // plies of attack lookahead within the turn
  topK: 6, // attacks recursed into per internal node (depth > 1); leaves score all
  attackThreshold: 0.3, // best attack must beat stopping by at least this EV (Phase-0 tuned: 0.05 → 0.3 for patience)
  // --- Evaluation weights ---
  income: 1.1, // value of +1 reinforcement/turn = +1 to largest group
  territory: 1.0, // value of holding one more territory
  dice: 0.5, // value per die I own; also the cost of dice burned on a loss
  threat: 2.0, // cost of border cells an enemy can plausibly take (Phase-0 tuned: 0.45 → 2.0 vs over-extension)
  rivalIncome: 0.5, // value of suppressing the strongest rival's income
  activeRival: 0.4, // value of every rival eliminated from the board
};

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
function evaluateBoard(owner, dice, alive, adj, areaMax, me, pmax, P) {
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
    P.income * largest[me] +
    P.territory * territory[me] +
    P.dice * diceTotal[me] -
    P.threat * vulnerability -
    P.rivalIncome * bestRivalIncome -
    P.activeRival * activeRivals
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
 * nodes (depth > 1) recurse into only the top-K attacks (P.topK) ranked by their one-ply
 * EV, bounding the branching of the otherwise quadratic-per-ply search; leaf
 * nodes (depth === 1) score every attack by that one-ply EV without recursing.
 */
function search(owner, dice, alive, adj, areaMax, me, pmax, depth, P) {
  const stopValue = evaluateBoard(owner, dice, alive, adj, areaMax, me, pmax, P);
  if (depth <= 0) return { value: stopValue, from: -1, to: -1 };

  const moves = enumerateAttacks(owner, dice, alive, adj, areaMax, me);
  if (moves.length === 0) return { value: stopValue, from: -1, to: -1 };

  // One-ply EV of each attack: weight the two outcome positions by the odds.
  for (const m of moves) {
    const vWin = evaluateBoard(m.winOwner, m.winDice, alive, adj, areaMax, me, pmax, P);
    const vLoss = evaluateBoard(owner, m.lossDice, alive, adj, areaMax, me, pmax, P);
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
    candidates = moves.slice(0, P.topK);
    for (const m of candidates) {
      const win = search(m.winOwner, m.winDice, alive, adj, areaMax, me, pmax, depth - 1, P);
      const loss = search(owner, m.lossDice, alive, adj, areaMax, me, pmax, depth - 1, P);
      m.value = m.p * win.value + (1 - m.p) * loss.value;
    }
  }

  // Deterministic best: highest value, then lowest from, then lowest to.
  candidates.sort((x, y) => y.value - x.value || x.from - y.from || x.to - y.to);
  const best = candidates[0];

  if (best.value > stopValue + P.attackThreshold) {
    return { value: best.value, from: best.from, to: best.to };
  }
  return { value: stopValue, from: -1, to: -1 };
}

/**
 * Build an Expectimax bot (legacy convention) with a given tunable config.
 *
 * The returned function reads the mutable game view, sets `game.area_from` /
 * `game.area_to` for the chosen attack, and returns 0 to end the turn when
 * stopping is best. Unspecified params fall back to `DEFAULT_PARAMS`, so
 * `makeExpectimax()` reproduces the shipped bot exactly. Used by the arena
 * weight-tuning sweeps (docs/ml-bot/) without forking the search code.
 *
 * @param {Partial<typeof DEFAULT_PARAMS>} [params] - Search/eval overrides.
 * @returns {(game: Object) => 0|undefined} A legacy-convention bot function.
 */
export function makeExpectimax(params = {}) {
  /*
   * Fail fast on bad config: these are fed externally-sourced JSON by the tuning
   * sweeps (scripts/_tune.mjs), where a typo'd key would otherwise be silently
   * dropped — the sweep would "succeed" while re-testing the defaults, the worst
   * failure mode for a tuning tool. A non-finite weight (NaN/Infinity) likewise
   * silently makes every eval NaN and the bot stop on every board.
   */
  for (const key of Object.keys(params)) {
    if (!(key in DEFAULT_PARAMS)) {
      throw new Error(
        `makeExpectimax: unknown param "${key}" (expected one of: ${Object.keys(DEFAULT_PARAMS).join(', ')})`
      );
    }
    if (!Number.isFinite(params[key])) {
      throw new Error(
        `makeExpectimax: param "${key}" must be a finite number (got ${params[key]})`
      );
    }
  }
  const P = { ...DEFAULT_PARAMS, ...params };

  return game => {
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

    const best = search(owner, dice, alive, adj, AREA_MAX, me, pmax, P.searchDepth, P);
    if (best.from === -1) return 0;

    game.area_from = best.from;
    game.area_to = best.to;
    return undefined;
  };
}

/**
 * Expectimax AI entry point (legacy convention), built with `DEFAULT_PARAMS`.
 */
export const ai_expectimax = makeExpectimax();
