/**
 * Enhanced Map Generator Module
 *
 * An ES6+ implementation of the map generator module that uses modern data structures
 * like Maps for better performance. This module provides functions for procedurally
 * generating game maps with territories of varied sizes.
 */

import { AreaData, JoinData } from '../../models/enhanced/index.js';

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
 */
export function percolate(gameState, pt, cmax, an) {
  // Destructure required variables from gameState
  const { cel, join, num, next_f, cel_max } = gameState;

  // Ensure minimum territory size
  if (cmax < 3) cmax = 3;

  const opos = pt; // Starting cell position

  // Initialize adjacency flags for all cells
  for (let i = 0; i < cel_max; i++) next_f[i] = 0;

  // Initial growth phase - add cells until target size or no more available
  let c = 0; // Cell count
  let currentPos = opos;

  while (true) {
    // Add current cell to territory
    cel[currentPos] = an;
    c++;

    // Mark all adjacent cells as candidates for growth
    for (let i = 0; i < 6; i++) {
      const pos = join[currentPos].dir[i];
      if (pos < 0) continue; // Skip out-of-bounds
      next_f[pos] = 1; // Mark as adjacent
    }

    // Find best candidate cell to add next (lowest random priority number)
    let min = 9999;
    let nextPos = -1;

    for (let i = 0; i < cel_max; i++) {
      if (next_f[i] === 0) continue; // Skip non-adjacent cells
      if (cel[i] > 0) continue; // Skip cells already in territories
      if (num[i] > min) continue; // Skip cells with higher priority

      min = num[i];
      nextPos = i; // This becomes the next cell to add
    }

    // Stop growing if no more cells are available or we've reached target size
    if (min === 9999 || nextPos === -1) break; // No more adjacent cells
    if (c >= cmax) break; // Reached target size

    // Move to the next position
    currentPos = nextPos;
  }

  // Boundary smoothing - add all adjacent cells to avoid single-cell gaps
  for (let i = 0; i < cel_max; i++) {
    if (next_f[i] === 0) continue; // Skip non-adjacent cells
    if (cel[i] > 0) continue; // Skip cells already in territories

    // Add this cell to the territory
    cel[i] = an;
    c++;

    // Mark cells adjacent to this one as candidates for the next territory
    for (let k = 0; k < 6; k++) {
      const pos = join[i].dir[k];
      if (pos < 0) continue; // Skip out-of-bounds
      gameState.rcel[pos] = 1; // Mark as available for next territory
    }
  }

  return c; // Return total number of cells in the territory
}

/**
 * Generate Territory Border Data
 *
 * Creates the data needed to draw a border around a territory.
 * Uses a boundary-following algorithm to trace the perimeter.
 *
 * @param {Object} gameState - Game state including grid and territory data
 * @param {number} old_cel - Starting cell index
 * @param {number} old_dir - Starting direction
 */
export function setAreaLine(gameState, old_cel, old_dir) {
  const { cel, join, adat } = gameState;

  let c = old_cel; // Current cell
  let d = old_dir; // Current direction
  const area = cel[c]; // Territory ID
  let cnt = 0; // Border segment counter

  // Store the first border segment
  adat[area].line_cel[cnt] = c;
  adat[area].line_dir[cnt] = d;
  cnt++;

  // Follow the boundary until we return to starting point
  for (let i = 0; i < 100; i++) {
    /*
     * Safety limit of 100 segments
     * Move to next direction
     */
    d++;
    if (d >= 6) d = 0; // Direction wraps around 0-5

    // Check the cell in this direction
    const n = join[c].dir[d];
    if (n >= 0) {
      // If not out of bounds
      if (cel[n] === area) {
        /*
         * If adjacent cell is same territory, move to that cell
         * and adjust direction to continue following the boundary
         */
        c = n;
        d -= 2;
        if (d < 0) d += 6; // Turn 120° counterclockwise
      }
    }

    // Store this border segment
    adat[area].line_cel[cnt] = c;
    adat[area].line_dir[cnt] = d;
    cnt++;

    // Stop if we've returned to the starting point
    if (c === old_cel && d === old_dir) break;
  }
}

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
 * @returns {Object} Updated game state with generated map
 */
