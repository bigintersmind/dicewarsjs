# Testing and tuning

How to test a DiceWars bot and improve it systematically.

## Testing challenges

Testing a game AI is harder than testing ordinary code:

1. **Randomness** - Dice rolls make exact test cases difficult
2. **Emergent complexity** - Simple rules produce behavior you didn't write
3. **Game-long effects** - An early decision may not show its cost until the endgame
4. **Situational strength** - A bot can dominate one map shape and collapse on another
5. **Multi-agent dynamics** - Behavior changes with the mix of opponents

## Testing approaches

### 1. AI vs. AI tournaments

The single most informative test is letting your bot play against other implementations, many times:

```javascript
// Simple tournament runner
function runTournament(aiList, numGames = 100) {
  const wins = new Array(aiList.length).fill(0);
  const scores = new Array(aiList.length).fill(0);

  for (let gameNum = 0; gameNum < numGames; gameNum++) {
    // Initialize a new game with random map
    const game = new Game();
    game.make_map();

    // Assign AIs to players
    for (let i = 0; i < aiList.length; i++) {
      game.ai[i] = aiList[i];
    }

    // Run the game until completion
    const winner = runGameToCompletion(game);

    // Record results
    if (winner >= 0) {
      wins[winner]++;
    }

    // Record scores (e.g., territories controlled, dice owned)
    for (let i = 0; i < aiList.length; i++) {
      scores[i] += calculateScore(game, i);
    }
  }

  // Output results
  for (let i = 0; i < aiList.length; i++) {
    console.log(`AI ${i}: ${wins[i]} wins, average score: ${scores[i] / numGames}`);
  }
}

function runGameToCompletion(game) {
  game.start_game();

  // Set a reasonable limit to avoid infinite games
  const MAX_TURNS = 1000;
  let turnCount = 0;

  while (turnCount < MAX_TURNS) {
    // Check win condition
    const remainingPlayers = countRemainingPlayers(game);
    if (remainingPlayers === 1) {
      // Return the winner
      for (let i = 0; i < 8; i++) {
        if (game.player[i].area_c > 0) return i;
      }
    }

    // No winner yet, continue game
    while (true) {
      // Process one AI turn
      const pn = game.jun[game.ban];
      const result = game.ai[pn](game);

      // If the AI returns 0, end its turn
      if (result === 0) break;

      // Otherwise, process the attack
      processAttack(game);
    }

    // Move to next player
    advanceToNextPlayer(game);
    turnCount++;
  }

  // If no clear winner after MAX_TURNS, return the player with most territories
  let bestPlayer = -1;
  let mostTerritories = 0;
  for (let i = 0; i < 8; i++) {
    if (game.player[i].area_c > mostTerritories) {
      mostTerritories = game.player[i].area_c;
      bestPlayer = i;
    }
  }

  return bestPlayer;
}
```

### 2. Specific scenario testing

Build fixed game states to check how your AI handles particular situations:

```javascript
// Test handling of choke points
function testChokePointHandling(aiFunction) {
  // Create a game with a predefined map containing choke points
  const game = createChokePointMap();

  // Set the AI we're testing
  game.ai[1] = aiFunction;

  // Set up the specific scenario
  // Player 1 has territories on both sides of a choke point
  // Enemy player 2 controls the choke point
  setupChokePointScenario(game);

  // Run the AI and see if it targets the choke point
  const result = aiFunction(game);

  // Check if the AI correctly identified and attacked the choke point
  if (game.area_to === CHOKE_POINT_TERRITORY) {
    return 'PASS: AI correctly targeted the choke point';
  } else {
    return 'FAIL: AI did not target the choke point';
  }
}

// Test defensive behavior when threatened
function testDefensiveBehavior(aiFunction) {
  // Create a game with a predefined map
  const game = createTestMap();

  // Set the AI we're testing
  game.ai[1] = aiFunction;

  // Set up the specific scenario
  // Player 1 has a vulnerable territory with a strong enemy adjacent
  setupThreatenedScenario(game);

  // Run the AI and check if it avoids attacking from the threatened territory
  const result = aiFunction(game);

  // The AI should not attack from the threatened territory
  if (game.area_from !== THREATENED_TERRITORY) {
    return 'PASS: AI correctly avoided attacking from the threatened territory';
  } else {
    return 'FAIL: AI attacked from a threatened territory';
  }
}
```

