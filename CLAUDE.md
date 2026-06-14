# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important Project Status Update:** The project is following a new modernization roadmap (see `docs/MODERNIZATION_ROADMAP.md`) that replaces the old bridge-based ES6 migration. The bridge pattern (`src/bridge/`) is deprecated and will be removed — **do not add to or extend it**; build new functionality per the roadmap. Refer to the roadmap for all architectural goals and migration strategies.

## Build and Development Commands

The project uses **Vite** for builds and **Vitest** for testing (migrated from Webpack/Jest in Phase 1).

```bash
# Install dependencies
npm install

# Start Vite development server (port 3000)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run all tests (Vitest)
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

# Run Vitest benchmark tests
npm run test:benchmark

# Check bundle size
npm run perf:check

# Auto-fix lint warnings
npm run fix-warnings

# Run bot arena (CLI) — single deterministic ELO ranking
npm run arena

# Multi-seed arena sweep — mean win%/ELO with 95% confidence intervals
npm run arena:sweep

# Scaffold a new bot from a template
npm run new-bot

# Validate a bot file (syntax, compilation, runtime)
npm run validate-bot

# Benchmark a single bot (timing, win rate, ELO, placement)
npm run benchmark-bot

# Validate all community-bots/registry.json entries
npm run validate-community-bots

# Run full online tournament (built-in + community bots), persist ELO/leaderboard
npm run tournament
```

## Code Quality Requirements

Before completing any task, always ensure:

1. **Tests Pass**: Run `npm test` to verify all tests pass
2. **Linting**: Run `npm run lint` to check for code quality issues
3. **Coverage**: Maintain test coverage above 60% globally, 70% for models, 50%+ statements for mechanics (run `npm run test:coverage`; see `vite.config.js` for exact per-directory thresholds)
4. **Build Verification**: Run `npm run build` to ensure the project builds successfully

When test failures occur:

- First run tests to see what's failing
- Fix any broken tests before making other changes
- Add new tests when implementing features

## Project Architecture

DiceWarsJS is a turn-based strategy game where players compete to conquer territories on a hexagonal grid using dice for attack and defense. The project is being modernized per `docs/MODERNIZATION_ROADMAP.md`.

### Build Stack

- **Build**: Vite (replaced Webpack)
- **Tests**: Vitest (replaced Jest)
- **Rendering**: PixiJS v8 (replaced CreateJS)
- **UI**: Preact (replaced legacy DOM manipulation)
- **Config**: `vite.config.js` contains both build and test configuration

### Architecture

1. **Modern ES6 Modules**: All active code in the `src/` directory uses ES6 imports/exports with relative paths.

2. **Legacy Code** (reference only): Root directory files (game.js, main.js, areadice.js, mc.js) are preserved for reference but not loaded by the Vite build. `index.legacy.html` preserves the old entry point.

3. **Bridge Pattern** (DEPRECATED): `src/bridge/` is a legacy↔modern shim retained only until removal (see status note above).

4. **Game Engine** (Phase 2): `src/engine/` contains the pure game engine — no DOM, no rendering. Includes StateManager, BattleResolver, MapGenerator, TurnManager, HexGrid, AIAdapter, and GameRunner.

5. **Rendering & UI** (Phase 3): `src/renderer/` (PixiJS hex grid, dice, battle animation), `src/ui/` (Preact screens and HUD), `src/store/` (observable GameStore), `src/controller/` (GameController orchestrator), `src/audio/` (Web Audio SoundManager).

### Core Components

- **Game Engine** (src/engine/): Pure game logic — `createGame`, `applyAction`, `getValidMoves`, `runAI`. No DOM dependencies. Runs in both browser and Node.js.

- **AI System** (src/ai/): Contains different AI strategies:

  - ai_default: Balanced approach from the original game
  - ai_defensive: Prioritizes protecting vulnerable territories
  - ai_example: Basic implementation for educational purposes
  - ai_adaptive: Adapts strategy based on game conditions
  - ai_claude: Expected-value strategy using exact dice odds and connectivity economics (strongest in arena benchmarks)

- **Bot Arena** (src/arena/): Headless bot-vs-bot tournament system — ELO ratings (elo.js), match/tournament runners, custom-bot compilation & validation, replay format. Powers `npm run arena`, the in-game Arena screen, and the CLI bot tooling. See docs/BOT_GUIDE.md for authoring a bot (a function: state → { from, to } | null).

