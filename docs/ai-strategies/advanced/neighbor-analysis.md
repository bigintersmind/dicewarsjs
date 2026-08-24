# Neighbor analysis strategy

Look at each territory's neighbors before deciding to attack or defend. Where dice advantage only compares two territories, neighbor analysis asks what happens after the battle, when the surrounding territories get their turn.

## Core concept

For each territory, work out:

1. How many friendly vs. enemy neighbors it has
2. The dice strength of those neighbors
3. The threat posed by enemy neighbors
4. The defensive support available from friendly neighbors

## Implementation from ai_defensive.js

```javascript
function area_get_info(area_id) {
  let friendly_neighbors = 0;
  let unfriendly_neighbors = 0;
  let highest_friendly_neighbor_dice = 0;
  let highest_unfriendly_neighbor_dice = 0;
  let second_highest_unfriendly_neighbor_dice = 0;
  let num_neighbors = 0;

  for (let i = 0; i < game.AREA_MAX; i++) {
    if (i == area_id) continue;

    // Skip non-adjacent territories
    if (!game.adat[area_id].join[i]) continue;

    const num_dice = game.adat[i].dice;

    if (game.adat[area_id].arm == game.adat[i].arm) {
      friendly_neighbors += 1;
      // Track highest dice count among friendly neighbors
      if (highest_friendly_neighbor_dice < num_dice) highest_friendly_neighbor_dice = num_dice;
    } else {
      unfriendly_neighbors += 1;
      // Track highest and second highest dice counts among enemy neighbors
      if (highest_unfriendly_neighbor_dice < num_dice) {
        second_highest_unfriendly_neighbor_dice = highest_unfriendly_neighbor_dice;
        highest_unfriendly_neighbor_dice = num_dice;
      } else if (second_highest_unfriendly_neighbor_dice < num_dice)
        second_highest_unfriendly_neighbor_dice = num_dice;
    }
  }

  num_neighbors = friendly_neighbors + unfriendly_neighbors;

  return {
    friendly_neighbors,
    unfriendly_neighbors,
    highest_friendly_neighbor_dice,
    highest_unfriendly_neighbor_dice,
    second_highest_unfriendly_neighbor_dice,
    num_neighbors,
  };
}
```

## Strategic applications

### 1. Vulnerability assessment

```javascript
// Skip if winning would leave territory vulnerable to counter-attack
if (area_info[i].highest_friendly_neighbor_dice > game.adat[j].dice) continue;
```

This code skips an attack if the friendly neighbor with the highest dice count could counterattack and take the territory after we capture it.

### 2. Defensive priority

```javascript
// Skip if we have a large territory to protect and no reinforcements
if (game.player[pn].area_tc > 4
    && area_info[j].second_highest_unfriendly_neighbor_dice > 2
    && game.player[pn].stock == 0) continue;
```

This logic avoids attacking from a territory that might be needed for defense, especially when you have a large connected territory and no reinforcement dice in reserve.

### 3. Prioritizing safe attacks

```javascript
// Prioritize attacks from territories with only one enemy neighbor
if (area_info[game.area_from].unfriendly_neighbors == 1) {
    if (area_info[j].unfriendly_neighbors == 1) {
        // If both have one enemy neighbor, prefer larger dice count
        if (game.adat[j].dice < game.adat[game.area_from].dice) continue;
        else if (game.adat[j].dice == game.adat[game.area_from].dice)
            // If equal dice, prefer less connected territory
            if (area_info[j].num_neighbors < area_info[game.area_from].num_neighbors)
                continue;
    } else continue; // Let the territory with one enemy neighbor attack first
}
```

This prioritizes attacks from territories with only one enemy neighbor, since they stay less exposed after the attack. If multiple territories qualify, it selects based on dice count and connectivity.

## Implementation techniques

### 1. Pre-computation for efficiency

```javascript
// Pre-compute neighbor information for all territories to avoid redundant calculations
const area_info = [...Array(game.AREA_MAX).keys()].map(area_get_info);
```

Calculating neighbor information for all territories once per turn avoids repeating the same scans inside the move loop.

### 2. Multi-level analysis

The defensive AI tracks the highest enemy dice count and also the second highest:

```javascript
if (highest_unfriendly_neighbor_dice < num_dice) {
  second_highest_unfriendly_neighbor_dice = highest_unfriendly_neighbor_dice;
  highest_unfriendly_neighbor_dice = num_dice;
} else if (second_highest_unfriendly_neighbor_dice < num_dice)
  second_highest_unfriendly_neighbor_dice = num_dice;
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