### 3. Unit testing strategy components

Test the individual pieces of your AI in isolation:

```javascript
// Test territory evaluation function
function testTerritoryEvaluation() {
  const game = createTestMap();

  // Set up specific territories with known characteristics
  const borderTerritory = 5;
  const internalTerritory = 10;
  const chokePointTerritory = 15;

  // Evaluate each territory
  const borderValue = evaluateTerritory(game, borderTerritory);
  const internalValue = evaluateTerritory(game, internalTerritory);
  const chokePointValue = evaluateTerritory(game, chokePointTerritory);

  // Check that the evaluations match expectations
  console.assert(
    borderValue < internalValue,
    'Border territory should be less valuable than internal territory'
  );

  console.assert(
    chokePointValue > borderValue,
    'Choke point should be more valuable than regular border territory'
  );

  // Additional assertions...
}

// Test move generation and filtering
function testMoveGeneration() {
  const game = createTestMap();

  // Set up a known game state
  // ...

  // Generate moves
  const moves = generateMoves(game, DEFAULT_STRATEGY, 1);

  // Verify move count
  console.assert(
    moves.length === EXPECTED_MOVE_COUNT,
    `Expected ${EXPECTED_MOVE_COUNT} moves, got ${moves.length}`
  );

  // Verify specific moves are included
  const hasExpectedMove = moves.some(
    move => move.from === EXPECTED_FROM && move.to === EXPECTED_TO
  );

  console.assert(hasExpectedMove, 'Expected move not found in generated moves');

  // Verify invalid moves are excluded
  const hasInvalidMove = moves.some(move => move.from === INVALID_FROM && move.to === INVALID_TO);

  console.assert(!hasInvalidMove, 'Invalid move was incorrectly included');
}
```

### 4. Comparative analysis

Give several AIs the same board and compare what they choose:

```javascript
function compareAIDecisions(aiList, game) {
  const decisions = [];

  // Clone the game state for each AI
  for (let i = 0; i < aiList.length; i++) {
    const gameCopy = cloneGameState(game);

    // Run the AI
    aiList[i](gameCopy);

    // Record the decision
    decisions.push({
      ai: i,
      from: gameCopy.area_from,
      to: gameCopy.area_to,
    });
  }

  // Analyze the decisions
  console.log('AI decisions for the same game state:');
  for (const decision of decisions) {
    if (decision.from === 0 && decision.to === 0) {
      console.log(`AI ${decision.ai} chose to end turn`);
    } else {
      console.log(`AI ${decision.ai} attacked from ${decision.from} to ${decision.to}`);
    }
  }

  // Find consensus or disagreement
  const uniqueDecisions = new Set(decisions.map(d => `${d.from}-${d.to}`));
  if (uniqueDecisions.size === 1) {
    console.log('All AIs made the same decision');
  } else {
    console.log(`AIs disagreed, with ${uniqueDecisions.size} different decisions`);
  }
}
```

## Tuning approaches

### 1. Parameter tuning

Most strategies have parameters worth tuning:

