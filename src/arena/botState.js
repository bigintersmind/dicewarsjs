/**
 * Bot State Sanitization
 *
 * Transforms the engine's internal GameState into a sanitized BotState
 * that exposes only what a player could observe by looking at the board.
 *
 * @module arena/botState
 */

// eslint-disable-next-line no-unused-vars -- used in JSDoc
import './types.js';

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
 * Transform engine GameState into a sanitized, frozen BotState.
 *
 * Strips internal fields (grid geometry, RNG state, history) that bots
 * should not depend on. Returns a frozen object to enforce no-mutation.
 *
 * @param {import('../engine/types.js').GameState} state - Engine game state
 * @param {number} playerId - The player this bot is acting for
 * @returns {import('./types.js').BotState}
 */
export function createBotState(state, playerId) {
  const { areas, players, turnNumber } = state;

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
  const botPlayers = Object.freeze(
    players.map(p =>
      Object.freeze({
        id: p.id,
        territories: p.territoryCount,
        totalDice: p.diceCount,
        connectedTerritories: p.largestGroup,
        reinforcements: p.stock,
        eliminated: p.eliminated,
      })
    )
  );

  const gamePhase = computeGamePhase(activePlayers, totalPlayers, turnNumber);

  return Object.freeze({
    myPlayer: playerId,
    turnNumber,
    totalPlayers,
    activePlayers,
    gamePhase,
    myAreas,
    allAreas,
    players: botPlayers,
  });
}
