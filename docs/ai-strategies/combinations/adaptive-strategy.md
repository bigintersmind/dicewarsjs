# Adaptive strategy

An adaptive strategy changes its behavior based on the game state instead of playing the same way every turn.

## Core concept

Re-evaluate the game state each turn and adjust priorities: aggressive when ahead, defensive when threatened, opportunistic when an opening appears.

## Implementation framework

```javascript
function ai_adaptive(game) {
  // Current player
  const pn = game.get_pn();

  // Analyze game state
  const gameState = analyzeGameState(game);

  // Determine strategy based on game state
  const currentStrategy = determineStrategy(game, gameState, pn);

  // Generate moves based on current strategy
  const moves = generateMoves(game, currentStrategy, pn);

  // If no moves available, end turn
  if (moves.length === 0) return 0;

  // Execute best move
  const bestMove = selectBestMove(moves, currentStrategy);
  game.area_from = bestMove.from;
  game.area_to = bestMove.to;
}
```

## Game state analysis

Everything downstream depends on an accurate read of the board:

```javascript
function analyzeGameState(game) {
  const state = {
    playerStats: [],
    territories: {
      total: 0,
      byPlayer: new Array(8).fill(0),
    },
    dice: {
      total: 0,
      byPlayer: new Array(8).fill(0),
    },
    borderTerritories: new Array(8).fill(0),
    playerRankings: [],
    dominantPlayer: -1,
    averageDicePerTerritory: new Array(8).fill(0),
    gamePhase: 'early', // 'early', 'mid', or 'late'
    remainingPlayers: 0,
  };

  // Count territories and dice
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;

    const player = game.adat[i].arm;
    const dice = game.adat[i].dice;

    state.territories.total++;
    state.territories.byPlayer[player]++;

    state.dice.total += dice;
    state.dice.byPlayer[player] += dice;

    // Check if this is a border territory
    let isBorder = false;
    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (!game.adat[i].join[j]) continue;

      if (game.adat[j].arm !== player) {
        isBorder = true;
        break;
      }
    }

    if (isBorder) {
      state.borderTerritories[player]++;
    }
  }

  // Calculate average dice per territory
  for (let i = 0; i < 8; i++) {
    if (state.territories.byPlayer[i] > 0) {
      state.averageDicePerTerritory[i] = state.dice.byPlayer[i] / state.territories.byPlayer[i];
      state.remainingPlayers++;
    }
  }

  // Rank players by dice count
  state.playerRankings = Array(8)
    .fill()
    .map((_, i) => i)
    .sort((a, b) => state.dice.byPlayer[b] - state.dice.byPlayer[a]);

  // Identify dominant player (>40% of total dice)
  for (let i = 0; i < 8; i++) {
    if (state.dice.byPlayer[i] > state.dice.total * 0.4) {
      state.dominantPlayer = i;
      break;
    }
  }

  // Determine game phase
  if (state.territories.total > 0) {
    const territoriesClaimed = state.territories.total / 32; // Assuming 32 max territories
    if (territoriesClaimed < 0.5) state.gamePhase = 'early';
    else if (territoriesClaimed < 0.8) state.gamePhase = 'mid';
    else state.gamePhase = 'late';
  }

  return state;
}
```

## Strategy determination

From the game state analysis, choose a strategy:

