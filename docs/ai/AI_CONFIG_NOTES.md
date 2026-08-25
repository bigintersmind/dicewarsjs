# AI configuration system notes

Notes on the centralized AI configuration system in DiceWarsJS.

## Overview

AI configuration is centralized in `src/ai/aiConfig.js` so the game and the bot arena manage AI strategies the same way. `src/ai/index.js` re-exports the module and nothing else.

## The registry

`AI_STRATEGIES` is the registry: a map from strategy ID to metadata. Each entry carries `id`, `name`, `description`, `difficulty` (1 to 5), an async `loader`, and `implementation: null`. Some entries add `category: 'self-play'` (the persona nets) or `hidden: true`.

`implementation` starts empty on purpose. `getAIImplementation(id)` runs the entry's `loader` on first use, which is a dynamic `import()` of the strategy file, then caches the function back onto the entry. A strategy's code is fetched only when a seat actually uses it; persona entries pull a weights chunk on top of their module, and their loaders also wrap the bot in `adaptModernBot`, since a persona reads a sanitized BotState rather than the legacy mutable game view. Listing strategies loads nothing, because the metadata above is static.

Helper functions:

- `getAIById(id)`: the full registry entry, metadata included. Unknown IDs fall back to `ai_default`.
- `getAIImplementation(id)`: the callable AI function, loading it on first use. Same fallback.
- `getAllAIStrategies()`: every entry, hidden ones included.
- `getAIStrategiesByCategory()`: what the title-screen picker renders. Drops `hidden` entries and splits the rest into `selfPlay` (the personas) and `general` (the hand-written heuristics), each in registry order.

`hidden` in this registry means one thing: not offered in the game-setup picker. A hidden entry still resolves through `getAIById` and `getAIImplementation`. `src/arena/builtInBots.js` has a separate `hidden` flag meaning "kept off competitive surfaces" (arena, tournament, leaderboard). The two sets differ on purpose: since #167, Defensive and Basic are picker-visible as Easy-mode ingredients while staying hidden on the arena side.

Difficulty presets live in `src/ai/difficultyModes.js`. Easy, Standard, and Hard are each an explicit 8-slot lineup of registry IDs with slot 0 as the human seat, sliced down to the chosen player count by the title screen. Custom has no lineup; it is the per-slot picker, seeded from the last preset. Every ID in a lineup is validated against `AI_STRATEGIES` at import time, so a typo fails the test suite rather than a player's game.

## How a seat gets its AI

The title screen writes `config.aiAssignments` into the GameStore: one entry per seat, where a strategy ID names a built-in bot, `community:<id>` names a community bot, and `null` marks the human seat.

When a game starts, `GameController.loadAIFunctions` (`src/controller/GameController.js`) reads that array back out of the store and resolves each entry through `resolveAIFunction`. A `community:` prefix is stripped and the rest handed to `loadCommunityBot` plus `adaptModernBot`; everything else goes to `getAIImplementation`. Each seat also gets its picker name, so the HUD says "Conqueror is thinking..." instead of "Player 3".

A seat whose bot fails to load gets `ai_default` plus a visible notice ("Player 3: ... could not load. Using Balanced AI instead."), never a silent substitution.

## Adding a new strategy

`docs/ai/DEVELOPER_GUIDE.md` covers registration step by step: the loader, the registry entry, the pinned picker order in `tests/ai/aiConfig.test.js`, and the arena entry in `src/arena/builtInBots.js`. The one step on the config side it does not cover: to put a new ID in a preset lineup, edit `src/ai/difficultyModes.js`, which validates every ID against `AI_STRATEGIES` at import time.

## Driving games from code

To play a headless game, resolve each strategy ID with `getAIImplementation` and hand the functions to `simulateGame` from `src/engine/GameRunner.js`. An unknown ID resolves to `ai_default`, so a typo in the lineup plays Balanced AI rather than failing. Import paths below are written as from a file in `scripts/` or `tests/`.

```javascript
import { getAIImplementation } from '../src/ai/index.js';
import { simulateGame } from '../src/engine/GameRunner.js';

// Every seat needs a function. A null (human) entry makes simulateGame throw
// "No AI function assigned", so use a full AI lineup here.
const ids = ['ai_default', 'ai_lookahead', 'ai_strategist', 'ai_adaptive'];
const fns = await Promise.all(ids.map(id => getAIImplementation(id)));

const { winner, turnCount, completed } = simulateGame({
  config: { playerCount: 4 },
  aiAssignments: fns, // fns[i] is the AI for player i
  seed: 12345,
  maxTurns: 300,
});
```
