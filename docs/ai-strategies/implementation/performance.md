# Performance considerations

Techniques to keep your AI's turns fast.

## Why it matters

1. **Turn-based gameplay** - A slow bot makes the game feel sluggish to the human at the table
2. **Multiple AI players** - Several bots per game multiplies any slowdown
3. **Nested loops** - The naive attacker×defender scan is already O(n²) over territories, before any evaluation
4. **Browser environment** - Your bot shares the main thread with rendering

## Key performance techniques

### 1. Precalculate and cache data

Avoid recalculating the same data multiple times:

```javascript
function ai_efficient(game) {
  // Precalculate territory information once
  const territoryInfo = new Array(game.AREA_MAX);

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;

    territoryInfo[i] = {
      owner: game.adat[i].arm,
      dice: game.adat[i].dice,
      neighbors: getNeighbors(game, i),
      isBorder: false,
      connectivityScore: 0,
      // ...other useful information
    };

    // Determine if this is a border territory
    for (const neighbor of territoryInfo[i].neighbors) {
      if (game.adat[neighbor].arm !== territoryInfo[i].owner) {
        territoryInfo[i].isBorder = true;
        break;
      }
    }

    // Calculate connectivity
    territoryInfo[i].connectivityScore = territoryInfo[i].neighbors.length;
  }

  // Now use the cached data for all subsequent calculations
  // ...rest of the AI implementation
}

function getNeighbors(game, territoryId) {
  const neighbors = [];

  for (let j = 1; j < game.AREA_MAX; j++) {
    if (game.adat[j].size === 0) continue;
    if (game.adat[territoryId].join[j]) {
      neighbors.push(j);
    }
  }

  return neighbors;
}
```

### 2. Early filtering

Eliminate invalid moves before running any expensive evaluation:

```javascript
function generateMoves(game, strategy, currentPlayer) {
  const possibleMoves = [];

  // First, identify potential attackers (our territories with >1 dice)
  const potentialAttackers = [];
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== currentPlayer) continue;
    if (game.adat[i].dice <= 1) continue;

    potentialAttackers.push(i);
  }

  // Then for each attacker, find potential targets
  for (const attacker of potentialAttackers) {
    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === currentPlayer) continue;
      if (!game.adat[attacker].join[j]) continue;

      // Basic dice advantage filter
      if (game.adat[attacker].dice <= game.adat[j].dice) continue;

      // Only now do the more expensive evaluation
      const value = evaluateMove(game, attacker, j, strategy);

      possibleMoves.push({
        from: attacker,
        to: j,
        value: value,
      });
    }
  }

  return possibleMoves;
}
```

### 3. Avoid deep copy operations

Simulate on the live state and restore it, rather than deep-copying the whole game:

```javascript
// AVOID: Creating expensive copies
function simulateAttack(game, from, to) {
  // This is expensive - creates a deep copy of the entire game state
  const gameCopy = JSON.parse(JSON.stringify(game));

  // Simulate the attack
  gameCopy.adat[to].arm = gameCopy.adat[from].arm;
  gameCopy.adat[to].dice = gameCopy.adat[from].dice - 1;
  gameCopy.adat[from].dice = 1;

  return evaluateGameState(gameCopy);
}

// BETTER: Use in-place modification and restoration
function simulateAttack(game, from, to) {
  // Save original state
  const originalToOwner = game.adat[to].arm;
  const originalToDice = game.adat[to].dice;
  const originalFromDice = game.adat[from].dice;

  // Temporarily modify in-place
  game.adat[to].arm = game.adat[from].arm;
  game.adat[to].dice = game.adat[from].dice - 1;
  game.adat[from].dice = 1;

  // Evaluate the modified state
  const evaluation = evaluateGameState(game);

  // Restore original state
  game.adat[to].arm = originalToOwner;
  game.adat[to].dice = originalToDice;
  game.adat[from].dice = originalFromDice;

  return evaluation;
}
```

### 4. Use array-based data structures

Indexed arrays beat object literals for per-territory lookups:

