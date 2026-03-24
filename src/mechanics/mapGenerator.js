/**
 * Map Generator Module
 *
 * Provides functions for procedurally generating game maps with territories of varied sizes,
 * ensuring good gameplay balance. Extracted from Game.js for modularity.
 * Implemented using functional programming patterns and ES6 features.
 *
 * @module mechanics/mapGenerator
 */

import { AreaData } from '../models/index.js';
import { withErrorHandling } from './errorHandling.js';
import { GameError, TerritoryError } from './errors/index.js';
import { gameEvents, EventType } from './eventSystem.js';

/**
 * Territory growth options
 *
 * @typedef {Object} TerritoryGrowthOptions
 * @property {number} minSize - Minimum size for territories (default: 3)
 * @property {number} targetSize - Target size for territories (default: 8)
 * @property {number} growthStrategy - Strategy to use for territory growth (0=balanced, 1=compact, 2=sprawling)
 */

/**
 * Grow a Territory
 *
 * Creates a new territory by growing outward from a starting cell.
 * Uses a greedy algorithm to select cells for inclusion in the territory.
 *
 * @param {Object} gameState - Game state including grid data
 * @param {number} pt - Starting cell index
 * @param {number} cmax - Target maximum size for the territory
 * @param {number} an - Territory ID to assign
 * @returns {number} Number of cells in the created territory
 * @throws {TerritoryError} If territory creation fails
 */
export const percolate = withErrorHandling(
  (gameState, pt, cmax, an) => {
    // Destructure required variables from gameState
    const { cel, join, num, next_f, cel_max } = gameState;

    // Ensure minimum territory size
    const targetSize = Math.max(cmax, 3);
    const opos = pt; // Starting cell position

    // Initialize adjacency flags for all cells
    Array.from({ length: cel_max }).forEach((_, i) => {
      next_f[i] = 0;
    });

    // Initial growth phase - add cells until target size or no more available
    let cellCount = 0;
    let currentPos = opos;

    // Territory growth process
    const growTerritory = () => {
      cel[currentPos] = an;
      cellCount++;

      // Mark all adjacent cells as candidates for growth
      Array.from({ length: 6 })
        .map((_, i) => join[currentPos].dir[i])
        .filter(pos => pos >= 0)
        .forEach(pos => {
          next_f[pos] = 1; // Mark as adjacent
        });

      // Find best candidate cell to add next (lowest random priority number)
      const nextCellInfo = Array.from({ length: cel_max })
        .map((_, i) => ({ index: i, priority: num[i] }))
        .filter(
          ({ index }) =>
            next_f[index] === 1 && // Is adjacent
            cel[index] === 0 // Not already in a territory
        )
        .reduce((best, current) => (current.priority < best.priority ? current : best), {
          index: -1,
          priority: 9999,
        });

      // Stop growing if no more cells are available or we've reached target size
      if (nextCellInfo.index === -1 || cellCount >= targetSize) {
        return false;
      }

      // Move to the next position and continue growing
      currentPos = nextCellInfo.index;
      return true;
    };

    // Grow until we can't anymore
    while (growTerritory()) {
      // Continue growing until the condition becomes false
    }

    // Boundary smoothing - add all adjacent cells to avoid single-cell gaps
    const smoothBoundary = () => {
      const addedCells = Array.from({ length: cel_max })
        .map((_, i) => i)
        .filter(
          i =>
            next_f[i] === 1 && // Is adjacent
            cel[i] === 0 // Not already in a territory
        )
        .map(i => {
          // Add this cell to the territory
          cel[i] = an;
          cellCount++;

          // Mark cells adjacent to this one as candidates for the next territory
          return Array.from({ length: 6 })
            .map((_, k) => join[i].dir[k])
            .filter(pos => pos >= 0);
        })
        .flat();

      // Mark cells as available for next territory
      addedCells.forEach(pos => {
        gameState.rcel[pos] = 1;
      });
    };

    smoothBoundary();

    // Emit territory creation event
    gameEvents.emit(EventType.CUSTOM, {
      type: 'territory_created',
      territoryId: an,
      size: cellCount,
      gameState,
    });

    return cellCount; // Return total number of cells in the territory
  },
  (error, gameState, pt, cmax, an) => {
    // Custom error handler for percolate
    console.error(`Failed to grow territory ${an} from cell ${pt}:`, error);

    // Clean up any partially assigned cells
    if (gameState && gameState.cel) {
      for (let i = 0; i < gameState.cel_max; i++) {
        if (gameState.cel[i] === an) {
          gameState.cel[i] = 0; // Reset cell to unassigned
        }
      }
    }

    // Return failure result
    return 0; // Zero cells created
  }
);

