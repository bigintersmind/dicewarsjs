/**
 * Default AI strategy from gamedesign.jp
 * This AI uses a simple but effective approach:
 * 1. Counts territories and dice for each player
 * 2. Ranks players by dice count
 * 3. Identifies dominant players
 * 4. Makes random attacks from valid options
 */
import { getPlayerCount } from './playerCount.js';

export const ai_default = game => {
  const pmax = getPlayerCount(game);

  // Initialize area and dice counts for all players
  for (let i = 0; i < pmax; i++) {
    game.player[i].area_c = 0;
    game.player[i].dice_c = 0;
  }

  // Helper function to count dice and territories for each player
  const countPlayerResources = () => {
    let totalDiceCount = 0;

    // Count total dice and territories for each player
    for (let i = 1; i < game.AREA_MAX; i++) {
      const area = game.adat[i];

      if (area.size === 0) continue;

      const playerIndex = area.arm;
      const diceCount = area.dice;

      game.player[playerIndex].area_c++;
      game.player[playerIndex].dice_c += diceCount;
      totalDiceCount += diceCount;
    }

    return totalDiceCount;
  };

  // Count resources and get total dice count
  const totalDiceCount = countPlayerResources();

  /**
   * Helper function to rank players by dice count
   * Uses array operations instead of bubble sort
   */
  const rankPlayersByDiceCount = () => {
    // Create array of player indices with their dice counts
    const playerRankings = Array.from({ length: pmax }, (_, i) => ({
      playerIndex: i,
      diceCount: game.player[i].dice_c,
    }));

    // Sort by dice count (descending)
    playerRankings.sort((a, b) => b.diceCount - a.diceCount);

    // Assign ranks
    playerRankings.forEach((player, rank) => {
      game.player[player.playerIndex].dice_jun = rank;
    });
  };

  // Rank players by dice count
  rankPlayersByDiceCount();

  /**
   * Identify if there's a dominant player
   * A player is considered dominant if they have more than 40% of total dice
   */
  const findDominantPlayer = () => {
    const dominanceThreshold = totalDiceCount * 0.4;

    // Find first player with dice count above the threshold
    return game.player.findIndex(player => player.dice_c > dominanceThreshold);
  };

  // Determine if there's a dominant player
  const dominantPlayer = findDominantPlayer();

  /**
   * Helper function to determine if an attack is valid
   */
  const isValidAttack = (attackerArea, defenderArea) => {
    const currentPlayer = game.jun[game.ban];
    const defenderPlayer = defenderArea.arm;

    // Check if either attacker or defender involves dominant player (if any)
    if (dominantPlayer >= 0) {
      if (attackerArea.arm !== dominantPlayer && defenderArea.arm !== dominantPlayer) {
        return false;
      }
    }

    // Skip if defender has more dice
    if (defenderArea.dice > attackerArea.dice) {
      return false;
    }

    // Handle equal dice situations
    if (defenderArea.dice === attackerArea.dice) {
      // Default to not attacking
      let shouldAttack = false;

      // Attack if we're top ranked
      if (game.player[currentPlayer].dice_jun === 0) {
        shouldAttack = true;
      }

      // Attack if opponent is top ranked
      if (game.player[defenderPlayer].dice_jun === 0) {
        shouldAttack = true;
      }

      // 90% chance to attack in equal dice situations
      if (Math.random() > 0.1) {
        shouldAttack = true;
      }

      if (!shouldAttack) {
        return false;
      }
    }

    return true;
  };

  /**
   * Find all valid attacks
   * The AI will randomly choose from valid attacks that meet these criteria:
   * - Attacker has more dice than defender
   * - If dice counts are equal, various conditions apply
   * - If there's a dominant player, only consider attacks involving them
   */
  const findValidAttacks = () => {
    const validAttacks = [];
    const currentPlayer = game.jun[game.ban];

    // Check each potential attacker
    for (let i = 1; i < game.AREA_MAX; i++) {
      const attackerArea = game.adat[i];

      // Skip invalid attackers
      if (attackerArea.size === 0 || attackerArea.arm !== currentPlayer || attackerArea.dice <= 1) {
        continue;
      }

      // Check each potential defender
      for (let j = 1; j < game.AREA_MAX; j++) {
        const defenderArea = game.adat[j];

        // Skip invalid defenders
        if (
          defenderArea.size === 0 ||
          defenderArea.arm === currentPlayer ||
          attackerArea.join[j] === 0
        ) {
          continue;
        }

        // Verify if this attack is valid
        if (isValidAttack(attackerArea, defenderArea)) {
          validAttacks.push({
            attacker: i,
            defender: j,
          });
        }
      }
    }

    return validAttacks;
  };

  // Get all valid attacks
  const validAttacks = findValidAttacks();

  // End turn if no valid attacks found
  if (validAttacks.length === 0) {
    return 0;
  }

  // Choose a random valid attack from the list
  const selectedAttack = validAttacks[Math.floor(Math.random() * validAttacks.length)];

  // Update game state with the selected attack
  game.area_from = selectedAttack.attacker;
  game.area_to = selectedAttack.defender;
};
