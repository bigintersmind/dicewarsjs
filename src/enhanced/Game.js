/**
 * Enhanced Game.js - Core Game Logic for Dice Wars
 * 
 * This file contains the ES6+ implementation of the Game class using modern data structures
 * like Maps for better performance and more idiomatic JavaScript.
 */

import { AreaData, PlayerData, JoinData, HistoryData, GridData } from '../models/enhanced/index.js';
// AI implementations will be loaded on demand via configuration
import { 
  // Map generation
  makeMap, setAreaTc, 
  // Battle resolution
  executeAttack, distributeReinforcements, setPlayerTerritoryData,
  // AI handling
  executeAIMove, AI_REGISTRY
} from '../mechanics/enhanced/index.js';
import { getConfig } from '../utils/config.js';

/**
 * Enhanced Game Class
 * 
 * An ES6+ implementation of the Game class using modern data structures
 * like Maps for better performance. Manages:
 * - Game state and configuration
 * - Player turns and board state
 * - Integration with AI players
 * - Territory ownership and dice placement
 * - Game history for replay
 */
export class Game {
  /**
   * AI registry - stores references to all available AI strategies
   * This allows the configuration system to map string names to function references
   */
  aiRegistry = AI_REGISTRY;
    
  /**
   * AI strategy array
   * 
   * Maps player indices to their AI strategy functions:
   * - Index 0 (null): Human player (no AI)
   * - Other indices: Different AI strategies set by configuration
   * 
   * These functions are called during computer player turns to determine moves.
   */
  ai = [
    null, // Player 0 (human player)
    null,
    null,
    null,
    null,
    null,
    null,
    null
  ];

  //=============================================
  // GRID AND MAP PROPERTIES
  //=============================================
  
  // Map dimensions
  XMAX = 28;                // Width of map grid (cells)
  YMAX = 32;                // Height of map grid (cells) 
  cel_max = this.XMAX * this.YMAX;  // Total number of cells
  
  // Grid data using typed arrays for better performance
  #gridData = new GridData(this.XMAX, this.YMAX);
  
