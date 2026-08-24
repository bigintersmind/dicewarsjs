# Reinforcement optimization strategy

Get the most out of the reinforcement dice granted at the end of each turn. Where those dice land shapes both your next defense and your next attack.

## Core concept

Players receive reinforcement dice based on their largest connected territory. This strategy involves:

1. Understanding how reinforcements are calculated
2. Identifying the territories where reinforcements matter most
3. Factoring reinforcement changes into attack planning
4. Sometimes skipping an attack to preserve a strong reinforcement position

## Game mechanics for reinforcements

```javascript
// In the game engine, reinforcements are based on the largest connected territory
set_area_tc(pn) {
  // ...logic to find the largest connected territory group...
  this.player[pn].area_tc = max;
}
```

Players receive reinforcement dice proportional to the size of their largest connected territory group.

## Implementation approach

### 1. Reinforcement prediction

```javascript
function predictReinforcements(game, player) {
  // Calculate connected territory size
  let originalAreaTC = game.player[player].area_tc;

  // The game likely has a specific formula for reinforcement calculation
  // This is a simplified example - replace with the actual formula
  const expectedReinforcements = Math.floor(originalAreaTC / 2);

  return {
    territorySize: originalAreaTC,
    expectedDice: expectedReinforcements,
  };
}
```

### 2. Strategic territory identification

Identify the territories that would benefit most from reinforcements:

```javascript
function identifyReinforcementCandidates(game, area_info) {
  const player = game.get_pn();
  const candidates = [];

  // Check all owned territories
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size == 0) continue;
    if (game.adat[i].arm != player) continue;
    if (game.adat[i].dice >= 8) continue; // Already at max dice

    let score = 0;

    // Border territories are more valuable for reinforcement
    if (area_info[i].unfriendly_neighbors > 0) {
      score += 3; // Base points for being on the border

      // More enemy neighbors = higher priority
      score += area_info[i].unfriendly_neighbors * 1.5;

      // Strong enemy neighbors = higher priority
      score += area_info[i].highest_unfriendly_neighbor_dice * 0.5;

      // Few dice = higher priority
      score += (8 - game.adat[i].dice) * 0.75;

      // Strategic territories (like choke points) get bonus points
      if (isChokePoint(game, i)) {
        score += 5;
      }

      // Territories that could be used for strong attacks next turn
      if (hasStrongAttackPotential(game, i)) {
        score += 4;
      }
    }

    candidates.push({
      territory: i,
      score: score,
      currentDice: game.adat[i].dice,
      maxReinforcement: 8 - game.adat[i].dice,
    });
  }

  // Sort by score (highest first)
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

function isChokePoint(game, territory) {
  // Implementation from the Choke Point Control strategy
  // ...
}

function hasStrongAttackPotential(game, territory) {
  // Check if this territory is adjacent to valuable enemy territories
  const player = game.get_pn();

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size == 0) continue;
    if (game.adat[i].arm == player) continue;
    if (!game.adat[territory].join[i]) continue;

    // If adding dice would create a strong attack opportunity
    if (game.adat[territory].dice + 2 > game.adat[i].dice + 1) {
      return true;
    }
  }

  return false;
}
```

### 3. Attack planning with reinforcement impact

```javascript
function evaluateAttackWithReinforcementImpact(game, from, to) {
  const player = game.get_pn();

  // Calculate current reinforcement expectation
  const currentReinforcement = predictReinforcements(game, player);

  // Simulate the attack
  const originalToOwner = game.adat[to].arm;
  const originalToDice = game.adat[to].dice;
  const originalFromDice = game.adat[from].dice;

  // Assume attack success
  game.adat[to].arm = player;
  game.adat[to].dice = originalFromDice - 1;
  game.adat[from].dice = 1;

  // Calculate new reinforcement expectation
  const newReinforcement = predictReinforcements(game, player);

  // Restore original state
  game.adat[to].arm = originalToOwner;
  game.adat[to].dice = originalToDice;
  game.adat[from].dice = originalFromDice;

  // Calculate the net impact
  const reinforcementChange = newReinforcement.expectedDice - currentReinforcement.expectedDice;

  return {
    from: from,
    to: to,
    diceAdvantage: originalFromDice - originalToDice,
    reinforcementChange: reinforcementChange,
    // Higher scores for attacks that maintain or increase reinforcements
    score: originalFromDice - originalToDice + reinforcementChange * 2,
  };
}
```

### 4. Deployment planning

