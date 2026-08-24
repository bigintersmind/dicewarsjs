# Dice advantage analysis

The most basic filter in DiceWars: attack only when you have more dice than your opponent.

## Core concept

Only initiate attacks where your territory has more dice than the target territory. Since all dice on both sides are rolled and ties go to the defender, attacking without an advantage loses more often than not.

## Implementation

```javascript
// Only consider attacks where attacker has more dice than defender
if (defending_area.dice >= attacking_area.dice) continue;
```

## Probability analysis

The probability of winning a battle depends on the difference in dice:

| Attacker Dice | Defender Dice | Win Probability |
| ------------- | ------------- | --------------- |
| 2             | 1             | ~75%            |
| 3             | 2             | ~66%            |
| 4             | 3             | ~62%            |
| 5             | 4             | ~60%            |
| 6             | 5             | ~59%            |
| 7             | 6             | ~58%            |
| 8             | 7             | ~57%            |

These are approximate values and assume fair dice.

## Example from ai_example.js

```javascript
// Iterate through all territories to find potential attackers
for (let i = 1; i < game.AREA_MAX; i++) {
  const attacking_area = game.adat[i];

  if (attacking_area.size == 0) continue; // Skip empty territories
  if (attacking_area.arm != current_player) continue; // Skip enemy territories
  if (attacking_area.dice <= 1) continue; // Skip territories with 1 or fewer dice

  // For each potential attacker, look for valid targets
  for (let j = 1; j < game.AREA_MAX; j++) {
    const defending_area = game.adat[j];

    if (defending_area.size == 0) continue; // Skip empty territories
    if (defending_area.arm == current_player) continue; // Skip own territories
    if (attacking_area.join[j] == 0) continue; // Skip non-adjacent territories

    // Skip if defender has equal or more dice (considered a bad move)
    if (defending_area.dice >= game.adat[i].dice) continue;

    // Add valid move to the list
    list_moves[number_of_moves] = {
      attacker: i, // Index of the attacking territory
      defender: j, // Index of the defending territory
    };
    number_of_moves++;
  }
}
```

## Refinements

Once the basic filter works, consider:

1. **Weighted advantage** - Prefer attacks with greater dice differences, since the win probability climbs with the gap
2. **Equal-dice attacks** - Occasionally worth it despite the sub-50% odds, for example to break a stalemate or hit the leading player
3. **Attack from 8-dice stacks first** - A territory at the 8-dice cap can't grow any further, so dice parked there are wasted potential

## When to use

Almost every bot needs this filter, but on its own it is a weak player. Combine it with the other strategies in this guide.
