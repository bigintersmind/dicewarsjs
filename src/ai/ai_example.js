/**
 * Example AI that demonstrates basic game mechanics
 * This AI implements a simple strategy:
 * 1. Finds all valid attacks where the attacker has more dice than the defender
 * 2. Randomly selects one of these valid attacks
 * 3. Continues until no valid attacks remain
 *
 * This implementation is written for clarity and educational purposes,
 * showing the basic structure needed for any Dice Wars AI.
 */
export const ai_example = game => {
  const currentPlayer = game.get_pn(); // Get the index of the current player

  /**
   * Create a list of valid moves (attacker/defender pairs)
   * Each move must meet these criteria:
   * - Attacking territory must be owned by current player
   * - Attacking territory must have more than 1 die
   * - Defending territory must be adjacent
   * - Attacker must have more dice than defender
   */
  const validMoves = [];

  // Helper function to check if a territory belongs to current player and has multiple dice
  const isValidAttacker = area => area.size !== 0 && area.arm === currentPlayer && area.dice > 1;

  // Helper function to check if a territory is a valid target
  const isValidTarget = (attacker, defender, defenderIndex) =>
    defender.size !== 0 &&
    defender.arm !== currentPlayer &&
    attacker.join[defenderIndex] !== 0 &&
    defender.dice < attacker.dice;

  // Iterate through all territories to find potential attackers
  for (let i = 1; i < game.AREA_MAX; i++) {
    const attackingArea = game.adat[i];

    // Skip invalid attackers
    if (!isValidAttacker(attackingArea)) continue;

    // For each potential attacker, look for valid targets
    for (let j = 1; j < game.AREA_MAX; j++) {
      const defendingArea = game.adat[j];

      // Skip invalid targets
      if (!isValidTarget(attackingArea, defendingArea, j)) continue;

      // Add valid move to the list
      validMoves.push({
        attacker: i,
        defender: j,
      });
    }
  }

  // End turn if no valid moves found
  if (validMoves.length === 0) return 0;

  // Randomly select a move from the valid options (seeded — never Math.random)
  const selectedMove = validMoves[Math.floor(game.random() * validMoves.length)];

  // Destructure the selected move
  const { attacker, defender } = selectedMove;

  // Set the selected move in the game state
  game.area_from = attacker;
  game.area_to = defender;

  /*
   * Note: This function will be called repeatedly until it returns 0
   * Returning nothing here allows the attack to proceed
   */
};