- **GameController** (src/controller/GameController.js): Orchestrates the full game loop — title → mapPreview → playing → gameOver. Handles human input (two-phase click: select from, select to), AI turns with step-by-step animation, and turn advancement. Only module that calls engine functions.

- **GameStore** (src/store/GameStore.js): Observable pub/sub store shared by renderer, controller, and UI. Shallow-merge `setState`, subscriber notification with error isolation.

- **Renderer** (src/renderer/): PixiJS rendering layer — `GameRenderer` (top-level), `HexGridRenderer` (territory drawing with border tracing), `DiceRenderer` (isometric stacked dice), `BattleAnimation` (physics-based dice rolling).

- **UI** (src/ui/): Preact components — `App` (screen router), `TitleScreen`, `MapPreview`, `GameHUD`, `GameOverlay`, `GameOverScreen`. Uses `useGameStore` hook for reactive updates.

- **SoundManager** (src/audio/SoundManager.js): Web Audio API sound system replacing legacy CreateJS SoundJS. Lazy AudioContext creation, on-demand loading, volume control.

- **Map Generation** (src/mechanics/mapGenerator.js): Creates the hexagonal grid and territories.

- **Battle Resolution** (src/mechanics/battleResolution.js): Handles attack resolution and dice distribution.

- **Models** (src/models/): Data structures for game entities (AreaData, PlayerData, Battle, HistoryData, JoinData).

- **Enhanced Modules** (src/enhanced/, src/models/enhanced/, src/mechanics/enhanced/): Improved variants of core components with additional features like adjacency graphs, territory graphs, and disjoint sets.

- **Adapters** (src/adapters/): Adapter classes for interfacing with legacy components (e.g., MCAdapter).

- **Error Handling** (src/mechanics/errors/): Custom error classes for different error types.

### Important Design Patterns

1. **Immutable Data**: The state directory implements immutable data patterns for the game state.

2. **Factory Functions**: Used throughout the codebase to create game objects.

3. **Error Hierarchy**: Custom error classes (GameError, BattleError, TerritoryError, etc.) provide structured error handling.

### AI Implementation Notes

When working with AI strategies:

1. All AI functions must return 0 when they have no more moves to make (ends their turn).
2. AI functions perform attacks by setting `game.area_from` and `game.area_to` properties.
3. AI functions have access to the full game state through the game object parameter.
4. The AI system is designed to be extensible - new strategies can be added by creating a new file in src/ai/.

### Testing Approach

1. Unit tests for individual components (AI strategies, map generation, battle resolution).
2. Integration tests for the bridge components (retained while the bridge code exists).
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

- **ESLint ignores legacy root files**: The .eslintrc.cjs explicitly excludes `areadice.js`, `mc.js`, `game.js`, `config.js`, and `main.js` from linting.
- **Path aliases**: `@utils`, `@ai`, `@models`, `@mechanics`, `@state` are configured in `vite.config.js` for both builds and tests. Source files use relative imports; aliases are available but prefer relative paths in new code.
- **Husky pre-commit hook**: Runs `lint-staged` automatically, which applies ESLint fixes and Prettier formatting to staged `.js` and `.jsx` files.
- **Bridge files excluded from coverage**: `vite.config.js` excludes `src/bridge/` from coverage thresholds (deprecated code; see status note at top).
- **Vitest globals**: Tests use `globals: true` in vitest config, so `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` are available without imports. Use `import { vi } from 'vitest'` only if needed for explicit typing.

## Common Pitfalls to Avoid

1. Don't modify legacy files unless specifically required
2. Always run tests before suggesting code is complete
3. Ensure error events are properly emitted for error tracking
4. Keep AI functions pure and deterministic for testing

## Documentation Updates

### Key Documentation

- `docs/MODERNIZATION_ROADMAP.md` — architectural north star (supersedes the bridge pattern)
- `docs/BOT_GUIDE.md` — how to write a bot
- `docs/ARCHITECTURE.md`, `docs/GAME_RULES.md`, `docs/TESTING.md`, `docs/CODE_STYLE.md` — system design, rules, testing approach, conventions

When making changes:

1. Update inline code comments for clarity
2. Update relevant docs in the docs/ directory
3. Update this CLAUDE.md file if workflow changes
4. Keep README.md synchronized with new features
