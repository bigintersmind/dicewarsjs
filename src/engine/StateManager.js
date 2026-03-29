/**
 * State Manager (Immutable State Transitions)
 *
 * Central reducer that composes BattleResolver and TurnManager
 * into a single applyAction(state, action) → newState function.
 *
 * All state transitions are immutable — the input state is never mutated.
 * Immutability is maintained by convention and shallow Object.freeze() on
 * the top-level state. Nested objects (areas, players) are not deep-frozen.
 * The RNG state is embedded in GameState so replaying the same actions
 * from the same initial state produces an identical game.
 *
 * @module engine/StateManager
 */

import { createRng } from './rng.js';
import { resolveBattle } from './BattleResolver.js';
import {
  nextTurn,
  isGameOver,
  findLargestConnectedGroup,
  distributeReinforcements as distributeReinforcementsDice,
} from './TurnManager.js';
import { createHexGrid } from './HexGrid.js';
import { ACTION_TYPES, GAME_PHASES } from './constants.js';

/**
 * Create the initial game state from map data and turn order.
 *
 * @param {import('./types.js').GameConfig} config
 * @param {{ areas: import('./types.js').Area[], cells: number[], grid: import('./types.js').HexGrid }} mapData
 * @param {number[]} turnOrder
 * @param {number} rngState - Current RNG state (uint32) after map generation
 * @returns {import('./types.js').GameState}
 */
export function createInitialState(config, mapData, turnOrder, rngState) {
  const playerCount = config.playerCount ?? 7;

  // Build player objects from area data
  const players = [];
  for (let p = 0; p < playerCount; p++) {
    let territoryCount = 0;
    let diceCount = 0;
    for (let a = 1; a < mapData.areas.length; a++) {
      if (mapData.areas[a].size > 0 && mapData.areas[a].owner === p) {
        territoryCount++;
        diceCount += mapData.areas[a].dice;
      }
    }
    const largestGroup = findLargestConnectedGroup(mapData.areas, p);
    players.push({
      id: p,
      territoryCount,
      diceCount,
      largestGroup,
      stock: 0,
      eliminated: false,
    });
  }

  return Object.freeze({
    config,
    grid: mapData.grid,
    areas: mapData.areas,
    players,
    turnOrder,
    currentPlayerIndex: 0,
    turnNumber: 0,
    phase: GAME_PHASES.PLAYING,
    history: [],
    rngState,
    winner: null,
  });
}

/**
 * Clone areas array by spreading each area object and copying its array-valued fields.
 */
function cloneAreas(areas) {
  return areas.map(a => ({ ...a, neighborAreaIds: [...a.neighborAreaIds], cells: [...a.cells] }));
}

/**
 * Clone players array (shallow per player — safe while all Player fields are primitives).
 */
function clonePlayers(players) {
  return players.map(p => ({ ...p }));
}

/**
 * Recalculate player stats from areas.
 */
function recalcPlayerStats(players, areas) {
  for (const p of players) {
    p.territoryCount = 0;
    p.diceCount = 0;
  }
  for (let a = 1; a < areas.length; a++) {
    if (areas[a].size > 0 && areas[a].owner >= 0 && areas[a].owner < players.length) {
      players[areas[a].owner].territoryCount++;
      players[areas[a].owner].diceCount += areas[a].dice;
    }
  }
  for (const p of players) {
    p.largestGroup = findLargestConnectedGroup(areas, p.id);
    if (p.territoryCount === 0 && !p.eliminated) {
      p.eliminated = true;
    }
  }
}

/**
 * Apply an action to the game state, returning a new state.
 *
 * @param {import('./types.js').GameState} state
 * @param {import('./types.js').Action} action
 * @returns {import('./types.js').GameState}
 */
