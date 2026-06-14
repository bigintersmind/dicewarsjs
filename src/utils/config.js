/**
 * Configuration Management Module
 *
 * Provides utilities for game configuration:
 * - Default game settings
 * - Configuration loading and saving
 * - Dynamic configuration options
 */

import { createAIFunctionMapping } from '../ai/index.js';  // Import AI configuration utilities

/**
 * Default game configuration
 */
export const DEFAULT_CONFIG = {
  // Game rules
  playerCount: 7,         // Default number of players (including human)
  humanPlayerIndex: 0,    // Index of human player (0-7)
  averageDicePerArea: 3,  // Average dice per territory
  maxDice: 8,             // Maximum dice per territory
  
  // AI configuration - imported from centralized AI config
  aiAssignments: [
    null,                // Player 0 (human by default)
    'ai_defensive',      // Player 1
    'ai_defensive',      // Player 2
    'ai_adaptive',       // Player 3
    'ai_default',        // Player 4
    'ai_default',        // Player 5
    'ai_claude',         // Player 6
    'ai_codex'           // Player 7
  ],

  // Spectator mode settings
  spectatorSpeedMultiplier: 1,
  
  // Display settings
  mapWidth: 28,           // Width of map grid (cells)
  mapHeight: 32,          // Height of map grid (cells)
  territoriesCount: 32,   // Maximum number of territories
  
  // Graphics settings
  displayScale: 1,        // Display scaling factor
  soundEnabled: true,     // Sound effects enabled
  
  // Display dimensions
  display: {
    viewWidth: 840,       // Canvas width
    viewHeight: 840,      // Canvas height
    cellWidth: 27,        // Cell width before scaling
    cellHeight: 18,       // Cell height before scaling
    messageYPos: 688,     // Y-position for messages
    armyYPos: 770         // Y-position for player status
  }
};

/**
 * Map-size presets surfaced in the title-screen UI.
 *
 * Each key resolves to concrete engine dimensions: a `mapWidth × mapHeight`
 * hex grid plus `maxAreas` (the territory-count ceiling passed to the engine's
 * createGame/generateMap). Sizes are chosen so that cells-per-territory stays
 * comfortably above the engine's MIN_TERRITORY_SIZE (6) and `maxAreas` always
 * exceeds the 8-player maximum, so every preset is guaranteed to generate a
 * playable map for any supported player count (no RangeError from pruning).
 *
 * `medium` intentionally mirrors DEFAULT_CONFIG (28×32, 32 territories) so the
 * default selection reproduces today's exact behaviour.
 */
export const MAP_SIZE_PRESETS = {
  small: { mapWidth: 20, mapHeight: 24, maxAreas: 20 },
  medium: { mapWidth: 28, mapHeight: 32, maxAreas: 32 },
  large: { mapWidth: 36, mapHeight: 40, maxAreas: 48 },
};

/** Default map-size preset key. */
export const DEFAULT_MAP_SIZE = 'medium';

/**
 * Resolve a map-size preset key to concrete engine dimensions.
 * Unknown/invalid keys fall back to the default (medium) preset.
 *
 * @param {string} size - Preset key ('small' | 'medium' | 'large')
 * @returns {{ mapWidth: number, mapHeight: number, maxAreas: number }}
 */
export function resolveMapSize(size) {
  return MAP_SIZE_PRESETS[size] ?? MAP_SIZE_PRESETS[DEFAULT_MAP_SIZE];
}

/**
 * Current active configuration
 */
let activeConfig = { ...DEFAULT_CONFIG };

// Merge in any legacy configuration provided before modules loaded
if (typeof window !== 'undefined' && window.GAME_CONFIG) {
  activeConfig = { ...activeConfig, ...window.GAME_CONFIG };
}

/**
 * Get the current game configuration
 * @returns {Object} The current configuration object
 */
export function getConfig() {
  return { ...activeConfig };
}

/**
 * Update the game configuration
 * @param {Object} newConfig - New configuration settings to apply
 * @returns {Object} The updated configuration
 */
