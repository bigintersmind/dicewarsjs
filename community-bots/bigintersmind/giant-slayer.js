/**
 * Giant Slayer — refuses to let any single player run away with the game.
 *
 * Finds the strongest opponent by total dice and focuses favorable attacks on
 * that leader, chipping down the board's biggest threat. When the leader is out
 * of reach it falls back to the best favorable attack anywhere.
 *
 * Deterministic (no Math.random).
 */

const me = state.myPlayer;
const byId = new Map(state.allAreas.map(a => [a.id, a]));

// Identify the leader: the active opponent holding the most total dice.
let leader = -1;
let leaderDice = -1;
for (const p of state.players) {
  if (p.id === me || p.eliminated) continue;
  if (p.totalDice > leaderDice) {
    leaderDice = p.totalDice;
    leader = p.id;
  }
}

let best = null;
let bestScore = -Infinity;

for (const area of state.myAreas) {
  if (area.dice <= 1 || !area.isBorder) continue;

  for (const nId of area.neighbors) {
    const target = byId.get(nId);
    if (!target || target.owner === me) continue;

    const advantage = area.dice - target.dice;
    if (advantage <= 0) continue; // only pick fights we are favored to win

    // Large bonus for hitting the leader; otherwise rank purely by dice edge.
    const score = (target.owner === leader ? 1000 : 0) + advantage * 10;

    if (score > bestScore) {
      bestScore = score;
      best = { from: area.id, to: target.id };
    } else if (score === bestScore && best) {
      if (area.id < best.from || (area.id === best.from && target.id < best.to)) {
        best = { from: area.id, to: target.id };
      }
    }
  }
}

return best;
