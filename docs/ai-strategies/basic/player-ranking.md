# Player ranking strategy

Rank the players by strength, then use the ranking to decide who to attack. It lets a bot gang up on a runaway leader or pick off the weakest opponent.

## Core concept

Calculate a strength ranking for each player, typically from total dice count, and use it when choosing which players to attack or defend against.

## Implementation

```javascript
// Calculate dice ranking for each player (0 = highest rank)
for (let i = 0; i < 8; i++) game.player[i].dice_jun = i;
for (let i = 0; i < 8 - 1; i++) {
  for (let j = i + 1; j < 8; j++) {
    if (game.player[i].dice_c < game.player[j].dice_c) {
      const tmp = game.player[i].dice_jun;
      game.player[i].dice_jun = game.player[j].dice_jun;
      game.player[j].dice_jun = tmp;
    }
  }
}
```

## Example from ai_default.js

```javascript
// Count total dice and territories for each player
let sum = 0;
for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    const arm = game.adat[i].arm;
    game.player[arm].area_c++;
    game.player[arm].dice_c += game.adat[i].dice;
    sum += game.adat[i].dice;
}

// Calculate dice ranking for each player (0 = highest rank)
for (let i = 0; i < 8; i++) game.player[i].dice_jun = i;
for (let i = 0; i < 8 - 1; i++) {
    for (let j = i + 1; j < 8; j++) {
        if (game.player[i].dice_c < game.player[j].dice_c) {
            const tmp = game.player[i].dice_jun;
            game.player[i].dice_jun = game.player[j].dice_jun;
            game.player[j].dice_jun = tmp;
        }
    }
}

// Identify if there's a dominant player (>40% of total dice)
let top = -1;
for (let i = 0; i < 8; i++) {
    if (game.player[i].dice_c > sum * 2 / 5) top = i;
}

// Handle equal dice situations based on player ranking
if (game.adat[j].dice === game.adat[i].dice) {
    const en = game.adat[j].arm;
    let f = 0;
    if (game.player[pn].dice_jun === 0) f = 1;  // Attack if we're top ranked
    if (game.player[en].dice_jun === 0) f = 1;  // Attack if opponent is top ranked
    // ...
}

// If there's a dominant player, only consider attacks involving them
if (top >= 0) {
    if (game.adat[i].arm !== top && game.adat[j].arm !== top) continue;
}
```

## Ranking metrics

Metrics to rank players by:

1. **Total dice count** - The sum of all dice across a player's territories
2. **Territory count** - The number of territories a player controls
3. **Connected territory size** - A player's largest connected group, which is what actually drives their reinforcement income
4. **Border pressure** - How many enemy territories border a player's territories
5. **Composite score** - A weighted combination of the above

## Strategic applications

Once you have rankings:

1. **Target the leader** - Attack the highest-ranked player before they run away with the game
2. **Opportunistic expansion** - Attack the lowest-ranked players for easier conquests
3. **Defensive posture** - Prioritize defense when your own rank is high, since everyone will be gunning for you
4. **Risk assessment** - Take more risks against lower-ranked players, who are least able to punish a failed attack

## Dominant player strategy

A special case is detecting a "dominant" player who controls a large portion of the board's resources:

```javascript
// Identify if there's a dominant player (>40% of total dice)
let top = -1;
for (let i = 0; i < 8; i++) {
    if (game.player[i].dice_c > sum * 2 / 5) top = i;
}

// If there's a dominant player, only consider attacks involving them
if (top >= 0) {
    if (game.adat[i].arm !== top && game.adat[j].arm !== top) continue;
}
```

This focuses all attention on either attacking or defending against the dominant player.

## Refinements

1. **Dynamic thresholds** - Adjust the definition of "dominant" based on the game state
2. **Multi-level targeting** - Build a full priority list instead of only flagging the top player
3. **Trend tracking** - Watch how rankings change between turns to spot a player who is about to break out

## When to use

Player ranking pays off most:

1. In the mid to late game, once player strengths have differentiated
2. In games with 3+ players, where choosing a target matters
3. Combined with other signals rather than as the sole decision rule
