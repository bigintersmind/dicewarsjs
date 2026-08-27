# Random selection strategy

Pick a move at random from the valid options. It sounds like a non-strategy, but it is the backbone of `ai_default` and a useful ingredient in stronger bots.

## Core concept

After identifying all valid moves (typically attacks with a dice advantage), randomly select one rather than trying to determine the "best" move.

## Implementation

Draw from `game.random()`, the seeded drop-in for `Math.random` on the game view. Same seed, same game; `Math.random` would break that (issue #151). [AI structure](../implementation/ai-structure.md#move-selection) has the full reasoning.

```javascript
// Randomly select a move from the valid options
const n = Math.floor(game.random() * number_of_moves);
const move = list_moves[n];

// Set the selected move in the game state
game.area_from = move['attacker'];
game.area_to = move['defender'];
```

## Example from ai_default.js

`ai_default` collects the attacks that pass its `isValidAttack` filters (dice advantage, the dominant-player rule, the equal-dice rule) in a helper, then picks one at the end of the function:

```javascript
// Get all valid attacks
const validAttacks = findValidAttacks();

// End turn if no valid attacks found
if (validAttacks.length === 0) {
  return 0;
}

// Choose a random valid attack from the list
const selectedAttack = validAttacks[Math.floor(game.random() * validAttacks.length)];

// Update game state with the selected attack
game.area_from = selectedAttack.attacker;
game.area_to = selectedAttack.defender;
```

## Trade-offs

Random selection is cheap to run and hard for opponents to read. The cost is that it happily picks a strategically bad move when a better one exists, never adapts to the board or the opponents, and swings wildly from game to game.

## Variations

Uniform probability is only the starting point:

1. **Weighted selection** - Give higher-value moves a higher probability of being picked
2. **Bounded randomness** - Filter down to "good enough" moves first, then pick randomly within that subset

## When to use

1. As a fallback when your evaluation function can't separate the top moves
2. In the early game, before the board has taken shape
3. To make an otherwise deterministic bot less predictable

## Example hybrid approach

```javascript
// First, identify all moves with at least a 2-dice advantage
const strongMoves = findMovesWithStrengthAdvantage(game, 2);

// If we have strong moves, pick one randomly
if (strongMoves.length > 0) {
  const index = Math.floor(game.random() * strongMoves.length);
  return strongMoves[index];
}

// Otherwise, fall back to any valid move with a dice advantage
const validMoves = findAllValidMoves(game);
if (validMoves.length > 0) {
  const index = Math.floor(game.random() * validMoves.length);
  return validMoves[index];
}

// No valid moves, end turn
return 0;
```
