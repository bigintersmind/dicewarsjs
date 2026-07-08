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
 * Decision policy — the structural press-mechanism (ml-bot D-8). Phase-0 weight
 * tuning lifted this bot to Strategist-class on ELO/placement but hit a ceiling
 * on outright win%: a single *fixed* attack threshold cannot both stay patient in
 * a crowd (avoid over-extension) and press to close out a won game. The fix,
 * mirroring what makes `ai_lookahead` the field leader, is two structural terms:
 *
 *   1. A *posture-adaptive* attack threshold (`postureThreshold`) — an inverted-U
 *      (∩) bar that PRESSES (accepts slightly-negative-EV captures) when dominant,
 *      claws back at a low bar when weak in a crowd, and holds a steep patient BASE
 *      bar in the common balanced case.
 *   2. A strengthened *elimination term* (`activeRival`) — a per-rival penalty in
 *      the board eval, so a capture that removes a rival scores higher on its win
 *      branch; through the chance-node search that becomes an implicitly
 *      win-probability-weighted bonus, pushing the bot to finish players off rather
 *      than stall on a winning board.
 *
 * These parameters were tuned against `npm run arena:sweep` (see
 * docs/ml-bot/RESULTS.md); the gate is `ai_lookahead` (D-7), with `ai_strategist`
 * as a secondary reference.
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
  /*
   * --- Decision policy: posture-adaptive attack threshold (the D-8 press-mechanism) ---
   * A single fixed bar can't both stay patient in a crowd and press to close out a
   * won game (docs/ml-bot DECISIONS D-8), so the bar adapts to my board posture,
   * forming an inverted U (∩): a high (patient) bar in the middle, low (decisive)
   * bars at both strength extremes.
   */
  attackThreshold: null, // fixed EV bar override; null ⇒ posture-adaptive (base/press/weak below)
  baseThreshold: 1.2, // balanced game (the common case): steep bar — only clearly profitable captures (D-9 tuned)
  pressThreshold: -2.5, // dominant / winning duel: spend the advantage hard to close the game out (D-9 tuned)
  closeoutThreshold: -8.0, // clearly winning (strict territory lead + dominant share or ≤3 alive): admit the maxed frontier's near-even full-stack swings that even pressThreshold rejects (a risk-penalized 8v8 ≈ -3) — issue #115. Finite on purpose: a truly suicidal only-move is still declined.
  weakThreshold: 0.15, // losing badly in a crowd: still take near-even fights to claw back
  pressDiceShare: 0.38, // dice share above which (strict >) I'm dominant enough to press
  weakDiceShare: 0.15, // dice share below which (in a crowd) I'm weak enough to claw back
  // --- Evaluation weights ---
  income: 1.1, // value of +1 reinforcement/turn = +1 to largest group
  territory: 1.0, // value of holding one more territory
  dice: 0.5, // value per die I own; also the cost of dice burned on a loss
  threat: 2.0, // cost of border cells an enemy can plausibly take (Phase-0 tuned: 0.45 → 2.0 vs over-extension)
  rivalIncome: 0.5, // value of suppressing the strongest rival's income
  activeRival: 2.0, // elimination term: per-rival board-eval penalty → an eliminating capture's win branch scores higher (implicitly winChance-weighted via the search)
  /*
   * --- Risk floor (mirrors ai_lookahead's LOW_ODDS_PENALTY) ---
   * Pure expectimax under-penalizes variance in a 7-way elimination game: an
   * EV-neutral coin-flip is actually bad, because losing the dice/position exposes
   * me to the *other* five rivals, not just the one I attacked. This adds an
   * explicit penalty on committing to a low-odds attack, on top of the EV math, so
   * the bot only gambles when the upside clearly justifies it. `lowOddsPenalty: 0`
   * disables it (pure expectimax).
   */
  lowOddsFloor: 0.78, // win-prob below which an attack is penalized (D-9 tuned)
  lowOddsPenalty: 5.0, // penalty per unit of win-prob below the floor (D-9 tuned)
};

const clampDie = n => (n > MAX_DICE ? MAX_DICE : n);