export function updateConfig(newConfig) {
  activeConfig = {
    ...activeConfig,
    ...newConfig,
    // Handle nested objects separately for deep merge
    display: {
      ...activeConfig.display,
      ...(newConfig?.display ?? {})
    }
  };
  
  // Save to localStorage if available
  try {
    localStorage?.setItem('dicewarsConfig', JSON.stringify(activeConfig));
  } catch (e) {
    console.warn('Failed to save configuration to localStorage', e);
  }
  
  return getConfig();
}

/**
 * Load configuration from localStorage if available
 * @returns {Object} The loaded or default configuration
 */
export function loadConfig() {
  try {
    const savedConfig = localStorage?.getItem('dicewarsConfig');
    if (savedConfig) {
      updateConfig(JSON.parse(savedConfig));
    }
  } catch (e) {
    console.warn('Failed to load configuration from localStorage', e);
  }
  return getConfig();
}

/**
 * Reset configuration to defaults
 * @returns {Object} The default configuration
 */
export function resetConfig() {
  activeConfig = { ...DEFAULT_CONFIG };
  
  // Clear from localStorage if available
  try {
    localStorage?.removeItem('dicewarsConfig');
  } catch (e) {
    console.warn('Failed to clear configuration from localStorage', e);
  }
  
  return getConfig();
}

/**
 * Apply configuration to a game instance
 * @param {Game} game - The game instance to configure
 * @param {Object} [config=null] - Optional configuration to apply (uses active config if not provided)
 */
export async function applyConfigToGame(game, config = null) {
  const cfg = config ?? activeConfig;
  
  // Game rules
  game.pmax = cfg.playerCount;
  game.user = cfg.humanPlayerIndex;
  game.put_dice = cfg.averageDicePerArea;
  
  // Map dimensions
  game.XMAX = cfg.mapWidth;
  game.YMAX = cfg.mapHeight;
  game.AREA_MAX = cfg.territoriesCount;
  
  // AI configuration using the central configuration system
  if (Array.isArray(cfg.aiAssignments) && game.ai) {
    // Create a copy of aiAssignments to modify for the human player
    const aiAssignments = [...cfg.aiAssignments];

    // Ensure human player has null AI only if not in spectator mode
    if (cfg.humanPlayerIndex !== null && cfg.humanPlayerIndex >= 0 && cfg.humanPlayerIndex < aiAssignments.length) {
      aiAssignments[cfg.humanPlayerIndex] = null;
    }

    // Use the configureAI function if available (modern code pattern)
    if (typeof game.configureAI === 'function') {
      await game.configureAI(aiAssignments);
    }
    // Legacy compatibility approach
    else {
      // Get AI functions from the assignments
      const aiFunctions = await createAIFunctionMapping(aiAssignments);

      // Apply to the game's AI array
      for (let i = 0; i < aiFunctions.length && i < game.ai.length; i++) {
        game.ai[i] = aiFunctions[i];
      }
    }

    // Log info about AI configuration for debugging
    console.log(`Game configured with humanPlayerIndex: ${cfg.humanPlayerIndex}`);
    console.log(`Player 0 AI function: ${game.ai[0] ? 'AI' : 'Human'}`);
  }
  // Legacy support for older config format
  else if (Array.isArray(cfg.aiTypes) && game.ai) {
    console.warn('Using legacy aiTypes configuration - consider upgrading to aiAssignments');

    // Use aiTypes as aiAssignments
    const aiAssignments = [...cfg.aiTypes];

    // Ensure human player has null AI only if not in spectator mode
    if (cfg.humanPlayerIndex !== null && cfg.humanPlayerIndex >= 0 && cfg.humanPlayerIndex < aiAssignments.length) {
      aiAssignments[cfg.humanPlayerIndex] = null;
    }

    // Get AI functions from the assignments
    const aiFunctions = await createAIFunctionMapping(aiAssignments);

    // Apply to the game's AI array
    for (let i = 0; i < aiFunctions.length && i < game.ai.length; i++) {
      game.ai[i] = aiFunctions[i];
    }
  }
  
  return game;
}

// Initialize by loading any saved configuration
loadConfig();

// Export functions for global use
if (typeof window !== 'undefined') {
  window.applyGameConfig = applyConfigToGame;
  window.getConfig = getConfig;
  window.updateConfig = updateConfig;
  window.resetConfig = resetConfig;
}
