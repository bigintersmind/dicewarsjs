# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important Project Status Update:** The project has completed its modernization (see `docs/MODERNIZATION_ROADMAP.md`). The legacy CreateJS code and the deprecated legacy↔modern bridge have been removed — the repo is now **modern-only** (Vite + PixiJS + Preact, running on a pure `src/engine/`). Build new functionality per the roadmap.

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

# Check for linting issues
npm run lint

# Fix linting issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without writing
npm run format:check

# Run Vitest benchmark tests
npm run test:benchmark

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

1. **Modern ES6 Modules**: All active code in the `src/` directory uses ES6 imports/exports with relative paths. The entry point is `src/main.jsx` (loaded by the root `index.html`).

2. **Game Engine**: `src/engine/` contains the pure game engine — no DOM, no rendering. Includes StateManager, BattleResolver, MapGenerator, TurnManager, HexGrid, AIAdapter, and GameRunner.

3. **Rendering & UI**: `src/renderer/` (PixiJS hex grid, dice, battle animation), `src/ui/` (Preact screens and HUD), `src/store/` (observable GameStore), `src/controller/` (GameController orchestrator), `src/audio/` (Web Audio SoundManager).

### Core Components

- **Game Engine** (src/engine/): Pure game logic — `createGame`, `applyAction`, `getValidMoves`, `runAI`. No DOM dependencies. Runs in both browser and Node.js.

- **AI System** (src/ai/): Contains different AI strategies:

  - ai_default: Balanced approach from the original game
  - ai_defensive: Prioritizes protecting vulnerable territories
  - ai_example: Basic implementation for educational purposes
  - ai_adaptive: Adapts strategy based on game conditions
  - ai_strategist: Expected-value strategy using exact dice odds and connectivity economics (strongest in arena benchmarks; authored by Claude Opus 4.8)
  - ai_lookahead: Standalone shallow-expectimax search over win/loss branches with board-value evaluation (authored by GPT-5.5)

- **Bot Arena** (src/arena/): Headless bot-vs-bot tournament system — ELO ratings (elo.js), match/tournament runners, custom-bot compilation & validation, replay format. Powers `npm run arena`, the in-game Arena screen, and the CLI bot tooling. See docs/BOT_GUIDE.md for authoring a bot (a function: state → { from, to } | null).

- **GameController** (src/controller/GameController.js): Orchestrates the full game loop — title → mapPreview → playing → gameOver. Handles human input (two-phase click: select from, select to), AI turns with step-by-step animation, and turn advancement. Only module that calls engine functions.

- **GameStore** (src/store/GameStore.js): Observable pub/sub store shared by renderer, controller, and UI. Shallow-merge `setState`, subscriber notification with error isolation.

- **Renderer** (src/renderer/): PixiJS rendering layer — `GameRenderer` (top-level), `HexGridRenderer` (territory drawing with border tracing), `DiceRenderer` (isometric stacked dice), `BattleAnimation` (physics-based dice rolling).

- **UI** (src/ui/): Preact components — `App` (screen router), `TitleScreen`, `MapPreview`, `GameHUD`, `GameOverlay`, `GameOverScreen`. Uses `useGameStore` hook for reactive updates.

- **SoundManager** (src/audio/SoundManager.js): Web Audio API sound system replacing legacy CreateJS SoundJS. Lazy AudioContext creation, on-demand loading, volume control.

- **Map Generation** (src/engine/MapGenerator.js): Creates the hexagonal grid and territories.

- **Battle Resolution** (src/engine/BattleResolver.js): Handles attack resolution and dice distribution.

### Important Design Patterns

1. **Immutable State**: The engine never mutates state in place — `applyAction(...)` returns a new state object (see `src/engine/StateManager.js`).

2. **Factory Functions**: Used throughout the codebase to create game objects.

### AI Implementation Notes

When working with AI strategies:

1. All AI functions must return 0 when they have no more moves to make (ends their turn).
2. AI functions perform attacks by setting `game.area_from` and `game.area_to` properties.
3. AI functions have access to the full game state through the game object parameter.
4. The AI system is designed to be extensible - new strategies can be added by creating a new file in src/ai/.

### Testing Approach

1. Unit tests for individual components (AI strategies, map generation, battle resolution).
2. Performance tests for comparing AI strategies.
3. Test utilities and mocks are located in the tests/mocks/ directory.
4. Benchmarks are in tests/benchmarks/.
5. Error handling should be tested thoroughly, including edge cases.

### Running tests safely (resource limits)

The full suite forks many workers; running several copies at once can exhaust RAM and freeze the machine. Two guardrails are in place: each run is capped at 50% of cores (`maxWorkers` in `vite.config.js`), and `npm test` / `npm run test:coverage` go through a machine-wide lock (`scripts/test-lock.sh`) so only one run executes at a time — concurrent callers queue rather than pile up.

**Subagents must not each run the full suite.** When work is delegated across multiple subagents, do not have each one call `npm test`. Instead:

- Prefer the `game-test` skill, or run only the relevant tests with `npx vitest run <path-or-pattern>` for the area you changed.
- Let the **main agent** run the full `npm test` once, at the end, to validate. The lock makes accidental overlap safe but it serializes (slow); avoiding redundant full runs is still the goal.

## Best Practices

1. **Code Style**: Follow existing code patterns and conventions
2. **Documentation**: Update relevant documentation when making significant changes
3. **Error Handling**: Validate inputs at boundaries and raise or return errors explicitly rather than failing silently
4. **Testing**: Write tests for new functionality and ensure existing tests pass
5. **Commit Messages**: Use conventional commit format (e.g., "feat:", "fix:", "test:", "docs:")

## Gotchas

- **Imports**: Source files use relative paths — the project configures no path aliases. (The old `@utils`/`@ai`/`@engine` Vite aliases were unused and have been removed.)
- **Husky pre-commit hook**: Runs `lint-staged` automatically — `eslint --fix` + `prettier --write` on staged `.js`/`.jsx`/`.mjs` files, and `prettier --write` on staged `.json`/`.md`/`.yml`/`.yaml` files. Note it formats Markdown too, but it has occasionally failed to fully normalize a `.md` file (e.g. a multi-line inline-code span), so if CI's `format:check` (`prettier --check .`) flags a doc, run `npx prettier --write <file>` yourself.
- **Vitest globals**: Tests use `globals: true` in vitest config, so `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` are available without imports. Use `import { vi } from 'vitest'` only if needed for explicit typing.
- **Test environment is `node` by default**: To keep memory down, the suite runs under the lightweight Node environment, not jsdom. A test that touches `document`, `window`, `localStorage`, canvas, or renders a Preact component must declare `// @vitest-environment jsdom` as the first line of the file, or it will fail with `X is not defined`.

## Common Pitfalls to Avoid

1. Always run tests before suggesting code is complete
2. Surface errors explicitly instead of silently swallowing them
3. Keep AI functions pure and deterministic for testing

## Documentation Updates

### Key Documentation

- `docs/MODERNIZATION_ROADMAP.md` — architectural north star
- `docs/BOT_GUIDE.md` — how to write a bot
- `docs/ARCHITECTURE.md`, `docs/GAME_RULES.md`, `docs/TESTING.md`, `docs/CODE_STYLE.md` — system design, rules, testing approach, conventions

When making changes:

1. Update inline code comments for clarity
2. Update relevant docs in the docs/ directory
3. Update this CLAUDE.md file if workflow changes
4. Keep README.md synchronized with new features
