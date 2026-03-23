# Mapping Legacy `game.js` Features to ES6 Modules

This document describes where the functionality from the legacy `game.js` file has been migrated within the modern ES6 module structure.

The migration process keeps the game playable by exposing ES6 modules through bridge files while the remaining legacy code is updated. The following table explains the current mapping between the old code and the new modules.

## Data Structures

Legacy constructors defined in `game.js` are now ES6 classes exported from the `src/models` directory:

- `AreaData` → `src/models/AreaData.js`
- `PlayerData` → `src/models/PlayerData.js`
- `JoinData` → `src/models/JoinData.js`
- `HistoryData` → `src/models/HistoryData.js`
- All models are re-exported from `src/models/index.js`.

## Core Game Logic

The main game logic lives in the `Game` class at `src/Game.js`. It manages overall state, player turns and delegates work to other modules. The legacy global `make_map` method now calls the `makeMap` function imported from the map generator module.

## Map Generation

Procedural map creation, including the `percolate` algorithm, is implemented in `src/mechanics/mapGenerator.js`. Key exports are `percolate`, `makeMap` and `setAreaTc`.

## Battle Resolution

Dice rolls and territory capture logic reside in `src/mechanics/battleResolution.js`. It exports `rollDice`, `executeAttack`, `distributeReinforcements` and `setPlayerTerritoryData`. The module imports `setAreaTc` from the map generator to update connectivity after a battle.

## AI Integration

AI handling is split into several modules:

- `src/mechanics/aiHandler.js` registers AI strategies and generates possible moves.
- Individual strategies live under `src/ai/` and are referenced through `src/ai/aiConfig.js`.

## Event System

Typed game and UI events are defined in `src/mechanics/eventSystem.js`. The `EventType` enumeration is used across modules.

## Utilities and Bridge Modules

General helpers live in `src/utils/`. During the transition, bridge modules under `src/bridge/` expose ES6 functionality (such as the `Game` class) to the global scope so legacy files can continue to function.

This mapping provides a reference while porting the remaining code. Once all functionality has been transferred to the ES6 modules, the legacy `game.js` file will be removed along with the bridge modules.