```javascript
function determineStrategy(game, gameState, pn) {
  const strategy = {
    aggression: 0.5, // 0 (full defense) to 1 (full offense)
    expansion: 0.5, // 0 (consolidate) to 1 (expand)
    riskTolerance: 0.5, // 0 (risk-averse) to 1 (risk-seeking)
    targetSelection: {
      dominantPlayer: false,
      weakestPlayer: false,
      specificPlayer: -1,
    },
    reinforcementFocus: 'balanced', // 'offensive', 'defensive', or 'balanced'
  };

  // Adjust based on game phase
  switch (gameState.gamePhase) {
    case 'early':
      strategy.aggression = 0.7; // More aggressive early
      strategy.expansion = 0.8; // Focus on expansion
      strategy.riskTolerance = 0.6; // Willing to take more risks
      break;

    case 'mid':
      strategy.aggression = 0.5; // Balanced
      strategy.expansion = 0.5; // Balanced

      // If we're leading, be more conservative
      if (gameState.playerRankings[0] === pn) {
        strategy.aggression = 0.4;
        strategy.riskTolerance = 0.3;
      }

      // If we're behind but not last, be more aggressive
      if (
        gameState.playerRankings.indexOf(pn) > 0 &&
        gameState.playerRankings.indexOf(pn) < gameState.remainingPlayers - 1
      ) {
        strategy.aggression = 0.7;
        strategy.riskTolerance = 0.6;
      }
      break;

    case 'late':
      // In late game, focus on the win condition
      if (gameState.playerRankings[0] === pn) {
        // If we're leading, be aggressive against the second place
        strategy.aggression = 0.8;
        strategy.targetSelection.specificPlayer = gameState.playerRankings[1];
      } else if (gameState.playerRankings.indexOf(pn) === 1) {
        // If we're second, focus on the leader
        strategy.aggression = 0.7;
        strategy.targetSelection.specificPlayer = gameState.playerRankings[0];
      } else {
        // If we're far behind, target the weakest remaining player
        strategy.aggression = 0.9;
        strategy.targetSelection.weakestPlayer = true;
        strategy.riskTolerance = 0.8; // High risk, high reward
      }
      break;
  }

  // Adjust for dominant player
  if (gameState.dominantPlayer !== -1) {
    if (gameState.dominantPlayer === pn) {
      // We're dominant, be more defensive
      strategy.aggression = Math.max(0.3, strategy.aggression - 0.2);
      strategy.riskTolerance = Math.max(0.3, strategy.riskTolerance - 0.2);
    } else {
      // Someone else is dominant, focus on them
      strategy.targetSelection.dominantPlayer = true;
      strategy.aggression = Math.min(0.8, strategy.aggression + 0.2);
    }
  }

  // Adjust for territory consolidation needs
  const consolidationRatio = game.player[pn].area_tc / gameState.territories.byPlayer[pn];
  if (consolidationRatio < 0.7) {
    // Our territories are fragmented, focus on consolidation
    strategy.expansion = Math.max(0.2, strategy.expansion - 0.3);
  }

  // Adjust for reinforcement strategy
  const borderRatio = gameState.borderTerritories[pn] / gameState.territories.byPlayer[pn];
  if (borderRatio > 0.7) {
    // Many border territories, need defensive reinforcement
    strategy.reinforcementFocus = 'defensive';
  } else if (strategy.aggression > 0.7) {
    // Highly aggressive, reinforce for offense
    strategy.reinforcementFocus = 'offensive';
  }

  return strategy;
}
```

## Move generation and selection

Generate possible moves based on the current strategy:

```javascript
function generateMoves(game, strategy, pn) {
  const moves = [];

  // Get neighbor info for all territories
  const area_info = calculateAreaInfo(game);

  // Generate all possible attacks
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== pn) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === pn) continue;
      if (!game.adat[i].join[j]) continue;

      // Basic dice advantage check
      const diceAdvantage = game.adat[i].dice - game.adat[j].dice;
      if (diceAdvantage <= 0) {
        // Skip unless we have max dice and are feeling aggressive
        if (!(game.adat[i].dice === 8 && strategy.aggression > 0.7)) {
          continue;
        }
      }

      // Calculate attack risk
      const attackRisk = calculateAttackRisk(game, i, j, area_info);

      // Skip high-risk attacks if we're risk-averse
      if (attackRisk > 0.7 && strategy.riskTolerance < 0.4) continue;

      // Calculate strategic value
      const strategicValue = calculateStrategicValue(game, i, j, area_info, strategy);

      // Target selection adjustments
      let targetValue = 0;
      const defendingPlayer = game.adat[j].arm;

      if (strategy.targetSelection.dominantPlayer && defendingPlayer === game.dominantPlayer) {
        targetValue += 3;
      }

      if (strategy.targetSelection.weakestPlayer) {
        // Find the weakest active player
        const weakestPlayer = findWeakestPlayer(game);
        if (defendingPlayer === weakestPlayer) {
          targetValue += 2;
        }
      }

      if (
        strategy.targetSelection.specificPlayer !== -1 &&
        defendingPlayer === strategy.targetSelection.specificPlayer
      ) {
        targetValue += 4;
      }

      // Calculate total move value
      const moveValue =
        diceAdvantage * 2 +
        strategicValue * 3 +
        targetValue -
        attackRisk * (1 - strategy.riskTolerance) * 5;

      moves.push({
        from: i,
        to: j,
        value: moveValue,
        diceAdvantage: diceAdvantage,
        risk: attackRisk,
        strategicValue: strategicValue,
      });
    }
  }

  // Sort by value (highest first)
  moves.sort((a, b) => b.value - a.value);

  return moves;
}

function calculateAttackRisk(game, from, to, area_info) {
  let risk = 0;

  // Base risk from dice ratio
  const diceRatio = game.adat[to].dice / game.adat[from].dice;
  risk += diceRatio * 0.5;

  // Risk from exposing the attacking territory
  const exposureRisk = area_info[from].unfriendly_neighbors / 6; // Normalize to 0-1
  risk += exposureRisk * 0.3;

  // Risk from attacking a territory with strong friendly support
  if (area_info[to].highest_friendly_neighbor_dice > game.adat[from].dice - 1) {
    risk += 0.3;
  }

  // Risk from breaking a strong connected territory
  // (Simplified - actual implementation would check if this breaks connectivity)
  let connectivityRisk = 0;
  if (area_info[from].friendly_neighbors === 1) {
    connectivityRisk = 0.2;
  }
  risk += connectivityRisk;

  return Math.min(1, risk); // Ensure risk is between 0 and 1
}

function calculateStrategicValue(game, from, to, area_info, strategy) {
  let value = 0;

  // Value from expansion vs. consolidation strategy
  if (strategy.expansion > 0.5) {
    // Expansion value - favor territories that open up new attack options
    value += area_info[to].unfriendly_neighbors * 0.2 * strategy.expansion;
  } else {
    // Consolidation value - favor territories that reduce our exposed border
    const borderReduction = simulateBorderReduction(game, from, to);
    value += borderReduction * 0.3 * (1 - strategy.expansion);
  }

  // Value from aggression strategy
  if (strategy.aggression > 0.5) {
    // Aggressive value - favor high-dice territories and those belonging to strong players
    value += game.adat[to].dice * 0.1 * strategy.aggression;
    value += (8 - gameState.playerRankings.indexOf(game.adat[to].arm)) * 0.1 * strategy.aggression;
  } else {
    // Defensive value - favor territories that improve our defensive position
    const defensiveImprovement = simulateDefensiveImprovement(game, from, to);
    value += defensiveImprovement * 0.2 * (1 - strategy.aggression);
  }

  // Value from connectivity improvement
  const connectivityValue = simulateConnectivityImprovement(game, from, to);
  value += connectivityValue * 0.3;

  // Value from reinforcement improvement
  const reinforcementValue = simulateReinforcementImprovement(game, from, to);
  value += reinforcementValue * 0.4;

  return value;
}

function selectBestMove(moves, strategy) {
  // Usually select the highest valued move
  if (moves.length === 0) return null;

  // Some randomness for unpredictability, weighted by risk tolerance
  if (Math.random() < strategy.riskTolerance * 0.3) {
    // Select from top 3 moves
    const topMoves = moves.slice(0, Math.min(3, moves.length));
    return topMoves[Math.floor(Math.random() * topMoves.length)];
  }

  return moves[0];
}
```