/**
 * Border segment data
 *
 * @typedef {Object} BorderSegment
 * @property {number} cell - Cell index
 * @property {number} dir - Direction (0-5 for hexagonal grid)
 */

/**
 * Generate Territory Border Data
 *
 * Creates the data needed to draw a border around a territory.
 * Uses a boundary-following algorithm to trace the perimeter.
 *
 * @param {Object} gameState - Game state including grid and territory data
 * @param {number} old_cel - Starting cell index
 * @param {number} old_dir - Starting direction
 * @throws {TerritoryError} If border generation fails
 */
export const setAreaLine = withErrorHandling((gameState, old_cel, old_dir) => {
  const { cel, join, adat } = gameState;

  let c = old_cel; // Current cell
  let d = old_dir; // Current direction
  const area = cel[c]; // Territory ID

  // Verify area exists
  if (!adat[area]) {
    throw new TerritoryError(`Territory ${area} does not exist`, area);
  }

  // Store line segments as we trace the boundary
  const segments = [];
  segments.push({ cell: c, dir: d });

  // Function to add a segment and update position
  const addSegmentAndMove = () => {
    // Move to next direction
    d = (d + 1) % 6;

    // Check the cell in this direction
    const n = join[c].dir[d];

    // If adjacent cell exists and is same territory, move to that cell
    if (n >= 0 && cel[n] === area) {
      c = n;
      d = (d - 2 + 6) % 6; // Turn 120° counterclockwise (wrap around 0-5)
    }

    // Store this border segment
    segments.push({ cell: c, dir: d });

    // Return true if we've reached the starting point
    return c === old_cel && d === old_dir;
  };

  // Follow the boundary until we return to starting point (or hit safety limit)
  for (let i = 0; i < 100 && !addSegmentAndMove(); i++) {
    // Continue processing until we complete the boundary or hit the safety limit
  }

  // Store the generated line data in the area data
  segments.forEach((segment, index) => {
    adat[area].line_cel[index] = segment.cell;
    adat[area].line_dir[index] = segment.dir;
  });
});

/**
 * Map generation options
 *
 * @typedef {Object} MapGenerationOptions
 * @property {number} territorySizeVariance - How much territory sizes can vary (0-1)
 * @property {number} waterPercentage - Percentage of the map that should be water (0-1)
 * @property {boolean} allowIslands - Whether to allow isolated territories
 */

/**
 * Generate Game Map
 *
 * Creates a procedurally generated map with territories of varied sizes,
 * ensuring good gameplay balance. The algorithm:
 * 1. Creates territories using a growth algorithm
 * 2. Establishes adjacency relationships
 * 3. Distributes territories among players
 * 4. Places initial dice
 *
 * @param {Object} gameState - Game state to modify
 * @param {MapGenerationOptions} [options] - Optional map generation parameters
 * @returns {Object} Updated game state with generated map
 * @throws {GameError} If map generation fails
 */
