/**
 * Connector — maximizes reinforcements by growing the largest connected group.
 *
 * Reinforcements each turn equal the size of your biggest connected group of
 * territories, so Connector prefers favorable captures that fuse two of its own
 * groups into one. Among equally-connecting options it takes the safest odds.
 *
 * Deterministic (no Math.random), so daily tournaments are reproducible.
 */

const me = state.myPlayer;

// Fast id -> area lookup (the board is small, but this keeps scoring readable).
const byId = new Map(state.allAreas.map(a => [a.id, a]));

let best = null;
let bestScore = -Infinity;

for (const area of state.myAreas) {
  // Need 2+ dice to attack, and only border tiles can actually reach an enemy.
  if (area.dice <= 1 || !area.isBorder) continue;

  for (const nId of area.neighbors) {
    const target = byId.get(nId);
    if (!target || target.owner === me) continue;

    const advantage = area.dice - target.dice;
    if (advantage <= 0) continue; // only attack with a real dice edge

    // How many of MY other territories would capturing this tile connect to?
    // More connections => bigger merged group => more reinforcements next turn.
    let connections = 0;
    for (const adjId of target.neighbors) {
      if (adjId === area.id) continue;
      const adj = byId.get(adjId);
      if (adj && adj.owner === me) connections++;
    }

    const score = connections * 100 + advantage * 10;

    if (score > bestScore) {
      bestScore = score;
      best = { from: area.id, to: target.id };
    } else if (score === bestScore && best) {
      // Deterministic tie-break: lowest from-id, then lowest to-id.
      if (area.id < best.from || (area.id === best.from && target.id < best.to)) {
        best = { from: area.id, to: target.id };
      }
    }
  }
}

return best;
