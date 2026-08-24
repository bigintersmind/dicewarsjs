# AI structure

How to organize your AI code for DiceWars. A well-structured bot is easier to debug, extend, and tune.

## Basic AI function

Every DiceWars AI is implemented as a single function that receives the game state and makes decisions:

```javascript
function ai_your_name(game) {
  // 1. Analyze the game state
  // 2. Determine possible moves
  // 3. Evaluate and select the best move
  // 4. Set game.area_from and game.area_to or return 0 to end turn
}
```

## Modular structure

For a more complex bot, split the turn into phases:

```javascript
function ai_your_name(game) {
  // Get current player
  const pn = game.get_pn();

  // Phase 1: Game state analysis
  const gameState = analyzeGameState(game, pn);

  // Phase 2: Strategy determination
  const strategy = determineStrategy(gameState, pn);

  // Phase 3: Move generation
  const possibleMoves = generateMoves(game, strategy, pn);

  // Phase 4: Move evaluation and selection
  const selectedMove = selectBestMove(possibleMoves, strategy);

  // No valid moves, end turn
  if (!selectedMove) return 0;

  // Execute the selected move
  game.area_from = selectedMove.from;
  game.area_to = selectedMove.to;
}
```

## Helper functions

### Game state analysis

```javascript
function analyzeGameState(game, currentPlayer) {
  // Calculate and return relevant game state metrics
  return {
    playerStats: calculatePlayerStats(game),
    borderTerritories: identifyBorderTerritories(game, currentPlayer),
    territoryGroups: identifyTerritoryGroups(game, currentPlayer),
    // ...other metrics
  };
}

function calculatePlayerStats(game) {
  // Calculate territory counts, dice counts, etc. for each player
  // ...
}

function identifyBorderTerritories(game, player) {
  // Find territories that border enemy territories
  // ...
}

function identifyTerritoryGroups(game, player) {
  // Find connected groups of territories
  // ...
}
```

### Strategy determination

```javascript
function determineStrategy(gameState, currentPlayer) {
  // Determine appropriate strategy based on game state
  return {
    aggression: calculateAggressionLevel(gameState, currentPlayer),
    targetPriorities: determineTargetPriorities(gameState, currentPlayer),
    // ...other strategy parameters
  };
}

function calculateAggressionLevel(gameState, player) {
  // Determine how aggressively to play
  // ...
}

function determineTargetPriorities(gameState, player) {
  // Determine which opponents to prioritize
  // ...
}
```

### Move generation

```javascript
function generateMoves(game, strategy, currentPlayer) {
  const possibleMoves = [];

  // Find all valid attacks according to strategy
  for (let i = 1; i < game.AREA_MAX; i++) {
    // For each potential attacker...

    for (let j = 1; j < game.AREA_MAX; j++) {
      // For each potential target...

      // Apply filters based on strategy
      if (isValidMove(game, i, j, strategy, currentPlayer)) {
        possibleMoves.push({
          from: i,
          to: j,
          value: evaluateMove(game, i, j, strategy),
        });
      }
    }
  }

  return possibleMoves;
}

function isValidMove(game, from, to, strategy, player) {
  // Check if this is a valid move given our strategy
  // ...
}

function evaluateMove(game, from, to, strategy) {
  // Calculate the value of this move
  // ...
}
```

### Move selection

```javascript
function selectBestMove(moves, strategy) {
  if (moves.length === 0) return null;

  // Sort moves by value
  moves.sort((a, b) => b.value - a.value);

  // Usually select the highest-valued move
  // Sometimes add randomness based on strategy
  if (Math.random() < strategy.randomness) {
    // Select randomly from top N moves
    const topMoves = moves.slice(0, Math.min(3, moves.length));
    return topMoves[Math.floor(Math.random() * topMoves.length)];
  }

  return moves[0];
}
```

## Reusable utility functions

These handle common tasks and can be shared between different AI strategies:

```javascript
// Calculate neighbor information for a territory
function getNeighborInfo(game, territoryId) {
  let friendlyNeighbors = 0;
  let enemyNeighbors = 0;
  let highestFriendlyDice = 0;
  let highestEnemyDice = 0;

  const owner = game.adat[territoryId].arm;

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (!game.adat[territoryId].join[i]) continue;

    if (game.adat[i].arm === owner) {
      friendlyNeighbors++;
      if (game.adat[i].dice > highestFriendlyDice) {
        highestFriendlyDice = game.adat[i].dice;
      }
    } else {
      enemyNeighbors++;
      if (game.adat[i].dice > highestEnemyDice) {
        highestEnemyDice = game.adat[i].dice;
      }
    }
  }

  return {
    friendlyNeighbors,
    enemyNeighbors,
    highestFriendlyDice,
    highestEnemyDice,
    totalNeighbors: friendlyNeighbors + enemyNeighbors,
  };
}

// Calculate the probability of winning an attack
function calculateWinProbability(attackerDice, defenderDice) {
  // This is a simplified approximation
  if (attackerDice <= defenderDice) return 0.4;

  const advantage = attackerDice - defenderDice;
  return Math.min(0.95, 0.5 + advantage * 0.1);
}

// Find the largest connected territory group for a player
function findLargestTerritoryGroup(game, player) {
  // Implementation...
}

// Calculate border pressure on a territory
function calculateBorderPressure(game, territoryId) {
  // Implementation...
}
```