```javascript
// LESS EFFICIENT: Using object properties for lookup
function generateMoves(game, strategy, currentPlayer) {
  const possibleMoves = [];
  const validAttackers = {};

  // Mark valid attackers
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size !== 0 && game.adat[i].arm === currentPlayer && game.adat[i].dice > 1) {
      validAttackers[i] = true;
    }
  }

  // Check each potential target
  for (let j = 1; j < game.AREA_MAX; j++) {
    if (game.adat[j].size === 0) continue;
    if (game.adat[j].arm === currentPlayer) continue;

    // Check each potential attacker
    for (let i = 1; i < game.AREA_MAX; i++) {
      if (!validAttackers[i]) continue;
      if (!game.adat[i].join[j]) continue;

      // ... rest of the move generation
    }
  }
}

// MORE EFFICIENT: Using arrays
function generateMoves(game, strategy, currentPlayer) {
  const possibleMoves = [];
  const validAttackers = new Array(game.AREA_MAX).fill(false);

  // Mark valid attackers
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size !== 0 && game.adat[i].arm === currentPlayer && game.adat[i].dice > 1) {
      validAttackers[i] = true;
    }
  }

  // Rest of the implementation...
}
```

### 5. Implement efficient graph algorithms

Much of a DiceWars bot is graph work over the adjacency data:

```javascript
// EFFICIENT: Finding connected territory groups with BFS
function findConnectedTerritories(game, startTerritory, player) {
  const visited = new Array(game.AREA_MAX).fill(false);
  const group = [];
  const queue = [startTerritory];

  visited[startTerritory] = true;
  group.push(startTerritory);

  while (queue.length > 0) {
    const current = queue.shift();

    // Check all adjacent territories
    for (let i = 1; i < game.AREA_MAX; i++) {
      if (game.adat[i].size === 0) continue;
      if (game.adat[i].arm !== player) continue;
      if (!game.adat[current].join[i]) continue;
      if (visited[i]) continue;

      visited[i] = true;
      group.push(i);
      queue.push(i);
    }
  }

  return group;
}
```

### 6. Prefer iteration over recursion

Browser JavaScript has limited stack depth. Prefer iterative algorithms:

```javascript
// AVOID: Recursive DFS (can cause stack overflow on large maps)
function findLargestGroup(game, player, territory, visited = {}) {
  visited[territory] = true;
  let groupSize = 1;

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;
    if (!game.adat[territory].join[i]) continue;
    if (visited[i]) continue;

    groupSize += findLargestGroup(game, player, i, visited);
  }

  return groupSize;
}

// BETTER: Iterative BFS
function findLargestGroup(game, player) {
  const visited = new Array(game.AREA_MAX).fill(false);
  let largestGroup = 0;

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;
    if (visited[i]) continue;

    // Start a new BFS from this unvisited territory
    const groupSize = bfsGroupSize(game, player, i, visited);
    largestGroup = Math.max(largestGroup, groupSize);
  }

  return largestGroup;
}

function bfsGroupSize(game, player, start, visited) {
  const queue = [start];
  visited[start] = true;
  let groupSize = 1;

  while (queue.length > 0) {
    const current = queue.shift();

    for (let i = 1; i < game.AREA_MAX; i++) {
      if (game.adat[i].size === 0) continue;
      if (game.adat[i].arm !== player) continue;
      if (!game.adat[current].join[i]) continue;
      if (visited[i]) continue;

      visited[i] = true;
      queue.push(i);
      groupSize++;
    }
  }

  return groupSize;
}
```

### 7. Avoid excessive object creation

Many small short-lived objects mean frequent garbage collection pauses:

```javascript
// LESS EFFICIENT: Creating many small objects in a loop
function evaluateAllTerritories(game, player) {
  const evaluations = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    // Creates a new object for every territory
    evaluations.push({
      territory: i,
      value: calculateTerritoryValue(game, i),
      isBorder: isBorderTerritory(game, i),
      connectedness: countConnectedTerritories(game, i, player),
    });
  }

  return evaluations;
}

// MORE EFFICIENT: Reuse objects or use arrays
function evaluateAllTerritories(game, player) {
  const values = new Array(game.AREA_MAX).fill(0);
  const isBorder = new Array(game.AREA_MAX).fill(false);
  const connectedness = new Array(game.AREA_MAX).fill(0);

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    values[i] = calculateTerritoryValue(game, i);
    isBorder[i] = checkIfBorderTerritory(game, i);
    connectedness[i] = countConnectedTerritories(game, i, player);
  }

  return { values, isBorder, connectedness };
}
```

