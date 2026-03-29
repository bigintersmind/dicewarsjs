/**
 * Enhanced Player Data Structure
 *
 * An ES6+ implementation of the PlayerData class using private fields
 * for better encapsulation and data integrity.
 *
 * Tracks a player's game state, including:
 * - Territory ownership
 * - Dice counts and reinforcements
 * - Game ranking
 */
export class PlayerData {
  // Private fields using # prefix
  #areaCount = 0; // Number of areas owned

  #largestTerritory = 0; // Size of largest connected territory group

  #diceCount = 0; // Total number of dice across all territories

  #diceRank = 0; // Dice count ranking among players

  #stockedDice = 0; // Reinforcement dice available for distribution

  /**
   * Get the number of areas owned by this player
   * @returns {number} Area count
   */
  get areaCount() {
    return this.#areaCount;
  }

  /**
   * Set the number of areas owned by this player
   * @param {number} value - Area count
   */
  set areaCount(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new Error('Area count must be a non-negative number');
    }
    this.#areaCount = value;
  }

  /**
   * Get the size of the largest connected territory group
   * @returns {number} Largest territory size
   */
  get largestTerritory() {
    return this.#largestTerritory;
  }

  /**
   * Set the size of the largest connected territory group
   * @param {number} value - Largest territory size
   */
  set largestTerritory(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new Error('Largest territory size must be a non-negative number');
    }
    this.#largestTerritory = value;
  }

  /**
   * Get the total number of dice across all territories
   * @returns {number} Dice count
   */
  get diceCount() {
    return this.#diceCount;
  }

  /**
   * Set the total number of dice across all territories
   * @param {number} value - Dice count
   */
  set diceCount(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new Error('Dice count must be a non-negative number');
    }
    this.#diceCount = value;
  }

  /**
   * Get the dice count ranking among players
   * @returns {number} Dice rank
   */
  get diceRank() {
    return this.#diceRank;
  }

  /**
   * Set the dice count ranking among players
   * @param {number} value - Dice rank
   */
  set diceRank(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new Error('Dice rank must be a non-negative number');
    }
    this.#diceRank = value;
  }

  /**
   * Get the reinforcement dice available for distribution
   * @returns {number} Stocked dice
   */
  get stockedDice() {
    return this.#stockedDice;
  }

  /**
   * Set the reinforcement dice available for distribution
   * @param {number} value - Stocked dice
   */
  set stockedDice(value) {
    if (typeof value !== 'number' || value < 0) {
      throw new Error('Stocked dice must be a non-negative number');
    }
    this.#stockedDice = value;
  }

  /**
   * Add stocked dice
   * @param {number} amount - Amount to add
   * @param {number} maxStock - Maximum allowed stock
   * @returns {number} New stock amount
   */
  addStock(amount, maxStock = Infinity) {
    if (typeof amount !== 'number' || amount < 0) {
      throw new Error('Amount must be a non-negative number');
    }

    this.#stockedDice += amount;

    // Cap at max stock
    if (this.#stockedDice > maxStock) {
      this.#stockedDice = maxStock;
    }

    return this.#stockedDice;
  }

  /**
   * Use stocked dice
   * @param {number} amount - Amount to use
   * @returns {number} New stock amount
   * @throws {Error} If not enough dice in stock
   */
  useStock(amount) {
    if (typeof amount !== 'number' || amount < 0) {
      throw new Error('Amount must be a non-negative number');
    }

    if (this.#stockedDice < amount) {
      throw new Error('Not enough dice in stock');
    }

    this.#stockedDice -= amount;
    return this.#stockedDice;
  }

  /**
   * Update the player state after territory changes
   * @param {number} newAreaCount - New area count
   * @param {number} newDiceCount - New dice count
   * @param {number} newLargestTerritory - New largest territory size
   */
  updateState(newAreaCount, newDiceCount, newLargestTerritory) {
    this.areaCount = newAreaCount;
    this.diceCount = newDiceCount;
    this.largestTerritory = newLargestTerritory;
  }

  /**
   * Check if the player is defeated (has no territories)
   * @returns {boolean} True if defeated
   */
  isDefeated() {
    return this.#areaCount === 0;
  }

  /**
   * Calculate the reinforcement amount based on largest territory
   * @returns {number} Reinforcement amount
   */
  calculateReinforcements() {
    // Reinforcements = largest connected territory group (matches original DiceWars)
    return this.#largestTerritory;
  }

  // Legacy compatibility getters/setters

  get area_c() {
    return this.#areaCount;
  }

  set area_c(value) {
    this.#areaCount = value;
  }

  get area_tc() {
    return this.#largestTerritory;
  }

  set area_tc(value) {
    this.#largestTerritory = value;
  }

  get dice_c() {
    return this.#diceCount;
  }

  set dice_c(value) {
    this.#diceCount = value;
  }

  get dice_jun() {
    return this.#diceRank;
  }

  set dice_jun(value) {
    this.#diceRank = value;
  }

  get stock() {
    return this.#stockedDice;
  }

  set stock(value) {
    this.#stockedDice = value;
  }
}
