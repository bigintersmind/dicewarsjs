# ES6 Migration Plan for DiceWarsJS

This document provides a detailed plan for completing the migration of DiceWarsJS from legacy JavaScript to modern ES6 modules.

## Background

DiceWarsJS currently uses a hybrid architecture with:

1. **Legacy Code**: Original implementation with global variables/functions in the root directory
2. **Modern ES6 Modules**: Structured code with proper imports/exports in the src/ directory
3. **Bridge Pattern**: Connects legacy code with ES6 modules by exposing modern functionality to the global scope

The bridge pattern has allowed for incremental modernization, but the final goal is to complete the migration to a fully modular ES6 codebase.

## Current Status (Updated)

### Completed Items ✓

1. **Phase 1: Assessment and Planning** ✓

   - Complete code audit performed (see `docs/LEGACY_CODE_AUDIT.md`)
   - Dependency mapping completed
   - Migration priorities established
   - Success criteria defined

2. **Build Infrastructure** ✓

   - Webpack configuration split into common, legacy, and modern
   - CopyWebpackPlugin redundancy fixed for modern builds
   - Bundle analysis available (`npm run analyze`)
   - Source maps properly configured

3. **Bridge Initialization** ✓
   - Robust initialization pattern implemented
   - Promise-based coordination system
   - Timeout protection (5 seconds)
   - Graceful degradation with fallbacks

### In Progress

- Phase 2: Testing Infrastructure expansion
- Phase 3: Core Components Migration

## Migration Strategy Overview

Based on the completed legacy code audit, the migration will follow this refined approach:

1. **Easy Migrations First**: Start with simple data models and pure functions
2. **Moderate Complexity Next**: Game logic, state management, algorithms
3. **Hard Migrations Last**: UI/CreateJS code using adapter pattern
4. **Unmigrateable Code**: Keep mc.js and areadice.js behind adapters

## Detailed Phase Breakdown

### Phase 1: Assessment and Planning ✓ COMPLETED

**Key Findings from Audit:**

- game.js (753 lines) - Moderate difficulty, contains valuable business logic
- main.js (1835 lines) - Hard difficulty, heavy CreateJS integration
- mc.js & areadice.js - Should NOT migrate, use adapters
- Global dependencies mapped and documented

### Phase 2: Infrastructure and Environment Setup (IN PROGRESS)

#### Remaining Tasks:

1. **Enhance Testing Infrastructure**

   - Expand bridge component tests
   - Add integration tests for timing scenarios
   - Create regression test suite
   - Target 80% coverage for critical paths

2. **Performance Benchmarking**

   - Establish baseline metrics for:
     - Initial load time
     - Map generation speed
     - AI decision time
     - Frame rate during battles

3. **Migration Utilities**
   - Create helpers for common patterns
   - Build compatibility wrappers
   - Develop global scope verification tools

### Phase 3: Core Components Migration (2-3 weeks)

Based on the audit, prioritized migration order:

#### 3.1 Easy Migrations (Start Here)

**Data Models** (from game.js lines 20-82):

```javascript
// Legacy
var AreaData = function(){...}
var PlayerData = function(){...}
var JoinData = function(){...}
var HistoryData = function(){...}

// Migrate to ES6 classes in src/models/
export class AreaData {
  constructor() {
    this.size = 0;
    this.cpos = 0;
    // ... with proper encapsulation
  }
}
```

**Pure Functions** (from game.js):

- `next_cel()` - Cell adjacency calculation
- Map generation helpers
- Battle calculations

#### 3.2 Moderate Migrations

**Game State Management**:

- Extract from game.js lines 190-223 (state variables)
- Implement immutable patterns
- Add event system for state changes
- Create proper serialization

**Map Generation** (game.js lines 379-644):

- `make_map()` - Main generation algorithm
- `percolate()` - Territory growth
- `set_area_line()` - Border calculation
- Migrate to src/mechanics/mapGenerator.js

**Territory Connectivity** (game.js lines 300-358):

- `set_area_tc()` - Connected component algorithm
- Optimize with modern data structures

#### 3.3 Hard Migrations (Use Adapters)

**Main.js Components**:

- CreateJS stage management
- Sprite handling
- Animation sequences
- Event handlers

**Recommended Approach**:

```javascript
// src/adapters/RenderAdapter.js
export class RenderAdapter {
  constructor() {
    this.stage = window.stage; // Legacy CreateJS stage
  }

  drawTerritory(areaData) {
    // Wrap CreateJS calls
    const shape = new createjs.Shape();
    // ... adapter logic
  }
}
```

