/**
 * Turn Manager
 *
 * Turn order, player elimination, reinforcement calculation,
 * and connected-territory group detection (union-find).
 *
 * All functions are pure — they take state in and return new values out.
 *
 * @module engine/TurnManager
 */

import { STOCK_MAX, MAX_DICE } from './constants.js';

/**
 * Create a shuffled turn order for the given number of players.
 *
 * @param {number} playerCount
 * @param {Object} rng - Seeded RNG instance
 * @returns {number[]} Shuffled player indices
 */
export function createTurnOrder(playerCount, rng) {
  const order = Array.from({ length: playerCount }, (_, i) => i);
  rng.shuffle(order);
  return order;
}

/**
 * Find the size of the largest connected group of territories
 * owned by a player, using union-find with path halving.
 *
 * @param {import('./types.js').Area[]} areas - All territories (index 0 unused)
 * @param {number} playerId - Player to check
 * @returns {number} Size of largest connected group (0 if player has no territories)
 */
export function findLargestConnectedGroup(areas, playerId) {
  // Collect IDs of areas owned by this player
  const playerAreaIds = [];
  for (let i = 1; i < areas.length; i++) {
    if (areas[i].size > 0 && areas[i].owner === playerId) {
      playerAreaIds.push(i);
    }
  }

  if (playerAreaIds.length === 0) return 0;

  // Union-find parent map (areaId → root)
  const parent = new Map();
  for (const id of playerAreaIds) {
    parent.set(id, id);
  }

  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x))); // path compression
      x = parent.get(x);
    }
    return x;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
    }
  }

  // Union adjacent player areas
  for (const id of playerAreaIds) {
    for (const adjId of areas[id].neighborAreaIds) {
      if (parent.has(adjId)) {
        union(id, adjId);
      }
    }
  }

  // Count territories per group
  const groupSize = new Map();
  for (const id of playerAreaIds) {
    const root = find(id);
    groupSize.set(root, (groupSize.get(root) || 0) + 1);
  }

  return Math.max(...groupSize.values());
}

/**
 * Check if a player has been marked as eliminated.
 *
 * @param {{ players: import('./types.js').Player[] }} state
 * @param {number} playerId
 * @returns {boolean}
 */
export function isPlayerEliminated(state, playerId) {
  return state.players[playerId].eliminated;
}

/**
 * Get list of non-eliminated player indices.
 *
 * @param {{ players: import('./types.js').Player[] }} state
 * @returns {number[]}
 */
export function getActivePlayers(state) {
  return state.players.filter(p => !p.eliminated).map(p => p.id);
}

/**
 * Check if the game is over (only one active player remains).
 *
 * @param {{ players: import('./types.js').Player[] }} state
 * @returns {{ over: boolean, winner: number|null }}
 */
export function isGameOver(state) {
  const active = getActivePlayers(state);
  if (active.length <= 1) {
    return { over: true, winner: active.length === 1 ? active[0] : null };
  }
  return { over: false, winner: null };
}

/**
 * Calculate reinforcement dice count for a player.
 * Formula: size of largest connected territory group (matches original DiceWars).
 *
 * @param {{ areas: import('./types.js').Area[], players: import('./types.js').Player[] }} state
 * @param {number} playerId
 * @returns {number}
 */
export function calculateReinforcements(state, playerId) {
  const player = state.players[playerId];
  if (player.eliminated || player.territoryCount === 0) return 0;

  return findLargestConnectedGroup(state.areas, playerId);
}

/**
 * Advance to the next player's turn, skipping eliminated players.
 * Returns a new object with updated currentPlayerIndex and turnNumber.
 *
 * @param {{ turnOrder: number[], currentPlayerIndex: number, players: import('./types.js').Player[], turnNumber: number }} state
 * @returns {{ currentPlayerIndex: number, turnNumber: number }}
 */
export function nextTurn(state) {
  const { turnOrder, currentPlayerIndex, players, turnNumber } = state;
  const len = turnOrder.length;
  let idx = currentPlayerIndex;
  let newTurnNumber = turnNumber;

  // Advance at least once
  idx = (idx + 1) % len;
  if (idx === 0) newTurnNumber++;

  // Skip eliminated players (safety cap to prevent infinite loop)
  for (let attempts = 0; attempts < len; attempts++) {
    const pid = turnOrder[idx];
    if (!players[pid].eliminated) {
      return { currentPlayerIndex: idx, turnNumber: newTurnNumber };
    }
    idx = (idx + 1) % len;
    if (idx === 0) newTurnNumber++;
  }

  // All players eliminated — this indicates a game state invariant violation
  throw new Error('nextTurn: all players are eliminated');
}

/**
 * Distribute reinforcement dice to a player's territories.
 * Dice are placed randomly (matches original DiceWars).
 * Returns a new areas array with dice added. Does NOT mutate the input.
 *
 * @param {{ areas: import('./types.js').Area[], players: import('./types.js').Player[] }} state
 * @param {number} playerId
 * @param {Object} rng - Seeded RNG instance (from engine/rng.js)
 * @param {number} [precomputedReinforcements] - Optional reinforcement count to use instead of
 *   recomputing via calculateReinforcements. Reinforcement equals the size of the player's
 *   largest connected group, a pure function of their owned-territory set — so a caller that
 *   already maintains that value (e.g. applyEndTurn, where END_TURN changes no ownership) can
 *   pass it to skip a redundant findLargestConnectedGroup union-find pass. MUST equal what
 *   calculateReinforcements(state, playerId) would return, or dice placement diverges. Omit
 *   (or pass undefined) to recompute — the default for all other callers.
 * @returns {{ areas: import('./types.js').Area[], playerStock: number }}
 */
export function distributeReinforcements(state, playerId, rng, precomputedReinforcements) {
  const player = state.players[playerId];
  const reinforcements = precomputedReinforcements ?? calculateReinforcements(state, playerId);
  let stock = Math.min(player.stock + reinforcements, STOCK_MAX);

  if (stock <= 0) {
    /*
     * Nothing to place, but still return a fresh deep clone (same shape as the main
     * path below) so this function ALWAYS hands back independently-owned area objects.
     * Callers — e.g. applyEndTurn, which now passes state.areas straight through — never
     * have to rely on this branch being unreachable to preserve immutability. (It is in
     * fact unreachable via applyEndTurn: an active player always has >= 1 territory ⇒
     * reinforcements >= 1 ⇒ stock >= 1; the clone here is cheap insurance for any future
     * caller.)
     */
    return {
      areas: state.areas.map(a => ({
        ...a,
        neighborAreaIds: [...a.neighborAreaIds],
        cells: [...a.cells],
      })),
      playerStock: stock,
    };
  }

  // Clone areas so we don't mutate the original
  const newAreas = state.areas.map(a => ({
    ...a,
    neighborAreaIds: [...a.neighborAreaIds],
    cells: [...a.cells],
  }));

  // Build list of player territories that can receive dice
  const eligible = [];
  for (let i = 1; i < newAreas.length; i++) {
    const area = newAreas[i];
    if (area.size > 0 && area.owner === playerId && area.dice < MAX_DICE) {
      eligible.push(i);
    }
  }

  // Distribute dice randomly, one at a time
  while (stock > 0 && eligible.length > 0) {
    const idx = rng.nextInt(0, eligible.length - 1);
    const id = eligible[idx];

    newAreas[id].dice++;
    stock--;

    if (newAreas[id].dice >= MAX_DICE) {
      eligible.splice(idx, 1);
    }
  }

  return { areas: newAreas, playerStock: stock };
}
