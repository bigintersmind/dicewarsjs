# AI Configuration System Notes

This document provides additional details about the centralized AI configuration system implemented in DiceWarsJS.

## Overview

The AI configuration system has been centralized in `src/ai/aiConfig.js` to provide consistent AI management across both legacy and modern ES6 code. This approach makes the code more maintainable and simplifies adding new AI strategies in the future.

## Key Components

1. **AI Strategy Registry** - `AI_STRATEGIES` in `aiConfig.js`

   - Maps string identifiers to AI strategy objects with metadata
   - Includes name, description, difficulty, and implementation function
   - Single source of truth for all AI strategy information

2. **Helper Functions**

   - `getAIById()` - Gets strategy details by ID
   - `getAIImplementation()` - Gets just the AI function implementation
   - `getAllAIStrategies()` - Lists all available strategies
   - `createAIFunctionMapping()` - Creates player-to-AI function mappings

3. **Default Assignments**
   - `DEFAULT_AI_ASSIGNMENTS` - Default mapping of player indices to AI strategy IDs

## Configuration System

The configuration system uses `aiAssignments` instead of the previous `aiTypes`:

```javascript
// Old approach
config.aiTypes = [
  null, // Player 0 (human)
  'ai_defensive', // Player 1
  'ai_defensive', // Player 2
  // ...
];

// New approach
config.aiAssignments = [
  null, // Player 0 (human)
  'ai_defensive', // Player 1
  'ai_defensive', // Player 2
  // ...
];
```

## Adding New AI Strategies

To add a new AI strategy:

1. Create your AI implementation file (e.g., `src/ai/ai_myCustom.js`)
2. Add a dynamic loader and registry entry in `aiConfig.js`:

```javascript
export const load_ai_myCustom = async () => (await import('./ai_myCustom.js')).ai_myCustom;

export const AI_STRATEGIES = {
  // Existing strategies...

  // Your new strategy
  ai_myCustom: {
    id: 'ai_myCustom',
    name: 'My Custom AI',
    description: 'Description of your strategy approach',
    difficulty: 3, // Rating from 1-5
    loader: load_ai_myCustom,
    implementation: null,
  },
};
```

3. Assign it to players in the configuration:

```javascript
config.aiAssignments[3] = 'ai_myCustom'; // Assign to player 3
```

## Legacy Support

For backward compatibility, the configuration system still supports the old `aiTypes` format, but will log a warning recommending upgrade to `aiAssignments`.

## Testing

When testing AI functionality, you can use:

```javascript
import { createAIFunctionMapping } from '../ai/index.js';

// Create AI assignments based on string identifiers
const aiAssignments = ['ai_default', 'ai_defensive', null, 'ai_adaptive'];
const aiFunctions = createAIFunctionMapping(aiAssignments);

// Apply to game
game.ai = aiFunctions;
```

## Performance

The AI configuration system adds minimal overhead while providing better organization and metadata. The centralized approach enables potential future optimizations like lazy-loading AI strategies or dynamic strategy selection.
