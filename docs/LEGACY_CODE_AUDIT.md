# Legacy Code Audit Report

> **Historical / superseded (June 2026).** The legacy JavaScript files audited here (`game.js`, `main.js`, `areadice.js`, `mc.js`, `config.js`, and the `MCAdapter` pattern) have since been **deleted** in the modern-only sweep. This document is retained only as a record of the original migration analysis.

This document provides a comprehensive analysis of the legacy JavaScript files in the DiceWarsJS project to determine migration boundaries and develop an effective modernization strategy.

## Executive Summary

The legacy codebase consists of five main files:

- **game.js** (753 lines) - Core game logic and state management
- **main.js** (1835 lines) - UI, rendering, and game flow control
- **mc.js** (Auto-generated) - CreateJS graphics definitions
- **areadice.js** (Auto-generated) - Dice graphics library
- **index.js** (2 lines) - Simple redirect

### Migration Verdict Summary

| File        | Migration Difficulty | Recommended Approach                                |
| ----------- | -------------------- | --------------------------------------------------- |
| game.js     | Moderate             | Phased migration with state management focus        |
| main.js     | Hard                 | Adapter pattern for UI, gradual extraction of logic |
| mc.js       | Should Not Migrate   | MCAdapter pattern (already implemented)             |
| areadice.js | Should Not Migrate   | Include via MCAdapter                               |
| index.js    | Easy                 | Already migrated                                    |

## Detailed Analysis

### 1. game.js - Core Game Logic

**Responsibilities:**

- Game state management (territories, players, dice)
- Map generation algorithm
- Battle resolution logic
- AI interface (delegates to external AI functions)
- Turn management
- History tracking for replay

**Global Dependencies:**

- Defines: `Game` constructor function
- Uses: External AI functions (`window.ai_default`, etc.)
- No direct DOM manipulation
- No CreateJS dependencies

**Migration Assessment: MODERATE DIFFICULTY**

**Can Be Migrated:**

- All data structures (AreaData, PlayerData, JoinData, HistoryData)
- Map generation algorithm (`make_map`, `percolate`)
- Territory connectivity logic (`set_area_tc`)
- Battle logic (can be extracted)
- History system

**Challenges:**

- Heavy use of `this` context and prototypal patterns
- Mutable state throughout
- AI system expects global functions
- Some methods are very long (make_map is 200+ lines)

**Recommended Migration Strategy:**

1. **Phase 1**: Create ES6 data models with immutable patterns
2. **Phase 2**: Extract pure functions (map generation, battle calculations)
3. **Phase 3**: Create a GameEngine class that wraps legacy Game
4. **Phase 4**: Gradually move methods to the new GameEngine
5. **Phase 5**: Replace legacy Game instantiation with ES6 version

### 2. main.js - UI and Game Control

**Responsibilities:**

- CreateJS stage and sprite management
- User input handling (mouse events)
- Game state machine (title → game → battle → end)
- Animation control
- Sound management
- Screen layouts and transitions
- AI vs AI spectator mode

**Global Dependencies:**

- Uses: CreateJS library extensively
- Creates: Many global variables (`canvas`, `stage`, `game`, etc.)
- Depends on: `lib.mc()` from mc.js
- Modifies: DOM (canvas element)

**Migration Assessment: HARD**

**Can Be Migrated:**

- Game flow state machine logic
- Input validation logic
- Score calculation
- Configuration management

**Should Use Adapter:**

- All CreateJS sprite management
- Animation sequences
- Sound system integration
- Canvas rendering

**Cannot Be Migrated (easily):**

- CreateJS event handling patterns
- Sprite sheet builder integration
- Complex animation timelines

**Recommended Migration Strategy:**

1. **Create MainAdapter**: Wraps all CreateJS functionality
2. **Extract State Machine**: Create ES6 GameStateManager
3. **Extract Input Logic**: Create ES6 InputHandler
4. **Bridge Events**: Use event emitters to connect legacy UI to ES6 logic
5. **Gradual Extraction**: Move non-visual logic piece by piece

