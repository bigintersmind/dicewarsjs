# Bridge Module Usage Status

This document tracks which bridge files under `src/bridge/` are still required for
running the project. Modules that no longer have any dependents can be removed in
future refactors.

## Currently Used Bridges

| Bridge Module | Purpose                                                                                                      | Dependents                              |
| ------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `Game.js`     | Exposes the ES6 `Game` class globally so the legacy `main.js` and `game.js` can construct the game instance. | `game.js`, `main.js`, integration tests |
| `ai.js`       | Loads ES6 AI strategies and attaches them to `window` for the legacy game engine.                            | `game.js`, tests                        |

Both of these bridges are still required while the legacy game engine is present.

## Removed Bridges

The following bridge modules were previously kept solely for legacy test coverage
but have now been removed:

- `gameUtils.js`
- `render.js`
- `sound.js`
- `ui.js`
- `debugTools.js`

Only `Game.js` and `ai.js` remain until the legacy engine is fully migrated.

## Removal Plan

1. **Remove unused bridges** – Drop the modules listed above after verifying that
   all tests and build scripts work without them.
2. **Migrate legacy engine** – Convert `game.js` and `main.js` to ES6 modules so
   they import the `Game` class and AI functions directly.
3. **Delete `Game.js` and `ai.js` bridges** – Once the legacy engine uses ES6
   imports, these two bridges can be removed and `src/index.js` can stop loading
   `bridge/index.js`.

Each step should be followed by a full test run to ensure no regressions.