/**
 * Posture-adaptive attack threshold — the EV a candidate attack must beat the
 * stop value by before the bot commits. This is the D-8 press-mechanism a single
 * fixed threshold cannot express.
 *
 * The bar forms an inverted U (∩) over my strength: when I'm dominant (high dice
 * share, or ahead in a heads-up duel) I PRESS — accepting even slightly-negative-EV
 * captures to close the game out; when I'm weak in a crowd I claw back at a low
 * bar; in the common balanced case I hold the steep BASE bar and only spend dice
 * on clearly profitable captures. Mirrors ai_lookahead's posture logic — the
 * mechanism that makes it the field leader.
 * A fourth CLOSEOUT tier (issue #115) sits above PRESS: a strict territory
 * lead plus dominant share (or a ≤3-player field) drops the bar to
 * closeoutThreshold, admitting the near-even full-stack swings a maxed
 * winning frontier offers — the case PRESS's -2.5 still rejected.
 *
 * Computed once from the real root board (posture is a turn-level property) and
 * threaded unchanged into every recursive `search` node, so the bot's stance can't
 * flip mid-turn. That means the bar gates not just the root commit decision but the
 * value each interior node reports up: positions are valued under the bot's own
 * threshold-gated policy (what it will *actually* do — stop when attacks don't clear
 * the bar), not under a neutral max that assumes a greedy future self. Caveat — this
 * freezes the *root* posture onto deeper boards whose own posture could differ;
 * negligible at the shipped searchDepth: 2 (a board one ply out rarely flips
 * bucket), but the lever to revisit (recurse the interior with a neutral 0 bar)
 * should searchDepth grow. See docs/ml-bot/DECISIONS.md D-10.
 */
function postureThreshold(diceByPlayer, areasByPlayer, me, pmax, P) {
  let totalDice = 0;
  let activeRivals = 0;
  let bestRivalDice = 0;
  let bestRivalAreas = 0;
  for (let pl = 0; pl < pmax; pl++) {
    totalDice += diceByPlayer[pl];
    if (pl === me) continue;
    if (areasByPlayer[pl] > 0) activeRivals += 1;
    if (diceByPlayer[pl] > bestRivalDice) bestRivalDice = diceByPlayer[pl];
    if (areasByPlayer[pl] > bestRivalAreas) bestRivalAreas = areasByPlayer[pl];
  }
  const myShare = totalDice > 0 ? diceByPlayer[me] / totalDice : 0;

  /*
   * Clearly winning — strict territory lead AND (dominant dice share OR the
   * field narrowed to ≤3 alive) → the closeout bar, ABOVE press in precedence.
   * PRESS is not enough here: on a maxed frontier every candidate is a
   * risk-penalized ~8v8 (≈ -3 vs stopping), which even pressThreshold rejects,
   * freezing won games into turn-cap stalemates (issue #115).
   */
  if (areasByPlayer[me] > bestRivalAreas && (myShare > P.pressDiceShare || activeRivals <= 2)) {
    return P.closeoutThreshold;
  }
  // Dominant, or ahead in a heads-up endgame → press to finish.
  if (myShare > P.pressDiceShare || (activeRivals === 1 && diceByPlayer[me] > bestRivalDice)) {
    return P.pressThreshold;
  }
  // Weak in a crowd → low bar to claw back.
  if (myShare < P.weakDiceShare && activeRivals > 1) {
    return P.weakThreshold;
  }
  // Balanced → patient.
  return P.baseThreshold;
}

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
 *
 * `threshold` is the EV the best attack must beat stopping by before it is
 * committed (otherwise the node stops). The caller passes the posture-adaptive
 * bar (`postureThreshold`), or a fixed override — see `makeExpectimax`. The same
 * bar gates every node, not just the root: inside the recursion it shapes the value
 * each node reports up, so positions are valued under the bot's own threshold-gated
 * policy (deliberate — see `postureThreshold` and DECISIONS.md D-10). Each move's
 * value is also docked a risk-floor penalty for low win-probability (see
 * DEFAULT_PARAMS.lowOdds*), so the bot avoids variance-heavy gambles in a crowd.
 */
