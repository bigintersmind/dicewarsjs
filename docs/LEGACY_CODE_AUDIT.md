# Legacy code audit report

> **Historical / superseded (June 2026).** The legacy JavaScript files audited here (`game.js`, `main.js`, `areadice.js`, `mc.js`, `config.js`, and the `MCAdapter` pattern) have since been **deleted** in the modern-only sweep. This document is retained only as a record of the original migration analysis.

This document analyzes the legacy JavaScript files in the DiceWarsJS project to determine migration boundaries and plan the modernization.

## Executive summary

The legacy codebase consists of five main files:

- **game.js** (753 lines): core game logic and state management
- **main.js** (1835 lines): UI, rendering, and game flow control
- **mc.js** (auto-generated): CreateJS graphics definitions
- **areadice.js** (auto-generated): dice graphics library
- **index.js** (2 lines): simple redirect

### Migration verdict summary

| File        | Migration difficulty | Recommended approach                                |
| ----------- | -------------------- | --------------------------------------------------- |
| game.js     | Moderate             | Phased migration with state management focus        |
| main.js     | Hard                 | Adapter pattern for UI, gradual extraction of logic |
| mc.js       | Should Not Migrate   | MCAdapter pattern (already implemented)             |
| areadice.js | Should Not Migrate   | Include via MCAdapter                               |
| index.js    | Easy                 | Already migrated                                    |

## Detailed analysis

### 1. game.js: core game logic

**Responsibilities:**

- Game state management (territories, players, dice)
- Map generation algorithm
- Battle resolution logic
- AI interface (delegates to external AI functions)
- Turn management
- History tracking for replay

**Global dependencies:**

- Defines: `Game` constructor function
- Uses: External AI functions (`window.ai_default`, etc.)
- No direct DOM manipulation
- No CreateJS dependencies

**Migration Assessment: MODERATE DIFFICULTY**

**Can be migrated:**

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

**Recommended migration strategy:**

1. **Phase 1**: Create ES6 data models with immutable patterns
2. **Phase 2**: Extract pure functions (map generation, battle calculations)
3. **Phase 3**: Create a GameEngine class that wraps legacy Game
4. **Phase 4**: Gradually move methods to the new GameEngine
5. **Phase 5**: Replace legacy Game instantiation with ES6 version

### 2. main.js: UI and game control

**Responsibilities:**

- CreateJS stage and sprite management
- User input handling (mouse events)
- Game state machine (title → game → battle → end)
- Animation control
- Sound management
- Screen layouts and transitions
- AI vs AI spectator mode

**Global dependencies:**

- Uses: CreateJS library extensively
- Creates: Many global variables (`canvas`, `stage`, `game`, etc.)
- Depends on: `lib.mc()` from mc.js
- Modifies: DOM (canvas element)

**Migration Assessment: HARD**

**Can be migrated:**

- Game flow state machine logic
- Input validation logic
- Score calculation
- Configuration management

**Should use adapter:**

- All CreateJS sprite management
- Animation sequences
- Sound system integration
- Canvas rendering

**Cannot be migrated (easily):**

- CreateJS event handling patterns
- Sprite sheet builder integration
- Complex animation timelines

**Recommended migration strategy:**

1. **Create MainAdapter**: Wraps all CreateJS functionality
2. **Extract State Machine**: Create ES6 GameStateManager
3. **Extract Input Logic**: Create ES6 InputHandler
4. **Bridge Events**: Use event emitters to connect legacy UI to ES6 logic
5. **Gradual Extraction**: Move non-visual logic piece by piece

### 3. mc.js: CreateJS movie clips

**Responsibilities:**

- Defines all visual assets as CreateJS MovieClips
- Contains embedded graphics data
- Provides sprite definitions for game elements

**Migration Assessment: SHOULD NOT MIGRATE**

**Reasoning:**

- Auto-generated from Flash/Animate CC
- Tightly coupled to CreateJS MovieClip API
- No business logic, pure asset definitions
- Would require complete rewrite for different rendering system

**Current solution:**

- MCAdapter already implemented
- Provides clean ES6 interface to access graphics
- This is the correct approach

### 4. areadice.js: dice graphics library

**Responsibilities:**

- Defines dice visual representations
- Contains 56 different dice states (7 colors × 8 values)
- Pure CreateJS graphics definitions

**Migration Assessment: SHOULD NOT MIGRATE**

**Reasoning:**

- Similar to mc.js, auto-generated graphics
- No business logic
- Tightly coupled to CreateJS

**Recommended approach:**

- Include via MCAdapter pattern
- Could create DiceRenderer adapter if needed

### 5. index.js: entry point

**Migration Assessment: ALREADY COMPLETE**

- Simple redirect to modular version
- No migration needed

## Global variable analysis

**Critical global dependencies:**

```javascript
// From game.js
window.Game; // Main game constructor

// From main.js
window.game; // Game instance
window.canvas, window.stage; // CreateJS
window.soundon; // Sound state
window.spectate_mode; // Game mode

// Used by both
window.ai_default, window.ai_defensive; // AI functions (and the other ai_* globals)
window.GAME_CONFIG; // Configuration object
```

## Migration priority and order

### High priority (business logic)

1. **Game state models**: create immutable ES6 versions
2. **Map generation**: pure functional implementation
3. **Battle system**: extract and modularize
4. **AI interface**: standardize with ES6 modules

### Medium priority (hybrid approach)

1. **Game flow control**: extract state machine from main.js
2. **Turn management**: separate from UI concerns
3. **Configuration system**: already partially complete

### Low priority (adapter pattern)

1. **Rendering system**: keep CreateJS, use adapters
2. **Sound system**: wrap with ES6 interface
3. **Animation system**: abstract behind interfaces

## Risk assessment

### High-risk areas

1. **Timing dependencies**: main.js relies on specific initialization order
2. **Event system**: CreateJS events deeply integrated
3. **Global state mutations**: both files modify shared state

### Mitigation strategies

1. **Extensive testing**: create regression tests before migration
2. **Incremental migration**: small, tested changes
3. **Bridge pattern**: maintain compatibility during transition
4. **Feature flags**: toggle between legacy and new implementations

## Recommendations

### Immediate actions

1. **Complete the bridge initialization fix** (timing issues)
2. **Create thorough tests** for game.js logic
3. **Document all global dependencies**
4. **Establish performance baselines**

### Short-term goals

1. **Migrate game state to immutable models**
2. **Extract pure functions from game.js**
3. **Create GameStateManager from main.js logic**
4. **Standardize AI interface**

### Long-term vision

1. **game.js**: Fully migrated to ES6 GameEngine class
2. **main.js**: Thin adapter layer over ES6 modules
3. **mc.js/areadice.js**: Accessed only through adapters
4. **Zero global variables** except for bridge compatibility

## Conclusion

The migration is feasible but requires careful planning. The game.js file contains the most valuable business logic and should be prioritized. The main.js file should be approached with an adapter pattern, extracting logic while keeping CreateJS rendering intact. The graphics files (mc.js, areadice.js) should remain unmigrated and accessed through adapters.

The key to success is maintaining a working game throughout the migration, using the bridge pattern to ensure compatibility while gradually moving to modern ES6 modules.