export function makeMap(gameState) {
  // Destructure all required variables from gameState
  const { cel, cel_max, XMAX, YMAX, AREA_MAX, num, rcel, join, adat, pmax, chk, put_dice } =
    gameState;

  /*
   * --------------------------------------------------------
   *  RANDOMIZATION AND INITIALIZATION
   * --------------------------------------------------------
   */

  // Randomize cell order for territory generation
  for (let i = 0; i < cel_max; i++) {
    const r = Math.floor(Math.random() * cel_max);
    [num[i], num[r]] = [num[r], num[i]]; // ES6 swap
  }

  // Initialize all cells and adjacency data
  for (let i = 0; i < cel_max; i++) {
    cel[i] = 0; // No territory assigned yet
    rcel[i] = 0; // Not available for expansion yet
  }

  // Start the first territory (area number 1)
  let an = 1; // Territory ID counter

  // Pick a random starting cell and mark it available for territory growth
  rcel[Math.floor(Math.random() * cel_max)] = 1;

  // Create territories until we run out of space or reach maximum count
  while (true) {
    // Determine penetration start cell
    let pos = -1;
    let min = 9999;

    for (let i = 0; i < cel_max; i++) {
      if (cel[i] > 0) continue;
      if (num[i] > min) continue;
      if (rcel[i] === 0) continue;

      min = num[i];
      pos = i;
    }

    // No more cells available for territory creation
    if (min === 9999 || pos === -1) break;

    // Start penetration (territory growth)
    const ret = percolate(gameState, pos, 8, an);
    if (ret === 0) break;

    an++;
    if (an >= AREA_MAX) break;
  }

  // Remove single-cell areas in sea
  for (let i = 0; i < cel_max; i++) {
    if (cel[i] > 0) continue;

    let f = 0;
    let a = 0;

    for (let k = 0; k < 6; k++) {
      const pos = join[i].dir[k];
      if (pos < 0) continue;

      if (cel[pos] === 0) f = 1;
      else a = cel[pos];
    }

    if (f === 0) cel[i] = a;
  }

  // Initialize area data with enhanced AreaData objects
  for (let i = 0; i < AREA_MAX; i++) {
    gameState.adat[i] = new AreaData();
  }

  // Calculate area sizes
  for (let i = 0; i < cel_max; i++) {
    an = cel[i];
    if (an > 0) adat[an].size++;
  }

  // Remove areas with size <= 5
  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size <= 5) adat[i].size = 0;
  }

  for (let i = 0; i < cel_max; i++) {
    an = cel[i];
    if (adat[an].size === 0) cel[i] = 0;
  }

  // Determine area center and boundaries
  for (let i = 1; i < AREA_MAX; i++) {
    adat[i].left = XMAX;
    adat[i].right = -1;
    adat[i].top = YMAX;
    adat[i].bottom = -1;
    adat[i].len_min = 9999;
  }

  let c = 0;
  for (let i = 0; i < YMAX; i++) {
    for (let j = 0; j < XMAX; j++) {
      an = cel[c];
      if (an > 0) {
        if (j < adat[an].left) adat[an].left = j;
        if (j > adat[an].right) adat[an].right = j;
        if (i < adat[an].top) adat[an].top = i;
        if (i > adat[an].bottom) adat[an].bottom = i;
      }
      c++;
    }
  }

  // Calculate area centers
  for (let i = 1; i < AREA_MAX; i++) {
    adat[i].cx = Math.floor((adat[i].left + adat[i].right) / 2);
    adat[i].cy = Math.floor((adat[i].top + adat[an].bottom) / 2);
  }

  // Find optimal center positions and establish adjacency
  c = 0;
  for (let i = 0; i < YMAX; i++) {
    for (let j = 0; j < XMAX; j++) {
      an = cel[c];
      if (an > 0) {
        // Distance from center (avoiding boundary lines)
        let x = adat[an].cx - j;
        if (x < 0) x = -x;

        let y = adat[an].cy - i;
        if (y < 0) y = -y;

        let len = x + y;
        let f = 0;

        // Check for adjacency to other territories
        for (let k = 0; k < 6; k++) {
          const pos = join[c].dir[k];
          if (pos > 0) {
            const an2 = cel[pos];
            if (an2 !== an && an2 > 0) {
              f = 1;
              // Create adjacency data using modern Map approach
              adat[an].setAdjacency(an2, 1);
            }
          }
        }

        // Cells on territory borders get lower priority for center
        if (f) len += 4;

        // Use closest point as center
        if (len < adat[an].len_min) {
          adat[an].len_min = len;
          adat[an].cpos = i * XMAX + j;
        }
      }
      c++;
    }
  }

  // Determine area player affiliations (distribute territories among players)
  for (let i = 0; i < AREA_MAX; i++) {
    adat[i].arm = -1;
  }

  let arm = 0; // Current player to assign
  const alist = new Array(AREA_MAX); // Areas available for assignment

  while (true) {
    let count = 0;

    // Find territories that haven't been assigned yet
    for (let i = 1; i < AREA_MAX; i++) {
      if (adat[i].size === 0) continue;
      if (adat[i].arm >= 0) continue;

      alist[count] = i;
      count++;
    }

    // All territories have been assigned
    if (count === 0) break;

    // Randomly select a territory to assign to the current player
    const an = alist[Math.floor(Math.random() * count)];
    adat[an].arm = arm;

    // Move to next player (cycling back to 0 after reaching max)
    arm = (arm + 1) % pmax;
  }

  // Create area drawing line data (for borders)
  for (let i = 0; i < AREA_MAX; i++) {
    chk[i] = 0;
  }

  // Set up border drawing data for each territory
  for (let i = 0; i < cel_max; i++) {
    const area = cel[i];
    if (area === 0) continue;
    if (chk[area] > 0) continue;

    // Find a cell on the border of this territory
    for (let k = 0; k < 6; k++) {
      if (chk[area] > 0) break;

      const n = join[i].dir[k];
      if (n >= 0) {
        if (cel[n] !== area) {
          setAreaLine(gameState, i, k);
          chk[area] = 1;
        }
      }
    }
  }

  // Place dice
  let anum = 0;
  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size > 0) {
      anum++;
      adat[i].dice = 1; // Start with 1 die per territory
    }
  }

  // Calculate additional dice to distribute
  anum *= put_dice - 1;
  let p = 0; // Current player for dice distribution

  // Distribute remaining dice
  for (let i = 0; i < anum; i++) {
    const list = [];

    // Find territories owned by current player that can receive dice
    for (let j = 1; j < AREA_MAX; j++) {
      if (adat[j].size === 0) continue;
      if (adat[j].arm !== p) continue;
      if (adat[j].dice >= 8) continue; // Max 8 dice per territory

      list.push(j);
    }

    if (list.length === 0) break;

    // Randomly select a territory and add a die
    const an = list[Math.floor(Math.random() * list.length)];
    adat[an].dice++;

    // Move to next player
    p = (p + 1) % pmax;
  }

  return gameState;
}

