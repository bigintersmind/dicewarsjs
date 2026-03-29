# DiceWarsJS Architecture

This document describes how the codebase is organized and how data flows through the system.

## Module Layers

```
┌─────────────────────────────────────────────┐
│  UI (Preact)          Renderer (PixiJS)     │  What the player sees
│  src/ui/              src/renderer/          │
├─────────────────────────────────────────────┤
│  GameStore (Observable)                      │  Shared state
│  src/store/GameStore.js                      │
├─────────────────────────────────────────────┤
│  GameController (Orchestrator)               │  Game loop & input
│  src/controller/GameController.js            │
├─────────────────────────────────────────────┤
│  Game Engine (Pure Logic)                    │  No DOM, no rendering
│  src/engine/                                 │
├─────────────────────────────────────────────┤
│  Arena System (Bot SDK)                      │  Bot execution & tournaments
│  src/arena/                                  │
└─────────────────────────────────────────────┘
```

## Directory Guide

| Directory         | Purpose                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/`     | Pure game logic: state management, map generation, battle resolution, turn management. No DOM dependencies — runs in Node.js and browser.           |
| `src/renderer/`   | PixiJS rendering: hex grid drawing, dice sprites, battle animations. Reads from GameStore, never mutates game state.                                |
| `src/ui/`         | Preact components: title screen, game HUD, arena screen, tournament screen, replay viewer, leaderboard.                                             |
| `src/store/`      | Observable GameStore with pub/sub. Shared by controller, renderer, and UI.                                                                          |
| `src/controller/` | GameController orchestrates the game loop (title -> map preview -> playing -> game over), handles human input, and drives AI turns.                 |
| `src/arena/`      | Bot SDK: bot validation, sandboxed execution, match running, ELO ratings, tournament formats, replay serialization.                                 |
| `src/ai/`         | Four AI strategies (example, default, defensive, adaptive) using the legacy game object interface. Adapted for the arena via `legacyBotAdapter.js`. |
| `src/audio/`      | Web Audio API sound manager with lazy loading.                                                                                                      |
| `src/mechanics/`  | Shared game mechanics: event system, error handling, map generation utilities.                                                                      |
| `src/models/`     | Data structures (AreaData, PlayerData, Battle, etc.) used by legacy code paths.                                                                     |
| `src/utils/`      | Configuration, debug tools, and helper functions.                                                                                                   |
| `src/bridge/`     | **Deprecated.** Legacy async/sync bridge — will be removed.                                                                                         |
| `src/state/`      | Orphaned immutable state patterns — never integrated.                                                                                               |
| `src/adapters/`   | Legacy adapter for CreateJS MovieClip.                                                                                                              |
| `src/enhanced/`   | Experimental Map-based data structures — unused.                                                                                                    |

## Data Flow: Playing a Game

### Human player makes a move

```
Click on territory → GameController.handleClick()
  → validates selection (own territory with dice > 1, then enemy neighbor)
  → engine.applyAction({ type: 'ATTACK', from, to })
  → GameStore.setState(newState)
  → Renderer re-draws board (subscribed to store)
  → UI updates HUD (subscribed to store)
```

### AI player takes a turn

```
GameController advances to AI turn
  → engine.runFullAITurn(state, aiFunction)
  → AI function reads game state, returns attacks
  → engine applies each attack + END_TURN
  → GameStore.setState(newState) after each step
  → Renderer animates battles
```

### Reinforcement (automatic at end of turn)

```
applyAction({ type: 'END_TURN' })
  → calculateReinforcements(state, playerId)
    → findLargestConnectedGroup() — this determines the count
  → distributeReinforcements() — placed randomly on eligible territories
  → advance to next player
```

## Data Flow: Arena Match

```
ArenaScreen selects bots → matchRunner.runMatch({ bots, seed })
  → createGame(config) — generates map with seed
  → for each turn:
    → createBotState(state, playerId) — sanitized view
    → botFn(botState) → { from, to } or null
    → validateMove(move, botState) — check legality
    → applyAction(state, { type: 'ATTACK', from, to })
  → returns MatchResult with winner, stats, placements
  → ELO ratings updated via updateEloRatings()
```

## Key Design Decisions

- **Engine is pure**: No DOM, no rendering, no side effects. All state transitions are through `applyAction()` which returns a new state object.
- **Deterministic**: Games are seeded — same seed produces same map and same RNG sequence. This enables replays.
- **Bot sandboxing**: Bots receive a frozen `BotState` with only observable information. They cannot access or mutate the engine state directly.
- **Store as bridge**: GameStore is the single source of truth between the controller (which mutates state) and the renderer/UI (which reads state).

## For More Detail

- [Modernization Roadmap](MODERNIZATION_ROADMAP.md) — project history and phase-by-phase plan
- [Bot Guide](BOT_GUIDE.md) — how to write a bot
- [Game Rules](GAME_RULES.md) — how the game works
