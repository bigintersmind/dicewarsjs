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

Both sides roll every die and compare the sums, and the defender wins ties. Exact win probabilities for a one-die lead:

| Attacker dice | Defender dice | Win probability |
| ------------- | ------------- | --------------- |
| 2             | 1             | 83.8%           |
| 3             | 2             | 77.9%           |
| 4             | 3             | 74.3%           |
| 5             | 4             | 71.8%           |
| 6             | 5             | 70.0%           |
| 7             | 6             | 68.5%           |
| 8             | 7             | 67.3%           |

One extra die is worth most on small stacks. The extra die always adds the same 3.5 points on average, but the spread of both totals widens as the stacks grow, so that fixed edge covers less and less of the variance: 2 vs 1 wins 83.8% of the time, 8 vs 7 only 67.3%.

Equal dice never favor the attacker, because ties go to the defender. 2 vs 2 wins 44.4%, 3 vs 3 wins 45.4%, and 8 vs 8 wins 47.1%. The odds edge toward even as the stacks grow but never reach it.

These figures come from `src/ai/diceOdds.js`, which builds the full table by convolving the d6 distributions at module load. Use `winProbability(attackerDice, defenderDice)` from there rather than hard-coding numbers.

## Example from ai_example.js

```javascript
// Iterate through all territories to find potential attackers
for (let i = 1; i < game.AREA_MAX; i++) {
  const attacking_area = game.adat[i];

  if (attacking_area.size === 0) continue; // Skip empty territories
  if (attacking_area.arm !== current_player) continue; // Skip enemy territories
  if (attacking_area.dice <= 1) continue; // Skip territories with 1 or fewer dice

  // For each potential attacker, look for valid targets
  for (let j = 1; j < game.AREA_MAX; j++) {
    const defending_area = game.adat[j];

    if (defending_area.size === 0) continue; // Skip empty territories
    if (defending_area.arm === current_player) continue; // Skip own territories
    if (attacking_area.join[j] === 0) continue; // Skip non-adjacent territories

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
