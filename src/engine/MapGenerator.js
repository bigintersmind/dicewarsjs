/**
 * Map Generator (Pure Function)
 *
 * Procedural map generation using percolation-based territory growth.
 * Takes a config and seeded RNG, returns complete map data.
 * No side effects, no event emissions, no mutation of inputs.
 *
 * @module engine/MapGenerator
 */

import { createHexGrid } from './HexGrid.js';
import {
  DEFAULT_XMAX,
  DEFAULT_YMAX,
  DEFAULT_AREA_MAX,
  DEFAULT_PLAYER_COUNT,
  DEFAULT_DICE_PER_AREA,
  MIN_TERRITORY_SIZE,
  MAX_DICE,
  HEX_DIRECTIONS,
} from './constants.js';

/**
 * Generate a complete game map.
 *
 * @param {import('./types.js').GameConfig} config
 * @param {Object} rng - Seeded RNG instance
 * @returns {{ areas: import('./types.js').Area[], cells: number[], grid: import('./types.js').HexGrid }}
 */
export function generateMap(config, rng) {
  const width = config.mapWidth ?? DEFAULT_XMAX;
  const height = config.mapHeight ?? DEFAULT_YMAX;
  const maxAreas = config.maxAreas ?? DEFAULT_AREA_MAX;
  const playerCount = config.playerCount ?? DEFAULT_PLAYER_COUNT;
  const dicePerArea = config.dicePerArea ?? DEFAULT_DICE_PER_AREA;

  if (playerCount < 1) {
    throw new RangeError(`generateMap: playerCount must be >= 1, got ${playerCount}`);
  }
  if (width < 1 || height < 1) {
    throw new RangeError(`generateMap: grid dimensions must be >= 1, got ${width}x${height}`);
  }
  if (maxAreas < 2) {
    throw new RangeError(`generateMap: maxAreas must be >= 2, got ${maxAreas}`);
  }

  const grid = createHexGrid(width, height);
  const cellCount = grid.cellCount;

  // cells[i] = area ID that owns cell i (0 = unassigned)
  const cells = new Array(cellCount).fill(0);

  // Randomized priority for each cell (used to pick growth candidates)
  const priority = Array.from({ length: cellCount }, (_, i) => i);
  rng.shuffle(priority);

  // Track which cells are available as seeds for new territories
  const available = new Array(cellCount).fill(0);

  // Seed the first available cell
  available[Math.floor(rng.nextFloat() * cellCount)] = 1;

  // Grow territories
  let areaCount = 0;
  const areasCells = []; // areasCells[areaId] = [cellIndices]

  while (areaCount < maxAreas - 1) {
    // Find the next starting cell (available, unassigned, lowest priority number)
    let bestCell = -1;
    let bestPriority = Infinity;
    for (let i = 0; i < cellCount; i++) {
      if (cells[i] === 0 && available[i] === 1 && priority[i] < bestPriority) {
        bestCell = i;
        bestPriority = priority[i];
      }
    }
    if (bestCell === -1) break;

    areaCount++;
    const areaId = areaCount;
    const areaCells = percolate(grid, cells, priority, available, bestCell, areaId, rng);
    areasCells[areaId] = areaCells;
  }

  // Fill single-cell gaps (empty cells surrounded by one territory)
  fillSingleCellGaps(grid, cells);

  // Build area data from cells array
  const areas = buildAreas(grid, cells, maxAreas);

  // Remove areas smaller than MIN_TERRITORY_SIZE
  removeSmallAreas(areas, cells);

  // Validate enough territories remain for all players
  const validAreaCount = areas.reduce((count, a) => count + (a.size > 0 ? 1 : 0), 0);
  if (validAreaCount < playerCount) {
    throw new RangeError(
      `generateMap: only ${validAreaCount} valid territories after pruning, but ${playerCount} players need territories. ` +
        `Try larger grid dimensions or fewer players.`
    );
  }

  // Compute adjacency between territories
  computeAdjacency(grid, cells, areas);

  // Compute area centers
  computeCenters(grid, cells, areas);

  // Distribute territories among players
  distributeTerritoriesAmongPlayers(areas, playerCount, rng);

  // Place initial dice
  distributeDice(areas, playerCount, dicePerArea, rng);

  return { areas, cells, grid };
}

