# Territory connections strategy

Keep your territories connected. Reinforcement dice at the end of each turn are based on the size of your largest connected group, so connections are income.

## Core concept

Players receive reinforcement dice based on the size of their largest connected territory group. This strategy prioritizes moves that maintain or expand those connections.

## Game mechanic

The `set_area_tc` function in the game calculates a player's largest connected territory:

```javascript
set_area_tc(pn) {
  // ...
  // Find the largest connected group for a player
  // ...
  // Store the size of the largest connected group
  this.player[pn].area_tc = max;
}
```

## Implementation

This strategy has two main components:

1. **Avoid breaking connections** - Prevent attacks that could lead to disconnected territories
2. **Target strategic connections** - Prioritize attacks that connect or expand territory groups

```javascript
// Example: Defensive consideration for territory size
if (game.player[pn].area_tc > 4
    && area_info[j].second_highest_unfriendly_neighbor_dice > 2
    && game.player[pn].stock == 0) continue;
```

## Example from ai_defensive.js

The defensive AI considers territory connections when deciding whether to attack:

```javascript
// Skip if we have a large territory to protect and no reinforcements
if (game.player[pn].area_tc > 4
    && area_info[j].second_highest_unfriendly_neighbor_dice > 2
    && game.player[pn].stock == 0) continue;
```

This logic avoids risky attacks when the AI already has a substantial connected territory (more than 4 territories) but no reinforcement dice in reserve, especially if there are strong enemy territories nearby.

## Why connections matter

A larger connected group means more reinforcement dice every turn, and those reinforcements land where the group needs defending. Losing a link that splits your group in two cuts your income immediately, which is why opponents will aim for exactly those territories.

## Implementation techniques

Ways to implement territory connection analysis:

1. **Graph algorithms** - Use union-find or graph traversal to identify connected components
2. **Connection metrics** - Score potential moves by how much they grow or shrink your largest group
3. **Bridge identification** - Find and protect "bridge" territories whose loss would split a group
4. **Expansion planning** - Target enemy territories whose capture would join two of your separate groups

## Example: finding bridge territories

Bridge territories are critical connections that, if lost, would split your territory into disconnected parts:

```javascript
function findBridgeTerritories(game, player) {
  const bridges = [];

  // For each territory owned by the player
  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size == 0) continue;
    if (game.adat[i].arm != player) continue;

    // Simulate removing this territory
    const originalArm = game.adat[i].arm;
    game.adat[i].arm = -1;

    // Calculate connected territories without this one
    const originalSize = game.player[player].area_tc;
    game.set_area_tc(player);
    const newSize = game.player[player].area_tc;

    // If removing this territory reduces the connected size, it's a bridge
    if (newSize < originalSize - 1) {
      bridges.push(i);
    }

    // Restore the territory
    game.adat[i].arm = originalArm;
  }

  // Restore the original connected territory calculation
  game.set_area_tc(player);

  return bridges;
}
```

## When to use

1. In the mid to late game, once territory groups have formed
2. Against aggressive opponents who might split your territories
3. Whenever your plan depends on out-earning opponents in reinforcements

## Combining with other strategies

Territory connection analysis works well with:

1. **Border security** - Protect the perimeter of your connected territories
2. **Choke point control** - Control the narrow passages between territory groups
3. **Expansion planning** - Target the territories that would connect your separate groups
