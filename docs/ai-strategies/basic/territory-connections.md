# Territory connections strategy

Keep your territories connected. Reinforcement dice at the end of each turn are based on the size of your largest connected group, so connections are income.

## Core concept

Players receive reinforcement dice based on the size of their largest connected territory group. This strategy prioritizes moves that maintain or expand those connections.

## Game mechanic

The engine computes each player's largest connected group in `findLargestConnectedGroup` (`src/engine/StateManager.js`) and hands the size to a legacy bot as `game.player[pn].area_tc`. That number is a snapshot taken when the game view is built. The view's `set_area_tc()` is a no-op kept so old bots still load, so a bot that wants the size of a hypothetical board has to walk `adat[].join` itself; [Reinforcement optimization](../advanced/reinforcement-optimization.md) has a `largestGroupSize(game, player)` flood fill for that, and the bridge finder below is the same walk with one territory left out.

## Implementation

This strategy has two main components:

1. **Avoid breaking connections** - Prevent attacks that could lead to disconnected territories
2. **Target strategic connections** - Prioritize attacks that connect or expand territory groups

```javascript
// Example: don't strip a border territory to one die while you have a big group to defend and no reserve dice
// `attacking_area` is the territory the attack would leave on one die
if (
  game.player[pn].area_tc > 4 &&
  area_info[attacking_area].second_highest_unfriendly_neighbor_dice > 2 &&
  game.player[pn].stock === 0
)
  continue;
```

## Example from ai_defensive.js

The defensive AI considers territory connections when deciding whether to attack:

```javascript
// Skip if we have a large territory to protect and no reinforcements
if (
  player[pn].area_tc > 4 &&
  area_info[attacker].second_highest_unfriendly_neighbor_dice > 2 &&
  player[pn].stock === 0
)
  return false;
```

This logic avoids risky attacks when the AI already has a substantial connected territory (more than 4 territories) but no reinforcement dice in reserve, especially when the territory it would attack from has a second strong enemy neighbor waiting.

## Why connections matter

A larger connected group earns more reinforcement dice every turn. Those dice are dropped at random across your territories, so a bigger income is what keeps your borders stocked. Losing a link that splits your group in two cuts your income immediately, which is why opponents will aim for exactly those territories.

## Implementation techniques

Ways to implement territory connection analysis:

1. **Graph algorithms** - Use union-find or graph traversal to identify connected components
2. **Connection metrics** - Score potential moves by how much they grow or shrink your largest group
3. **Bridge identification** - Find and protect "bridge" territories whose loss would split a group
4. **Expansion planning** - Target enemy territories whose capture would join two of your separate groups

## Example: finding bridge territories

Bridge territories are critical connections that, if lost, would split your territory into disconnected parts. The view's `area_tc` never changes under a bot's hands, so the check recomputes the largest group with each candidate left out:

```javascript
// Size of `player`'s largest connected group with `excluded` treated as lost.
function largestGroupWithout(game, player, excluded) {
  const mine = id => id !== excluded && game.adat[id].size !== 0 && game.adat[id].arm === player;
  const seen = new Set();
  let largest = 0;

  for (let start = 1; start < game.AREA_MAX; start++) {
    if (!mine(start) || seen.has(start)) continue;

    // Flood fill the group containing this territory
    let size = 0;
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.pop();
      size++;
      for (let i = 1; i < game.AREA_MAX; i++) {
        if (seen.has(i) || !mine(i) || !game.adat[current].join[i]) continue;
        seen.add(i);
        queue.push(i);
      }
    }

    if (size > largest) largest = size;
  }

  return largest;
}

function findBridgeTerritories(game, player) {
  const bridges = [];
  const currentSize = game.player[player].area_tc;

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;

    // Losing a territory that is not a bridge shrinks the largest group by at most one: itself.
    if (largestGroupWithout(game, player, i) < currentSize - 1) bridges.push(i);
  }

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
