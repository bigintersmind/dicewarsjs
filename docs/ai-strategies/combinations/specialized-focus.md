# Specialized focus strategy

Commit the whole bot to one plan: pure offense, pure defense, or a single tactical idea. A specialist beats a generalist in the situations it was built for, and each one plays with a recognizable personality.

## Core concept

Rather than balancing every aspect of gameplay, a specialized bot does one thing well and accepts the weaknesses that come with it.

## Strategy types

### 1. Hyper-aggressive focus

Attack constantly to expand territory, with minimal concern for defense.

```javascript
function ai_aggressive(game) {
  const pn = game.get_pn();
  const validMoves = [];

  // Find all possible attacks with any dice advantage
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === pn) continue;
      if (!game.adat[i].join[j]) continue;

      // Accept attacks with any dice advantage, or even equal dice
      if (game.adat[i].dice >= game.adat[j].dice) {
        validMoves.push({
          from: i,
          to: j,
          advantage: game.adat[i].dice - game.adat[j].dice,
          // Prioritize higher dice targets (more aggressive)
          value: game.adat[i].dice - game.adat[j].dice + game.adat[j].dice * 0.5,
        });
      }
    }
  }

  // No valid moves, end turn
  if (validMoves.length === 0) return 0;

  // Sort by value (highest first)
  validMoves.sort((a, b) => b.value - a.value);

  // Execute the best move
  game.area_from = validMoves[0].from;
  game.area_to = validMoves[0].to;
}
```

### 2. Turtle defense focus

Fortify a small, defensible territory and attack only to shrink the perimeter.

```javascript
function ai_turtle(game) {
  const pn = game.get_pn();

  // Get info about all territories
  const area_info = calculateAreaInfo(game);

  // Only attack when it improves our defensive position
  const defensiveMoves = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === pn) continue;
      if (!game.adat[i].join[j]) continue;

      // Need significant dice advantage for safety
      if (game.adat[i].dice <= game.adat[j].dice + 1) continue;

      // Skip if winning would leave territory vulnerable
      if (area_info[i].highest_unfriendly_neighbor_dice > game.adat[j].dice) continue;

      // Calculate how this attack affects our defensive perimeter
      const defensiveImprovement = calculateDefensiveImprovement(game, i, j, area_info);

      // Only consider attacks that improve our defensive position
      if (defensiveImprovement > 0) {
        defensiveMoves.push({
          from: i,
          to: j,
          improvement: defensiveImprovement,
          advantage: game.adat[i].dice - game.adat[j].dice,
        });
      }
    }
  }

  // No valid defensive moves, end turn
  if (defensiveMoves.length === 0) return 0;

  // Sort by defensive improvement (highest first)
  defensiveMoves.sort((a, b) => b.improvement - a.improvement);

  // Execute the best defensive move
  game.area_from = defensiveMoves[0].from;
  game.area_to = defensiveMoves[0].to;
}

function calculateDefensiveImprovement(game, from, to, area_info) {
  const pn = game.get_pn();

  // Count current border territories
  let currentBorderCount = 0;
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;

    if (area_info[i].unfriendly_neighbors > 0) {
      currentBorderCount++;
    }
  }

  // Simulate the attack
  const originalOwner = game.adat[to].arm;
  game.adat[to].arm = pn;

  // Recalculate area info after the simulated attack
  const newAreaInfo = calculateAreaInfo(game);

  // Count new border territories
  let newBorderCount = 0;
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;

    if (newAreaInfo[i].unfriendly_neighbors > 0) {
      newBorderCount++;
    }
  }

  // Restore original state
  game.adat[to].arm = originalOwner;

  // Calculate the change in defensive perimeter
  // Negative value means we reduced our border (good for defense)
  const borderChange = newBorderCount - currentBorderCount;

  // Additional factors for defensive improvement
  let improvement = -borderChange * 2; // Border reduction is good

  // Bonus for eliminating enemy attack vectors
  improvement += area_info[to].unfriendly_neighbors * 0.5;

  return improvement;
}
```

### 3. Territory connection focus

Maintain and expand one large connected territory group to maximize reinforcements.