### 8. Use bitwise operations for simple flags

For per-territory boolean flags, one integer of bit flags beats several parallel arrays:

```javascript
// Using bitwise operations for territory flags
const TERRITORY_FLAGS = {
  BORDER: 1, // 001
  CHOKE_POINT: 2, // 010
  CONNECTED: 4, // 100
};

function analyzeTerritories(game, player) {
  const flags = new Array(game.AREA_MAX).fill(0);

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    // Check border status
    if (isBorderTerritory(game, i)) {
      flags[i] |= TERRITORY_FLAGS.BORDER; // Set border flag
    }

    // Check choke point status
    if (isChokePoint(game, i)) {
      flags[i] |= TERRITORY_FLAGS.CHOKE_POINT; // Set choke point flag
    }

    // Check connectivity
    if (isInLargestGroup(game, i, player)) {
      flags[i] |= TERRITORY_FLAGS.CONNECTED; // Set connected flag
    }
  }

  // Later, check flags quickly
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (flags[i] & TERRITORY_FLAGS.BORDER) {
      // This is a border territory
    }

    if (flags[i] & TERRITORY_FLAGS.CHOKE_POINT && flags[i] & TERRITORY_FLAGS.BORDER) {
      // Both a border and a choke point: high priority
    }
  }
}
```

### 9. Profile before optimizing

If your AI is still slow, find the actual bottleneck before rewriting anything:

1. Use the browser's performance profiler to identify slow functions
2. Add console.time() / console.timeEnd() pairs around specific operations
3. Count how many times the expensive functions actually run

Example performance tracking:

```javascript
function ai_your_name(game) {
  // Start timing the entire AI turn
  console.time('AI Turn');

  // Time individual components
  console.time('Game State Analysis');
  const gameState = analyzeGameState(game);
  console.timeEnd('Game State Analysis');

  console.time('Strategy Determination');
  const strategy = determineStrategy(gameState);
  console.timeEnd('Strategy Determination');

  console.time('Move Generation');
  const moves = generateMoves(game, strategy);
  console.timeEnd('Move Generation');

  console.time('Move Selection');
  const selectedMove = selectBestMove(moves, strategy);
  console.timeEnd('Move Selection');

  // End timing the entire AI turn
  console.timeEnd('AI Turn');

  // Execute the selected move
  if (!selectedMove) return 0;

  game.area_from = selectedMove.from;
  game.area_to = selectedMove.to;
}
```

### 10. Algorithmic optimizations

1. **Pruning** - Drop clearly inferior moves before full evaluation
2. **Approximation** - Use a cheaper estimate where exactness doesn't change the decision
3. **Progressive refinement** - Score everything cheaply, then re-score only the promising moves in detail

Example of progressive refinement:

```javascript
function selectBestMove(game, currentPlayer) {
  // Phase 1: Quick filtering - generate all moves with basic criteria
  const candidateMoves = generateBasicMoves(game, currentPlayer);

  if (candidateMoves.length === 0) return null;
  if (candidateMoves.length === 1) return candidateMoves[0];

  // Phase 2: Basic evaluation - evaluate moves with simple heuristics
  const evaluatedMoves = evaluateMovesBasic(game, candidateMoves);

  // Take top 25% of moves for deeper analysis
  evaluatedMoves.sort((a, b) => b.basicValue - a.basicValue);
  const topCandidates = evaluatedMoves.slice(0, Math.max(3, Math.ceil(evaluatedMoves.length / 4)));

  // Phase 3: Detailed evaluation - only perform expensive calculations on top candidates
  for (const move of topCandidates) {
    move.detailedValue = evaluateMoveDetailed(game, move.from, move.to);
  }

  // Sort by detailed value and return the best move
  topCandidates.sort((a, b) => b.detailedValue - a.detailedValue);
  return topCandidates[0];
}
```

## Common performance pitfalls

### 1. Recalculating the same data