```javascript
// AI with tunable parameters
function ai_tunable(game) {
  // Strategy parameters
  const params = {
    // Aggression parameters
    AGGRESSION_LEVEL: 0.6, // 0-1 scale (0 = defensive, 1 = aggressive)
    RISK_TOLERANCE: 0.4, // 0-1 scale (0 = risk-averse, 1 = risk-seeking)

    // Evaluation weights
    DICE_ADVANTAGE_WEIGHT: 2.0,
    STRATEGIC_POSITION_WEIGHT: 1.5,
    CONNECTIVITY_WEIGHT: 1.0,
    BORDER_REDUCTION_WEIGHT: 1.2,

    // Thresholds
    MIN_DICE_ADVANTAGE: 1, // Minimum dice advantage for an attack
    MAX_BORDER_EXPOSURE: 3, // Maximum number of exposed borders
  };

  // Implementation using these parameters
  // ...
}

// Systematic parameter tuning
function tuneParameters() {
  // Define the parameter to tune and its range
  const paramToTune = 'AGGRESSION_LEVEL';
  const values = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  const results = [];

  // Test each value
  for (const value of values) {
    // Create a version of the AI with this parameter value
    const tunedAI = createTunedAI(paramToTune, value);

    // Run a tournament with this AI
    const winRate = runTournament([tunedAI, ai_default, ai_defensive], 50);

    results.push({
      value,
      winRate,
    });
  }

  // Find the optimal value
  results.sort((a, b) => b.winRate - a.winRate);

  console.log(
    `Optimal value for ${paramToTune}: ${results[0].value} (win rate: ${results[0].winRate})`
  );
  return results;
}

function createTunedAI(paramName, value) {
  return function (game) {
    // Clone the default parameters
    const params = { ...DEFAULT_PARAMS };

    // Override the specified parameter
    params[paramName] = value;

    // Run the AI implementation with these parameters
    return ai_implementation(game, params);
  };
}
```

### 2. Grid search

To tune several parameters at once, sweep the combinations:

```javascript
function gridSearch() {
  // Define parameter ranges
  const parameterRanges = {
    AGGRESSION_LEVEL: [0.4, 0.6, 0.8],
    RISK_TOLERANCE: [0.3, 0.5, 0.7],
    DICE_ADVANTAGE_WEIGHT: [1.5, 2.0, 2.5],
  };

  // Generate all combinations
  const parameterCombinations = generateParameterCombinations(parameterRanges);

  // Test each combination
  const results = [];

  for (const params of parameterCombinations) {
    const tunedAI = createAIWithParams(params);
    const winRate = runTournament([tunedAI, ai_default, ai_defensive], 20);

    results.push({
      params,
      winRate,
    });
  }

  // Sort by win rate
  results.sort((a, b) => b.winRate - a.winRate);

  // Return the top 3 parameter combinations
  return results.slice(0, 3);
}

function generateParameterCombinations(ranges) {
  const keys = Object.keys(ranges);
  const combinations = [{}];

  for (const key of keys) {
    const values = ranges[key];
    const newCombinations = [];

    for (const value of values) {
      for (const combo of combinations) {
        newCombinations.push({
          ...combo,
          [key]: value,
        });
      }
    }

    combinations.length = 0;
    combinations.push(...newCombinations);
  }

  return combinations;
}
```

### 3. Evolutionary algorithms

For a parameter space too large to sweep, evolve it:

```javascript
function evolveParameters(numGenerations = 10) {
  // Initial population with random parameters
  let population = generateInitialPopulation(20);

  for (let generation = 0; generation < numGenerations; generation++) {
    // Evaluate fitness of all individuals
    const fitnessScores = evaluatePopulationFitness(population);

    // Select parents for the next generation
    const parents = selectParents(population, fitnessScores);

    // Create offspring through crossover and mutation
    const offspring = createOffspring(parents);

    // Replace the population with the new generation
    population = [...parents.slice(0, 5), ...offspring];

    // Log the best parameters in this generation
    const bestIndex = fitnessScores.indexOf(Math.max(...fitnessScores));
    console.log(`Generation ${generation + 1} best:`, population[bestIndex]);
  }

  // Return the best individual from the final generation
  const finalFitness = evaluatePopulationFitness(population);
  const bestIndex = finalFitness.indexOf(Math.max(...finalFitness));

  return population[bestIndex];
}

function generateInitialPopulation(size) {
  const population = [];

  for (let i = 0; i < size; i++) {
    population.push({
      AGGRESSION_LEVEL: Math.random(),
      RISK_TOLERANCE: Math.random(),
      DICE_ADVANTAGE_WEIGHT: 1 + Math.random() * 2,
      STRATEGIC_POSITION_WEIGHT: 1 + Math.random() * 2,
      CONNECTIVITY_WEIGHT: 1 + Math.random() * 2,
    });
  }

  return population;
}

function evaluatePopulationFitness(population) {
  const fitnessScores = [];

  for (const params of population) {
    const ai = createAIWithParams(params);
    const winRate = runTournament([ai, ai_default, ai_defensive], 10);
    fitnessScores.push(winRate);
  }

  return fitnessScores;
}

function selectParents(population, fitnessScores) {
  // Sort population by fitness
  const sortedPopulation = population
    .map((params, index) => ({ params, fitness: fitnessScores[index] }))
    .sort((a, b) => b.fitness - a.fitness);

  // Return the top half as parents
  return sortedPopulation.slice(0, Math.ceil(population.length / 2)).map(entry => entry.params);
}

function createOffspring(parents) {
  const offspring = [];

  while (offspring.length < parents.length) {
    // Select two parents randomly
    const parent1 = parents[Math.floor(Math.random() * parents.length)];
    const parent2 = parents[Math.floor(Math.random() * parents.length)];

    // Create a child through crossover
    const child = crossover(parent1, parent2);

    // Apply mutation
    mutate(child);

    offspring.push(child);
  }

  return offspring;
}

function crossover(parent1, parent2) {
  const child = {};

  // For each parameter, randomly select from either parent
  for (const key in parent1) {
    child[key] = Math.random() < 0.5 ? parent1[key] : parent2[key];
  }

  return child;
}

function mutate(params) {
  // Small chance to mutate each parameter
  for (const key in params) {
    if (Math.random() < 0.2) {
      // 20% mutation chance
      // Apply a small random adjustment
      const mutationAmount = (Math.random() - 0.5) * 0.2; // ±10%
      params[key] += params[key] * mutationAmount;

      // Ensure values stay in reasonable ranges
      if (key.includes('LEVEL') || key.includes('TOLERANCE')) {
        params[key] = Math.max(0, Math.min(1, params[key]));
      } else {
        params[key] = Math.max(0.1, params[key]);
      }
    }
  }
}
```

## Performance metrics

Track more than win rate. A bot that never wins but always finishes second is very different from one that wins occasionally and busts out early the rest of the time:

```javascript
function evaluateAI(aiFunction, numGames = 100) {
  const metrics = {
    wins: 0,
    territoriesControlled: [],
    diceOwned: [],
    averageTurnLength: [],
    survivalTurns: [],
    eliminationsPerformed: [],
  };

  for (let gameNum = 0; gameNum < numGames; gameNum++) {
    const game = new Game();
    game.make_map();

    // Assign the AI to player 1
    game.ai[1] = aiFunction;

    // Fill other players with default AI
    for (let i = 2; i < 8; i++) {
      game.ai[i] = ai_default;
    }

    // Run the game and collect metrics
    const gameMetrics = runGameAndTrackMetrics(game, 1);

    // Aggregate metrics
    if (gameMetrics.winner === 1) metrics.wins++;
    metrics.territoriesControlled.push(gameMetrics.maxTerritories);
    metrics.diceOwned.push(gameMetrics.maxDice);
    metrics.averageTurnLength.push(gameMetrics.avgTurnLength);
    metrics.survivalTurns.push(gameMetrics.survivalTurns);
    metrics.eliminationsPerformed.push(gameMetrics.eliminations);
  }

  // Calculate final metrics
  const winRate = metrics.wins / numGames;
  const avgTerritories = average(metrics.territoriesControlled);
  const avgDice = average(metrics.diceOwned);
  const avgTurnLength = average(metrics.averageTurnLength);
  const avgSurvival = average(metrics.survivalTurns);
  const avgEliminations = average(metrics.eliminationsPerformed);

  return {
    winRate,
    avgTerritories,
    avgDice,
    avgTurnLength,
    avgSurvival,
    avgEliminations,
  };
}

function average(array) {
  return array.reduce((sum, value) => sum + value, 0) / array.length;
}
```