### 3. mc.js - CreateJS Movie Clips

**Responsibilities:**

- Defines all visual assets as CreateJS MovieClips
- Contains embedded graphics data
- Provides sprite definitions for game elements

**Migration Assessment: SHOULD NOT MIGRATE**

**Reasoning:**

- Auto-generated from Flash/Animate CC
- Tightly coupled to CreateJS MovieClip API
- No business logic - pure asset definitions
- Would require complete rewrite for different rendering system

**Current Solution:**

- MCAdapter already implemented
- Provides clean ES6 interface to access graphics
- This is the correct approach

### 4. areadice.js - Dice Graphics Library

**Responsibilities:**

- Defines dice visual representations
- Contains 56 different dice states (7 colors × 8 values)
- Pure CreateJS graphics definitions

**Migration Assessment: SHOULD NOT MIGRATE**

**Reasoning:**

- Similar to mc.js - auto-generated graphics
- No business logic
- Tightly coupled to CreateJS

**Recommended Approach:**

- Include via MCAdapter pattern
- Could create DiceRenderer adapter if needed

### 5. index.js - Entry Point

**Migration Assessment: ALREADY COMPLETE**

- Simple redirect to modular version
- No migration needed

## Global Variable Analysis

**Critical Global Dependencies:**

```javascript
// From game.js
window.Game; // Main game constructor

// From main.js
window.game; // Game instance
window.canvas, window.stage; // CreateJS
window.soundon; // Sound state
window.spectate_mode; // Game mode

// Used by both
window.ai_default, window.ai_defensive, etc.window.GAME_CONFIG; // AI functions // Configuration object
```

## Migration Priority and Order

### High Priority (Business Logic)

1. **Game State Models** - Create immutable ES6 versions
2. **Map Generation** - Pure functional implementation
3. **Battle System** - Extract and modularize
4. **AI Interface** - Standardize with ES6 modules

### Medium Priority (Hybrid Approach)

1. **Game Flow Control** - Extract state machine from main.js
2. **Turn Management** - Separate from UI concerns
3. **Configuration System** - Already partially complete

### Low Priority (Adapter Pattern)

1. **Rendering System** - Keep CreateJS, use adapters
2. **Sound System** - Wrap with ES6 interface
3. **Animation System** - Abstract behind interfaces

## Risk Assessment

### High Risk Areas

1. **Timing Dependencies** - main.js relies on specific initialization order
2. **Event System** - CreateJS events deeply integrated
3. **Global State Mutations** - Both files modify shared state

### Mitigation Strategies

1. **Extensive Testing** - Create regression tests before migration
2. **Incremental Migration** - Small, tested changes
3. **Bridge Pattern** - Maintain compatibility during transition
4. **Feature Flags** - Toggle between legacy and new implementations

## Recommendations

### Immediate Actions

1. **Complete the bridge initialization fix** (timing issues)
2. **Create comprehensive tests** for game.js logic
3. **Document all global dependencies**
4. **Establish performance baselines**

### Short-term Goals

1. **Migrate game state to immutable models**
2. **Extract pure functions from game.js**
3. **Create GameStateManager from main.js logic**
4. **Standardize AI interface**

### Long-term Vision

1. **game.js**: Fully migrated to ES6 GameEngine class
2. **main.js**: Thin adapter layer over ES6 modules
3. **mc.js/areadice.js**: Accessed only through adapters
4. **Zero global variables** except for bridge compatibility

## Conclusion

The migration is feasible but requires careful planning. The game.js file contains the most valuable business logic and should be prioritized. The main.js file should be approached with an adapter pattern, extracting logic while keeping CreateJS rendering intact. The graphics files (mc.js, areadice.js) should remain unmigrated and accessed through adapters.

The key to success is maintaining a working game throughout the migration, using the bridge pattern to ensure compatibility while gradually moving to modern ES6 modules.
