# DiceWarsJS Modular Structure

This directory contains the refactored version of DiceWarsJS using ES6 modules. The modular structure separates concerns and makes the codebase easier to maintain and extend.

## Directory Structure

```
src/
├── ai/                    # AI strategy implementations
│   ├── ai_default.js      # Default balanced AI strategy
│   ├── ai_defensive.js    # Defensive AI strategy
│   ├── ai_example.js      # Simple example AI for learning
│   ├── ai_adaptive.js     # Adaptive AI that changes strategy based on game state
│   ├── aiConfig.js        # Centralized AI configuration and registry
│   └── index.js           # Exports all AI strategies and configuration
├── models/                # Data structures and models
│   ├── AreaData.js        # Territory data structure
│   ├── Battle.js          # Battle animation data
│   ├── HistoryData.js     # History tracking for replays
│   ├── JoinData.js        # Adjacency information for grid cells
│   ├── PlayerData.js      # Player state tracking
│   └── index.js           # Exports all models
├── utils/                 # Utility functions
│   ├── config.js          # Configuration management
│   ├── gameUtils.js       # Game logic helpers
│   ├── render.js          # UI rendering utilities
│   ├── sound.js           # Sound management
│   └── index.js           # Exports all utilities
├── Game.js                # Core game logic
├── index.html             # Main HTML file
├── main.js                # Game initialization and UI
└── README.md              # This documentation file
```

## Module Overview

### Game.js

The core game logic module that manages:

- Map generation and territory layout
- Game state management
- Player turns
- Attack resolution and dice mechanics
- History and replay functionality

### Models

Separate data structure classes:

- `AreaData`: Represents a territory on the map
- `PlayerData`: Tracks player stats and resources
- `JoinData`: Handles grid adjacency information
- `HistoryData`: Records game actions for replay
- `Battle`: Manages battle visualization data

### AI Strategies

Modular AI implementations with centralized configuration:

- `ai_default`: Balanced strategy from the original game
- `ai_defensive`: Conservative strategy focused on territory protection
- `ai_example`: Simple example for learning how to create custom AIs
- `ai_adaptive`: Adaptive strategy that changes based on game conditions

The AI system is managed through a centralized configuration in `aiConfig.js` that provides:

- A registry of all available AI strategies with metadata
- Helper functions for accessing and mapping AI implementations
- Utility functions for creating player-to-AI mappings
- Standardized AI registration for new strategies

### Utility Modules

Helper functions organized by purpose:

- `config.js`: Manages game configuration settings and persistence
- `gameUtils.js`: Game logic helper functions (attack probability, territory analysis)
- `render.js`: UI rendering utilities for map, territories, and UI elements
- `sound.js`: Sound management (loading, playing, volume control)

## Creating Custom AI

To create a custom AI:

1. Create a new file in the `ai/` directory (e.g., `ai_custom.js`)
2. Export a function that takes a `game` parameter
3. Implement your AI logic to select attacks
4. Add your new AI to the `index.js` export list
5. Add your AI to the registry in `aiConfig.js` for centralized management

Example:

```javascript
// ai/ai_custom.js
export function ai_custom(game) {
  // Your AI logic here
  // ...

  // Return 0 to end turn if no valid attacks
  if (no_good_moves) return 0;

  // Set your chosen attack
  game.area_from = attackerArea;
  game.area_to = targetArea;
}
```

## Configuration System

The configuration system allows customizing various aspects of the game:

```javascript
import { updateConfig, getConfig } from '@utils/config.js';

// Change the number of players
updateConfig({ playerCount: 4 });

// Change the AI for player 3
const config = getConfig();
config.aiAssignments[3] = 'ai_defensive';
updateConfig(config);

// Save configuration to localStorage
// (done automatically by updateConfig)
```

## Game Utilities

The gameUtils module provides helpful functions for game logic:

```javascript
import { calculateAttackProbability, analyzeTerritory, findBestAttack } from '@utils/gameUtils.js';

// Calculate probability of attack success
const probability = calculateAttackProbability(5, 3); // 0.65

// Analyze a territory for strategic value
const analysis = analyzeTerritory(game, territoryId);
console.log(analysis.vulnerabilityRating); // 0-100

// Find best attack for AI
const bestAttack = findBestAttack(game, playerId);
if (bestAttack) {
  game.area_from = bestAttack.from;
  game.area_to = bestAttack.to;
}
```

## Rendering Utilities

The render module provides functions for UI elements:

```javascript
import { createButton, createText, drawTerritory, createDiceDisplay } from '@utils/render.js';

// Create a button
const button = createButton('End Turn', x, y, width, height, handleClick);
stage.addChild(button);

// Draw a territory
drawTerritory(game, graphics, areaId, cellPositions, cellWidth, cellHeight);

// Create player status display
const statusDisplay = createPlayerStatus(game, playerId, x, y);
stage.addChild(statusDisplay);
```

## Future Development

See [`docs/MODERNIZATION_ROADMAP.md`](../docs/MODERNIZATION_ROADMAP.md) for the full modernization plan, including PixiJS rendering, a Bot SDK, and an arena system for bot competitions.