export const makeMap = withErrorHandling(
  (gameState, options = {}) => {
    // Default options
    const mapOptions = {
      territorySizeVariance: 0.2,
      waterPercentage: 0.1,
      allowIslands: false,
      ...options,
    };

    // Emit map generation start event
    gameEvents.emit(EventType.CUSTOM, {
      type: 'map_generation_start',
      options: mapOptions,
      gameState,
    });

    // Destructure all required variables from gameState
    const { cel, cel_max, XMAX, YMAX, AREA_MAX, num, rcel, join, adat, pmax, chk, put_dice } =
      gameState;

    /*
     * --------------------------------------------------------
     *  RANDOMIZATION AND INITIALIZATION
     * --------------------------------------------------------
     */

    // Randomize cell order for territory generation
    Array.from({ length: cel_max }).forEach((_, i) => {
      const r = Math.floor(Math.random() * cel_max);
      [num[i], num[r]] = [num[r], num[i]]; // ES6 swap
    });

    // Initialize all cells and adjacency data
    Array.from({ length: cel_max }).forEach((_, i) => {
      cel[i] = 0; // No territory assigned yet
      rcel[i] = 0; // Not available for expansion yet
    });

    // Start the first territory (area number 1)
    let an = 1; // Territory ID counter

    // Pick a random starting cell and mark it available for territory growth
    rcel[Math.floor(Math.random() * cel_max)] = 1;

    // Create territories until we run out of space or reach maximum count
    const createTerritories = () => {
      while (an < AREA_MAX) {
        // Find the next starting position using functional approach
        const nextPosition = Array.from({ length: cel_max })
          .map((_, i) => ({ index: i, priority: num[i] }))
          .filter(
            ({ index }) =>
              cel[index] === 0 && // Not already in a territory
              rcel[index] === 1 // Available for expansion
          )
          .reduce((best, current) => (current.priority < best.priority ? current : best), {
            index: -1,
            priority: 9999,
          });

        // No more cells available for territory creation
        if (nextPosition.index === -1) break;

        // Determine territory target size with some variance
        const targetSize = Math.max(
          3,
          Math.floor(8 * (1 + (Math.random() * 2 - 1) * mapOptions.territorySizeVariance))
        );

        // Start penetration (territory growth)
        const ret = percolate(gameState, nextPosition.index, targetSize, an);
        if (ret === 0) break;

        an++;
      }
    };

    createTerritories();

    // Remove single-cell areas in sea using functional approach
    const fillSingleCellGaps = () => {
      Array.from({ length: cel_max })
        .map((_, i) => i)
        .filter(i => cel[i] === 0) // Only consider empty cells
        .forEach(i => {
          // Check all neighboring cells
          const neighborInfo = Array.from({ length: 6 })
            .map((_, k) => join[i].dir[k])
            .filter(pos => pos >= 0)
            .reduce(
              (info, pos) => {
                if (cel[pos] === 0) info.hasEmptyNeighbor = true;
                else info.filledNeighborId = cel[pos];
                return info;
              },
              { hasEmptyNeighbor: false, filledNeighborId: 0 }
            );

          // If the cell is completely surrounded by a territory, make it part of that territory
          if (!neighborInfo.hasEmptyNeighbor && neighborInfo.filledNeighborId > 0) {
            cel[i] = neighborInfo.filledNeighborId;
          }
        });
    };

    fillSingleCellGaps();

    // Initialize area data
    Array.from({ length: AREA_MAX }).forEach((_, i) => {
      gameState.adat[i] = new AreaData();
    });

    // Calculate area sizes using functional approach
    Array.from({ length: cel_max })
      .map((_, i) => cel[i])
      .filter(areaId => areaId > 0)
      .forEach(areaId => {
        adat[areaId].size++;
      });

    // Remove areas with size <= 5
    const invalidAreas = Array.from({ length: AREA_MAX })
      .map((_, i) => i)
      .filter(i => i > 0 && adat[i].size <= 5);

    invalidAreas.forEach(i => {
      adat[i].size = 0;
    });

    // Clear cells belonging to removed areas
    Array.from({ length: cel_max })
      .map((_, i) => ({ index: i, areaId: cel[i] }))
      .filter(({ areaId }) => areaId > 0 && adat[areaId].size === 0)
      .forEach(({ index }) => {
        cel[index] = 0;
      });

    // Initialize area boundaries
    Array.from({ length: AREA_MAX })
      .map((_, i) => i)
      .filter(i => i > 0)
      .forEach(i => {
        adat[i].left = XMAX;
        adat[i].right = -1;
        adat[i].top = YMAX;
        adat[i].bottom = -1;
        adat[i].len_min = 9999;
      });

    // Calculate area boundaries
    const updateAreaBoundaries = () => {
      let c = 0;
      for (let i = 0; i < YMAX; i++) {
        for (let j = 0; j < XMAX; j++) {
          const areaId = cel[c];
          if (areaId > 0) {
            adat[areaId].left = Math.min(adat[areaId].left, j);
            adat[areaId].right = Math.max(adat[areaId].right, j);
            adat[areaId].top = Math.min(adat[areaId].top, i);
            adat[areaId].bottom = Math.max(adat[areaId].bottom, i);
          }
          c++;
        }
      }
    };

    updateAreaBoundaries();

    // Calculate area centers
    Array.from({ length: AREA_MAX })
      .map((_, i) => i)
      .filter(i => i > 0)
      .forEach(i => {
        adat[i].cx = Math.floor((adat[i].left + adat[i].right) / 2);
        adat[i].cy = Math.floor((adat[i].top + adat[i].bottom) / 2);
      });

    // Find optimal center positions and establish adjacency
    const establishAdjacency = () => {
      let c = 0;
      for (let i = 0; i < YMAX; i++) {
        for (let j = 0; j < XMAX; j++) {
          const areaId = cel[c];
          if (areaId > 0) {
            // Distance from center (avoiding boundary lines)
            const x = Math.abs(adat[areaId].cx - j);
            const y = Math.abs(adat[areaId].cy - i);
            let len = x + y;

            /*
             * Check for adjacency to other territories
             * Create a function outside the loop to check adjacency
             */
            const checkAdjacency = (cellIndex, areaIdentifier) =>
              Array.from({ length: 6 })
                .map((_, k) => ({ dir: k, pos: join[cellIndex].dir[k] }))
                .filter(({ pos }) => pos > 0)
                .map(({ pos }) => ({ pos, areaId: cel[pos] }))
                .filter(({ areaId: adjAreaId }) => adjAreaId !== areaIdentifier && adjAreaId > 0);

            const adjacencyInfo = checkAdjacency(c, areaId);

            // If this cell has adjacent territories, it's on a border
            const isBorder = adjacencyInfo.length > 0;

            // Create adjacency data
            adjacencyInfo.forEach(({ areaId: adjAreaId }) => {
              adat[areaId].join[adjAreaId] = 1;
            });

            // Cells on territory borders get lower priority for center
            if (isBorder) len += 4;

            // Use closest point as center
            if (len < adat[areaId].len_min) {
              adat[areaId].len_min = len;
              adat[areaId].cpos = i * XMAX + j;
            }
          }
          c++;
        }
      }
    };

    establishAdjacency();

    /*
     * Determine area player affiliations (distribute territories among players)
     * Initialize ownership
     */
    Array.from({ length: AREA_MAX }).forEach((_, i) => {
      adat[i].arm = -1;
    });

    // Distribute territories to players
    const distributeTerritoriesAmongPlayers = () => {
      let arm = 0; // Current player to assign

      // Loop until no unassigned territories remain
      let hasUnassignedTerritories = true;
      while (hasUnassignedTerritories) {
        // Find unassigned territories
        const unassignedTerritories = Array.from({ length: AREA_MAX })
          .map((_, i) => i)
          .filter(i => i > 0 && adat[i].size > 0 && adat[i].arm < 0);

        // All territories have been assigned
        if (unassignedTerritories.length === 0) {
          hasUnassignedTerritories = false;
          break;
        }

        // Randomly select a territory to assign to the current player
        const randomIndex = Math.floor(Math.random() * unassignedTerritories.length);
        const assignedTerritory = unassignedTerritories[randomIndex];
        adat[assignedTerritory].arm = arm;

        // Move to next player (cycling back to 0 after reaching max)
        arm = (arm + 1) % pmax;
      }
    };

    distributeTerritoriesAmongPlayers();

    // Create area drawing line data (for borders)
    Array.from({ length: AREA_MAX }).forEach((_, i) => {
      chk[i] = 0;
    });

    // Set up border drawing data for each territory
    const generateBorderData = () => {
      Array.from({ length: cel_max })
        .map((_, i) => ({ index: i, areaId: cel[i] }))
        .filter(({ areaId }) => areaId > 0 && chk[areaId] === 0)
        .forEach(({ index, areaId }) => {
          // Find a cell on the border of this territory
          const borderDir = Array.from({ length: 6 })
            .map((_, k) => ({ dir: k, neighbor: join[index].dir[k] }))
            .find(({ neighbor }) => neighbor >= 0 && cel[neighbor] !== areaId);

          // If we found a border, generate the line data
          if (borderDir) {
            setAreaLine(gameState, index, borderDir.dir);
            chk[areaId] = 1;
          }
        });
    };

    generateBorderData();

    /*
     * Place dice
     * Count valid territories and initialize with 1 die each
     */
    const validTerritoryCount = Array.from({ length: AREA_MAX })
      .map((_, i) => i)
      .filter(i => i > 0 && adat[i].size > 0)
      .map(i => {
        adat[i].dice = 1; // Start with 1 die per territory
        return i;
      }).length;

    // Calculate additional dice to distribute
    const additionalDice = validTerritoryCount * (put_dice - 1);

    // Distribute remaining dice
    const distributeDice = () => {
      let p = 0; // Current player for dice distribution

      // For each die to distribute
      Array.from({ length: additionalDice }).forEach(() => {
        // Find territories owned by current player that can receive dice
        const eligibleTerritories = Array.from({ length: AREA_MAX })
          .map((_, j) => j)
          .filter(
            j => j > 0 && adat[j].size > 0 && adat[j].arm === p && adat[j].dice < 8 // Max 8 dice per territory
          );

        if (eligibleTerritories.length > 0) {
          // Randomly select a territory and add a die
          const randomIndex = Math.floor(Math.random() * eligibleTerritories.length);
          const selectedTerritory = eligibleTerritories[randomIndex];
          adat[selectedTerritory].dice++;
        }

        // Move to next player
        p = (p + 1) % pmax;
      });
    };

    distributeDice();

    // Calculate connected territories for each player
    Array.from({ length: pmax }).forEach((_, p) => {
      setAreaTc(gameState, p);
    });

    // Emit map generation complete event
    gameEvents.emit(EventType.CUSTOM, {
      type: 'map_generation_complete',
      territoriesCreated: an - 1,
      gameState,
    });

    return gameState;
  },
  error => {
    // Custom error handler for makeMap
    console.error('Map generation failed:', error);

    // Emit error event
    gameEvents.emit(EventType.CUSTOM, {
      type: 'map_generation_error',
      error: {
        message: error.message,
        name: error.name,
        code: error.code || 'UNKNOWN',
      },
    });

    // Return failure result
    throw new GameError(`Failed to generate map: ${error.message}`, 'ERR_MAP_GENERATION', {
      originalError: error,
    });
  }
);

