# DiceWarsJS Project Roadmap

This document outlines the current development status, immediate next steps, and long-term vision for the DiceWarsJS project.

## Recent Accomplishments (Updated)

### ES6 Migration Foundation

1. **Legacy Code Audit Completed**

   - Comprehensive analysis of game.js, main.js, mc.js, areadice.js
   - Identified migration boundaries and difficulty levels
   - Created detailed migration strategies for each file
   - Documented in `docs/LEGACY_CODE_AUDIT.md`

2. **Webpack Configuration Optimized**

   - Fixed CopyWebpackPlugin redundancy in modern builds
   - Reduced dist folder by ~84KB of unnecessary files
   - Split configuration into common, legacy, and modern builds
   - Documented in `docs/fixes/WEBPACK_COPYWEBPACKPLUGIN_FIX.md`

3. **Robust Bridge Initialization Pattern**
   - Created initialization system preventing timing issues
   - Implemented promise-based coordination
   - Added immediate placeholders for AI functions
   - Includes timeout protection and graceful degradation
   - Documented in `docs/BRIDGE_INITIALIZATION_PATTERN.md`

### Previous Accomplishments

1. **Fixed Development Environment Configuration**

   - Changed package.json `serve` script to use webpack-dev-server
   - Updated webpack config to use consistent runtime chunk naming
   - Fixed 404 errors for bundle files and game-loader.js
   - Fixed sound loading "Type not recognized" errors
   - Fixed "AI function not found for player 0" in AI vs AI mode

2. **Improved AI Bridge Initialization**

   - Created `game-loader.js` for initializing global AI functions
   - Updated HTML to load game-loader.js before other scripts
   - Fixed "AI function not found" warnings
   - Implemented proper AI configuration in both legacy and modern systems

3. **Sound System Enhancement**
   - Added event listener to initialize AudioContext on user gesture
   - Implemented proper sound system initialization sequence
   - Changed dynamic imports to direct file paths
   - Added explicit file type indication for CreateJS Sound API

## Immediate Next Steps (Priority Order)

### 1. Expand Adapter Pattern Documentation (Medium Priority)

- Create comprehensive guide with multiple examples beyond MCAdapter
- Document patterns for:
  - UI component adapters
  - Event system adapters
  - State management adapters
- Include best practices and anti-patterns

### 2. Establish Performance Benchmarks (Medium Priority)

- Measure current game performance metrics
- Create automated performance testing suite
- Document baseline metrics for:
  - Initial load time
  - Map generation speed
  - AI decision time
  - Rendering performance

### 3. Create Component Migration Checklist (Medium Priority)

- Develop standardized checklist template
- Include pre-migration requirements
- Add testing requirements
- Create post-migration validation steps

### 4. Increase Bridge Test Coverage (Medium Priority)

- Expand test suite for bridge components
- Add integration tests for timing scenarios
- Create tests for error conditions
- Implement regression test suite

### 5. Document Global Variable Dependencies (Low Priority)

- Create comprehensive list of all global variables
- Map dependencies between globals
- Plan systematic removal strategy
- Create migration priority list

## Comprehensive ES6 Migration Plan

### Phase 1: Assessment and Planning ✓ COMPLETED

- ✓ Complete code audit of legacy files
- ✓ Map global variables and functions
- ✓ Document bridge pattern usage
- ✓ Create migration strategies

### Phase 2: Infrastructure and Environment Setup (IN PROGRESS)

1. **Testing Infrastructure** (Next Focus)

   - Create comprehensive tests for bridge components
   - Implement integration tests for bridge functionality
   - Set up automated backwards compatibility tests
   - See [PHASE2_TESTING_PLAN.md](./PHASE2_TESTING_PLAN.md)

2. **Build Pipeline Refinement** ✓ PARTIALLY COMPLETE
   - ✓ Optimize webpack configuration
   - ✓ Configure development and production builds
   - ✓ Implement source maps
   - ✓ Set up bundle analysis
   - TODO: Implement stricter size limits

### Phase 3: Core Components Migration

Based on the legacy code audit, the migration priority is:

