/**
 * Group / Income Analysis over a sanitized BotState board
 *
 * Connected-component labeling and capture-consequence deltas computed from
 * `BotState.allAreas` (the bot-visible board), for the v3 observation encoding
 * ([D-31] in docs/ml-bot/DECISIONS.md) and any bot that wants connectivity
 * economics without reaching into engine internals.
 *
 * In DiceWars a player's reinforcement income each turn equals the size of
 * their largest connected territory group (`findLargestConnectedGroup` in
 * engine/TurnManager.js — the income-defining function whose semantics this
 * module must match). The two capture-consequence helpers answer the questions
 * a human reads off the board at a glance:
 *
 *   - `cutValueFor`   — how much income the current owner loses if this
 *     territory flips (nonzero only for territories in a largest group; large
 *     for the bridge of a long thin chain).
 *   - `myGainIfCaptured` — how much income I gain by taking this territory
 *     (merging every one of my adjacent components plus the captured node).
 *
 * The algorithms mirror ai_strategist.js's `labelComponents` /
 * `incomeLossIfCaptured` / `myIncomeGain` (same math on the legacy adjacency
 * matrix); this module is their BotState-native (`area.neighbors`) counterpart.
 *
 * All functions are pure and never mutate the areas they are given.
 *
 * @module arena/groupIncome
 */

/**
 * Connected-component analysis of the whole board, all owners at once.
 *
 * @typedef {Object} GroupAnalysis
 * @property {Map<number, import('./types.js').BotArea>} areaById - present areas by id
 * @property {Map<number, number>} compIndexById - area id → component index
 * @property {number[]} compSizes - component index → component size
 * @property {Map<number, number>} largestByOwner - owner → largest component size
 */

/**
 * Label the connected same-owner components of a BotState board in one pass.
 *
 * Neighbors that are absent from `allAreas` are ignored (the sanitizer already
 * filters them, but stay safe — mirroring encodeObservation's neighborStats).
 *
 * @param {readonly import('./types.js').BotArea[]} allAreas - present areas (BotState.allAreas)
 * @returns {GroupAnalysis}
 */
export function computeGroups(allAreas) {
  const areaById = new Map(allAreas.map(a => [a.id, a]));
  const compIndexById = new Map();
  const compSizes = [];
  const largestByOwner = new Map();

  for (const seed of allAreas) {
    if (compIndexById.has(seed.id)) continue;
    const comp = compSizes.length;
    const { owner } = seed;
    let size = 0;
    const stack = [seed.id];
    compIndexById.set(seed.id, comp);
    while (stack.length > 0) {
      const cur = areaById.get(stack.pop());
      size += 1;
      for (const adjId of cur.neighbors) {
        if (compIndexById.has(adjId)) continue;
        const adj = areaById.get(adjId);
        if (!adj || adj.owner !== owner) continue;
        compIndexById.set(adjId, comp);
        stack.push(adjId);
      }
    }
    compSizes.push(size);
    if (size > (largestByOwner.get(owner) ?? 0)) largestByOwner.set(owner, size);
  }

  return { areaById, compIndexById, compSizes, largestByOwner };
}

/**
 * Throw unless `area` was part of the board `groups` analyzed. Both consequence
 * helpers key their component lookups by `area.id`; an area from a DIFFERENT
 * board (cross-board misuse — easy for a community bot caching a GroupAnalysis
 * across turns) would silently read a stale/absent component and return a
 * plausible-looking 0 or NaN. Fail loudly instead.
 *
 * @param {import('./types.js').BotArea} area
 * @param {GroupAnalysis} groups
 * @param {string} fn - calling function name for the error message
 */
function assertAnalyzedArea(area, groups, fn) {
  if (!groups.compIndexById.has(area?.id)) {
    throw new Error(
      `groupIncome.${fn}: area ${area?.id} is not part of the analyzed board — pass an area ` +
        `from the same allAreas that produced this computeGroups result (a stale/cross-board ` +
        `GroupAnalysis would silently yield a wrong consequence value).`
    );
  }
}

/**
 * Income the current owner loses if `area` flips to another player: their
 * largest-group size now minus their largest-group size with `area` removed.
 *
 * Zero when `area` is not in one of the owner's largest components (removing
 * it can't shrink the maximum), including the tie case where another component
 * of equal size survives intact. Otherwise the owner's remaining components
 * are recomputed with `area` deleted, which also accounts for splits — the
 * "long thin chain" case where one flip severs the group.
 *
 * @param {import('./types.js').BotArea} area - a present area from the analyzed board
 * @param {GroupAnalysis} groups - result of {@link computeGroups} for that board
 * @returns {number} income loss in territories (≥ 0)
 * @throws {Error} If `area` was not part of the board `groups` analyzed
 */
export function cutValueFor(area, groups) {
  assertAnalyzedArea(area, groups, 'cutValueFor');
  const { areaById, compIndexById, compSizes, largestByOwner } = groups;
  const { owner } = area;
  const before = largestByOwner.get(owner) ?? 0;
  if (compSizes[compIndexById.get(area.id)] !== before) return 0;

  // Recompute the owner's largest component with `area` removed. Bounded by
  // the owner's territory count (≤ board size ≤ maxAreas), so this stays cheap
  // even when called for every node of a board.
  const visited = new Set([area.id]);
  let after = 0;
  for (const [id, candidate] of areaById) {
    if (candidate.owner !== owner || visited.has(id)) continue;
    const stack = [id];
    visited.add(id);
    let size = 0;
    while (stack.length > 0) {
      const cur = areaById.get(stack.pop());
      size += 1;
      for (const adjId of cur.neighbors) {
        if (visited.has(adjId)) continue;
        const adj = areaById.get(adjId);
        if (!adj || adj.owner !== owner) continue;
        visited.add(adjId);
        stack.push(adjId);
      }
    }
    if (size > after) after = size;
  }
  return before - after;
}

/**
 * Income player `me` gains by capturing `area`: the merged size of every one
 * of my components adjacent to it plus the captured node itself, minus my
 * current largest group — floored at 0 (a capture never shrinks my largest
 * group; a capture far from it just doesn't grow it).
 *
 * Returns 0 for an area `me` already owns (capturing it is not a move).
 *
 * @param {import('./types.js').BotArea} area - a present area from the analyzed board
 * @param {GroupAnalysis} groups - result of {@link computeGroups} for that board
 * @param {number} me - the capturing player
 * @returns {number} income gain in territories (≥ 0)
 * @throws {Error} If `area` was not part of the board `groups` analyzed
 */
export function myGainIfCaptured(area, groups, me) {
  assertAnalyzedArea(area, groups, 'myGainIfCaptured');
  if (area.owner === me) return 0;
  const { areaById, compIndexById, compSizes, largestByOwner } = groups;
  const seen = new Set();
  let merged = 1;
  for (const adjId of area.neighbors) {
    const adj = areaById.get(adjId);
    if (!adj || adj.owner !== me) continue;
    const comp = compIndexById.get(adjId);
    if (!seen.has(comp)) {
      seen.add(comp);
      merged += compSizes[comp];
    }
  }
  return Math.max(0, merged - (largestByOwner.get(me) ?? 0));
}
