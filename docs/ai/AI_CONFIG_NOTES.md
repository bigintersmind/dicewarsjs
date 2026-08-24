# AI configuration system notes

Notes on the centralized AI configuration system in DiceWarsJS.

## Overview

AI configuration is centralized in `src/ai/aiConfig.js` so the game and the bot arena manage AI strategies the same way. This keeps the code maintainable and makes new strategies easy to add.

## Key components

1. **AI strategy registry**: `AI_STRATEGIES` in `aiConfig.js`

   - Maps string identifiers to AI strategy objects with metadata
   - Includes name, description, difficulty, and implementation function
   - Single source of truth for all AI strategy information

2. **Helper functions**

   - `getAIById()`: gets strategy details by ID
   - `getAIImplementation()`: gets just the AI function implementation
   - `getAllAIStrategies()`: lists all available strategies
   - `createAIFunctionMapping()`: creates player-to-AI function mappings

3. **Default assignments**
   - `DEFAULT_AI_ASSIGNMENTS`: default mapping of player indices to AI strategy IDs

## Assigning AIs to players

AI strategies are assigned per player with an `aiAssignments` array. Each entry is a strategy ID for that player index; `null` marks a human player:

```javascript
const aiAssignments = [
  null, // Player 0 (human)
  'ai_defensive', // Player 1
  'ai_defensive', // Player 2
  // ...
];
```

`createAIFunctionMapping(aiAssignments)` resolves these IDs to the actual AI functions the engine runs.

## Adding new AI strategies

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

3. Assign it to players in the `aiAssignments` array:

```javascript
aiAssignments[3] = 'ai_myCustom'; // Assign to player 3
```

## Testing

When testing AI functionality, you can use:

```javascript
import { createAIFunctionMapping } from '../ai/index.js';

// Map strategy IDs to AI functions (async, since strategies load on demand)
const aiAssignments = ['ai_default', 'ai_defensive', null, 'ai_adaptive'];
const aiFunctions = await createAIFunctionMapping(aiAssignments);

// aiFunctions[i] is the AI for player i (null = human)
```

## Performance

The AI configuration system adds minimal overhead in exchange for better organization and metadata. Centralizing it also leaves room for later optimizations like lazy-loading AI strategies or dynamic strategy selection.
