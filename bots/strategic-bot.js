/**
 * Strategic Bot — adapts strategy based on game phase and board position.
 *
 * Early game:  Aggressive expansion to claim territory.
 * Mid game:    Prioritizes attacks that connect territory groups.
 * Late game:   Conservative, only attacks with strong dice advantage.
 */

// Score each possible attack
const attacks = [];

for (const area of state.myAreas) {
  if (area.dice <= 1) continue;

  for (const neighborId of area.neighbors) {
    const neighbor = state.allAreas.find(a => a.id === neighborId);
    if (!neighbor || neighbor.owner === state.myPlayer) continue;

    const advantage = area.dice - neighbor.dice;
    let score = 0;

    // Base score from dice advantage
    score += advantage * 10;

    // Bonus: capturing this territory would connect to other owned territories
    // Check if the target has any of our other territories as neighbors
    const connectsGroups = neighbor.neighbors.some(adjId => {
      if (adjId === area.id) return false;
      const adj = state.allAreas.find(a => a.id === adjId);
      return adj && adj.owner === state.myPlayer;
    });
    if (connectsGroups) score += 15;

    // Bonus: target has few neighbors (easier to defend once captured)
    if (neighbor.neighbors.length <= 3) score += 5;

    // Penalty: attacking from a territory that's our only high-dice border defense
    if (area.dice >= 6 && area.isBorder) score -= 5;

    // Phase adjustments
    if (state.gamePhase === 'early') {
      // Be more aggressive — accept smaller advantages
      score += 8;
    } else if (state.gamePhase === 'late') {
      // Be conservative — require strong advantage
      if (advantage < 2) score -= 20;
    }

    attacks.push({ from: area.id, to: neighbor.id, score, advantage });
  }
}

// Require strict dice advantage to attack (in early game, equal dice is also allowed)
const validAttacks = attacks.filter(a => {
  if (state.gamePhase === 'early') return a.advantage >= 0;
  return a.advantage > 0;
});

if (validAttacks.length === 0) return null;

// Sort by score descending, pick the best
validAttacks.sort((a, b) => b.score - a.score);

return { from: validAttacks[0].from, to: validAttacks[0].to };