export function applyAction(state, action) {
  if (state.phase === GAME_PHASES.GAME_OVER) {
    throw new Error('Cannot apply actions to a finished game');
  }
  switch (action.type) {
    case ACTION_TYPES.ATTACK:
      return applyAttack(state, action);
    case ACTION_TYPES.END_TURN:
      return applyEndTurn(state);
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

/**
 * Apply an ATTACK action.
 */
function applyAttack(state, action) {
  const { from, to } = action;
  const areas = cloneAreas(state.areas);
  const players = clonePlayers(state.players);

  // Validate the attack
  const fromArea = areas[from];
  const toArea = areas[to];

  if (!fromArea || fromArea.size === 0) {
    throw new Error(`Invalid attacking territory: ${from}`);
  }
  if (!toArea || toArea.size === 0) {
    throw new Error(`Invalid defending territory: ${to}`);
  }

  const currentPlayer = state.turnOrder[state.currentPlayerIndex];
  if (fromArea.owner !== currentPlayer) {
    throw new Error(`Territory ${from} not owned by current player ${currentPlayer}`);
  }
  if (toArea.owner === currentPlayer) {
    throw new Error(`Cannot attack own territory ${to}`);
  }
  if (fromArea.dice <= 1) {
    throw new Error(`Territory ${from} needs > 1 dice to attack (has ${fromArea.dice})`);
  }
  if (!fromArea.neighborAreaIds.includes(to)) {
    throw new Error(`Territory ${from} is not adjacent to ${to}`);
  }

  // Resolve battle
  const rng = createRng(state.rngState);
  const battle = resolveBattle(fromArea.dice, toArea.dice, rng);
  const newRngState = rng.state();

  if (battle.success) {
    // Attacker wins: take over territory
    toArea.owner = currentPlayer;
    toArea.dice = fromArea.dice - 1;
    fromArea.dice = 1;

    // Recalculate stats
    recalcPlayerStats(players, areas);
  } else {
    // Attacker loses: lose all dice except 1
    fromArea.dice = 1;

    // Recalculate attacker's dice count
    recalcPlayerStats(players, areas);
  }

  // Check for game over
  const gameOverCheck = isGameOver({ players });
  const phase = gameOverCheck.over ? GAME_PHASES.GAME_OVER : state.phase;
  const winner = gameOverCheck.over ? gameOverCheck.winner : state.winner;

  return Object.freeze({
    ...state,
    areas,
    players,
    phase,
    winner,
    rngState: newRngState,
    history: [...state.history, { ...action, result: battle }],
  });
}

/**
 * Apply an END_TURN action.
 */
function applyEndTurn(state) {
  const currentPlayer = state.turnOrder[state.currentPlayerIndex];
  const areas = cloneAreas(state.areas);
  const players = clonePlayers(state.players);

  // Create RNG for deterministic reinforcement distribution
  const rng = createRng(state.rngState);

  // Distribute reinforcements (calculates reinforcements + places dice randomly)
  const { areas: newAreas, playerStock } = distributeReinforcementsDice(
    { areas, players },
    currentPlayer,
    rng
  );

  const newRngState = rng.state();

  // Update the player's stock after distribution
  players[currentPlayer].stock = playerStock;

  // Recalculate stats with new areas
  recalcPlayerStats(players, newAreas);

  // Advance turn
  const { currentPlayerIndex, turnNumber } = nextTurn({
    turnOrder: state.turnOrder,
    currentPlayerIndex: state.currentPlayerIndex,
    players,
    turnNumber: state.turnNumber,
  });

  return Object.freeze({
    ...state,
    areas: newAreas,
    players,
    currentPlayerIndex,
    turnNumber,
    rngState: newRngState,
    history: [...state.history, { type: ACTION_TYPES.END_TURN }],
  });
}

/**
 * Get all valid attack moves for the current player.
 *
 * @param {import('./types.js').GameState} state
 * @returns {import('./types.js').Move[]}
 */
export function getValidMoves(state) {
  const currentPlayer = state.turnOrder[state.currentPlayerIndex];
  const { areas } = state;
  const moves = [];

  for (let i = 1; i < areas.length; i++) {
    const area = areas[i];
    if (area.size === 0 || area.owner !== currentPlayer || area.dice <= 1) continue;

    for (const adjId of area.neighborAreaIds) {
      if (
        adjId > 0 &&
        adjId < areas.length &&
        areas[adjId].size > 0 &&
        areas[adjId].owner !== currentPlayer
      ) {
        moves.push({
          from: i,
          to: adjId,
          attackerDice: area.dice,
          defenderDice: areas[adjId].dice,
        });
      }
    }
  }

  return moves;
}

/**
 * Serialize game state to a JSON-safe object.
 *
 * @param {import('./types.js').GameState} state
 * @returns {Object}
 */
export function serializeState(state) {
  return JSON.parse(
    JSON.stringify({
      config: state.config,
      grid: { width: state.grid.width, height: state.grid.height },
      areas: state.areas,
      players: state.players,
      turnOrder: state.turnOrder,
      currentPlayerIndex: state.currentPlayerIndex,
      turnNumber: state.turnNumber,
      phase: state.phase,
      history: state.history,
      rngState: state.rngState,
      winner: state.winner,
    })
  );
}

/**
 * Deserialize game state from a serialized object.
 * Reconstructs the hex grid from saved dimensions.
 *
 * @param {Object} data
 * @returns {import('./types.js').GameState}
 */
export function deserializeState(data) {
  if (!data || typeof data !== 'object') {
    throw new TypeError('deserializeState: data must be a non-null object');
  }
  const requiredFields = [
    'config',
    'grid',
    'areas',
    'players',
    'turnOrder',
    'currentPlayerIndex',
    'turnNumber',
    'phase',
    'rngState',
  ];
  for (const field of requiredFields) {
    if (!(field in data)) {
      throw new TypeError(`deserializeState: missing required field "${field}"`);
    }
  }
  if (!data.grid || typeof data.grid.width !== 'number' || typeof data.grid.height !== 'number') {
    throw new TypeError('deserializeState: data.grid must have numeric width and height');
  }

  const grid = createHexGrid(data.grid.width, data.grid.height);

  return Object.freeze({
    ...data,
    grid,
  });
}
