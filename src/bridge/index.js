/**
 * Bridge Module Index
 *
 * This file serves as the main bridge between the ES6 module system and the legacy global scope.
 * It imports all bridge modules, which in turn expose ES6 module functionality to the global scope.
 *
 * This approach allows us to:
 * 1. Incrementally migrate to ES6 modules
 * 2. Keep the legacy code functioning during transition
 * 3. Test new ES6 modules without disrupting the game
 */

// Import initialization system first
import { BridgeInitializer, initCallbacks } from './initialization.js';

// Import all bridge modules directly
import './ai.js';
import './Game.js';
// Import mechanics but only re-export non-conflicting parts
import * as Mechanics from '../mechanics/index.js';

// Export utility modules for ES6 usage
export * from '../utils/config.js';
export * from '../utils/gameUtils.js';
export * from '../utils/render.js';
export * from '../utils/sound.js';

// Export core modules for ES6 usage
export { Game } from '../Game.js';
// Selectively re-export to avoid conflicts
export const {
  makeMap,
  setAreaTc,
  executeAttack,
  distributeReinforcements,
  setPlayerTerritoryData,
  executeAIMove,
  AI_REGISTRY,
} = Mechanics;

// Export AI modules for ES6 usage
export * from '../ai/index.js';

// Export initialization system
export { BridgeInitializer, initCallbacks };

// Mark config as ready (it's synchronous)
initCallbacks.configReady();

// Mark game as ready (currently synchronous)
initCallbacks.gameReady();

// Mark mechanics as ready (currently synchronous)
initCallbacks.mechanicsReady();

// Add legacy compatibility layer for checking bridge status
window.checkBridgeStatus = () => {
  const status = BridgeInitializer.getStatus();
  console.log('Bridge module status:', status);
  return status;
};

// Add legacy game initialization hook
window.waitForBridge = async () => {
  console.log('[Bridge] Legacy code waiting for bridge initialization...');
  const result = await BridgeInitializer.whenReady();
  console.log('[Bridge] Bridge ready:', result);
  return result;
};

// Add a global verification that can be called to check if ES6 modules loaded properly
window.ES6_LOADED = true;
window.verifyES6BridgeStatus = () => {
  const status = BridgeInitializer.getStatus();
  const ready = BridgeInitializer.isReady();

  console.log('Checking ES6 Bridge Status:');
  console.log('- Bridge ready:', ready);
  console.log('- Module status:', status);

  // Check each AI function to see if it's the placeholder or ES6 version
  const aiStatus = {};
  ['ai_default', 'ai_defensive', 'ai_example', 'ai_adaptive'].forEach(name => {
    const fn = window[name];
    if (!fn) {
      aiStatus[name] = 'Missing';
    } else if (fn.isPlaceholder) {
      aiStatus[name] = 'Placeholder';
    } else {
      aiStatus[name] = 'Loaded';
    }
  });

  console.log('- AI Functions:', aiStatus);

  return {
    ready,
    moduleStatus: status,
    aiStatus,
  };
};

// Log bridge initialization with timestamp
console.log(`[${new Date().toISOString()}] ES6 bridge initialization started`);

// For backward compatibility, dispatch event when ready
BridgeInitializer.whenReady().then(() => {
  console.log(`[${new Date().toISOString()}] ES6 bridge fully initialized`);

  // Dispatch legacy event for compatibility
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('es6ModulesLoaded'));
  }
});
