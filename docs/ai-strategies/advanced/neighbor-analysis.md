# Neighbor analysis strategy

Look at each territory's neighbors before deciding to attack or defend. Where dice advantage only compares two territories, neighbor analysis asks what happens after the battle, when the surrounding territories get their turn.

## Core concept

For each territory, work out:

1. How many friendly vs. enemy neighbors it has
2. The dice strength of those neighbors
3. The threat posed by enemy neighbors
4. The defensive support available from friendly neighbors

## Implementation from ai_defensive.js

`analyzeTerritory` is a closure inside `ai_defensive`, so it reads `game` from the enclosing scope:

```javascript
const analyzeTerritory = area_id => {
  // Initialize neighbor data with default values
  const neighborData = {
    friendly_neighbors: 0,
    unfriendly_neighbors: 0,
    highest_friendly_neighbor_dice: 0,
    highest_unfriendly_neighbor_dice: 0,
    second_highest_unfriendly_neighbor_dice: 0,
    num_neighbors: 0,
  };

  // Get the current area's data
  const currentArea = game.adat[area_id];

  // Create array of adjacent territories
  const adjacentTerritories = [...Array(game.AREA_MAX).keys()].filter(
    i => i !== area_id && currentArea.join[i]
  );

  // Process each adjacent territory
  adjacentTerritories.forEach(i => {
    const { arm: owner, dice: num_dice } = game.adat[i];
    const isFriendly = currentArea.arm === owner;

    if (isFriendly) {
      // Update friendly neighbor data
      neighborData.friendly_neighbors += 1;
      neighborData.highest_friendly_neighbor_dice = Math.max(
        neighborData.highest_friendly_neighbor_dice,
        num_dice
      );
    } else {
      // Update unfriendly neighbor data
      neighborData.unfriendly_neighbors += 1;

      // Update highest and second highest dice counts
      if (neighborData.highest_unfriendly_neighbor_dice < num_dice) {
        neighborData.second_highest_unfriendly_neighbor_dice =
          neighborData.highest_unfriendly_neighbor_dice;
        neighborData.highest_unfriendly_neighbor_dice = num_dice;
      } else if (neighborData.second_highest_unfriendly_neighbor_dice < num_dice) {
        neighborData.second_highest_unfriendly_neighbor_dice = num_dice;
      }
    }
  });

  // Calculate total neighbors
  neighborData.num_neighbors = neighborData.friendly_neighbors + neighborData.unfriendly_neighbors;

  return neighborData;
};
```

## Strategic applications

### 1. Vulnerability assessment

```javascript
const attackerArea = adat[attacker];

// Skip if winning would leave territory vulnerable to counter-attack
if (area_info[defender].highest_friendly_neighbor_dice > attackerArea.dice) return false;
```

Inside `isValidAttack(defender, attacker)`, this check rejects an attack when the target's strongest ally has more dice than the attacking territory, because that neighbor could retake the territory right after the capture.

### 2. Defensive priority

```javascript
// Skip if we have a large territory to protect and no reinforcements
if (
  player[pn].area_tc > 4 &&
  area_info[attacker].second_highest_unfriendly_neighbor_dice > 2 &&
  player[pn].stock === 0
)
  return false;
```

This logic avoids attacking from a territory that might be needed for defense, especially when you have a large connected territory and no reinforcement dice in reserve.

### 3. Prioritizing safe attacks

`getBetterAttack` compares two candidate attacks by the territory each would attack from:

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

It keeps the attack whose origin has only one enemy neighbor, since that territory stays less exposed after the attack. When both qualify, it prefers the larger stack, then the less connected territory.

## Implementation techniques

### 1. Pre-computation for efficiency

```javascript
// Pre-compute neighbor information for all territories to avoid redundant calculations
const area_info = [...Array(game.AREA_MAX).keys()].map(analyzeTerritory);
```

Calculating neighbor information for all territories once per turn avoids repeating the same scans inside the move loop.

### 2. Multi-level analysis

The defensive AI tracks the highest enemy dice count and also the second highest:

```javascript
if (neighborData.highest_unfriendly_neighbor_dice < num_dice) {
  neighborData.second_highest_unfriendly_neighbor_dice =
    neighborData.highest_unfriendly_neighbor_dice;
  neighborData.highest_unfriendly_neighbor_dice = num_dice;
} else if (neighborData.second_highest_unfriendly_neighbor_dice < num_dice) {
  neighborData.second_highest_unfriendly_neighbor_dice = num_dice;
}
```

The distinction matters: a territory facing one strong enemy is in a different position from one facing two, because the second stack can still attack after the first one commits.

## Advanced applications

### 1. Territory scoring

Using neighbor analysis to calculate a value score for each territory:

```javascript
function calculateTerritoryValue(game, territory_id, area_info) {
  // Base value is the number of dice
  let value = game.adat[territory_id].dice;

  // Strategic value modifiers

  // Fewer enemy neighbors = more valuable (less vulnerable)
  value += (6 - area_info[territory_id].unfriendly_neighbors) * 0.5;

  // Higher friendly support = more valuable
  value += area_info[territory_id].highest_friendly_neighbor_dice * 0.3;

  // More connected = more valuable for reinforcements
  value += area_info[territory_id].friendly_neighbors * 0.2;

  return value;
}
```

### 2. Attack path planning

Identifying chains of vulnerable territories for sequential conquest:

```javascript
function findAttackPath(game, start_territory, max_depth = 3) {
  const path = [];
  const visited = new Set();

  function dfs(territory, depth) {
    if (depth >= max_depth) return;
    visited.add(territory);

    // Check all adjacent enemy territories
    for (let i = 1; i < game.AREA_MAX; i++) {
      if (game.adat[i].size == 0) continue;
      if (game.adat[i].arm == game.adat[territory].arm) continue;
      if (!game.adat[territory].join[i]) continue;
      if (visited.has(i)) continue;

      // If we have a strong dice advantage
      if (game.adat[territory].dice > game.adat[i].dice + 1) {
        path.push({ from: territory, to: i });
        dfs(i, depth + 1);
      }
    }
  }

  dfs(start_territory, 0);
  return path;
}
```

## When to use

1. When defending against aggressive opponents
2. In the mid to late game, when territories are more established
3. When planning multi-step attack sequences

## Combining with other strategies

Neighbor analysis complements:

1. **Dice advantage** - Adds context beyond the two territories in the fight
2. **Territory connections** - Shows how a capture or loss changes your groups
3. **Border security** - Identifies the most vulnerable border territories
4. **Choke point control** - Surfaces territories whose neighbor pattern makes them bottlenecks
