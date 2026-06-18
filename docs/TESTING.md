# Testing Strategy for Dice Wars JS

This document describes how the DiceWarsJS test suite is organized and run. The
project is fully modernized (Vite + PixiJS + Preact on a pure `src/engine/`), and
the suite runs on **Vitest**.

## Testing Framework

We use **Vitest** (configured in the `test` block of `vite.config.js`, so the test
runner shares the build's module resolution). It provides:

- A fast Vite-native test runner with parallel, worker-based execution
- A Jest-compatible assertion API (`expect`) and mocking (`vi`)
- Coverage reporting via the V8 provider
- Watch mode for development

`globals: true` is enabled, so `describe`, `it`, `test`, `expect`, `vi`,
`beforeEach`, and `afterEach` are available without importing them. Add
`import { vi } from 'vitest'` only when you want explicit types.

## Test Environment: `node` by default, `jsdom` opt-in

To keep memory down, the suite defaults to the lightweight **`node`** environment
rather than booting a full DOM in every worker. Most of the suite is pure
engine/AI/arena logic that never touches the DOM.

A test that touches `document`, `window`, `localStorage`, canvas, or renders a
Preact component must declare jsdom on the **first line of the file**:

```javascript
// @vitest-environment jsdom
```

Without that docblock, DOM globals are undefined and the test fails with errors
like `window is not defined`.

## Directory Structure

Tests live under `tests/`, mirroring the `src/` layout, plus shared fixtures in
`tests/mocks/`:

```
tests/
├── ai/            # Built-in AI strategies
├── arena/         # Bot SDK: validation, execution, ELO, tournaments, replays
├── audio/         # SoundManager
├── controller/    # GameController, KeyboardController
├── engine/        # Pure engine: state, map gen, battles, turns, RNG
├── renderer/      # PixiJS rendering (hex grid, dice, themes, layout)
├── store/         # GameStore, PreferencesManager
├── ui/            # Preact components and hooks
├── utils/         # Configuration (map-size presets)
├── scripts/       # CLI tooling (arena, bot validation)
├── benchmarks/    # AI performance benchmarks (*.benchmark.js)
├── mocks/         # Shared test fixtures (e.g. areaData.js, gameMock.js)
└── setup.js       # Global setup (registered via setupFiles)
```

Vitest collects `tests/**/*.test.{js,cjs}`, `src/**/*.test.js`, and
`tests/benchmarks/*.benchmark.js` (see `include` in `vite.config.js`).

`tests/setup.js` installs the global stubs needed under jsdom — notably a minimal
canvas 2D context, because PixiJS probes `canvas.getContext('2d')` at import time
and would otherwise log noisy "Not implemented" errors.

## Test Types

- **Unit** — individual functions/modules in isolation (e.g. battle resolution,
  map generation, an AI's move selection, map-size preset resolution).
- **Integration** — modules working together (e.g. the controller driving the
  engine, the store notifying subscribers).
- **Benchmarks** — comparative AI performance under `tests/benchmarks/`, run
  separately from the correctness suite.

## Mocking Strategy

- **Module dependencies**: `vi.mock('../path')` to isolate the unit under test.
- **Functions/spies**: `vi.fn()` and `vi.spyOn(obj, 'method')`; restore with
  `vi.restoreAllMocks()` / `mockRestore()` (e.g. silencing a `console.warn`).
- **DOM / browser APIs**: opt into jsdom (see above); `localStorage`, canvas, and
  similar are then available or stubbed via `tests/setup.js`.

## Running Tests

```bash
# Run the whole suite (serialized through a machine-wide lock)
npm test

# Watch mode during development
npm run test:watch

# With coverage
npm run test:coverage

# AI benchmarks only
npm run test:benchmark

# A single file or directory (fastest while iterating)
npx vitest run tests/engine/BattleResolver.test.js
npx vitest run tests/ai/

# Filter by test name
npx vitest run -t "map size presets"
```

### Running tests safely (resource limits)

Each forked worker can hold a jsdom instance worth hundreds of MB, so running
several full suites at once can exhaust RAM. Two guardrails are in place:

1. `maxWorkers: '50%'` in `vite.config.js` caps a single run's worker count.
2. `npm test` and `npm run test:coverage` go through a machine-wide lock
   (`scripts/test-lock.sh`), so only one run executes at a time — concurrent
   callers queue rather than pile up.

When work is split across multiple agents, **do not** have each one run the full
`npm test`. Run only the relevant files with `npx vitest run <path>`, and let a
single final `npm test` validate the whole suite.

## Code Coverage

Coverage uses the V8 provider over `src/**/*.{js,jsx}`. Thresholds are enforced in
`vite.config.js` (the authoritative source); current floors:

| Scope         | Statements | Branches | Functions | Lines |
| ------------- | ---------- | -------- | --------- | ----- |
| Global        | 55         | 50       | 60        | 55    |
| `src/engine/` | 70         | 50       | 70        | 70    |
| `src/arena/`  | 70         | 50       | 70        | 70    |
| `src/utils/`  | 30         | 25       | 30        | 30    |

These are floors set to current reality; raise them as coverage improves. Generate
a local report with `npm run test:coverage` (HTML output lands in `coverage/`).

## Writing Tests

1. **Descriptive names** — say what behavior is verified, not which function runs.
2. **AAA** — structure each test as Arrange, Act, Assert.
3. **Isolation** — no test may depend on another's state; reset shared state in
   `beforeEach`.
4. **Determinism** — seed any randomness; avoid wall-clock and order dependence.
5. **Behavior over implementation** — assert on observable outcomes.
6. **Pick the right environment** — keep pure-logic tests in `node`; add the jsdom
   docblock only when a test genuinely needs the DOM.

Example (pure logic, `node` environment, using Vitest globals):

```javascript
import { resolveMapSize } from '../../src/utils/config.js';

describe('resolveMapSize', () => {
  test('falls back to the default preset for an unknown size', () => {
    // Arrange
    const unknown = 'enormous';

    // Act
    const preset = resolveMapSize(unknown);

    // Assert — medium is the default
    expect(preset).toEqual({ mapWidth: 28, mapHeight: 32, maxAreas: 32 });
  });
});
```

## Continuous Integration

Tests run in CI on every pull request as part of the single `build-and-test` job,
which runs format checking, linting, the build, `test:coverage`, and
`test:benchmark`. A PR must be green to merge. See
[`CI_CD.md`](./CI_CD.md) for the full pipeline.