```javascript
function optimizeReinforcementDeployment(game, reinforcementAmount) {
  const candidates = identifyReinforcementCandidates(game, calculateAreaInfo(game));
  const deploymentPlan = [];
  let remainingDice = reinforcementAmount;

  // Allocate dice in order of priority until we run out
  for (const candidate of candidates) {
    if (remainingDice <= 0) break;

    // How many dice to allocate to this territory
    const allocation = Math.min(
      candidate.maxReinforcement, // Don't exceed max dice (8)
      remainingDice, // Don't allocate more than we have
      calculateOptimalDiceForTerritory(game, candidate.territory) // Don't over-allocate
    );

    if (allocation > 0) {
      deploymentPlan.push({
        territory: candidate.territory,
        allocation: allocation,
      });

      remainingDice -= allocation;
    }
  }

  return deploymentPlan;
}

function calculateOptimalDiceForTerritory(game, territory) {
  // Calculate the optimal number of dice for this territory based on threats
  // and attack opportunities
  const area_info = calculateAreaInfo(game);

  // Start with the current threats
  let optimalDice = area_info[territory].highest_unfriendly_neighbor_dice + 1;

  // Consider attack opportunities
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size == 0) continue;
    if (game.adat[i].arm == game.adat[territory].arm) continue;
    if (!game.adat[territory].join[i]) continue;

    // If attacking this territory would be valuable
    if (isValuableTarget(game, i)) {
      // We'd want enough dice to have a strong advantage
      const diceNeededForAttack = game.adat[i].dice + 2;
      if (diceNeededForAttack > optimalDice) {
        optimalDice = diceNeededForAttack;
      }
    }
  }

  // Cap at maximum dice
  return Math.min(optimalDice, 8);
}

function isValuableTarget(game, territory) {
  // Determine if a territory is a valuable target
  // Could consider: choke points, connected territory impact, etc.
  // ...
}
```

## Strategic considerations

### 1. Reinforcement vs. immediate attack

Sometimes it's better to skip an attack and keep a stronger reinforcement position:

```javascript
function shouldForgoAttackForReinforcements(game, from, to) {
  const attackEvaluation = evaluateAttackWithReinforcementImpact(game, from, to);

  // If this attack would significantly decrease our reinforcements
  if (attackEvaluation.reinforcementChange < -1) {
    // Only worth it if we have a massive dice advantage or the target is extremely valuable
    if (attackEvaluation.diceAdvantage <= 3 && !isExtremelyValuableTarget(game, to)) {
      return true; // Should forego the attack
    }
  }

  return false; // Attack is worth it
}
```

### 2. Territory consolidation

Expanding your largest connected group can be worth more than a tactically safe capture elsewhere:

```javascript
function findConsolidationAttacks(game) {
    const player = game.get_pn();
    const consolidationTargets = [];

    // Find the largest connected group
    game.set_area_tc(player);
    const largestGroupSize = game.player[player].area_tc;

    // Initialize territory group tracking
    for (let i = 0; i < game.AREA_MAX; i++) game.chk[i] = i;

    // Identify which territories belong to the largest group
    // ... (implement group identification logic) ...

    // Look for attacks that would connect separate territory groups
    for (let i = 1; i < game.AREA_MAX; i++) {
        if (game.adat[i].size == 0) continue;
        if (game.adat[i].arm != player) continue;
        if (game.adat[i].dice <= 1) continue;

        // Check if this territory is NOT in the largest group
        const isInLargestGroup = /* determine if in largest group */;

        for (let j = 1; j < game.AREA_MAX; j++) {
            if (game.adat[j].size == 0) continue;
            if (game.adat[j].arm == player) continue;
            if (!game.adat[i].join[j]) continue;

            // Check if capturing this would connect to the largest group
            const wouldConnectToLargestGroup = /* logic to determine */;

            if (wouldConnectToLargestGroup && game.adat[i].dice > game.adat[j].dice) {
                consolidationTargets.push({
                    from: i,
                    to: j,
                    diceAdvantage: game.adat[i].dice - game.adat[j].dice,
                    // Higher priority for attacks that connect larger separate groups
                    priority: (game.adat[i].dice - game.adat[j].dice) +
                              (/* size of group being connected */ * 2)
                });
            }
        }
    }

    return consolidationTargets;
}
```

## When to use

1. In the mid to late game, once territory patterns are established
2. When your territories are fragmented and need consolidation
3. When facing multiple opponents and dice have to be rationed
4. When planning multi-turn strategies

## Combining with other strategies

Reinforcement optimization works well with:

1. **Territory connections** - The largest connected group is what sets your reinforcement count
2. **Border security** - Tells you which borders need the dice most
3. **Choke point control** - Flags the territories worth keeping topped up
4. **Player ranking** - Shifts reinforcement priorities toward the biggest threat