/**
 * Calculate Connected Territory Groups
 *
 * Finds the largest connected group of territories for a player.
 * Uses a union-find algorithm to identify connected components.
 *
 * @param {Object} gameState - Game state including territory data
 * @param {number} pn - Player number/index
 * @throws {GameError} If territory connectivity calculation fails
 */
export const setAreaTc = withErrorHandling((gameState, pn) => {
  const { player, adat, AREA_MAX, chk, tc } = gameState;

  // Validate player
  if (!player[pn]) {
    throw new GameError(`Player ${pn} does not exist`, 'ERR_PLAYER_NOT_FOUND');
  }

  player[pn].area_tc = 0;

  // Initialize each area as its own group (union-find algorithm)
  Array.from({ length: AREA_MAX }).forEach((_, i) => {
    chk[i] = i;
  });

  // Find all areas owned by this player
  const playerAreas = Array.from({ length: AREA_MAX })
    .map((_, i) => i)
    .filter(i => i > 0 && adat[i].size > 0 && adat[i].arm === pn);

  // Union-find algorithm to group connected territories
  const findRoot = id => {
    if (chk[id] === id) return id;
    // Path compression - set parent to root directly
    chk[id] = findRoot(chk[id]);
    return chk[id];
  };

  const unionAreas = (a, b) => {
    const rootA = findRoot(a);
    const rootB = findRoot(b);
    if (rootA !== rootB) {
      // Union by rank (smaller ID becomes the root)
      if (rootA < rootB) chk[rootB] = rootA;
      else chk[rootA] = rootB;
      return true; // Merge occurred
    }
    return false; // Already in same group
  };

  // Iteratively merge adjacent areas until no more merges occur
  const mergeConnectedTerritories = () => {
    let mergeOccurred;
    do {
      mergeOccurred = false;

      // Define a function outside the loop that returns whether a merge occurred
      const attemptMerge = (areaId, adjAreaId) => unionAreas(areaId, adjAreaId);

      for (let i = 0; i < playerAreas.length; i++) {
        const areaId = playerAreas[i];
        // Extract the filter logic to a predicate function
        const isAdjacentPlayerArea = j =>
          j > 0 && adat[j].size > 0 && adat[j].arm === pn && adat[areaId].join[j] === 1;

        const adjacentAreas = Array.from({ length: AREA_MAX })
          .map((_, j) => j)
          .filter(isAdjacentPlayerArea);

        // Try to merge with each adjacent area
        for (const adjAreaId of adjacentAreas) {
          if (attemptMerge(areaId, adjAreaId)) {
            mergeOccurred = true;
          }
        }
      }
    } while (mergeOccurred);
  };

  mergeConnectedTerritories();

  // Count the size of each territory group
  Array.from({ length: AREA_MAX }).forEach((_, i) => {
    tc[i] = 0;
  });

  // Count territories in each group
  playerAreas.forEach(areaId => {
    const groupId = findRoot(areaId);
    tc[groupId]++;
  });

  // Find the largest group
  player[pn].area_tc = Math.max(...tc);
});