### Phase 4: UI and Interaction Migration (1-2 weeks)

**Extract Non-Visual Logic from main.js**:

- Game state machine (title → game → battle → end)
- Input validation
- Score calculations
- Player turn management

**Create UI Adapters**:

- MainAdapter for CreateJS functionality
- EventAdapter for input handling
- AnimationAdapter for battle sequences

### Phase 5: Error Handling and Optimization (1 week)

1. **Leverage Existing Error System**:

   - Use custom error classes in src/mechanics/errors/
   - Add error boundaries
   - Implement comprehensive logging

2. **Performance Optimization**:
   - Apply benchmarking results
   - Consider TypedArrays for grid (896 cells)
   - Use Map/Set for O(1) lookups

### Phase 6: Bridge Reduction (1 week)

**Safe Removal Order**:

1. Remove unused bridge exports
2. Convert bridge imports to direct imports
3. Clean global namespace systematically
4. Keep bridge only for adapter interfaces

### Phase 7: Legacy Code Isolation (Ongoing)

**Permanent Legacy Components** (per audit):

- mc.js - MCAdapter pattern ✓
- areadice.js - Access through adapter
- CreateJS rendering core

**Adapter Expansion Needed**:

- Expand MCAdapter based on usage audit
- Create DiceAdapter for areadice.js
- Document all adapter interfaces

### Phase 8: Documentation and Cleanup (1 week)

1. **Update Documentation**:

   - Architecture diagrams
   - Migration guide
   - API references

2. **Code Cleanup**:
   - Remove dead code
   - Standardize naming
   - Apply Prettier formatting

### Phase 9: Final Migration (1 week)

1. **Remove Legacy Files**:
   - Phase out game.js after full migration
   - Minimize main.js to adapter only
   - Remove bridge modules
   - Update HTML entry points

## Implementation Guidelines

### Migration Pattern for Game.js Functions

```javascript
// Legacy (game.js)
this.com_thinking = function () {
  var currentPlayer = this.jun[this.ban];
  var ai_function = this.ai[currentPlayer];
  // ... complex logic
};

// Modern ES6 (src/mechanics/aiHandler.js)
export function executeAIMove(gameState, aiRegistry) {
  const currentPlayer = gameState.currentPlayer;
  const aiStrategy = aiRegistry.get(currentPlayer);
  // ... clean implementation
}
```

### Adapter Pattern for Main.js

```javascript
// src/adapters/UIAdapter.js
export class UIAdapter {
  constructor(legacyMain) {
    this.legacy = legacyMain;
    this.eventEmitter = new EventEmitter();
  }

  showBattleAnimation(attacker, defender) {
    // Delegate to legacy
    this.legacy.start_battle();

    // Emit modern event
    this.eventEmitter.emit('battle:start', { attacker, defender });
  }
}
```

## Success Metrics

1. **Zero unnecessary global variables** (only CreateJS and adapters)
2. **100% ES6 module coverage** for business logic
3. **<500KB initial bundle size**
4. **>80% test coverage** for migrated components
5. **Identical game behavior** (regression tested)
6. **Clear module boundaries** with dependency graph

## Risk Mitigation

### High Risk Areas (from audit)

1. **Timing Dependencies**: Use BridgeInitializer pattern
2. **CreateJS Events**: Keep in adapters, don't migrate
3. **Global State Mutations**: Use immutable patterns

### Mitigation Strategies

1. **Incremental Migration**: Small, tested changes
2. **Regression Testing**: Before/after each component
3. **Feature Flags**: Toggle legacy/modern implementations
4. **Adapter Pattern**: Isolate risky code

## Timeline

**Total: 8-10 weeks** (adjusted based on audit findings)

- Week 1-2: Complete testing infrastructure
- Week 3-4: Easy migrations (data models, pure functions)
- Week 5-6: Moderate migrations (game logic, state)
- Week 7: Hard migrations (UI adapters)
- Week 8: Optimization and bridge reduction
- Week 9: Documentation and cleanup
- Week 10: Final migration and verification

## Next Steps

1. **Immediate** (This Week):

   - Complete bridge test coverage
   - Set up performance benchmarks
   - Start migrating data models

2. **Short Term** (Next 2 Weeks):

   - Migrate pure functions from game.js
   - Extract game state management
   - Create first UI adapter

3. **Medium Term** (Next Month):
   - Complete core game logic migration
   - Implement all necessary adapters
   - Begin bridge reduction

The migration plan has been refined based on the comprehensive legacy code audit, providing clear priorities and realistic complexity assessments for each component.