/**
 * Grow a territory from a starting cell using percolation.
 *
 * @param {import('./types.js').HexGrid} grid
 * @param {number[]} cells - Cell ownership (mutated)
 * @param {number[]} priority - Random priority per cell
 * @param {number[]} available - Availability flags (mutated)
 * @param {number} startCell
 * @param {number} areaId
 * @param {Object} rng
 * @returns {number[]} Array of cell indices in the new territory
 */
function percolate(grid, cells, priority, available, startCell, areaId, rng) {
  const cellCount = grid.cellCount;
  const adjacent = new Uint8Array(cellCount); // 1 = adjacent to growing territory
  const areaCells = [];

  const targetSize = Math.max(3, Math.floor(8 * (1 + (rng.nextFloat() * 2 - 1) * 0.2)));

  let currentPos = startCell;

  // Growth loop
  while (true) {
    cells[currentPos] = areaId;
    areaCells.push(currentPos);

    // Mark neighbors as adjacent
    for (let d = 0; d < HEX_DIRECTIONS; d++) {
      const n = grid.adjacency[currentPos][d];
      if (n >= 0) adjacent[n] = 1;
    }

    if (areaCells.length >= targetSize) break;

    // Find best candidate: adjacent, unassigned, lowest priority
    let bestCell = -1;
    let bestPriority = Infinity;
    for (let i = 0; i < cellCount; i++) {
      if (adjacent[i] === 1 && cells[i] === 0 && priority[i] < bestPriority) {
        bestCell = i;
        bestPriority = priority[i];
      }
    }

    if (bestCell === -1) break;
    currentPos = bestCell;
  }

  // Boundary smoothing: absorb all remaining adjacent unassigned cells
  for (let i = 0; i < cellCount; i++) {
    if (adjacent[i] === 1 && cells[i] === 0) {
      cells[i] = areaId;
      areaCells.push(i);

      // Mark neighbors of absorbed cells as available for next territory
      for (let d = 0; d < HEX_DIRECTIONS; d++) {
        const n = grid.adjacency[i][d];
        if (n >= 0) available[n] = 1;
      }
    }
  }

  return areaCells;
}

/**
 * Fill single-cell gaps: empty cells with no empty neighbors,
 * where all filled neighbors belong to the same territory.
 */
function fillSingleCellGaps(grid, cells) {
  for (let i = 0; i < grid.cellCount; i++) {
    if (cells[i] !== 0) continue;

    let hasEmptyNeighbor = false;
    let filledNeighborId = 0;
    let singleOwner = true;

    for (let d = 0; d < HEX_DIRECTIONS; d++) {
      const n = grid.adjacency[i][d];
      if (n < 0) continue;
      if (cells[n] === 0) {
        hasEmptyNeighbor = true;
      } else if (filledNeighborId === 0) {
        filledNeighborId = cells[n];
      } else if (cells[n] !== filledNeighborId) {
        singleOwner = false;
      }
    }

    if (!hasEmptyNeighbor && filledNeighborId > 0 && singleOwner) {
      cells[i] = filledNeighborId;
    }
  }
}

/**
 * Build area objects from cells array.
 */
function buildAreas(grid, cells, maxAreas) {
  /** @type {import('./types.js').Area[]} */
  const areas = [];

  // Index 0 is unused sentinel
  areas[0] = { id: 0, size: 0, owner: -1, dice: 0, neighborAreaIds: [], centerCell: -1, cells: [] };

  for (let a = 1; a < maxAreas; a++) {
    const cellList = [];
    // Collect cells for this area from the cells array
    for (let i = 0; i < grid.cellCount; i++) {
      if (cells[i] === a) cellList.push(i);
    }
    areas[a] = {
      id: a,
      size: cellList.length,
      owner: -1,
      dice: 0,
      neighborAreaIds: [],
      centerCell: -1,
      cells: cellList,
    };
  }

  return areas;
}

/**
 * Remove areas smaller than MIN_TERRITORY_SIZE.
 */
