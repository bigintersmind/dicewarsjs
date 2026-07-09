/**
 * Random Bot — picks a random territory and attacks a random enemy neighbor.
 * The simplest possible bot. Not effective, but a good starting point.
 *
 * Note it draws from state.random(), the seeded Math.random drop-in — never
 * the global Math.random, which would break same-seed reproducibility.
 */

// Find all territories we own that can attack (dice > 1, has enemy neighbor)
const attackers = state.myAreas.filter(
  a =>
    a.dice > 1 &&
    a.neighbors.some(nId => {
      const n = state.allAreas.find(t => t.id === nId);
      return n && n.owner !== state.myPlayer;
    })
);

if (attackers.length === 0) return null;

// Pick a random attacker
const from = attackers[Math.floor(state.random() * attackers.length)];

// Pick a random enemy neighbor
const enemies = from.neighbors
  .map(id => state.allAreas.find(a => a.id === id))
  .filter(a => a && a.owner !== state.myPlayer);

if (enemies.length === 0) return null;

const to = enemies[Math.floor(state.random() * enemies.length)];

return { from: from.id, to: to.id };
