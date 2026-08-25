# DiceWarsJS architecture

This document describes how the codebase is organized and how data flows through the system.

## Module layers

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

## Directory guide

| Directory         | Purpose                                                                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/`     | Pure game logic: state management, map generation, battle resolution, turn management. No DOM dependencies, so it runs in Node.js and the browser.                                                                                                                                                                         |
| `src/renderer/`   | PixiJS rendering: hex grid drawing, dice sprites, battle animations. Four overlay layers sit above the territories, painted in this order: board hints, `from`, `to`, keyboard focus. Reads from GameStore, never mutates game state.                                                                                      |
| `src/ui/`         | Preact components: title screen, game HUD, arena screen, tournament screen, replay viewer, leaderboard, and `RulesModal`, the how-to-play card, which is store-driven like `QuitConfirm` and mounted outside the screen switch so it opens over any screen.                                                                |
| `src/store/`      | Observable GameStore with pub/sub. Shared by controller, renderer, and UI.                                                                                                                                                                                                                                                 |
| `src/controller/` | GameController orchestrates the game loop (title -> map preview -> playing -> game over), handles human input, and drives AI turns. It also owns the board hints: one seam (`refreshCandidateHighlights`) derives the outlined territories from the engine's `getValidMoves` and publishes them as `store.candidateAreas`. |
| `src/arena/`      | Bot SDK: bot validation, sandboxed execution, match running, ELO ratings, tournament formats, replay serialization.                                                                                                                                                                                                        |
| `src/ai/`         | Built-in AI strategies (example, default, defensive, adaptive, Strategist, Lookahead) using the legacy game object interface. Adapted for the arena via `legacyBotAdapter.js`.                                                                                                                                             |
| `src/audio/`      | Web Audio API sound manager with lazy loading.                                                                                                                                                                                                                                                                             |
| `src/utils/`      | Game configuration: map-size presets surfaced in the title screen, resolved to engine dimensions by the controller (`resolveMapSize`).                                                                                                                                                                                     |

## Data flow: playing a game

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
    → findLargestConnectedGroup() (this determines the count)
  → distributeReinforcements() (placed randomly on eligible territories)
  → advance to next player
```

## Data flow: arena match

```
ArenaScreen selects bots → matchRunner.runMatch({ bots, seed })
  → createGame(config) (generates map with seed)
  → for each turn:
    → createBotState(state, playerId) (sanitized view)
    → botFn(botState) → { from, to } or null
    → validateMove(move, botState) (check legality)
    → applyAction(state, { type: 'ATTACK', from, to })
  → returns MatchResult with winner, stats, placements
  → ELO ratings updated via updateEloRatings()
```

## Key design decisions

- **Engine is pure**: No DOM, no rendering, no side effects. All state transitions go through `applyAction()`, which returns a new state object.
- **Deterministic**: Games are seeded. The same seed produces the same map and the same RNG sequence, which is what makes replays possible.
- **Bot sandboxing**: Bots receive a frozen `BotState` with only observable information. They cannot access or mutate the engine state directly.
- **Store as bridge**: GameStore is the single source of truth between the controller (which mutates state) and the renderer/UI (which reads state).

## For more detail

- [Modernization Roadmap](MODERNIZATION_ROADMAP.md): project history and phase-by-phase plan
- [Bot Guide](BOT_GUIDE.md): how to write a bot
- [Game Rules](GAME_RULES.md): how the game works
