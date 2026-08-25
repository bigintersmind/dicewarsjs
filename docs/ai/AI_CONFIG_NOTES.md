# AI configuration system notes

Notes on the centralized AI configuration system in DiceWarsJS.

## Overview

AI configuration is centralized in `src/ai/aiConfig.js` so the game and the bot arena manage AI strategies the same way. This keeps the code maintainable and makes new strategies easy to add. `src/ai/index.js` re-exports the module and nothing else.

## Key components

`AI_STRATEGIES` is the registry: a map from strategy ID to metadata. Each entry carries `id`, `name`, `description`, `difficulty` (1 to 5), an async `loader`, and `implementation: null`. Some entries add `category: 'self-play'` (the persona nets) or `hidden: true`.

`implementation` starts empty on purpose. `getAIImplementation(id)` runs the entry's `loader` on first use, which is a dynamic `import()` of the strategy file, then caches the function back onto the entry. A strategy's code is fetched only when a seat actually uses it; persona entries pull a weights chunk on top of their module, and their loaders also wrap the bot in `adaptModernBot`, since a persona reads a sanitized BotState rather than the legacy mutable game view. Listing strategies loads nothing, because the metadata above is static.

Helper functions:

- `getAIById(id)`: the full registry entry, metadata included. Unknown IDs fall back to `ai_default`.
- `getAIImplementation(id)`: the callable AI function, loading it on first use. Same fallback.
- `getAllAIStrategies()`: every entry, hidden ones included.
- `getAIStrategiesByCategory()`: what the title-screen picker renders. Drops `hidden` entries and splits the rest into `selfPlay` (the personas) and `general` (the hand-written heuristics), each in registry order.

`hidden` in this registry means one thing: not offered in the game-setup picker. A hidden entry still resolves through `getAIById` and `getAIImplementation`. `src/arena/builtInBots.js` has a separate `hidden` flag meaning "kept off competitive surfaces" (arena, tournament, leaderboard). The two sets differ on purpose: since #167, Defensive and Basic are picker-visible as Easy-mode ingredients while staying hidden on the arena side.

`DEFAULT_AI_ASSIGNMENTS` mirrors the Standard difficulty preset and is pinned against it by `tests/ai/aiConfig.test.js`. Nothing consumes it at runtime.

Difficulty presets live in `src/ai/difficultyModes.js`. Easy, Standard, and Hard are each an explicit 8-slot lineup of registry IDs with slot 0 as the human seat, sliced down to the chosen player count by the title screen. Custom has no lineup; it is the per-slot picker, seeded from the last preset. Every ID in a lineup is validated against `AI_STRATEGIES` at import time, so a typo fails the test suite rather than a player's game.

## How a seat gets its AI

The title screen writes `config.aiAssignments` into the GameStore: one entry per seat, where a strategy ID names a built-in bot, `community:<id>` names a community bot, and `null` marks the human seat.

When a game starts, `GameController.loadAIFunctions` (`src/controller/GameController.js`) reads that array back out of the store and resolves each entry through `resolveAIFunction`. A `community:` prefix is stripped and the rest handed to `loadCommunityBot` plus `adaptModernBot`; everything else goes to `getAIImplementation`. Each seat also gets its picker name, so the HUD says "Conqueror is thinking..." instead of "Player 3".

A seat whose bot fails to load gets `ai_default` plus a visible notice ("Player 3: ... could not load. Using Balanced AI instead."), never a silent substitution.

## Adding a new strategy

1. Write the implementation in `src/ai/ai_myCustom.js`.
2. Add a dynamic loader and a registry entry in `aiConfig.js`:

```javascript
export const load_ai_myCustom = async () => (await import('./ai_myCustom.js')).ai_myCustom;

export const AI_STRATEGIES = {
  // Existing strategies...

  // Your new strategy
  ai_myCustom: {
    id: 'ai_myCustom',
    name: 'My Custom AI',
    description: 'Description of your strategy approach',
    difficulty: 3, // Rating from 1-5
    loader: load_ai_myCustom,
    implementation: null,
  },
};
```

3. That is enough to make it selectable. The picker reads the registry, so an entry appears on its own unless it is flagged `hidden`. Picker order is pinned by `tests/ai/aiConfig.test.js`, so add the new ID to the expected lists there or those tests fail.
4. To put it in a preset lineup, edit `src/ai/difficultyModes.js`. To run it in the arena and tournament, register it in `src/arena/builtInBots.js`; `docs/ai/DEVELOPER_GUIDE.md` covers that step.

## Driving games from code

`createAIFunctionMapping(aiAssignments)` maps an array of strategy IDs to an array of loaded AI functions. The game does not use it (the controller path above is what seats bots in a real game), so treat it as a convenience for tests, benchmarks, and scripts. Its only failure handling is to log the error and substitute `ai_default`.

Pair it with `simulateGame` from `src/engine/GameRunner.js` to play a headless game:

```javascript
import { createAIFunctionMapping } from '../ai/index.js';
import { simulateGame } from '../engine/GameRunner.js';

// Every seat needs a function. A null (human) entry makes simulateGame throw
// "No AI function assigned", so use a full AI lineup here.
const fns = await createAIFunctionMapping([
  'ai_default',
  'ai_lookahead',
  'ai_strategist',
  'ai_adaptive',
]);

const { winner, turnCount, completed } = simulateGame({
  config: { playerCount: 4 },
  aiAssignments: fns, // fns[i] is the AI for player i
  seed: 12345,
  maxTurns: 300,
});
```