function removeSmallAreas(areas, cells) {
  for (let a = 1; a < areas.length; a++) {
    if (areas[a].size > 0 && areas[a].size < MIN_TERRITORY_SIZE) {
      // Clear cells
      for (const c of areas[a].cells) {
        cells[c] = 0;
      }
      areas[a].size = 0;
      areas[a].cells = [];
    }
  }
}

/**
 * Compute adjacency between territories from the cell grid.
 */
function computeAdjacency(grid, cells, areas) {
  // For each area, find adjacent areas
  const adjSets = new Array(areas.length);
  for (let a = 0; a < areas.length; a++) {
    adjSets[a] = new Set();
  }

  for (let i = 0; i < grid.cellCount; i++) {
    const areaId = cells[i];
    if (areaId <= 0) continue;

    for (let d = 0; d < HEX_DIRECTIONS; d++) {
      const n = grid.adjacency[i][d];
      if (n < 0) continue;
      const neighborArea = cells[n];
      if (neighborArea > 0 && neighborArea !== areaId) {
        adjSets[areaId].add(neighborArea);
      }
    }
  }

  for (let a = 1; a < areas.length; a++) {
    areas[a].neighborAreaIds = [...adjSets[a]];
  }
}

/**
 * Compute center cell for each territory.
 */
function computeCenters(grid, cells, areas) {
  const width = grid.width;

  for (let a = 1; a < areas.length; a++) {
    if (areas[a].size === 0) continue;

    // Find bounding box
    let left = width,
      right = -1,
      top = grid.height,
      bottom = -1;
    for (const c of areas[a].cells) {
      const x = c % width;
      const y = Math.floor(c / width);
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }

    const cx = Math.floor((left + right) / 2);
    const cy = Math.floor((top + bottom) / 2);

    // Find the cell in this area closest to center, preferring non-border cells
    let bestLen = Infinity;
    let bestCell = areas[a].cells[0];

    for (const c of areas[a].cells) {
      const x = c % width;
      const y = Math.floor(c / width);
      let len = Math.abs(cx - x) + Math.abs(cy - y);

      // Penalize border cells
      let isBorder = false;
      for (let d = 0; d < HEX_DIRECTIONS; d++) {
        const n = grid.adjacency[c][d];
        if (n >= 0 && cells[n] !== areas[a].id) {
          isBorder = true;
          break;
        }
      }
      if (isBorder) len += 4;

      if (len < bestLen) {
        bestLen = len;
        bestCell = c;
      }
    }

    areas[a].centerCell = bestCell;
  }
}

/**
 * Distribute territories evenly among players.
 */
function distributeTerritoriesAmongPlayers(areas, playerCount, rng) {
  // Collect valid area indices
  const validAreas = [];
  for (let a = 1; a < areas.length; a++) {
    if (areas[a].size > 0) validAreas.push(a);
  }

  // Shuffle for random assignment
  rng.shuffle(validAreas);

  // Round-robin assign
  for (let i = 0; i < validAreas.length; i++) {
    areas[validAreas[i]].owner = i % playerCount;
  }
}

/**
 * Place initial dice on territories.
 * Each territory starts with 1 die, then extra dice are distributed
 * round-robin by player.
 */
function distributeDice(areas, playerCount, dicePerArea, rng) {
  // Count valid territories and give each 1 die
  let validCount = 0;
  for (let a = 1; a < areas.length; a++) {
    if (areas[a].size > 0) {
      areas[a].dice = 1;
      validCount++;
    }
  }

  const additionalDice = validCount * (dicePerArea - 1);
  let currentPlayer = 0;

  for (let d = 0; d < additionalDice; d++) {
    // Find eligible territories for current player
    const eligible = [];
    for (let a = 1; a < areas.length; a++) {
      if (areas[a].size > 0 && areas[a].owner === currentPlayer && areas[a].dice < MAX_DICE) {
        eligible.push(a);
      }
    }

    if (eligible.length > 0) {
      const idx = rng.nextInt(0, eligible.length - 1);
      areas[eligible[idx]].dice++;
    }

    currentPlayer = (currentPlayer + 1) % playerCount;
  }
}
