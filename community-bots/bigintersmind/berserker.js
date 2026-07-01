/**
 * Berserker — relentless expansion. Grabs every favorable capture and will even
 * take a coin-flip (equal dice) when nothing safer is on the board, trading
 * risk for board presence and tempo.
 *
 * Picks the single best attack each call; the engine calls the bot again until
 * it returns null, so Berserker keeps swinging while it has loaded territories.
 *
 * Deterministic (no Math.random).
 */

const me = state.myPlayer;
const byId = new Map(state.allAreas.map(a => [a.id, a]));

let best = null;
let bestScore = -Infinity;

for (const area of state.myAreas) {
  if (area.dice <= 1 || !area.isBorder) continue;

  for (const nId of area.neighbors) {
    const target = byId.get(nId);
    if (!target || target.owner === me) continue;

    const advantage = area.dice - target.dice;
    if (advantage < 0) continue; // accept equal dice, but never attack uphill

    // Reward big dice edges; lightly prefer weak, poorly-connected targets that
    // are easier to hold once captured.
    const score = advantage * 100 - target.dice * 5 - target.neighbors.length;

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