```javascript
// BAD: Calculates neighbor info multiple times for the same territory
function evaluateMove(game, from, to) {
  const fromNeighbors = getNeighborInfo(game, from);
  // ... some evaluation logic

  const targetValue = calculateTargetValue(game, to);
  // More evaluation that calls getNeighborInfo(game, from) again

  const risk = calculateRisk(game, from, to);
  // More evaluation that calls getNeighborInfo(game, from) yet again
}

// GOOD: Calculate once and reuse
function evaluateMove(game, from, to) {
  const fromNeighbors = getNeighborInfo(game, from);
  const toNeighbors = getNeighborInfo(game, to);

  const targetValue = calculateTargetValue(game, to, toNeighbors);
  const risk = calculateRisk(game, from, to, fromNeighbors);
  // ... rest of the evaluation
}
```

### 2. Excessive iteration

```javascript
// BAD: Iterates through all territories multiple times
function findBestTerritory(game, player) {
  let bestValue = -1;
  let bestTerritory = -1;

  // First pass - find the highest dice count
  let maxDice = 0;
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    if (game.adat[i].dice > maxDice) {
      maxDice = game.adat[i].dice;
    }
  }

  // Second pass - find territories with the highest dice
  const highDiceTerritories = [];
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    if (game.adat[i].dice === maxDice) {
      highDiceTerritories.push(i);
    }
  }

  // Third pass - evaluate the filtered territories
  for (const territory of highDiceTerritories) {
    const value = evaluateTerritory(game, territory);
    if (value > bestValue) {
      bestValue = value;
      bestTerritory = territory;
    }
  }

  return bestTerritory;
}

// GOOD: Single pass with tracking
function findBestTerritory(game, player) {
  let bestValue = -1;
  let bestTerritory = -1;
  let maxDice = 0;
  const highDiceTerritories = [];

  // First pass - find max dice and record territories with max dice
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    if (game.adat[i].dice > maxDice) {
      maxDice = game.adat[i].dice;
      highDiceTerritories.length = 0;
      highDiceTerritories.push(i);
    } else if (game.adat[i].dice === maxDice) {
      highDiceTerritories.push(i);
    }
  }

  // Evaluate only the filtered territories
  for (const territory of highDiceTerritories) {
    const value = evaluateTerritory(game, territory);
    if (value > bestValue) {
      bestValue = value;
      bestTerritory = territory;
    }
  }

  return bestTerritory;
}
```

### 3. Inefficient data lookups

```javascript
// BAD: Repeated map lookups with string keys
function analyzeGameState(game) {
  const playerStats = {};

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;

    const player = game.adat[i].arm;
    const playerKey = `player_${player}`;

    if (!playerStats[playerKey]) {
      playerStats[playerKey] = {
        territories: 0,
        dice: 0,
      };
    }

    playerStats[playerKey].territories++;
    playerStats[playerKey].dice += game.adat[i].dice;
  }

  return playerStats;
}

// GOOD: Array-based lookups
function analyzeGameState(game) {
  const playerTerritories = new Array(8).fill(0);
  const playerDice = new Array(8).fill(0);

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;

    const player = game.adat[i].arm;
    playerTerritories[player]++;
    playerDice[player] += game.adat[i].dice;
  }

  return { playerTerritories, playerDice };
}
```

## Performance-critical functions

These run the most times per turn, so optimize them first:

1. **Neighbor analysis** - Runs for every move you evaluate
2. **Territory evaluation** - Called for many territories each turn
3. **Move generation** - Must filter invalid moves cheaply
4. **Connectivity analysis** - Graph traversal is the expensive one, and everything wants it

Example optimization for connectivity analysis:

```javascript
// Efficient implementation for finding connected territories
// This version uses an iterative approach and avoids recursion
function getConnectedTerritories(game, player) {
  const visited = new Array(game.AREA_MAX).fill(false);
  const groups = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;
    if (visited[i]) continue;

    // Found an unvisited territory, start a new group
    const group = [];
    const queue = [i];
    visited[i] = true;

    while (queue.length > 0) {
      const current = queue.shift();
      group.push(current);

      // Add all adjacent territories of same player
      for (let j = 1; j < game.AREA_MAX; j++) {
        if (game.adat[j].size === 0) continue;
        if (game.adat[j].arm !== player) continue;
        if (visited[j]) continue;
        if (!game.adat[current].join[j]) continue;

        visited[j] = true;
        queue.push(j);
      }
    }

    groups.push(group);
  }

  return groups;
}
```