```javascript
function ai_connector(game) {
  const pn = game.get_pn();

  // Identify our largest connected territory group
  const largestGroup = identifyLargestTerritoryGroup(game, pn);

  // Look for attacks that would connect separate territory groups
  const connectingMoves = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;
    if (game.adat[i].dice <= 1) continue;

    // Check if this territory is in our largest group
    const inLargestGroup = largestGroup.includes(i);

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === pn) continue;
      if (!game.adat[i].join[j]) continue;

      // Need dice advantage for safety
      if (game.adat[i].dice <= game.adat[j].dice) continue;

      // Check if capturing this territory would connect to another of our territories
      // that isn't already in the same group as the attacker
      let wouldConnect = false;
      let connectingTerritorySize = 0;

      for (let k = 1; k < game.AREA_MAX; k++) {
        if (game.adat[k].size === 0) continue;
        if (game.adat[k].arm !== pn) continue;
        if (!game.adat[j].join[k]) continue;
        if (k === i) continue;

        if (inLargestGroup !== largestGroup.includes(k)) {
          wouldConnect = true;

          // Calculate size of the group that would be connected
          connectingTerritorySize = countConnectedTerritories(game, k, pn);
        }
      }

      if (wouldConnect) {
        connectingMoves.push({
          from: i,
          to: j,
          advantage: game.adat[i].dice - game.adat[j].dice,
          connectingSize: connectingTerritorySize,
          value: game.adat[i].dice - game.adat[j].dice + connectingTerritorySize * 2,
        });
      } else {
        // Still consider regular attacks, but with lower priority
        connectingMoves.push({
          from: i,
          to: j,
          advantage: game.adat[i].dice - game.adat[j].dice,
          connectingSize: 0,
          value: game.adat[i].dice - game.adat[j].dice,
        });
      }
    }
  }

  // No valid moves, end turn
  if (connectingMoves.length === 0) return 0;

  // Sort by value (highest first)
  connectingMoves.sort((a, b) => b.value - a.value);

  // Execute the best move
  game.area_from = connectingMoves[0].from;
  game.area_to = connectingMoves[0].to;
}

function identifyLargestTerritoryGroup(game, player) {
  // Temporarily set up territory tracking arrays
  const groups = [];
  const visited = new Array(game.AREA_MAX).fill(false);

  // Find all connected groups using BFS
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;
    if (visited[i]) continue;

    // Start a new group
    const group = [];
    const queue = [i];
    visited[i] = true;

    while (queue.length > 0) {
      const current = queue.shift();
      group.push(current);

      // Check all adjacent territories
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

  // Find the largest group
  let largestGroup = [];
  for (const group of groups) {
    if (group.length > largestGroup.length) {
      largestGroup = group;
    }
  }

  return largestGroup;
}

function countConnectedTerritories(game, startTerritory, player) {
  const visited = new Array(game.AREA_MAX).fill(false);
  const queue = [startTerritory];
  visited[startTerritory] = true;
  let count = 1;

  while (queue.length > 0) {
    const current = queue.shift();

    // Check all adjacent territories
    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm !== player) continue;
      if (visited[j]) continue;
      if (!game.adat[current].join[j]) continue;

      visited[j] = true;
      queue.push(j);
      count++;
    }
  }

  return count;
}
```

### 4. King-of-the-hill focus

Control the territories with the highest number of connections.

```javascript
function ai_kingofthehill(game) {
  const pn = game.get_pn();

  // Identify "hill" territories (those with many connections)
  const hillTerritories = identifyHillTerritories(game);

  // Generate possible attacks
  const moves = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === pn) continue;
      if (!game.adat[i].join[j]) continue;

      // Need dice advantage
      if (game.adat[i].dice <= game.adat[j].dice) continue;

      let value = game.adat[i].dice - game.adat[j].dice;

      // Huge bonus for attacking hill territories
      if (hillTerritories.includes(j)) {
        value += 10;
      }

      // Bonus for attacking from hill territories (protecting our hills)
      if (hillTerritories.includes(i)) {
        value += 3;
      }

      moves.push({
        from: i,
        to: j,
        value: value,
      });
    }
  }

  // No valid moves, end turn
  if (moves.length === 0) return 0;

  // Sort by value (highest first)
  moves.sort((a, b) => b.value - a.value);

  // Execute the best move
  game.area_from = moves[0].from;
  game.area_to = moves[0].to;
}

function identifyHillTerritories(game) {
  const connectionCounts = new Array(game.AREA_MAX).fill(0);
  const territories = [];

  // Count connections for each territory
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;

    let connections = 0;
    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[i].join[j]) connections++;
    }

    connectionCounts[i] = connections;
    territories.push(i);
  }

  // Sort territories by connection count
  territories.sort((a, b) => connectionCounts[b] - connectionCounts[a]);

  // Return top 20% of territories
  const hillCount = Math.max(1, Math.floor(territories.length * 0.2));
  return territories.slice(0, hillCount);
}
```

