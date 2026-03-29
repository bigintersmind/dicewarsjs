/**
 * Cautious Bot — only attacks when it has strictly more dice than the defender.
 * Among valid attacks, picks the one with the biggest dice advantage.
 * Never takes a risky fight.
 */

let bestAttack = null;
let bestAdvantage = 0;

for (const area of state.myAreas) {
  if (area.dice <= 1) continue;

  for (const neighborId of area.neighbors) {
    const neighbor = state.allAreas.find(a => a.id === neighborId);
    if (!neighbor || neighbor.owner === state.myPlayer) continue;

    // Only attack with strict dice advantage
    const advantage = area.dice - neighbor.dice;
    if (advantage <= 0) continue;

    // Pick the attack with the biggest advantage
    if (advantage > bestAdvantage) {
      bestAdvantage = advantage;
      bestAttack = { from: area.id, to: neighbor.id };
    }
  }
}

return bestAttack;
