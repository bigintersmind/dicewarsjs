# Testing strategy

This document describes how the DiceWarsJS test suite is organized and run. The
project is fully modernized (Vite + PixiJS + Preact on a pure `src/engine/`), and
the suite runs on **Vitest**.

## Testing framework

We use **Vitest** (configured in the `test` block of `vite.config.js`, so the test
runner shares the build's module resolution). It provides:

- A fast Vite-native test runner with parallel, worker-based execution
- A Jest-compatible assertion API (`expect`) and mocking (`vi`)
- Coverage reporting via the V8 provider
- Watch mode for development

`globals: true` is enabled, so `describe`, `it`, `test`, `expect`, `vi`,
`beforeEach`, and `afterEach` are available without importing them. Add
`import { vi } from 'vitest'` only when you want explicit types.

## Test environment: `node` by default, `jsdom` opt-in

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

## Directory structure

Tests live under `tests/`, mirroring the `src/` layout, plus shared fixtures in
`tests/mocks/` and shared utilities in `tests/helpers/`:

```
tests/
├── ai/            # Built-in AI strategies
├── arena/         # Bot SDK: validation, execution, ELO, tournaments, replays
├── audio/         # SoundManager
├── controller/    # GameController, KeyboardController, TitleAttractMode, canvasPointer
├── engine/        # Pure engine: state, map gen, battles, turns, RNG
├── renderer/      # PixiJS rendering (hex grid, dice, themes, layout)
├── store/         # GameStore, PreferencesManager
├── ui/            # Preact components and hooks
├── utils/         # Configuration (map-size presets)
├── scripts/       # CLI tooling (arena, bot validation)
├── benchmarks/    # AI performance benchmarks (*.benchmark.js)
├── helpers/       # Shared test utilities (e.g. contrast.js — WCAG arithmetic)
├── mocks/         # Shared test fixtures (e.g. areaData.js, gameMock.js)
└── setup.js       # Global setup (registered via setupFiles)
```

Vitest collects `tests/**/*.test.{js,cjs}`, `src/**/*.test.js`, and
`tests/benchmarks/*.benchmark.js` (see `include` in `vite.config.js`).

`tests/setup.js` stubs two globals jsdom is missing, both to keep the runs
quiet: a minimal canvas 2D context, because PixiJS probes
`canvas.getContext('2d')` at import time and would otherwise log noisy "Not
implemented" errors, and a `window.matchMedia` answering `matches: false`, which
this jsdom does not implement at all and which `PreferencesManager` reads for the
system reduced-motion preference (that read is inside a try/catch and answers
`false` without the stub too, so what the stub settles is the noise and the
answer). Both guard on the global they patch, so the
file is a no-op under the default `node` environment.

## Test types

- **Unit**: individual functions/modules in isolation (e.g. battle resolution,
  map generation, an AI's move selection, map-size preset resolution).
- **Integration**: modules working together (e.g. the controller driving the
  engine, the store notifying subscribers).
- **Benchmarks**: comparative AI performance under `tests/benchmarks/`, run
  separately from the correctness suite.

## Mocking strategy

- **Module dependencies**: `vi.mock('../path')` to isolate the unit under test.
- **Functions/spies**: `vi.fn()` and `vi.spyOn(obj, 'method')`; restore with
  `vi.restoreAllMocks()` / `mockRestore()` (e.g. silencing a `console.warn`).
- **DOM / browser APIs**: opt into jsdom (see above); `localStorage`, canvas, and
  similar are then available or stubbed via `tests/setup.js`.

## Running tests

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
   (`scripts/test-lock.sh`), so only one run executes at a time. Concurrent
   callers queue rather than pile up.

When work is split across multiple agents, **do not** have each one run the full
`npm test`. Run only the relevant files with `npx vitest run <path>`, and let a
single final `npm test` validate the whole suite.

## Code coverage

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

## Writing tests

1. **Descriptive names**: say what behavior is verified, not which function runs.
2. **AAA**: structure each test as Arrange, Act, Assert.
3. **Isolation**: no test may depend on another's state; reset shared state in
   `beforeEach`.
4. **Determinism**: seed any randomness; avoid wall-clock and order dependence.
5. **Behavior over implementation**: assert on observable outcomes.
6. **Pick the right environment**: keep pure-logic tests in `node`; add the jsdom
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

    // Assert: medium is the default
    expect(preset).toEqual({ mapWidth: 28, mapHeight: 32, maxAreas: 32 });
  });
});
```

## Manual checks

Contrast is pinned by unit tests, but the light theme is not the one anyone
develops in, so walk it once before shipping a UI change (#220). Open the
settings die, set **Theme: light**, and go through the whole loop:

1. **Title** — the wordmark, START, the difficulty row and the footer links,
   all read against the attract board drifting behind them.
2. **Setup** — open Custom: each seat swatch keeps a visible hairline, and the
   bot dropdowns and luck rungs read on the panel.
3. **Map preview** — the setup eyebrow and the PLAY / NEW MAP / ← BACK row. The
   bot-load notice above them appears only when a chosen bot fails to load; to
   see it, go offline in DevTools once the title screen is up, pick a persona or
   a community bot under Custom, and press START — its lazy chunk fails and the
   seat falls back to the default bot with the notice.
4. **An AI turn** — the "… is thinking …" line: the seat swatch, the name in the
   text color, and the halo behind them, over the brightest territory you can
   find under it.
5. **Your turn** — the instruction line ("Click your territory to attack from"),
   END TURN, and on the HUD bar the ring around the current chip plus every
   seat swatch.
6. **Game over** — the heading, the subtitle, and the button row: HOME and HOW
   TO PLAY always, HISTORY when the game left a replay, and SPECTATE when you
   were the one eliminated — the usual way a tester gets here. Fastest route: 2
   players on a Small map with Speed 4x.

Then repeat the walk with **Color-blind: on**. It swaps the player and dice
palettes, so every swatch, chip and thinking line changes color while the
chrome around them does not.

### Phone viewports (#222)

The dense surfaces overflow on a phone, and `html, body { overflow: hidden }`
means nothing that overflows can be scrolled back into view. jsdom does no
layout and evaluates no media query, so the stylesheets are unit-pinned but the
measurements are not — walk them in the DevTools device toolbar at **360, 390
and 414px** wide, in that order (360 is the tightest phone still worth
supporting). Set up a game with **8 players**, then START → PLAY:

1. **HUD** — every chip visible: eight swatches with their territory counts, the
   bar on two rows with QUIT and RULES above the chips, and the ring on the
   current chip not clipped at either end. On a crowded board the chips row
   scrolls horizontally rather than cutting the last seats off, with no
   scrollbar taking height off the bar; at rest it stays centered. END TURN and
   the instruction line sit clear of the bar, not on it, and the board's bottom
   edge is above the bar rather than behind it — the HUD measures itself and
   publishes `--dw-hud-bar-height` for the renderer, so check it again after
   rotating the device and at a larger browser default font size.
2. **Leaderboard** — the same table appears on three screens: the Leaderboard
   hub screen (the one reachable without running anything) and the Arena and
   Tournament results. On each, it is never wider than the panel around it (it
   scrolls inside the panel if it must, and the panel border stays unbroken),
   and the **Avg Place** and **Atk%** columns are gone under 560px.
3. **Touch targets** — turn on touch emulation (the device toolbar does this).
   Option rows, footer links, the settings options and the HUD's QUIT / RULES
   each want a hit area at least 40px tall — check by tapping just above and
   below the glyphs, not by eye. Then turn touch emulation **off** (device type
   → Desktop) and confirm the same controls look exactly as they did — the
   rules key on the pointer, not the viewport width.
4. **Every screen** — `document.documentElement.scrollWidth === innerWidth` in
   the console. Title, setup, map preview, playing, game over, and each of the
   three hub screens. The replay viewer is the known exception — its control row
   pins a 220px slider beside a 100px counter and the transport buttons, which
   overflows every phone width — and stays one until #222 item 3 lands.

## Continuous integration

Tests run in CI on every pull request as part of the single `build-and-test` job,
which runs format checking, linting, the build, `test:coverage`, and
`test:benchmark`. A PR must be green to merge. See
[`CI_CD.md`](./CI_CD.md) for the full pipeline.