/**
 * Calculate Connected Territory Groups
 *
 * Finds the largest connected group of territories for a player.
 * Uses a union-find algorithm to identify connected components.
 * Optimized to use Map for tracking territory groups.
 *
 * @param {Object} gameState - Game state including territory data
 * @param {number} pn - Player number/index
 */
export function setAreaTc(gameState, pn) {
  const { player, adat, AREA_MAX, chk, tc } = gameState;

  player[pn].area_tc = 0;

  // Initialize each area as its own group (union-find algorithm)
  for (let i = 0; i < AREA_MAX; i++) chk[i] = i;

  // Combine adjacent areas owned by the same player into groups
  while (true) {
    let f = 0; // Flag to track if any merges were made this iteration

    // Check each territory
    for (let i = 1; i < AREA_MAX; i++) {
      if (adat[i].size === 0) continue; // Skip non-existent areas
      if (adat[i].arm !== pn) continue; // Skip areas not owned by player

      // Get all adjacent territories using modern method
      const adjacentAreas = adat[i].getAdjacentAreas();

      // Check each adjacent territory
      for (const j of adjacentAreas) {
        if (j < 1 || j >= AREA_MAX) continue; // Skip invalid indices
        if (adat[j].size === 0) continue; // Skip non-existent areas
        if (adat[j].arm !== pn) continue; // Skip areas not owned by player
        if (chk[j] === chk[i]) continue; // Skip if already in same group

        // Merge the groups by setting both to the smaller group number
        if (chk[i] > chk[j]) chk[i] = chk[j];
        else chk[j] = chk[i];

        f = 1; // Set flag indicating that a merge occurred
      }
    }

    // If no merges occurred in this iteration, we're done
    if (f === 0) break;
  }

  // Count the size of each territory group
  for (let i = 0; i < AREA_MAX; i++) tc[i] = 0;

  // Count territories in each group
  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size === 0) continue;
    if (adat[i].arm !== pn) continue;
    tc[chk[i]]++; // Increment count for this territory's group
  }

  // Find the largest group
  for (let i = 0; i < AREA_MAX; i++) {
    if (player[pn].area_tc < tc[i]) {
      player[pn].area_tc = tc[i];
    }
  }
}
