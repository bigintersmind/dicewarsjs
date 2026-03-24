/**
 * AI Bridge Module
 *
 * This is a bridge module that exports ES6 module AI implementations to the global scope
 * for compatibility with the legacy code while enabling the incremental transition to ES6.
 */

// Import initialization system
import { initCallbacks } from './initialization.js';

// Import ES6 module implementations and configuration
import {
  AI_STRATEGIES,
  getAIById,
  getAIImplementation,
  getAllAIStrategies,
  createAIFunctionMapping,
  DEFAULT_AI_ASSIGNMENTS,
} from '../ai/index.js';

// Also export as ES6 module for new code
export {
  AI_STRATEGIES,
  getAIById,
  getAIImplementation,
  getAllAIStrategies,
  createAIFunctionMapping,
  DEFAULT_AI_ASSIGNMENTS,
};

// Create fallback AI function that returns 0 (end turn)
const fallbackAI = game => {
  console.warn('Using fallback AI function - ending turn');
  // Legacy AI functions return 0 to end their turn
  return 0;
};

// Create placeholder AI functions that will be replaced
const createPlaceholder = name => {
  const placeholder = function (game) {
    console.warn(`${name} called before initialization - using fallback`);
    return fallbackAI(game);
  };
  // Mark as placeholder for detection
  placeholder.isPlaceholder = true;
  placeholder.aiName = name;
  return placeholder;
};

// Initialize placeholders immediately (synchronous)
window.AI_REGISTRY = window.AI_REGISTRY || {};
window.ai_default = createPlaceholder('ai_default');
window.ai_defensive = createPlaceholder('ai_defensive');
window.ai_example = createPlaceholder('ai_example');
window.ai_adaptive = createPlaceholder('ai_adaptive');

// Also add to registry
window.AI_REGISTRY.ai_default = window.ai_default;
window.AI_REGISTRY.ai_defensive = window.ai_defensive;
window.AI_REGISTRY.ai_example = window.ai_example;
window.AI_REGISTRY.ai_adaptive = window.ai_adaptive;

console.log('[AI Bridge] Placeholders installed');

// Load actual AI implementations asynchronously
(async () => {
  try {
    const loadedAIs = {};
    const aiNames = ['ai_default', 'ai_defensive', 'ai_example', 'ai_adaptive'];

    // Load all AI strategies
    const loadPromises = aiNames.map(async key => {
      try {
        if (AI_STRATEGIES[key] && AI_STRATEGIES[key].loader) {
          const fn = await AI_STRATEGIES[key].loader();
          loadedAIs[key] = fn;
          console.log(`[AI Bridge] Loaded ${key}`);
        } else {
          console.warn(`[AI Bridge] No loader for ${key}`);
          loadedAIs[key] = fallbackAI;
        }
      } catch (error) {
        console.error(`[AI Bridge] Failed to load ${key}:`, error);
        loadedAIs[key] = fallbackAI;
      }
    });

    await Promise.all(loadPromises);

    // Replace placeholders with actual implementations
    Object.entries(loadedAIs).forEach(([key, fn]) => {
      window[key] = fn;
      window.AI_REGISTRY[key] = fn;
    });

    // Expose the configuration utility functions
    window.AI_STRATEGIES = AI_STRATEGIES;
    window.DEFAULT_AI_ASSIGNMENTS = DEFAULT_AI_ASSIGNMENTS;
    window.getAIById = getAIById;
    window.getAIImplementation = getAIImplementation;
    window.getAllAIStrategies = getAllAIStrategies;
    window.createAIFunctionMapping = createAIFunctionMapping;

    // Helper function to get AI by name (for legacy compatibility)
    window.getAIFunctionByName = name => {
      if (window.AI_REGISTRY[name]) {
        return window.AI_REGISTRY[name];
      }
      console.warn(`AI function ${name} not found, using default`);
      return window.AI_REGISTRY.ai_default || fallbackAI;
    };

    console.log('[AI Bridge] All AI functions loaded successfully');

    // Signal that AI module is ready
    initCallbacks.aiReady();
  } catch (error) {
    console.error('[AI Bridge] Critical error during initialization:', error);

    // Ensure fallbacks are in place
    const aiNames = ['ai_default', 'ai_defensive', 'ai_example', 'ai_adaptive'];
    aiNames.forEach(key => {
      if (!window[key] || window[key].isPlaceholder) {
        window[key] = fallbackAI;
        window.AI_REGISTRY[key] = fallbackAI;
      }
    });

    // Set up minimal utility functions
    window.AI_STRATEGIES = {};
    window.DEFAULT_AI_ASSIGNMENTS = [];
    window.getAIById = () => fallbackAI;
    window.getAIImplementation = () => fallbackAI;
    window.getAllAIStrategies = () => [];
    window.createAIFunctionMapping = () => ({});
    window.getAIFunctionByName = () => fallbackAI;

    // Signal error
    initCallbacks.aiReady(error);
  }
})();