function search(owner, dice, alive, adj, areaMax, me, pmax, depth, P, threshold) {
  const stopValue = evaluateBoard(owner, dice, alive, adj, areaMax, me, pmax, P);
  if (depth <= 0) return { value: stopValue, from: -1, to: -1 };

  const moves = enumerateAttacks(owner, dice, alive, adj, areaMax, me);
  if (moves.length === 0) return { value: stopValue, from: -1, to: -1 };

  /*
   * One-ply EV of each attack: weight the two outcome positions by the odds, less
   * an explicit risk floor that penalizes committing to a low-odds attack. The
   * penalty keys off each candidate attack's *own* win-prob (`m.p`); deeper plies
   * are floored too, inside their recursive value below, just probability-discounted
   * by the odds of reaching them (see DEFAULT_PARAMS.lowOdds*).
   */
  for (const m of moves) {
    const vWin = evaluateBoard(m.winOwner, m.winDice, alive, adj, areaMax, me, pmax, P);
    const vLoss = evaluateBoard(owner, m.lossDice, alive, adj, areaMax, me, pmax, P);
    m.immediate = m.p * vWin + (1 - m.p) * vLoss;
    m.lowOdds = P.lowOddsPenalty > 0 ? Math.max(0, P.lowOddsFloor - m.p) * P.lowOddsPenalty : 0;
    m.riskAdjEV = m.immediate - m.lowOdds; // one-ply EV net of the risk floor
  }

  let candidates;
  if (depth === 1) {
    // Leaf decision: the one-ply EV (net of the risk floor) is the value.
    for (const m of moves) m.value = m.riskAdjEV;
    candidates = moves;
  } else {
    // Expand only the most promising attacks one ply deeper (by risk-adjusted EV).
    moves.sort((x, y) => y.riskAdjEV - x.riskAdjEV || x.from - y.from || x.to - y.to);
    candidates = moves.slice(0, P.topK);
    for (const m of candidates) {
      const win = search(
        m.winOwner,
        m.winDice,
        alive,
        adj,
        areaMax,
        me,
        pmax,
        depth - 1,
        P,
        threshold
      );
      const loss = search(
        owner,
        m.lossDice,
        alive,
        adj,
        areaMax,
        me,
        pmax,
        depth - 1,
        P,
        threshold
      );
      m.value = m.p * win.value + (1 - m.p) * loss.value - m.lowOdds;
    }
  }

  // Deterministic best: highest value, then lowest from, then lowest to.
  candidates.sort((x, y) => y.value - x.value || x.from - y.from || x.to - y.to);
  const best = candidates[0];

  if (best.value > stopValue + threshold) {
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
    /*
     * `attackThreshold` may be null — the sentinel that selects the posture-adaptive
     * bar (base/press/weak). Every other param, and a non-null attackThreshold, must
     * be a finite number.
     */
    if (key === 'attackThreshold' && params[key] === null) continue;
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
     * The per-player dice/area census is gathered in the same pass to choose the
     * posture-adaptive attack threshold (see postureThreshold).
     */
    const alive = new Array(AREA_MAX).fill(false);
    const owner = new Array(AREA_MAX).fill(-1);
    const dice = new Array(AREA_MAX).fill(0);
    const adj = new Array(AREA_MAX);
    const diceByPlayer = new Array(pmax).fill(0);
    const areasByPlayer = new Array(pmax).fill(0);
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
      diceByPlayer[area.arm] += area.dice;
      areasByPlayer[area.arm] += 1;
      if (area.arm === me) myTerritories += 1;
      const list = [];
      const { join } = area;
      for (let j = 1; j < AREA_MAX; j++) {
        if (join[j] && adat[j] && adat[j].size !== 0) list.push(j);
      }
      adj[i] = list;
    }

    if (myTerritories === 0) return 0;

    // Posture-adaptive bar (D-8 press-mechanism), unless a fixed override is set.
    const threshold =
      P.attackThreshold != null
        ? P.attackThreshold
        : postureThreshold(diceByPlayer, areasByPlayer, me, pmax, P);

    const best = search(owner, dice, alive, adj, AREA_MAX, me, pmax, P.searchDepth, P, threshold);
    /*
     * A non-finite search value means a weight NaN-poisoned the eval — a degenerate
     * config the construction-time guard somehow let through. Throw loudly rather
     * than let the legacy adapter swallow it and silently "stop on every board", the
     * worst failure mode for a tuning sweep.
     */
    if (!Number.isFinite(best.value)) {
      throw new Error(
        `makeExpectimax: non-finite search value (${best.value}) — degenerate config?`
      );
    }
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
