# src/ — DiceWarsJS Source

A modern ES module application: **Vite** build, **PixiJS v8** rendering, **Preact** UI, all running on a pure game engine in `src/engine/`.

## Directory Structure

```
src/
├── engine/       # Pure game logic — state, map gen, battles, turns (no DOM)
├── ai/           # Built-in AI strategies + registry (aiConfig.js)
├── arena/        # Bot SDK — validation, execution, tournaments, ELO, replays
├── renderer/     # PixiJS rendering (hex grid, dice, battle animations)
├── ui/           # Preact components (screens, HUD, overlays)
├── store/        # Observable GameStore (pub/sub shared state)
├── controller/   # GameController — game loop orchestrator
├── audio/        # Web Audio sound manager
├── utils/        # Game configuration — map-size presets
├── main.jsx      # Application entry point (PixiJS + Preact bootstrap)
└── README.md     # This file
```

See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the full directory guide and data-flow diagrams.

## Game Engine

The core game logic lives in `src/engine/` (pure, no DOM) and covers map generation,
state management, player turns, attack resolution, and replay history. State is
immutable — transitions go through `applyAction(...)`, which returns a new state object
rather than mutating in place. The engine runs in both the browser and Node.js, so the
arena and CLI tooling can drive it headlessly.

## AI Strategies

Built-in strategies live in `src/ai/`, registered with metadata in `aiConfig.js`:

- `ai_default` — balanced strategy from the original game
- `ai_defensive` — conservative, focused on protecting vulnerable territories
- `ai_example` — minimal example for learning
- `ai_adaptive` — adapts to game conditions
- `ai_strategist` — exact expected-value using dice odds and connectivity economics (authored by Claude Opus 4.8)
- `ai_lookahead` — standalone shallow expectimax over win/loss branches (authored by GPT-5.5)
- `ai_expectimax` — chance-node expectimax over the exact battle distribution (the ML-bot search baseline)
- `ai_conqueror` — balanced self-play net; ships the encoding-v3 `ppo-v3-scratch` weights ([D-31]); the strongest bot head-to-head
- `ai_blitz` — aggressive, short-horizon self-play net that presses hard and ends games fast; the most outright wins in the bot field (#157)
- `ai_survivor` — patient, placement-reward self-play net that outlasts the field; the best average placement in the bot field (#157)

The self-play **personas** (`ai_conqueror` / `ai_blitz` / `ai_survivor`, ml-bot Phase 3) are the player-facing neural-net roster; each runs a pure-JS forward pass (`bcForward.js`) over its own exported weights. The internal training nets they grew out of — `ai_ppo` (the `ppo-long` self-play net; the first ML bot to beat `ai_lookahead` head-to-head) and `ai_bc` (the Phase 2 behavioral clone of `ai_lookahead`) — are flagged `hidden` in `src/arena/builtInBots.js`: kept for the dev eval harness (`ppo:gate`) but not shown to players (Conqueror shipped PPO's weights under a friendlier name until the [D-31] v3 ship). See [docs/ml-bot/](../docs/ml-bot/).

### Writing an AI

A built-in AI is a function that receives the `game` object, sets `game.area_from` /
`game.area_to` to launch an attack, and returns `0` to end its turn:

```javascript
// src/ai/ai_custom.js
export function ai_custom(game) {
  // ...choose an attack...
  if (noGoodMoves) return 0; // end turn

  game.area_from = attackerArea;
  game.area_to = targetArea;
}
```

Register it by adding a dynamic loader and registry entry in `aiConfig.js`.

To write a **bot** for the arena — the modern, sandboxed `state → { from, to } | null`
interface used for tournaments — see [`docs/BOT_GUIDE.md`](../docs/BOT_GUIDE.md).

## Further Reading

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — codebase organization and data flow
- [`docs/BOT_GUIDE.md`](../docs/BOT_GUIDE.md) — how to write a bot, full SDK reference
- [`docs/MODERNIZATION_ROADMAP.md`](../docs/MODERNIZATION_ROADMAP.md) — project history
