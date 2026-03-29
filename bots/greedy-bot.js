/**
 * Greedy Bot — always attacks the weakest neighbor it can find.
 * Scans all possible attacks and picks the one where the defender has the fewest dice.
 * Ends turn when no attacks remain.
 */

let bestAttack = null;
let lowestDefenderDice = Infinity;

for (const area of state.myAreas) {
  if (area.dice <= 1) continue;

  for (const neighborId of area.neighbors) {
    const neighbor = state.allAreas.find(a => a.id === neighborId);
    if (!neighbor || neighbor.owner === state.myPlayer) continue;

    // Prefer targets with fewer dice
    if (neighbor.dice < lowestDefenderDice) {
      lowestDefenderDice = neighbor.dice;
      bestAttack = { from: area.id, to: neighbor.id };
    }
  }
}

return bestAttack;
