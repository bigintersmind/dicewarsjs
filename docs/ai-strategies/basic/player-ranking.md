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

`ai_default` ranks the players and detects a dominant one in closures inside the bot function (`pmax` is the player count, read once at the top); the last slice below sits in its `isValidAttack` helper, where `attackerArea` and `defenderArea` are the helper's parameters and `currentPlayer` and `defenderPlayer` its first two locals:

```javascript
// Count resources and get total dice count
const totalDiceCount = countPlayerResources();

/**
 * Helper function to rank players by dice count
 * Uses array operations instead of bubble sort
 */
const rankPlayersByDiceCount = () => {
  // Create array of player indices with their dice counts
  const playerRankings = Array.from({ length: pmax }, (_, i) => ({
    playerIndex: i,
    diceCount: game.player[i].dice_c,
  }));

  // Sort by dice count (descending)
  playerRankings.sort((a, b) => b.diceCount - a.diceCount);

  // Assign ranks
  playerRankings.forEach((player, rank) => {
    game.player[player.playerIndex].dice_jun = rank;
  });
};

// Rank players by dice count
rankPlayersByDiceCount();

/**
 * Identify if there's a dominant player
 * A player is considered dominant if they have more than 40% of total dice
 */
const findDominantPlayer = () => {
  const dominanceThreshold = totalDiceCount * 0.4;

  // Find first player with dice count above the threshold
  return game.player.findIndex(player => player.dice_c > dominanceThreshold);
};

// Determine if there's a dominant player
const dominantPlayer = findDominantPlayer();

// ...

// Handle equal dice situations
if (defenderArea.dice === attackerArea.dice) {
  // Default to not attacking
  let shouldAttack = false;

  // Attack if we're top ranked
  if (game.player[currentPlayer].dice_jun === 0) {
    shouldAttack = true;
  }

  // Attack if opponent is top ranked
  if (game.player[defenderPlayer].dice_jun === 0) {
    shouldAttack = true;
  }

  // 90% chance to attack in equal dice situations
  if (game.random() > 0.1) {
    shouldAttack = true;
  }

  if (!shouldAttack) {
    return false;
  }
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

A special case is detecting a "dominant" player who controls a large portion of the board's resources. `ai_default` runs the check once per call, then applies the result inside its `isValidAttack` helper:

```javascript
/**
 * Identify if there's a dominant player
 * A player is considered dominant if they have more than 40% of total dice
 */
const findDominantPlayer = () => {
  const dominanceThreshold = totalDiceCount * 0.4;

  // Find first player with dice count above the threshold
  return game.player.findIndex(player => player.dice_c > dominanceThreshold);
};

// Determine if there's a dominant player
const dominantPlayer = findDominantPlayer();

// ...

// Check if either attacker or defender involves dominant player (if any)
if (dominantPlayer >= 0) {
  if (attackerArea.arm !== dominantPlayer && defenderArea.arm !== dominantPlayer) {
    return false;
  }
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