## Configuration and constants

Put tunable parameters in one configuration object, so tuning means editing one place:

```javascript
const AI_CONFIG = {
  // Aggression parameters
  MIN_AGGRESSION: 0.3,
  MAX_AGGRESSION: 0.8,
  DEFAULT_AGGRESSION: 0.5,

  // Territory evaluation weights
  DICE_ADVANTAGE_WEIGHT: 2.0,
  STRATEGIC_POSITION_WEIGHT: 1.5,
  CONNECTIVITY_WEIGHT: 1.0,

  // Risk tolerance
  DEFAULT_RISK_TOLERANCE: 0.6,

  // Randomness
  MOVE_SELECTION_RANDOMNESS: 0.2,
};
```

## Debugging tools

A dump-all-moves helper pays for itself during development:

```javascript
function debugEvaluateAllMoves(game, currentPlayer) {
  const moves = [];

  // Generate all possible moves
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== currentPlayer) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === currentPlayer) continue;
      if (!game.adat[i].join[j]) continue;

      const evaluation = evaluateMove(game, i, j, DEFAULT_STRATEGY);

      moves.push({
        from: i,
        to: j,
        value: evaluation.value,
        factors: evaluation.factors,
      });
    }
  }

  // Sort by value
  moves.sort((a, b) => b.value - a.value);

  // Output top 5 moves
  console.log('Top 5 moves:');
  for (let i = 0; i < Math.min(5, moves.length); i++) {
    console.log(
      `${i + 1}. From ${moves[i].from} to ${moves[i].to} (Value: ${moves[i].value.toFixed(2)})`
    );
    console.log('   Factors:', moves[i].factors);
  }

  return moves;
}
```

## Code organization patterns

### 1. Namespace pattern

For a bot with many helper functions:

```javascript
// Namespace pattern
const YourAI = {
  // Main AI function
  execute: function (game) {
    // Implementation...
  },

  // Analysis functions
  analysis: {
    getNeighborInfo: function (game, territoryId) {
      /* ... */
    },
    calculatePlayerStrength: function (game, player) {
      /* ... */
    },
    // ...
  },

  // Strategy functions
  strategy: {
    determineAggression: function (gameState) {
      /* ... */
    },
    selectTargets: function (gameState) {
      /* ... */
    },
    // ...
  },

  // Move generation and evaluation
  moves: {
    generate: function (game, strategy) {
      /* ... */
    },
    evaluate: function (game, from, to, strategy) {
      /* ... */
    },
    select: function (moves, strategy) {
      /* ... */
    },
  },

  // Utility functions
  utils: {
    calculateWinProbability: function (attackerDice, defenderDice) {
      /* ... */
    },
    // ...
  },

  // Configuration
  config: {
    DEFAULT_AGGRESSION: 0.5,
    // ...
  },
};

// Export the main AI function
function ai_your_name(game) {
  return YourAI.execute(game);
}
```

### 2. Class-based pattern

For an object-oriented approach:

```javascript
class DiceWarsAI {
  constructor(config = {}) {
    this.config = {
      aggression: config.aggression || 0.5,
      riskTolerance: config.riskTolerance || 0.6,
      // ...other parameters
    };
  }

  execute(game) {
    const pn = game.get_pn();
    const gameState = this.analyzeGameState(game, pn);
    const strategy = this.determineStrategy(gameState, pn);
    const moves = this.generateMoves(game, strategy, pn);

    if (moves.length === 0) return 0;

    const selectedMove = this.selectMove(moves, strategy);
    game.area_from = selectedMove.from;
    game.area_to = selectedMove.to;
  }

  analyzeGameState(game, player) {
    // Implementation...
  }

  determineStrategy(gameState, player) {
    // Implementation...
  }

  generateMoves(game, strategy, player) {
    // Implementation...
  }

  selectMove(moves, strategy) {
    // Implementation...
  }

  // Utility methods...
}

// Create an instance with custom configuration
const myAI = new DiceWarsAI({
  aggression: 0.7,
  riskTolerance: 0.8,
});

// Export the main AI function
function ai_your_name(game) {
  return myAI.execute(game);
}
```

## Best practices

1. **Keep the main function clean** - Delegate specifics to helper functions
2. **Comment the tricky parts** - Especially probability calculations and strategic weights
3. **Keep pure functions pure** - Don't modify the game state in analysis functions
4. **Use consistent parameter ordering** - Always `(game, territoryId, player)`, never sometimes `(player, game, territoryId)`
5. **Avoid deep nesting** - Use early returns (the `continue`-based filters in the examples are this pattern)
6. **Structure for testability** - Each phase (analysis, strategy, generation, selection) should be callable on its own
7. **Name your magic numbers** - A constant like `MIN_DICE_ADVANTAGE` is tunable; a bare `0.4` buried in a formula is not
8. **Document dependencies** - Note which game-state properties your AI reads, so engine changes are easy to audit
