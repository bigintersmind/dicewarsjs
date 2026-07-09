/**
 * Bot State Sanitization
 *
 * Transforms the engine's internal GameState into a sanitized BotState
 * that exposes only what a player could observe by looking at the board.
 *
 * @module arena/botState
 */

import { deriveBotRandom } from '../engine/rng.js';

/**
 * Compute the estimated game phase based on active player count and turn number.
 *
 * @param {number} activePlayers
 * @param {number} totalPlayers
 * @param {number} turnNumber
 * @returns {'early'|'mid'|'late'}
 */
function computeGamePhase(activePlayers, totalPlayers, turnNumber) {
  const eliminated = totalPlayers - activePlayers;
  if (turnNumber <= 3 && eliminated === 0) return 'early';
  if (activePlayers <= 2 || eliminated >= totalPlayers / 2) return 'late';
  return 'mid';
}

/**
 * Turn distance from the acting player to every seat: how many turn-advances
 * from `playerId` until each player acts, counting only non-eliminated seats
 * (the engine's `nextTurn` skips eliminated players — see engine/TurnManager).
 * The acting player is 0; the next actor is 1; eliminated seats have no
 * upcoming turn and map to 0 (the `eliminated` flag disambiguates).
 *
 * Turn order is public information — a player watches the sequence of turns —
 * so exposing it keeps BotState "what you could observe by looking at the board".
 *
 * @param {import('../engine/types.js').Player[]} players
 * @param {number[]} turnOrder - The game's (shuffled) seat order
 * @param {number} playerId - The acting player
 * @returns {Map<number, number>} player id → turns until they act
 */
function computeTurnsUntilActs(players, turnOrder, playerId) {
  if (!Array.isArray(turnOrder)) {
    throw new TypeError(
      `computeTurnsUntilActs: state.turnOrder must be an array, got ${typeof turnOrder} — ` +
        `a hand-built state is missing the engine's shuffled seat order.`
    );
  }
  const myPos = turnOrder.indexOf(playerId);
  if (myPos === -1) {
    throw new Error(
      `computeTurnsUntilActs: playerId ${playerId} is not in turnOrder [${turnOrder.join(', ')}] ` +
        `— cannot rank seats relative to a player with no seat.`
    );
  }
  const distances = new Map();
  let rank = 0;
  for (let step = 0; step < turnOrder.length; step++) {
    const pid = turnOrder[(myPos + step) % turnOrder.length];
    if (players[pid].eliminated) continue;
    distances.set(pid, rank);
    rank += 1;
  }
  return distances;
}

/**
 * Transform engine GameState into a sanitized, frozen BotState.
 *
 * Strips internal fields (grid geometry, RNG state, history) that bots
 * should not depend on. Returns a frozen object to enforce no-mutation.
 * The raw rngState is exposed only indirectly, as the derived seeded
 * `random()` function (issue #151).
 *
 * @param {import('../engine/types.js').GameState} state - Engine game state
 * @param {number} playerId - The player this bot is acting for
 * @returns {import('./types.js').BotState}
 */
export function createBotState(state, playerId) {
  const { areas, players, turnNumber, turnsTaken, turnOrder } = state;

  const activePlayers = players.filter(p => !p.eliminated).length;
  const totalPlayers = players.length;

  // Build BotArea[] from areas (skip index 0 sentinel and zero-size areas)
  const allAreas = [];
  for (let i = 1; i < areas.length; i++) {
    const area = areas[i];
    if (area.size === 0) continue;

    const neighbors = area.neighborAreaIds.filter(
      adjId => adjId > 0 && adjId < areas.length && areas[adjId].size > 0
    );
    const isBorder = neighbors.some(adjId => areas[adjId].owner !== area.owner);

    allAreas.push(
      Object.freeze({
        id: area.id,
        owner: area.owner,
        dice: area.dice,
        neighbors: Object.freeze(neighbors),
        isBorder,
      })
    );
  }

  Object.freeze(allAreas);

  const myAreas = Object.freeze(allAreas.filter(a => a.owner === playerId));

  // Build BotPlayer[] from players
  const turnsUntil = computeTurnsUntilActs(players, turnOrder, playerId);
  const botPlayers = Object.freeze(
    players.map(p =>
      Object.freeze({
        id: p.id,
        territories: p.territoryCount,
        totalDice: p.diceCount,
        connectedTerritories: p.largestGroup,
        reinforcements: p.stock,
        eliminated: p.eliminated,
        turnsUntilActs: turnsUntil.get(p.id) ?? 0,
      })
    )
  );

  const gamePhase = computeGamePhase(activePlayers, totalPlayers, turnNumber);

  return Object.freeze({
    myPlayer: playerId,
    turnNumber,
    turnsTaken,
    totalPlayers,
    activePlayers,
    gamePhase,
    myAreas,
    allAreas,
    players: botPlayers,
    /*
     * Seeded drop-in for Math.random (issue #151): derived from rngState +
     * playerId per decision, so bots stay stochastic yet same-seed matches are
     * reproducible. This is the ONE spot where a raw-state field crosses into
     * BotState — as a derived function only, never the rngState value itself.
     * A function property drops out of JSON serialization, so recorded
     * trajectories/observations are unaffected.
     */
    random: deriveBotRandom(state.rngState, playerId),
  });
}