## Adaptation examples

### 1. Adapting to player behavior

If you track the outcome of previous engagements with specific players, you can adjust accordingly:

```javascript
function adaptToPlayerBehavior(strategy, playerHistory) {
  for (const player in playerHistory) {
    // If this player tends to counter-attack aggressively
    if (playerHistory[player].aggressiveCounterRate > 0.7) {
      // Be more cautious when attacking them
      if (strategy.targetSelection.specificPlayer === player) {
        strategy.riskTolerance = Math.max(0.2, strategy.riskTolerance - 0.2);
      }
    }

    // If this player tends to ignore weak positions
    if (playerHistory[player].ignoresWeakPositions > 0.7) {
      // Can take more risks when they're the target
      if (strategy.targetSelection.specificPlayer === player) {
        strategy.riskTolerance = Math.min(0.8, strategy.riskTolerance + 0.2);
      }
    }
  }

  return strategy;
}
```

### 2. Adapting to map topology

```javascript
function adaptToMapTopology(strategy, topology) {
  // If the map has many choke points
  if (topology.chokePointDensity > 0.5) {
    // Focus more on controlling these strategic positions
    strategy.expansion = Math.min(0.7, strategy.expansion + 0.2);
  }

  // If the map has many isolated pockets
  if (topology.isolationFactor > 0.5) {
    // Focus more on consolidation than expansion
    strategy.expansion = Math.max(0.3, strategy.expansion - 0.2);
  }

  // If the map has high connectivity
  if (topology.averageConnectivity > 4) {
    // Higher connectivity means more attack vectors - be more defensive
    strategy.aggression = Math.max(0.3, strategy.aggression - 0.1);
  }

  return strategy;
}
```

### 3. Adapting to dice distribution

```javascript
function adaptToDiceDistribution(strategy, diceStats) {
  // If we have many territories with max dice
  if (diceStats.maxDiceTerritories > diceStats.totalTerritories * 0.3) {
    // We can be more aggressive
    strategy.aggression = Math.min(0.9, strategy.aggression + 0.2);
  }

  // If we have many territories with only 1 die
  if (diceStats.vulnerableTerritories > diceStats.totalTerritories * 0.4) {
    // We need to be more defensive
    strategy.aggression = Math.max(0.2, strategy.aggression - 0.3);
    strategy.reinforcementFocus = 'defensive';
  }

  // If we have a good average dice count
  if (diceStats.averageDice > 4) {
    // We can take more risks
    strategy.riskTolerance = Math.min(0.8, strategy.riskTolerance + 0.2);
  }

  return strategy;
}
```

## When to use

1. When a static strategy would underperform as conditions shift
2. Against multiple opponents with different play styles
3. In longer games where the board changes character between opening and endgame

## Trade-offs

An adaptive bot adjusts to whatever the game throws at it and is harder to counter than a bot with one fixed plan. In exchange, it costs more to build and to run: there are more parameters to balance, the game-state analysis runs every turn, and a badly tuned bot can over-react, flip-flopping between postures on short-term noise.
