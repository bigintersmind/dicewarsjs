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
    turnsTaken: 0,
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
 *
 * territoryCount, diceCount and the eliminated flag are always refreshed (cheap
 * O(areas) scans). The expensive largestGroup — a union-find pass per player — is
 * recomputed only for the players listed in `dirtyLargestGroup`, because a
 * player's largest connected group can change only when the set of territories
 * they own changes. A single ATTACK changes ownership for at most one territory,
 * so only the attacker and the captured territory's former owner are affected; a
 * lost attack and an END_TURN change no ownership at all. Players that end up
 * with no territories get largestGroup 0 without a union-find pass. Pass `null`
 * (or omit) to recompute every player — used for the initial full build.
 *
 * @param {import('./types.js').Player[]} players
 * @param {import('./types.js').Area[]} areas
 * @param {number[]|null} [dirtyLargestGroup] - ids of players whose largestGroup
 *   must be recomputed; null/omitted recomputes all.
 */
function recalcPlayerStats(players, areas, dirtyLargestGroup) {
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
  const recomputeAll = dirtyLargestGroup == null;
  const dirty = recomputeAll ? null : new Set(dirtyLargestGroup);
  for (const p of players) {
    if (p.territoryCount === 0) {
      /*
       * No territories ⇒ empty group; also covers the just-eliminated defender
       * (always in the dirty set) without a union-find pass.
       */
      p.largestGroup = 0;
      if (!p.eliminated) p.eliminated = true;
    } else if (recomputeAll || dirty.has(p.id)) {
      p.largestGroup = findLargestConnectedGroup(areas, p.id);
    }
  }
}

/**
 * Append an entry to the action history unless training mode is active.
 *
 * Training mode is signalled by `config.recordHistory === false` (default is
 * record). When off, `state.history` is returned unchanged so it stays the
 * empty array from `createInitialState` — saving the O(n²) growing-copy and the
 * memory it holds across a long self-play run. Any other value (true/absent)
 * preserves the full log the browser `GameController` and replay/tournament
 * persistence depend on, so production paths are unaffected.
 *
 * @param {import('./types.js').GameState} state
 * @param {Object} entry - History entry to append
 * @returns {Object[]} The new history array (or the unchanged one when off)
 */
function appendHistory(state, entry) {
  if (state.config?.recordHistory === false) return state.history;
  return [...state.history, entry];
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
    const formerOwner = toArea.owner; // capture before overwriting
    toArea.owner = currentPlayer;
    toArea.dice = fromArea.dice - 1;
    fromArea.dice = 1;

    /*
     * Only the attacker and the captured territory's former owner changed their
     * owned-territory set, so only their largestGroup can have changed.
     */
    recalcPlayerStats(players, areas, [currentPlayer, formerOwner]);
  } else {
    // Attacker loses: lose all dice except 1
    fromArea.dice = 1;

    /*
     * A lost attack changes no ownership — no player's largestGroup changes;
     * only the attacker's dice count drops (refreshed by the cheap scan).
     */
    recalcPlayerStats(players, areas, []);
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
    history: appendHistory(state, { ...action, result: battle }),
  });
}

/**
 * Apply an END_TURN action.
 */
function applyEndTurn(state) {
  const currentPlayer = state.turnOrder[state.currentPlayerIndex];
  const players = clonePlayers(state.players);

  // Create RNG for deterministic reinforcement distribution
  const rng = createRng(state.rngState);

  /*
   * Distribute reinforcements (places dice randomly).
   * distributeReinforcements is pure — it clones areas internally before mutating —
   * so pass state.areas directly. Pre-cloning here would deep-copy the whole areas
   * array a second time only to discard it.
   *
   * Reinforcement count = the current player's largest connected group, which is a pure
   * function of their owned territories. END_TURN adds dice but changes no ownership, and
   * the ending player is always active (nextTurn never lands on an eliminated seat) with
   * >= 1 territory — so the maintained players[currentPlayer].largestGroup already equals
   * calculateReinforcements(...). Pass it to skip a redundant findLargestConnectedGroup
   * union-find pass per END_TURN. (territoryCount === 0 ⇒ 0 mirrors calculateReinforcements'
   * guard; that branch is unreachable here but kept conservative.)
   */
  const currentStats = players[currentPlayer];
  const { areas: newAreas, playerStock } = distributeReinforcementsDice(
    { areas: state.areas, players },
    currentPlayer,
    rng,
    currentStats.territoryCount === 0 ? 0 : currentStats.largestGroup
  );

  const newRngState = rng.state();

  // Update the player's stock after distribution
  players[currentPlayer].stock = playerStock;

  /*
   * Reinforcement only adds dice to the current player's existing territories — no
   * ownership changes — so every player's largestGroup is unchanged; refresh only
   * the cheap territory/dice counts.
   */
  recalcPlayerStats(players, newAreas, []);

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
    /*
     * turnsTaken counts COMPLETED player-turns — the same unit as matchRunner's
     * turnCount and its 500-turn truncation cap (turnNumber counts full-roster
     * ROUNDS, a different unit). Every player-turn ends through exactly one
     * END_TURN, so incrementing here keeps the two counters in lockstep.
     */
    turnsTaken: state.turnsTaken + 1,
    rngState: newRngState,
    history: appendHistory(state, { type: ACTION_TYPES.END_TURN }),
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
      turnsTaken: state.turnsTaken,
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
    /*
     * turnsTaken postdates the serialized format (deliberately NOT in
     * requiredFields above): a legacy payload without it deserializes with the
     * counter restarted at 0 rather than being rejected.
     */
    turnsTaken: data.turnsTaken ?? 0,
    grid,
  });
}
