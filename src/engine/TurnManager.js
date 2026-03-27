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
 * Formula: floor(largestConnectedGroup / 3), minimum 1 if player has territories.
 *
 * @param {{ areas: import('./types.js').Area[], players: import('./types.js').Player[] }} state
 * @param {number} playerId
 * @returns {number}
 */
export function calculateReinforcements(state, playerId) {
  const player = state.players[playerId];
  if (player.eliminated || player.territoryCount === 0) return 0;

  const largestGroup = findLargestConnectedGroup(state.areas, playerId);
  return Math.max(Math.floor(largestGroup / 3), 1);
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
 * Returns a new areas array with dice added. Does NOT mutate the input.
 *
 * @param {{ areas: import('./types.js').Area[], players: import('./types.js').Player[] }} state
 * @param {number} playerId
 * @returns {{ areas: import('./types.js').Area[], playerStock: number }}
 */
export function distributeReinforcements(state, playerId) {
  const player = state.players[playerId];
  const reinforcements = calculateReinforcements(state, playerId);
  let stock = Math.min(player.stock + reinforcements, STOCK_MAX);

  if (stock <= 0) {
    return { areas: [...state.areas], playerStock: stock };
  }

  // Clone areas so we don't mutate the original
  const newAreas = state.areas.map(a => ({
    ...a,
    neighborAreaIds: [...a.neighborAreaIds],
    cells: [...a.cells],
  }));

  // Build list of player territories that can receive dice, sorted by priority
  const eligible = [];
  for (let i = 1; i < newAreas.length; i++) {
    const area = newAreas[i];
    if (area.size > 0 && area.owner === playerId && area.dice < MAX_DICE) {
      // Border territories (adjacent to enemy) get higher priority
      const isBorder = area.neighborAreaIds.some(
        adjId =>
          adjId > 0 &&
          adjId < newAreas.length &&
          newAreas[adjId].size > 0 &&
          newAreas[adjId].owner !== playerId
      );
      const priority = (isBorder ? 100 : 0) + (MAX_DICE - area.dice) * 10;
      eligible.push({ id: i, priority });
    }
  }
  eligible.sort((a, b) => b.priority - a.priority);

  // Distribute dice
  for (const { id } of eligible) {
    if (stock <= 0) break;
    if (newAreas[id].dice < MAX_DICE) {
      newAreas[id].dice++;
      stock--;
    }
  }

  return { areas: newAreas, playerStock: stock };
}
