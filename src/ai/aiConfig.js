/**
 * AI Configuration Module
 *
 * Central configuration for all AI strategies in the game.
 * This module provides a registry of AI strategies, metadata,
 * and utility functions for accessing them.
 */

// Loader functions for each AI strategy using dynamic import
export const load_ai_default = async () => (await import('./ai_default.js')).ai_default;
export const load_ai_defensive = async () => (await import('./ai_defensive.js')).ai_defensive;
export const load_ai_example = async () => (await import('./ai_example.js')).ai_example;
export const load_ai_adaptive = async () => (await import('./ai_adaptive.js')).ai_adaptive;
export const load_ai_claude = async () => (await import('./ai_claude.js')).ai_claude;

/**
 * AI Strategy Registry
 *
 * Contains all available AI strategies with metadata.
 * Each entry provides:
 * - id: Unique identifier string for the AI
 * - name: Human-readable name
 * - description: Brief description of the AI's strategy
 * - difficulty: Relative difficulty (1-5)
 * - implementation: The actual AI function
 */
export const AI_STRATEGIES = {
  // Default balanced AI
  ai_default: {
    id: 'ai_default',
    name: 'Balanced AI',
    description: 'A balanced approach that weighs attack and defense equally',
    difficulty: 3,
    loader: load_ai_default,
    implementation: null,
  },

  // Defensive-focused AI
  ai_defensive: {
    id: 'ai_defensive',
    name: 'Defensive AI',
    description: 'Prioritizes protecting vulnerable territories',
    difficulty: 2,
    loader: load_ai_defensive,
    implementation: null,
  },

  // Example simple AI
  ai_example: {
    id: 'ai_example',
    name: 'Basic AI',
    description: 'Simple implementation for educational purposes',
    difficulty: 1,
    loader: load_ai_example,
    implementation: null,
  },

  // Adaptive AI that changes strategy
  ai_adaptive: {
    id: 'ai_adaptive',
    name: 'Adaptive AI',
    description: 'Adapts strategy based on game conditions',
    difficulty: 4,
    loader: load_ai_adaptive,
    implementation: null,
  },

  // Expected-value AI using exact dice odds and connectivity economics
  ai_claude: {
    id: 'ai_claude',
    name: 'Claude AI',
    description: 'Scores every attack by exact expected value of income and risk',
    difficulty: 5,
    loader: load_ai_claude,
    implementation: null,
  },
};

/**
 * Get AI information by ID
 * @param {string} aiId - The AI strategy ID
 * @returns {Object} AI strategy object with metadata and implementation
 */
export function getAIById(aiId) {
  return AI_STRATEGIES[aiId] || AI_STRATEGIES.ai_default;
}

/**
 * Get AI implementation function by ID
 * @param {string} aiId - The AI strategy ID
 * @returns {Function} The AI implementation function
 */
export async function getAIImplementation(aiId) {
  const strategy = AI_STRATEGIES[aiId] || AI_STRATEGIES.ai_default;
  if (!strategy.implementation) {
    strategy.implementation = await strategy.loader();
  }
  return strategy.implementation;
}

/**
 * Get all available AI strategies
 * @returns {Array} Array of AI strategy objects
 */
export function getAllAIStrategies() {
  return Object.values(AI_STRATEGIES);
}

/**
 * Default AI assignments
 * Maps player indices to AI strategy IDs
 */
export const DEFAULT_AI_ASSIGNMENTS = [
  'ai_adaptive', // Player 0 (human by default, AI in spectator mode)
  'ai_defensive', // Player 1
  'ai_defensive', // Player 2
  'ai_adaptive', // Player 3
  'ai_default', // Player 4
  'ai_default', // Player 5
  'ai_default', // Player 6
  'ai_default', // Player 7
];

/**
 * Create a mapping of player indices to AI implementation functions
 * @param {Array} aiAssignments - Array of AI strategy IDs for each player
 * @returns {Array} Array of AI implementation functions
 */
export async function createAIFunctionMapping(aiAssignments = DEFAULT_AI_ASSIGNMENTS) {
  const mappingPromises = aiAssignments.map(async aiId => {
    if (aiId === null) return null;
    try {
      return await getAIImplementation(aiId);
    } catch (err) {
      console.error(`Failed to load AI strategy ${aiId}`, err);
      return getAIImplementation('ai_default');
    }
  });
  return Promise.all(mappingPromises);
}
