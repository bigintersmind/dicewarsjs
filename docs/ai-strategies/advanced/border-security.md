# Border security strategy

Protect the territories at the edge of your domain, and attack only where it improves your defensive position.

## Core concept

Every territory that touches an enemy is a border, and borders are where you lose games. This strategy prioritizes:

1. Identifying vulnerable border territories
2. Avoiding attacks that would create new vulnerabilities
3. Targeting the enemy territories that threaten your borders
4. Deciding which territories you can afford to empty, since you cannot aim reinforcement dice yourself

## Implementation approach

Border security begins with identifying which territories are on the border:

```javascript
function isBorderTerritory(game, territory_id) {
  // A territory is on the border if it has at least one enemy neighbor
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size == 0) continue;
    if (!game.adat[territory_id].join[i]) continue;

    // If this neighbor belongs to a different player, this is a border territory
    if (game.adat[i].arm !== game.adat[territory_id].arm) {
      return true;
    }
  }
  return false;
}
```

## Example from ai_defensive.js

Inside its `isValidAttack(defender, attacker)` predicate, the defensive AI applies several border checks before committing to an attack:

```javascript
const defenderArea = adat[defender];
const attackerArea = adat[attacker];

// Skip if attacker doesn't have advantage (unless at max dice)
if (defenderArea.dice >= attackerArea.dice && attackerArea.dice !== 8) return false;

// Skip if winning would leave territory vulnerable to counter-attack
if (area_info[defender].highest_friendly_neighbor_dice > attackerArea.dice) return false;

// Skip if we have a large territory to protect and no reinforcements
if (
  player[pn].area_tc > 4 &&
  area_info[attacker].second_highest_unfriendly_neighbor_dice > 2 &&
  player[pn].stock === 0
)
  return false;
```

## Border security tactics

### 1. Threat assessment

Evaluate the threat level of border territories:

```javascript
function assessBorderThreat(game, territory_id, area_info) {
  // Higher number = higher threat
  let threat = 0;

  // More enemy neighbors = higher threat
  threat += area_info[territory_id].unfriendly_neighbors * 1.5;

  // Strong enemy neighbors = higher threat
  threat += area_info[territory_id].highest_unfriendly_neighbor_dice;
  threat += area_info[territory_id].second_highest_unfriendly_neighbor_dice * 0.5;

  // Few dice on this territory = higher threat
  threat += (8 - game.adat[territory_id].dice) * 0.75;

  // Few friendly neighbors = higher threat (less support)
  threat += (6 - area_info[territory_id].friendly_neighbors) * 0.5;

  return threat;
}
```

### 2. Safe attack identification

Identify attacks that won't weaken your border. `ai_defensive` does it when comparing two candidate attacks, keeping the one whose origin has a single enemy neighbor:

```javascript
const getBetterAttack = (attack1, attack2) => {
  // If first attack is not set, use the second
  if (attack1.from === -1) return attack2;

  const fromTerritory1 = attack1.from;
  const fromTerritory2 = attack2.from;

  // Prioritize attacks from territories with only one enemy neighbor
  if (area_info[fromTerritory1].unfriendly_neighbors === 1) {
    if (area_info[fromTerritory2].unfriendly_neighbors === 1) {
      // If both have one enemy neighbor, prefer larger dice count
      if (adat[fromTerritory2].dice < adat[fromTerritory1].dice) {
        return attack1;
      } else if (adat[fromTerritory2].dice === adat[fromTerritory1].dice) {
        // If equal dice, prefer less connected territory
        if (area_info[fromTerritory2].num_neighbors < area_info[fromTerritory1].num_neighbors) {
          return attack1;
        }
      }
    } else {
      return attack1; // Keep the territory with one enemy neighbor
    }
  }

  return attack2; // Default to new attack
};
```

### 3. Choosing what to strip, not where to reinforce

You cannot reinforce a border. Reinforcement dice land at random on your territories below the 8-dice cap ([Reinforcement optimization](./reinforcement-optimization.md) covers the rule), so a threatened border gets topped up only by luck, and a bigger connected group just buys more chances at it.

What you do control is where dice leave from. A successful attack moves all but one of the attacker's dice onto the captured territory, and a failed one throws them away, so either way the attacking territory ends the move on 1 die. The border question is therefore which territory you are willing to empty:

```javascript
// How much it costs to leave this territory on 1 die.
// A high score means don't attack from here, even when the odds look fine.
function stripCost(territory_id, area_info) {
  // Nothing can reach it, so emptying it is free
  if (area_info[territory_id].unfriendly_neighbors == 0) return 0;

  // The strongest enemy neighbor is the one that walks in next turn
  let cost = area_info[territory_id].highest_unfriendly_neighbor_dice;

  // More enemy neighbors, more chances that one of them tries
  cost += area_info[territory_id].unfriendly_neighbors * 0.5;

  // Friendly neighbors can take it back; an isolated territory cannot be helped
  cost -= area_info[territory_id].friendly_neighbors * 0.5;

  // A territory holding your group together costs income too, not just ground
  if (area_info[territory_id].friendly_neighbors <= 1) cost += 2;

  return Math.max(0, cost);
}
```

Feed that into move selection: rank attacks by what you gain minus what you expose, and drop the ones that empty a territory you cannot afford to lose.

### 4. Border expansion planning

Identify enemy territories whose capture would shorten or strengthen your border:

```javascript
function findBorderImprovingAttacks(game, area_info) {
  const attacks = [];
  const player = game.get_pn();

  // Check all possible attacks
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size == 0) continue;
    if (game.adat[i].arm != player) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size == 0) continue;
      if (game.adat[j].arm == player) continue;
      if (!game.adat[i].join[j]) continue;
      if (game.adat[j].dice >= game.adat[i].dice) continue;

      // Calculate how this attack would affect our border
      let currentBorderCount = 0;
      let newBorderCount = 0;

      // Count current border territories
      for (let k = 1; k < game.AREA_MAX; k++) {
        if (game.adat[k].size == 0) continue;
        if (game.adat[k].arm != player) continue;

        if (isBorderTerritory(game, k)) {
          currentBorderCount++;
        }
      }

      // Simulate the attack
      const originalArm = game.adat[j].arm;
      game.adat[j].arm = player;

      // Count new border territories
      for (let k = 1; k < game.AREA_MAX; k++) {
        if (game.adat[k].size == 0) continue;
        if (game.adat[k].arm != player) continue;

        if (isBorderTerritory(game, k)) {
          newBorderCount++;
        }
      }

      // Restore original state
      game.adat[j].arm = originalArm;

      // If this attack reduces our border or creates a stronger border
      if (newBorderCount <= currentBorderCount) {
        attacks.push({
          from: i,
          to: j,
          borderReduction: currentBorderCount - newBorderCount,
          diceAdvantage: game.adat[i].dice - game.adat[j].dice,
        });
      }
    }
  }

  // Sort by border improvement and dice advantage
  attacks.sort((a, b) => {
    if (a.borderReduction !== b.borderReduction) {
      return b.borderReduction - a.borderReduction;
    }
    return b.diceAdvantage - a.diceAdvantage;
  });

  return attacks;
}
```

## When to use

1. In the middle and late stages of the game
2. When you have strategic territory to protect
3. When facing multiple opponents
4. When you want to play defensively without giving up attacking entirely

## Combining with other strategies

Border security pairs well with:

1. **Neighbor analysis** - Provides the data for border threat assessment
2. **Territory connections** - Border losses are often what splits a connected group
3. **Reinforcement optimization** - Explains what actually sets your income and how each attack changes it
4. **Choke point control** - Identifies the territories that control access to your domain