  // Legacy compatibility - these getters/setters redirect to #gridData
  get cel() { return this.#gridData.cel; }
  set cel(value) { this.#gridData.cel = value; }
  
  get num() { return this.#gridData.num; }
  set num(value) { this.#gridData.num = value; }
  
  get next_f() { return this.#gridData.next_f; }
  set next_f(value) { this.#gridData.next_f = value; }
  
  get rcel() { return this.#gridData.rcel; }
  set rcel(value) { this.#gridData.rcel = value; }
  
  // Adjacency mapping - which cells are neighbors to each cell
  join = new Array(this.cel_max);   // Contains adjacency data for each cell
  
  // Territory (area) data
  AREA_MAX = 32;          // Maximum number of distinct territories
  
  // Modern ES6+ Map for territory data storage
  #territoriesMap = new Map();
  
  // Legacy array for backward compatibility
  adat = [];
  
  //=============================================
  // MAP GENERATION VARIABLES
  //=============================================
  
  // Used for map creation algorithm
  num = new Array(this.cel_max);    // Cell serial numbers for randomization
  rcel = new Array(this.cel_max);   // Cells available for territory expansion
  
  // Territory generation helpers
  next_f = new Array(this.cel_max);   // Peripheral cells used for territory growth
  alist = new Array(this.AREA_MAX);   // Working list of areas
  chk = new Array(this.AREA_MAX);     // Used for territory border drawing
  tc = new Array(this.AREA_MAX);      // Used for counting connected territories
  
  //=============================================
  // GAME STATE VARIABLES
  //=============================================
  
  // Game configuration
  pmax = 7;               // Number of players (default: 7)
  user = 0;               // Human player index (default: 0)
  put_dice = 3;           // Average number of dice per territory
  
  // Turn tracking
  jun = [0, 1, 2, 3, 4, 5, 6, 7]; // Player order array
  ban = 0;                        // Current turn index (current player = jun[ban])
  
  // Battle state
  area_from = 0;           // Attack source territory
  area_to = 0;             // Attack target territory
  defeat = 0;              // Attack result (0=failed, 1=succeeded)
  
  // Player state
  player = new Array(8);   // Player data objects
  STOCK_MAX = 64;          // Maximum dice reinforcements a player can have
  
  // AI helper arrays (used by computer players to track possible moves)
  list_from = new Array(this.AREA_MAX * this.AREA_MAX);  // Potential attacking territories
  list_to = new Array(this.AREA_MAX * this.AREA_MAX);    // Potential target territories
  
  //=============================================
  // HISTORY AND REPLAY SYSTEM
  //=============================================
  
  // Game action history
  his = [];                // Array of game actions (attacks/reinforcements)
  his_c = 0;               // Current history entry count
  
  // Initial game state for replay
  his_arm = new Array(this.AREA_MAX);   // Initial territory ownership
  his_dice = new Array(this.AREA_MAX);  // Initial dice counts

  /**
   * Game Constructor
   * 
   * Sets up initial state for a new game instance.
   * @param {Object} [config=null] - Optional configuration to apply
   */
  constructor(config = null) {
    // Initialize join data array
    for (let i = 0; i < this.cel_max; i++) {
      this.join[i] = new JoinData();
      // Pre-compute all adjacent cells for quick lookup
      for (let j = 0; j < 6; j++) {
        this.join[i].dir[j] = this.next_cel(i, j);
      }
    }
    
    // Initialize area data objects using Map
    for (let i = 0; i < this.AREA_MAX; i++) {
      const territory = new AreaData();
      this.#territoriesMap.set(i, territory);
      
      // Set up legacy array access
      this.adat[i] = territory;
    }
    
    // Initialize cell serial numbers for randomization
    for (let i = 0; i < this.cel_max; i++) {
      this.num[i] = i;
    }
    
    // Initialize player data objects
    for (let i = 0; i < 8; i++) {
      this.player[i] = new PlayerData();
    }
    
    // Apply configuration if provided
    if (config) {
      this.applyConfig(config);
    } else {
      // Otherwise load the default config
      this.applyConfig(getConfig());
    }
  }

  /**
   * Get Adjacent Cell Index
   * 
   * Calculates the index of a neighboring cell in the specified direction.
   * Handles the offset pattern of the hexagonal grid layout.
   * 
   * @param {number} opos - Current cell index
   * @param {number} dir - Direction (0-5, see JoinData for numbering)
   * @returns {number} Index of adjacent cell or -1 if out of bounds
   */
  next_cel(opos, dir) {
    const ox = opos % this.XMAX;            // Get x coordinate from index
    const oy = Math.floor(opos / this.XMAX);  // Get y coordinate from index
    const f = oy % 2;                       // Is this an odd-numbered row? (for offset)
    
    // Calculate offset based on direction and row parity
    let ax = 0;                             // x-offset to apply
    let ay = 0;                             // y-offset to apply
    
    switch (dir) {
      case 0: ax = f; ay = -1; break;      // Upper right
      case 1: ax = 1; ay = 0; break;       // Right
      case 2: ax = f; ay = 1; break;       // Bottom right
      case 3: ax = f - 1; ay = 1; break;   // Bottom left
      case 4: ax = -1; ay = 0; break;      // Left
      case 5: ax = f - 1; ay = -1; break;  // Upper left
    }
    
    // Apply offset to get new coordinates
    const x = ox + ax;
    const y = oy + ay;
    
    // Check if the new coordinates are out of bounds
    if (x < 0 || y < 0 || x >= this.XMAX || y >= this.YMAX) return -1;
    
    // Convert coordinates back to cell index
    return y * this.XMAX + x;
  }

  /**
   * Get territory by ID
   * 
   * @param {number} id - Territory ID
   * @returns {AreaData} Territory object
   */
  getTerritory(id) {
    return this.#territoriesMap.get(id);
  }

  /**
   * Get all territories
   * 
   * @returns {Map} Map of all territories
   */
  getTerritories() {
    return this.#territoriesMap;
  }

  /**
   * Generate Game Map
   * 
   * Creates a procedurally generated map with territories.
   * Delegates to the mapGenerator module.
   */
  make_map() {
    // Call the extracted makeMap function with the current game state
    makeMap(this);
  }

  /**
   * Initialize Game
   * 
   * Sets up a new game after the map has been created.
   * - Randomizes player turn order
   * - Initializes player data
   * - Sets up history tracking for replay
   * 
   * Note: Must be called after make_map() has generated the map.
   */
  start_game() {
    // Initialize and randomize player turn order
    for (let i = 0; i < 8; i++) this.jun[i] = i;  // Start with sequential ordering
    
    // Shuffle the first pmax elements using modern array shuffle
    for (let i = 0; i < this.pmax; i++) {
      const r = Math.floor(Math.random() * this.pmax);
      [this.jun[i], this.jun[r]] = [this.jun[r], this.jun[i]]; // ES6 destructuring swap
    }
    
    this.ban = 0;  // Set current turn to first player in the order
    
    // Initialize player data objects
    for (let i = 0; i < 8; i++) {
      this.player[i] = new PlayerData();
    }
    
    // Calculate territory groups for each player
    for (let i = 0; i < 8; i++) {
      this.set_area_tc(i);
    }
    
    // Initialize history for replay
    this.his_c = 0;  // Reset history counter
    
    // Record initial state of each territory using array methods
    for (let i = 0; i < this.AREA_MAX; i++) {
      const territory = this.getTerritory(i);
      if (territory) {
        this.his_arm[i] = territory.arm;   // Initial ownership
        this.his_dice[i] = territory.dice; // Initial dice count
      }
    }
  }

  /**
   * Calculate Connected Territory Groups
   * 
   * Delegates to the setAreaTc function in mapGenerator module.
   * 
   * @param {number} pn - Player number/index
   */
  set_area_tc(pn) {
    setAreaTc(this, pn);
  }

  /**
   * Get current player number
   * 
   * @returns {number} Index of the current player
   */
  get_pn() {
    return this.jun[this.ban];
  }
  
  /**
   * Execute Computer Player Move
   * 
   * Delegates to the appropriate AI strategy function for the current player.
   * 
   * @returns {number} Return value from the AI (0 to end turn, non-zero to continue)
   */
  com_thinking() {
    return executeAIMove(this);
  }
  
  /**
   * Record Action in History
   * 
   * Adds an entry to the game history for replay purposes.
   * 
   * @param {number} from - Source territory index
   * @param {number} to - Target territory (or 0 for reinforcement)
   * @param {number} res - Result (0=attack failed, 1=attack succeeded)
   */
  set_his(from, to, res) {
    // Create a new history entry
    this.his[this.his_c] = new HistoryData();
    this.his[this.his_c].from = from;
    this.his[this.his_c].to = to;
    this.his[this.his_c].res = res;
    
    // Increment history counter
    this.his_c++;
  }
  
  /**
   * Execute an Attack
   * 
   * Performs an attack between territories.
   * Delegates to the battleResolution module.
   * 
   * @param {number} fromArea - Index of attacking territory
   * @param {number} toArea - Index of defending territory
   * @returns {Object} Battle results
   */
  attack(fromArea, toArea) {
    return executeAttack(this, fromArea, toArea);
  }
  
  /**
   * Distribute Reinforcements
   * 
   * Calculates and distributes reinforcement dice for a player.
   * Delegates to the battleResolution module.
   * 
   * @param {number} playerIndex - Player to distribute reinforcements for
   * @returns {Object} Updated game state
   */
  distributeReinforcements(playerIndex) {
    return distributeReinforcements(this, playerIndex);
  }
  
  /**
   * Apply Configuration to Game
   * 
   * Updates game settings based on a configuration object.
   * 
   * @param {Object} config - Configuration settings to apply
   * @returns {Game} This game instance for chaining
   */
  applyConfig(config) {
    if (!config) return this;
    
    // Destructure configuration values with defaults
    const {
      playerCount = 7,
      humanPlayerIndex = 0,
      averageDicePerArea = 3,
      mapWidth = 28,
      mapHeight = 32,
      territoriesCount = 32,
      aiTypes = null
    } = config;
    
    // Game rules
    this.pmax = playerCount;
    this.user = humanPlayerIndex;
    this.put_dice = averageDicePerArea;
    
    // Map dimensions
    this.XMAX = mapWidth;
    this.YMAX = mapHeight;
    this.AREA_MAX = territoriesCount;
    
    // AI configuration - map string names to function references
    if (aiTypes && Array.isArray(aiTypes) && this.ai) {
      // Map AI type strings to actual functions
      for (let i = 0; i < aiTypes.length && i < this.ai.length; i++) {
        const aiType = aiTypes[i];
        
        // Skip null entries (human players)
        if (aiType === null) {
          this.ai[i] = null;
          continue;
        }
        
        // Map string names to the imported AI functions
        this.ai[i] = this.aiRegistry[aiType] || this.aiRegistry.ai_default;
        
        if (!this.aiRegistry[aiType]) {
          console.warn(`Unknown AI type: ${aiType}, using default AI`);
        }
      }
    }
    
    return this;
  }
}