1. **Game State Management** (game.js - Moderate Difficulty)

   - Extract data models (AreaData, PlayerData, etc.)
   - Implement immutable state patterns
   - Create event system for state changes
   - Add undo/redo functionality

2. **Pure Game Logic** (game.js - Easy to Moderate)

   - Map generation algorithm (`make_map`, `percolate`)
   - Territory connectivity (`set_area_tc`)
   - Battle calculations
   - History system

3. **Game Flow Control** (main.js - Hard, Use Adapters)
   - Extract state machine logic
   - Create GameStateManager
   - Separate from CreateJS dependencies
   - Use adapter pattern for UI

### Phase 4: UI and Interaction Migration

1. **Create UI Adapters** (main.js - Hard)

   - MainAdapter for CreateJS functionality
   - Wrap sprite management
   - Abstract animation sequences
   - Bridge event systems

2. **Extract Non-Visual Logic** (main.js - Moderate)
   - Input validation
   - Score calculation
   - Configuration management
   - Game flow logic

### Phase 5: Error Handling and Optimization

1. **Implement Error Boundaries**

   - Use custom error classes from mechanics/errors/
   - Add graceful degradation
   - Implement comprehensive logging

2. **Performance Optimization**
   - Apply findings from performance benchmarks
   - Implement TypedArrays for grid operations
   - Use Map/Set for O(1) lookups
   - Optimize rendering pipeline

### Phase 6: Bridge Reduction

1. **Safe Bridge Removals** (After Testing)

   - Analyze bridge usage patterns
   - Identify unused bridge exports
   - Remove redundant bridge code
   - Update direct imports

2. **Direct Module References**
   - Replace bridge imports gradually
   - Update to use ES6 exports directly
   - Clean global namespace systematically

### Phase 7: Legacy Code Isolation

Based on audit findings:

1. **Permanent Legacy Components**

   - mc.js - Keep MCAdapter pattern
   - areadice.js - Access through adapter
   - CreateJS rendering in main.js

2. **Adapter Implementation**
   - Expand MCAdapter pattern
   - Create RenderAdapter for CreateJS
   - Implement EventAdapter for input
   - Document adapter interfaces

### Phase 8: Documentation and Cleanup

1. **Architecture Documentation**

   - Update with final module structure
   - Document adapter patterns
   - Create migration guide

2. **Code Standardization**
   - Apply consistent naming
   - Remove dead code
   - Format with Prettier

### Phase 9: Final Migration

1. **Remove Legacy Dependencies**
   - Phase out game.js (after full migration)
   - Minimize main.js to adapter only
   - Remove bridge modules
   - Update entry points

## Success Metrics

1. **Zero unnecessary global variables** (only CreateJS and required legacy)
2. **100% ES6 module coverage** for business logic
3. **<500KB initial bundle size**
4. **>80% test coverage** for migrated components
5. **Identical game behavior** verified by regression tests
6. **Clear module boundaries** with dependency graph

## Migration Complexity Summary

Based on the audit:

| Component     | Complexity     | Strategy                             |
| ------------- | -------------- | ------------------------------------ |
| game.js logic | Moderate       | Phased extraction to ES6             |
| main.js logic | Hard           | Adapter pattern + gradual extraction |
| mc.js         | Do Not Migrate | MCAdapter (complete)                 |
| areadice.js   | Do Not Migrate | Access via adapter                   |
| State models  | Easy           | Direct ES6 conversion                |
| AI system     | Complete       | Already migrated                     |

## Long-Term Vision

### 1. Modern Architecture

- Pure ES6 modules for all business logic
- Adapter pattern for legacy graphics
- Event-driven architecture
- Immutable state management

### 2. Enhanced Features

- AI championship mode
- Replay system with save/load
- Multiplayer capabilities
- Advanced AI strategies

### 3. Technical Improvements

- WebGL rendering option
- Progressive Web App
- WebAssembly for performance
- Real-time multiplayer

The roadmap prioritizes stability and maintainability while gradually modernizing the codebase. The adapter pattern ensures we can deliver value continuously without breaking changes.
