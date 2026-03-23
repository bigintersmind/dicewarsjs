# Bridge Architecture: ES6 to Legacy Code

This document explains the bridge architecture used in DiceWarsJS to manage the transition from legacy code to modern ES6 modules.

## Overview

The bridge pattern implemented in this project allows us to:

1. Incrementally migrate to ES6 modules
2. Maintain backward compatibility with the legacy code
3. Avoid a complete rewrite while modernizing the codebase
4. Test and verify changes in isolation

## How the Bridge Works

The bridge consists of ES6 modules that:

1. Import functionality from modern ES6 module implementations
2. Export that functionality to the global window object for legacy code
3. Also provide proper ES6 exports for new code

```javascript
// Example: ai.js bridge
import {
  ai_default,
  ai_defensive,
  ai_example,
  ai_adaptive,
  AI_STRATEGIES,
  getAIById,
  getAllAIStrategies,
  createAIFunctionMapping,
} from '../ai/index.js';

// Export to global scope for legacy code
window.ai_default = ai_default;
window.ai_defensive = ai_defensive;
window.ai_example = ai_example;
window.ai_adaptive = ai_adaptive;

// Also export configuration to global scope
window.AI_STRATEGIES = AI_STRATEGIES;
window.getAIById = getAIById;
window.getAllAIStrategies = getAllAIStrategies;
window.createAIFunctionMapping = createAIFunctionMapping;

// Also export as ES6 module for new code
export {
  ai_default,
  ai_defensive,
  ai_example,
  ai_adaptive,
  AI_STRATEGIES,
  getAIById,
  getAllAIStrategies,
  createAIFunctionMapping,
};
```

## Bridge Components

The bridge system is composed of the following modules:

1. **AI Bridge** (`src/bridge/ai.js`)

   - Exposes AI strategy functions to the global scope
   - Provides access to the centralized AI configuration system
   - Exposes helper functions for AI lookups and player-to-AI mapping
   - Used by the legacy game.js for AI player moves

2. **Game Bridge** (`src/bridge/Game.js`)

   - Exposes the ES6 `Game` class globally so legacy scripts can create the game
     instance during migration

## Initialization Timing Issues

One key challenge with the bridge architecture is initialization timing. Since webpack bundles the modules together, the execution order might differ from the traditional script loading.

### Problem

Legacy code might try to access bridged functions before they're initialized, causing errors like:

```
Uncaught runtime errors:
ERROR
ai_function is not a function
```

### Solutions

We've implemented several strategies to handle initialization timing:

1. **Delayed Initialization**

   - Initialize key objects with null/empty values initially
   - Populate with actual functions after modules are loaded
   - Example: Game.js now initializes AI array with nulls and populates it later in start_game()

2. **Function Existence Checks**

   - Add existence checks before calling potentially uninitialized functions
   - Provide fallbacks for missing functions
   - Example: com_thinking() now checks if ai_function exists before calling it

3. **Explicit Loading Order**
   - Ensure bridge modules are loaded before they are needed
   - Webpack entry points and import structure control this

## Best Practices for Bridge Components

When working with or adding to the bridge architecture:

1. **Always Check for Existence**

   ```javascript
   if (typeof window.myFunction === 'function') {
     // Safe to call
     window.myFunction();
   }
   ```

2. **Provide Fallbacks**

   ```javascript
   const myFunction =
     typeof window.myFunction === 'function' ? window.myFunction : defaultImplementation;
   ```

3. **Log Bridge Initialization**

   ```javascript
   // At the end of bridge modules
   console.log('Bridge module X successfully initialized');
   ```

4. **Test for Race Conditions**
   - Create tests that verify bridge functions are available when needed
   - Test different initialization scenarios

## Comprehensive Migration Plan

We are now implementing a structured 9-phase plan to complete the ES6 migration. For the full details, refer to the [Project Roadmap](./roadmap.md). The approach involves:

1. **Assessment and Planning**: Auditing the codebase and establishing migration priorities
2. **Infrastructure Setup**: Creating robust testing and build systems
3. **Core Component Migration**: Converting key game systems to ES6 modules
4. **UI and Interaction Migration**: Modernizing the rendering and input systems
5. **Optimization**: Implementing performance improvements and error handling
6. **Bridge Reduction**: Gradually removing bridge dependencies
7. **Unmigratable Code Strategy**: Creating adapters for legacy code that cannot be migrated
8. **Documentation and Cleanup**: Ensuring thorough documentation and code quality
9. **Final Bridge Removal**: Complete elimination of bridge components

This phased approach ensures that at each step the game remains functional while progressively reducing dependency on the bridge pattern.

## Bridge Component Removal Strategy

As we migrate modules to pure ES6, we'll follow this bridge removal process:

1. **Identify Direct Module Users**: Determine which legacy components use each bridge module
2. **Convert Legacy Dependents**: Migrate those legacy components to ES6 modules
3. **Replace Bridge Imports**: Update import statements to reference ES6 modules directly
4. **Remove Global Exports**: Once no legacy code depends on global exports, remove them
5. **Test Extensively**: Verify that no regressions are introduced at each step
6. **Final Removal**: Once all dependencies are migrated, remove the bridge module

Each bridge component will go through this process individually, allowing for incremental progress while maintaining a working application.

## Future Direction

The bridge architecture is a temporary solution to ease the transition to full ES6 modules. Eventually, all code will be migrated to ES6 modules and the bridge components will be removed.

Long-term steps:

1. Migrate all legacy code to ES6 modules
2. Ensure all code imports the ES6 modules directly
3. Remove global exports from bridge modules
4. Eventually remove bridge modules entirely

This bridge architecture is a critical transitional tool. For the detailed strategy on phasing out legacy code, reducing reliance on the bridge, and the eventual goal of a fully modernized codebase (either pure ES6 or ES6 with adapters for difficult-to-migrate code), please refer to the [ES6 Migration Plan](./ES6_MIGRATION_PLAN.md) and the [Project Roadmap](./ROADMAP.md).

## Recent Fixes

We recently fixed an issue where the Game object was trying to access AI functions before they were available in the global scope:

1. **Problem**: AI functions were referenced directly in the Game constructor
2. **Solution**:
   - Initialized Game.ai array with null values
   - Populated the array in the start_game method
   - Added error handling in com_thinking for graceful fallbacks

This pattern may need to be applied to other components as we continue the modernization process.
