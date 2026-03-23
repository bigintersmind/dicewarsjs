# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

> **Note**: This file mirrors CLAUDE.md to ensure all AI agents work from the same best practices and have consistent understanding of the project.

**Important Project Status Update:** The project is following a new modernization roadmap (see `docs/MODERNIZATION_ROADMAP.md`) that replaces the old bridge-based ES6 migration. The bridge pattern is deprecated and will be removed. Refer to the roadmap for all architectural goals and migration strategies.

## Build and Development Commands

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Generate bundle analysis report
npm run analyze

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run benchmarks
npm run benchmark

# Run full benchmark suite
npm run benchmark:full

# Check for linting issues
npm run lint

# Fix linting issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without writing
npm run format:check

# Run regression tests
npm run test:regression

# Run jest benchmark tests
npm run test:benchmark

# Check bundle size
npm run perf:check

# Build both modern and legacy bundles
npm run build:all

# Start legacy development server
npm run dev:legacy

# Build legacy bundle only
npm run build:legacy

# Auto-fix lint warnings
npm run fix-warnings
```

## Code Quality Requirements

Before completing any task, always ensure:

1. **Tests Pass**: Run `npm test` to verify all tests pass
2. **Linting**: Run `npm run lint` to check for code quality issues
3. **Coverage**: Maintain test coverage above 60% globally, 70% for models, 50% for mechanics (run `npm run test:coverage`)
4. **Build Verification**: Run `npm run build` to ensure the project builds successfully

When test failures occur:

- First run tests to see what's failing
- Fix any broken tests before making other changes
- Add new tests when implementing features

## Project Architecture

DiceWarsJS is a turn-based strategy game where players compete to conquer territories on a hexagonal grid using dice for attack and defense. The project is in the process of transitioning from legacy JavaScript to modern ES6 modules.

### Hybrid Architecture

The codebase uses a hybrid architecture with three main components:

1. **Legacy Code**: Original implementation with global variables/functions in the root directory (game.js, main.js, ai\_\*.js).

2. **Modern ES6 Modules**: Structured code with proper imports/exports in the src/ directory.

3. **Bridge Pattern** (DEPRECATED): Previously connected legacy code with ES6 modules (src/bridge/). This pattern is deprecated and will be removed per the modernization roadmap. Do not add new bridge modules.

### Core Components

- **Game Engine** (src/Game.js): Manages game state, player turns, territory ownership, and dice placement.

- **AI System** (src/ai/): Contains different AI strategies:

  - ai_default: Balanced approach from the original game
  - ai_defensive: Prioritizes protecting vulnerable territories
  - ai_example: Basic implementation for educational purposes
  - ai_adaptive: Adapts strategy based on game conditions

- **Map Generation** (src/mechanics/mapGenerator.js): Creates the hexagonal grid and territories.

- **Battle Resolution** (src/mechanics/battleResolution.js): Handles attack resolution and dice distribution.

- **State Management** (src/state/): Contains immutable data structures for game state.

- **Models** (src/models/): Data structures for game entities (AreaData, PlayerData, Battle, HistoryData, JoinData).

- **Enhanced Modules** (src/enhanced/, src/models/enhanced/, src/mechanics/enhanced/): Improved variants of core components with additional features like adjacency graphs, territory graphs, and disjoint sets.

- **UI** (src/ui/): UI components including player status display and title screen.

- **Adapters** (src/adapters/): Adapter classes for interfacing with legacy components (e.g., MCAdapter).

- **Error Handling** (src/mechanics/errors/): Custom error classes for different error types.

### Important Design Patterns

1. **Bridge Pattern** (DEPRECATED): Previously used for transitioning between legacy and modern code. The bridge is deprecated per `docs/MODERNIZATION_ROADMAP.md` — do not extend it. New functionality should follow the modernization roadmap's architecture.

2. **Immutable Data**: The state directory implements immutable data patterns for the game state.

3. **Factory Functions**: Used throughout the codebase to create game objects.

4. **Error Hierarchy**: Custom error classes (GameError, BattleError, TerritoryError, etc.) provide structured error handling.

### AI Implementation Notes

When working with AI strategies:

1. All AI functions must return 0 when they have no more moves to make (ends their turn).
2. AI functions perform attacks by setting `game.area_from` and `game.area_to` properties.
3. AI functions have access to the full game state through the game object parameter.
4. The AI system is designed to be extensible - new strategies can be added by creating a new file in src/ai/.

### Testing Approach

1. Unit tests for individual components (AI strategies, map generation, battle resolution).
2. Integration tests for the bridge components (bridge is deprecated but tests remain while code exists).
3. Performance tests for comparing AI strategies.
4. Test utilities and mocks are located in the tests/mocks/ directory.
5. Regression tests are in tests/regression/ and benchmarks in tests/benchmarks/.
6. Error handling should be tested thoroughly, including edge cases.

## Best Practices

1. **Code Style**: Follow existing code patterns and conventions
2. **Documentation**: Update relevant documentation when making significant changes
3. **Error Handling**: Use appropriate custom error classes from src/mechanics/errors/
4. **Testing**: Write tests for new functionality and ensure existing tests pass
5. **Commit Messages**: Use conventional commit format (e.g., "feat:", "fix:", "test:", "docs:")

## Gotchas

- **ESLint ignores legacy root files**: The .eslintrc.js explicitly excludes `areadice.js`, `mc.js`, `game.js`, `config.js`, and `main.js` from linting.
- **Jest module aliases**: Tests use path aliases (`@utils`, `@ai`, `@models`, `@mechanics`, `@state`) configured in jest.config.js. Use these in test imports.
- **Husky pre-commit hook**: Runs `lint-staged` automatically, which applies ESLint fixes and Prettier formatting to staged `.js` files.
- **Bridge files excluded from coverage**: jest.config.js excludes `src/bridge/` from coverage thresholds. The bridge is deprecated and will be removed.

## Common Pitfalls to Avoid

1. Don't modify legacy files unless specifically required
2. Always run tests before suggesting code is complete
3. Do not extend the bridge pattern — it is deprecated. Follow `docs/MODERNIZATION_ROADMAP.md` for new functionality
4. Ensure error events are properly emitted for error tracking
5. Keep AI functions pure and deterministic for testing

## Documentation Updates

When making changes:

1. Update inline code comments for clarity
2. Update relevant docs in the docs/ directory
3. Update this AGENTS.md file if workflow changes
4. Update CLAUDE.md to maintain parity between agent guidance files
5. Keep README.md synchronized with new features

## Agent-Specific Guidelines

- This file is designed to work with various AI coding assistants
- The guidance provided here should enable consistent, high-quality contributions
- Always prioritize code safety and maintainability over clever solutions
- When in doubt, ask for clarification rather than making assumptions

## Keeping Agent Files Synchronized

This file (AGENTS.md) and CLAUDE.md should be kept in sync to ensure all AI assistants have the same understanding of:

- Project architecture
- Development workflows
- Best practices
- Testing requirements
- Documentation standards

When updating either file, consider whether the change should be reflected in both.