### 5. Predator focus

Target the weakest opponent and eliminate them from the game.

```javascript
function ai_predator(game) {
  const pn = game.get_pn();

  // Identify the weakest opponent
  const weakestOpponent = findWeakestOpponent(game);

  // Generate possible attacks
  const moves = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === pn) continue;
      if (!game.adat[i].join[j]) continue;

      // Need dice advantage
      if (game.adat[i].dice <= game.adat[j].dice) continue;

      let value = game.adat[i].dice - game.adat[j].dice;

      // Huge bonus for attacking the weakest opponent
      if (game.adat[j].arm === weakestOpponent) {
        value += 5;

        // Extra bonus if this could eliminate them
        if (isLastTerritory(game, j, weakestOpponent)) {
          value += 10;
        }
      }

      moves.push({
        from: i,
        to: j,
        value: value,
      });
    }
  }

  // No valid moves, end turn
  if (moves.length === 0) return 0;

  // Sort by value (highest first)
  moves.sort((a, b) => b.value - a.value);

  // Execute the best move
  game.area_from = moves[0].from;
  game.area_to = moves[0].to;
}

function findWeakestOpponent(game) {
  const playerStats = [];

  // Gather stats for each player
  for (let i = 0; i < 8; i++) {
    if (i === game.get_pn()) continue; // Skip ourselves

    let territories = 0;
    let totalDice = 0;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm !== i) continue;

      territories++;
      totalDice += game.adat[j].dice;
    }

    if (territories > 0) {
      // Only consider active players
      playerStats.push({
        player: i,
        territories: territories,
        totalDice: totalDice,
        strength: territories * totalDice, // Combined strength metric
      });
    }
  }

  // Sort by strength (lowest first)
  playerStats.sort((a, b) => a.strength - b.strength);

  // Return the weakest player
  return playerStats.length > 0 ? playerStats[0].player : -1;
}

function isLastTerritory(game, territory, player) {
  let count = 0;

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm === player) count++;
    if (count > 1) return false;
  }

  return count === 1;
}
```

## Implementation example: switching specialists

You can also carry several specialists and activate one depending on the situation:

```javascript
function ai_adaptive_specialist(game) {
  const pn = game.get_pn();

  // Analyze game state
  const gameState = analyzeGameState(game);

  // Choose a specialist strategy based on game state
  let strategy;

  if (gameState.gamePhase === 'early') {
    // In early game, focus on expansion
    strategy = 'aggressive';
  } else if (gameState.gamePhase === 'mid') {
    // In mid game, adapt based on our position
    if (gameState.playerRankings[0] === pn) {
      // If we're leading, focus on territory connections
      strategy = 'connector';
    } else if (gameState.territories.byPlayer[pn] < 5) {
      // If we're small, focus on defense
      strategy = 'turtle';
    } else {
      // Otherwise, focus on hills
      strategy = 'kingofthehill';
    }
  } else {
    // In late game, target the weakest
    strategy = 'predator';
  }

  // Execute the chosen specialist strategy
  switch (strategy) {
    case 'aggressive':
      return ai_aggressive(game);
    case 'turtle':
      return ai_turtle(game);
    case 'connector':
      return ai_connector(game);
    case 'kingofthehill':
      return ai_kingofthehill(game);
    case 'predator':
      return ai_predator(game);
    default:
      // Fallback to balanced approach
      return ai_balanced(game);
  }
}
```

## When to use

1. To create distinctive AI personalities
2. In scenarios where one approach is clearly superior
3. To get behavioral variety when several AIs share a game
4. To pose a specific kind of challenge to human players

## Trade-offs

A specialist is often simpler to write than a balanced bot, outperforms one inside its niche, and gives each opponent slot a recognizable character. The price is a clear weakness: a turtle loses the reinforcement race to a connector, an aggressive bot bleeds dice into bad attacks, and once a human player recognizes the pattern they can play around it.