## Visualizing results

Even crude console bar charts make patterns easier to spot than raw numbers:

```javascript
function visualizeResults(results) {
  // Assuming results is an array of metrics from multiple AIs

  // Compare win rates
  console.log('Win Rates:');
  for (let i = 0; i < results.length; i++) {
    const winPercentage = results[i].winRate * 100;
    console.log(
      `AI ${i}: ${'#'.repeat(Math.round(winPercentage / 2))} ${winPercentage.toFixed(1)}%`
    );
  }

  // Compare territory control
  console.log('\nAverage Max Territories Controlled:');
  for (let i = 0; i < results.length; i++) {
    const territories = results[i].avgTerritories;
    console.log(`AI ${i}: ${'#'.repeat(Math.round(territories))} ${territories.toFixed(1)}`);
  }

  // Compare survival turns
  console.log('\nAverage Survival Turns:');
  for (let i = 0; i < results.length; i++) {
    const turns = results[i].avgSurvival;
    console.log(`AI ${i}: ${'#'.repeat(Math.round(turns / 10))} ${turns.toFixed(1)}`);
  }

  // Additional visualizations...
}
```

## Regression testing

Check that a change didn't make the bot worse before keeping it:

```javascript
function regressionTest(newAI, baselineAI) {
  console.log('Running regression tests...');

  // Test 1: Win rate against standard opponents
  const winRateNew = evaluateAI(newAI).winRate;
  const winRateBaseline = evaluateAI(baselineAI).winRate;

  console.log(
    `Win rate - Baseline: ${(winRateBaseline * 100).toFixed(1)}%, New: ${(winRateNew * 100).toFixed(1)}%`
  );
  console.log(`Change: ${((winRateNew - winRateBaseline) * 100).toFixed(1)}%`);

  // Test 2: Specific scenarios
  const scenarioTests = [testChokePointHandling, testDefensiveBehavior, testEqualDiceHandling];

  for (const test of scenarioTests) {
    const resultBaseline = test(baselineAI);
    const resultNew = test(newAI);

    console.log(`${test.name}:`);
    console.log(`  Baseline: ${resultBaseline}`);
    console.log(`  New: ${resultNew}`);
  }

  // Test 3: Performance metrics
  console.time('Baseline AI - 10 games');
  evaluateAI(baselineAI, 10);
  console.timeEnd('Baseline AI - 10 games');

  console.time('New AI - 10 games');
  evaluateAI(newAI, 10);
  console.timeEnd('New AI - 10 games');
}
```

## Best practices

1. **Version control** - Keep every AI version and its measured performance
2. **Parameter documentation** - Note what each parameter does and its sensible range
3. **Regular benchmarking** - Re-test against standard opponents after engine or map changes
4. **Focused changes** - Change one thing at a time, or you won't know what helped
5. **Varied seeds** - Test across many random seeds; one seed is one sample
6. **A/B testing** - Compare each change against a fixed baseline
7. **Enough games** - A 55% win rate over 20 games is noise; over 1,000 games it's a result
8. **Diverse opponents** - A bot tuned only against ai_default learns to beat ai_default
9. **Edge cases** - Build scenarios for unusual situations (one territory left, one opponent left, no valid attacks)
10. **Human feedback** - Ask players whether the bot feels smart, cheap, or passive

## Common testing pitfalls

1. **Overfitting** - The bot aces your test scenarios but flops in real games
2. **Non-deterministic failures** - Bugs that only appear under some dice sequences
3. **Shallow testing** - A handful of game states proves very little
4. **Ignoring speed** - A theoretically strong bot that stalls the game loses in practice
5. **Untracked changes** - Tuning without recording results means re-learning the same lessons

## Iterative improvement workflow

Establish a baseline, form a hypothesis, make the change, test it rigorously, compare against the baseline, tune, and write down what you found. Then start the loop again.
