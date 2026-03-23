# DiceWarsJS Modernization Roadmap

> **Last Updated:** March 2026
> **Status:** Planning — replaces all prior migration documents
> **Developed by:** Claude Opus 4.6 in Claude Code

---

## Table of Contents

1. [Project Vision](#1-project-vision)
2. [Current State Assessment](#2-current-state-assessment)
3. [Why Not Continue the Bridge Migration](#3-why-not-continue-the-bridge-migration)
4. [Target Architecture](#4-target-architecture)
5. [Technology Choices](#5-technology-choices)
6. [Phase 1: Foundation](#6-phase-1-foundation)
7. [Phase 2: Core Game Engine](#7-phase-2-core-game-engine)
8. [Phase 3: Rendering & UI](#8-phase-3-rendering--ui)
9. [Phase 4: Bot SDK & Arena](#9-phase-4-bot-sdk--arena)
10. [Phase 5: Community & Polish](#10-phase-5-community--polish)
11. [What We Keep vs. Rewrite](#11-what-we-keep-vs-rewrite)
12. [File Structure](#12-file-structure)
13. [Bot SDK Design](#13-bot-sdk-design)
14. [Arena System Design](#14-arena-system-design)
15. [Migration Sequence](#15-migration-sequence)
16. [Open Questions](#16-open-questions)

---

## 1. Project Vision

DiceWarsJS is a browser-based territory conquest game played on a hexagonal grid. Players (human or AI) roll dice to attack adjacent territories. The last player standing wins.

**Goals for the modernized project:**

1. **Playable and fun** — smooth animations, responsive UI, works on desktop and mobile
2. **Modern codebase** — clean ES modules, no legacy globals, no Flash-era libraries
3. **Bot arena** — anyone can write a bot in JavaScript, submit it, and watch it compete
4. **Open source friendly** — easy to understand, easy to contribute, well-documented
5. **Spectator mode** — watch bots battle in real-time with leaderboards and replays

---

## 2. Current State Assessment

### What exists today

| Component                                  | Location                       | Status                                       | Quality         |
| ------------------------------------------ | ------------------------------ | -------------------------------------------- | --------------- |
| Game logic (map gen, battles, territories) | `game.js` + `src/Game.js`      | Duplicated — legacy works, ES6 version works | Good algorithms |
| AI strategies (4 bots)                     | `src/ai/`                      | Fully functional, well-tested                | Excellent       |
| Rendering                                  | `main.js` + CreateJS           | Working but Flash-era tech                   | Poor long-term  |
| Dice/UI sprites                            | `areadice.js`, `mc.js`         | Adobe Animate exports, not editable          | Dead end        |
| Bridge layer                               | `src/bridge/`                  | Broken — async/sync timing issues            | Abandon         |
| Data models                                | `src/models/`                  | Complete, well-tested                        | Good            |
| State management                           | `src/state/`                   | Written but never integrated                 | Orphaned        |
| Enhanced modules                           | `src/enhanced/`                | Written but never used                       | Orphaned        |
| Error system                               | `src/mechanics/errors/`        | Complete hierarchy                           | Good            |
| Event system                               | `src/mechanics/eventSystem.js` | Complete                                     | Good            |
| Tests                                      | `tests/`                       | 476 passing, 60%+ coverage                   | Good            |
| Build system                               | Webpack 5, Babel, Jest         | Working CI/CD pipeline                       | Adequate        |
| Config system                              | `src/utils/config.js`          | Working                                      | Good            |

### What works well (keep)

- **AI system**: Clean single-function interface, dynamic loading, centralized registry, comprehensive tests. This is the best part of the codebase.
- **Game algorithms**: Map generation (percolation), territory tracing, union-find for connected groups, battle resolution. These algorithms are correct and proven.
- **Test infrastructure**: Jest setup, mocks, benchmarks, coverage thresholds. All reusable.
- **Error hierarchy**: GameError, BattleError, TerritoryError, etc. Well-designed.
- **Event system**: EventEmitter with middleware support. Reusable.
- **CI/CD pipeline**: GitHub Actions for lint, test, build, deploy. Keep and extend.

### What's broken or dead-end (replace)

- **CreateJS rendering**: Flash-to-HTML5 bridge library. No WebGL. Full canvas redraw every frame. Not editable sprite assets (auto-generated from Adobe Animate). Community is dead.
- **Bridge pattern**: Fundamentally flawed. Tries to synchronously expose async ES6 modules to synchronous legacy code. Has a 5-second timeout hack, silent failure modes, and race conditions. Not worth fixing.
- **Legacy globals**: `game.js` and `main.js` communicate through global state mutation. Not testable, not composable.
- **Orphaned code**: `src/state/`, `src/enhanced/` — written speculatively but never connected to anything.

---

## 3. Why Not Continue the Bridge Migration

The previous plan proposed 9 phases of incremental migration using a bridge pattern. It stalled at Phase 2. Here's why continuing it is the wrong approach:

### The bridge is architecturally broken

The bridge tries to solve an impossible problem: making asynchronous ES6 dynamic imports available to synchronous legacy code that expects functions to exist at call time.

Specific failures:

- `src/bridge/ai.js` installs placeholder functions, then tries to replace them asynchronously. If legacy code captures a reference to the placeholder before replacement, it never gets the real implementation.
- `src/bridge/initialization.js` uses a 5-second timeout. If modules load slower (network, CPU), the bridge "completes" with errors silently swallowed.
- `checkAllModulesReady()` resolves its promise when `allReady || hasErrors` — meaning errors are treated as success.

### CreateJS is a dead end

CreateJS was built to help Flash developers transition to HTML5 Canvas. It:

- Has no WebGL renderer (Canvas 2D only — no hardware acceleration)
- Redraws the entire scene every frame (no dirty-rect optimization)
- Uses auto-generated sprite code from Adobe Animate (not human-editable)
- Has minimal community activity since ~2020
- Does not support modern features (shader effects, particle systems, etc.)

The dice sprites (`areadice.js`, 44KB) and UI elements (`mc.js`, 66KB) are machine-generated CreateJS MovieClip definitions. They cannot be maintained by hand. Any visual change requires the original Adobe Animate project file, which we don't have.

### Incremental migration creates permanent complexity

Each bridge module adds complexity that must be maintained forever or until removed. With ~191KB of legacy code and ~110KB of bridge/modern code, the hybrid state is harder to work with than either legacy or modern alone. A clean rewrite of the rendering layer, using the same proven algorithms, is faster and produces a better result.

---

## 4. Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser Client                       │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │  Renderer │  │    UI    │  │     Bot Sandbox       │  │
│  │  (PixiJS) │  │  (Preact)│  │  (Web Worker / iframe)│  │
│  └────┬─────┘  └────┬─────┘  └──────────┬────────────┘  │
│       │              │                   │               │
│  ┌────┴──────────────┴───────────────────┴────────────┐  │
│  │              Game Engine (pure JS)                  │  │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │  │
│  │  │ Map Gen │ │ Battle   │ │ State    │ │ AI     │ │  │
│  │  │         │ │ Resolution│ │ Manager  │ │ Runner │ │  │
│  │  └─────────┘ └──────────┘ └──────────┘ └────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                               │
│  ┌───────────────────────┴────────────────────────────┐  │
│  │              Event Bus / Store                      │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                           │
              (optional future phase)
                           │
┌─────────────────────────────────────────────────────────┐
│                    Arena Server (Node.js)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Match    │  │ Replay   │  │ Leader-  │              │
│  │ Runner   │  │ Storage  │  │ board    │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

### Key principles

1. **Game engine is pure JavaScript** — no DOM, no rendering, no side effects. It takes state in, produces state out. This makes it testable, portable (browser and Node.js), and usable for both human games and bot arenas.

2. **Rendering is a separate layer** — the renderer subscribes to state changes and draws. Swapping renderers (Canvas, WebGL, terminal) doesn't touch game logic.

3. **Bots run in isolation** — Web Workers or sandboxed iframes prevent bots from accessing game internals or the DOM. They receive a sanitized game state snapshot and return a move.

4. **Event-driven communication** — components communicate through an event bus, not global mutation. State changes are explicit and observable.

---

## 5. Technology Choices

### Rendering: PixiJS v8

**Why PixiJS:**

- WebGL 2 with Canvas 2D fallback — hardware-accelerated on all modern devices
- Sprite batching, dirty-rect rendering — only redraws what changed
- Active community, frequent releases, excellent documentation
- First-class support for shapes, sprites, text, filters, and particle effects
- Hex grid rendering is straightforward with Graphics API
- ~150KB gzipped (tree-shakeable)
- MIT licensed

**Why not:**

- Three.js: 3D engine, overkill for a 2D hex game
- Phaser: Full game framework with opinions about game loop, input, physics — too much when we only need rendering
- Raw Canvas: No WebGL, no batching, same perf issues as CreateJS
- SVG: Poor performance with many animated elements (dice rolling)

### UI Layer: Preact

**Why Preact:**

- 3KB gzipped — minimal overhead
- Same JSX/component API as React — familiar to most JS developers
- Handles menus, settings, leaderboards, lobby — things that are better as DOM than canvas
- Can overlay on top of the PixiJS canvas for HUD elements
- Signals for lightweight reactive state

**Why not:**

- React: 40KB+ for the same result
- Svelte: Good option but less familiar ecosystem
- Vanilla DOM: Tedious for dynamic UIs like leaderboards and settings panels
- No framework: Fine for simple games, but the arena/community features need real UI

### Build System: Vite

**Why Vite:**

- Near-instant dev server startup (ES modules, no bundling in dev)
- Rollup-based production builds with tree-shaking, code splitting
- First-class support for Web Workers (`new Worker(new URL(...), { type: 'module' })`)
- Built-in TypeScript support (for future migration if desired)
- Simple config — replaces 3 webpack config files with one `vite.config.js`
- Hot Module Replacement that actually works with ES modules

**Why not Webpack:**

- Current setup has 3 config files (common, modern, legacy) — complex
- HMR is disabled in modern mode because ES modules don't work well with Webpack HMR
- Slower dev server startup
- More configuration surface area

### Testing: Vitest

**Why Vitest:**

- Drop-in Jest replacement — same `describe/it/expect` API
- Uses Vite's transform pipeline — tests run against the same code as the app
- Native ES module support — no Babel transform needed for tests
- Compatible with existing Jest tests (migration is mostly mechanical)
- Built-in coverage, benchmarking, and watch mode

**Migration from Jest:** Rename `jest.config.js` → `vitest.config.js`, update imports from `@jest/globals` to `vitest`, update npm scripts. The test files themselves need minimal changes.

### Language: Modern JavaScript (ES2024+)

**Why not TypeScript:**

- The project's strength is accessibility — anyone should be able to write a bot in plain JavaScript
- TypeScript adds a compilation step and type complexity that raises the barrier to entry
- JSDoc type annotations provide IDE support without requiring TypeScript
- If TypeScript is desired later, it can be added incrementally without rewriting

**JavaScript standard:** ES2024+ (top-level await, private class fields, Array.groupBy, structuredClone). Vite handles the transpilation for older browsers.

### Package Manager: npm

Keep npm — it's already in use, everyone has it, no migration needed.

---

## 6. Phase 1: Foundation

**Goal:** Set up the new build system, project structure, and development workflow. The game doesn't need to be playable yet — this phase creates the skeleton.

### Tasks

#### 1.1 Initialize Vite project

- Create `vite.config.js` replacing the 3 webpack config files
- Configure path aliases (`@ai`, `@models`, `@mechanics`, `@state`, `@utils`) to match existing Jest aliases
- Configure Web Worker support
- Set up dev server with HMR

#### 1.2 Migrate test runner to Vitest

- Create `vitest.config.js` with same path aliases
- Update test imports (`@jest/globals` → `vitest`)
- Verify all 476 tests pass
- Keep coverage thresholds (60% global, 70% models, 50% mechanics)

#### 1.3 Create new directory structure

```
src/
├── engine/          # Pure game logic (no DOM, no rendering)
│   ├── Game.js          # Game class (from existing src/Game.js)
│   ├── MapGenerator.js  # Map generation algorithms
│   ├── BattleResolver.js# Dice rolling and battle resolution
│   ├── StateManager.js  # Game state management
│   ├── TurnManager.js   # Turn order, player elimination
│   └── types.js         # JSDoc type definitions
├── ai/              # AI strategies (keep existing, mostly unchanged)
│   ├── index.js
│   ├── registry.js      # AI registration and loading
│   ├── strategies/
│   │   ├── default.js
│   │   ├── defensive.js
│   │   ├── adaptive.js
│   │   └── example.js
│   └── sandbox.js       # Web Worker sandbox for untrusted bots
├── renderer/        # PixiJS rendering layer
│   ├── GameRenderer.js  # Main renderer orchestrator
│   ├── HexGrid.js       # Hexagonal grid drawing
│   ├── DiceSprites.js   # Dice rendering (replace areadice.js)
│   ├── BattleAnimation.js # Battle dice rolling animation
│   ├── Camera.js        # Pan/zoom controls
│   └── themes/          # Visual themes (colors, styles)
│       └── classic.js   # Original color scheme
├── ui/              # Preact UI components
│   ├── App.jsx          # Root component
│   ├── TitleScreen.jsx
│   ├── GameHUD.jsx      # In-game overlay (player status, turn info)
│   ├── Settings.jsx     # Game settings panel
│   ├── BotArena.jsx     # Arena lobby and match viewer
│   └── Leaderboard.jsx  # Bot rankings
├── audio/           # Sound system
│   ├── SoundManager.js
│   └── sounds/          # Audio files (keep existing .wav)
├── events/          # Event bus
│   └── EventBus.js      # Centralized event system
├── store/           # Application state
│   └── GameStore.js     # Observable game state
└── index.js         # Entry point
```

#### 1.4 Set up PixiJS

- Install PixiJS v8
- Create basic `GameRenderer.js` that draws a colored rectangle (proof of life)
- Verify WebGL context creation
- Set up responsive canvas sizing

#### 1.5 Set up Preact

- Install Preact
- Create `App.jsx` shell with title screen placeholder
- Verify JSX compilation through Vite
- Layer Preact DOM over PixiJS canvas

#### 1.6 Update CI/CD

- Update GitHub Actions to use Vite build commands
- Keep lint, test, build, deploy steps
- Add bundle size check (target: <300KB total JS gzipped)

#### 1.7 Update ESLint

- Update config for Vite/Vitest environment
- Add JSX support for Preact files
- Keep existing rules that make sense

### Definition of done

- `npm run dev` starts Vite dev server showing a Preact title screen over a PixiJS canvas
- `npm test` runs all existing tests via Vitest
- `npm run build` produces a production bundle
- CI pipeline passes

---

## 7. Phase 2: Core Game Engine

**Goal:** Extract the proven game algorithms into a pure, renderer-independent game engine. No globals, no DOM access, no CreateJS.

### Tasks

#### 2.1 Create pure `Game` class

- Merge the best of `game.js` and `src/Game.js` into `src/engine/Game.js`
- Remove all DOM/rendering references
- All state lives in plain objects (no globals)
- Methods are pure where possible: `state in → state out`
- Key methods:
  - `createMap(config) → GameState`
  - `attack(state, fromArea, toArea) → { newState, battleResult }`
  - `endTurn(state) → { newState, reinforcements }`
  - `getValidMoves(state, player) → Move[]`
  - `isGameOver(state) → { over, winner }`

#### 2.2 Extract `MapGenerator`

- Port the percolation/territory growth algorithm from `game.js`
- Port the border-tracing algorithm (`set_area_line`)
- Port the union-find algorithm (`set_area_tc`)
- Pure function: `generateMap(config) → { areas, cells, adjacency }`
- No side effects, no globals

#### 2.3 Extract `BattleResolver`

- Port dice rolling from `game.js` and `src/mechanics/battleResolution.js`
- Pure function: `resolveBattle(attackerDice, defenderDice, rng?) → BattleResult`
- Optional RNG parameter for deterministic testing and replays
- Include probability calculation for UI hints

#### 2.4 Create `StateManager`

- Immutable state updates: `applyAction(state, action) → newState`
- Action types: `ATTACK`, `END_TURN`, `REINFORCE`, `ELIMINATE_PLAYER`
- Full action history for replay
- State serialization for saving/loading games

#### 2.5 Create `TurnManager`

- Turn order management
- Player elimination detection
- Reinforcement calculation (connected territory bonus)
- Win condition checking

#### 2.6 Define game state types (JSDoc)

```javascript
/**
 * @typedef {Object} GameState
 * @property {Area[]} areas - Territory data (index 1 to AREA_MAX)
 * @property {Player[]} players - Player data (index 0 to playerCount-1)
 * @property {number} currentPlayer - Active player index
 * @property {number} turnNumber - Current turn
 * @property {Action[]} history - All actions taken
 * @property {GamePhase} phase - 'setup' | 'playing' | 'battle' | 'reinforce' | 'over'
 */
```

#### 2.7 Port and expand tests

- Migrate existing game logic tests to Vitest
- Add tests for pure engine functions
- Test deterministic replay (same RNG seed → same game)
- Verify compatibility with existing AI strategies

### Definition of done

- Game engine runs entirely in Node.js with no browser APIs
- All AI strategies work against the new engine
- `npm test` passes with engine + AI tests
- A game can be simulated from start to finish in Node.js (headless)

---

## 8. Phase 3: Rendering & UI

**Goal:** Build the visual layer on PixiJS and Preact, achieving feature parity with the current game.

### Tasks

#### 3.1 Hex grid renderer

- Draw hexagonal grid using PixiJS Graphics
- Territory coloring by player ownership
- Territory borders (thick outline)
- Hover highlight on mouseover
- Click detection (which territory was clicked?)
- Smooth color transitions on ownership change

**Hex rendering approach:**

```javascript
// Flat-top hexagon vertices
const hexPoints = (cx, cy, size) => {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    points.push(cx + size * Math.cos(angle), cy + size * Math.sin(angle));
  }
  return points;
};
```

Note: The existing game uses an offset-coordinate grid with cell-based territory rendering (each territory is a group of cells). The new renderer should replicate this look — territories are irregular blobs of hexagonal cells, not single hexagons.

#### 3.2 Dice rendering

- Replace `areadice.js` (Adobe Animate export) with hand-drawn PixiJS dice
- Simple 3D isometric dice using PixiJS Graphics (filled polygons for faces)
- Stacked dice display (1-8 dice per territory)
- Player color applied to dice faces
- Dice number shown on front face

#### 3.3 Battle animation

- Dice rolling animation when attack occurs
- Physics-based bouncing (port the simple bounce logic from `main.js`)
- Show attacker and defender dice with running totals
- Victory/defeat visual feedback
- Sound effects triggered at key frames

#### 3.4 Player status HUD

- Preact component overlaid on canvas
- Show each player: color, territory count, dice count, reinforcement stock
- Highlight current player's turn
- Eliminated players shown as greyed out

#### 3.5 Title screen and menus

- Preact-based title screen (not canvas-drawn)
- Player count selection
- AI strategy selection per player
- Human vs AI toggle per player slot
- Start game button
- Settings panel (sound, speed, visual theme)

#### 3.6 Game flow

- Wire up the full game loop: title → setup → play → battle → reinforce → next turn → game over
- Human input: click territory to attack from, click target
- AI turns: show thinking indicator, execute move, animate battle
- End turn button
- Spectator mode (AI vs AI with speed controls)
- Responsive layout (desktop and mobile)

#### 3.7 Sound system

- Port existing sounds (8 .wav files)
- Web Audio API (no CreateJS SoundJS)
- Mute toggle
- Volume control
- Handle mobile autoplay restrictions properly

#### 3.8 Camera controls (optional but nice)

- Pan and zoom on the game board
- Pinch-to-zoom on mobile
- Fit-to-screen button

### Definition of done

- Full game playable in browser with PixiJS rendering
- Feature parity with current CreateJS version
- Works on desktop (mouse) and mobile (touch)
- Spectator mode (AI vs AI) works
- All sounds play correctly
- Performance: 60fps on mid-range hardware

---

## 9. Phase 4: Bot SDK & Arena

**Goal:** Make it dead simple for anyone to write a bot, and build the infrastructure for bots to compete.

### Tasks

#### 4.1 Bot SDK

Create a simple, well-documented SDK for writing bots.

**Bot interface:**

```javascript
// my-bot.js — this is ALL you need to write
export default function myBot(state) {
  // state.myAreas - territories you own (id, dice, neighbors)
  // state.enemies - visible enemy territories (id, dice, owner)
  // state.players - player stats (territories, totalDice, ranking)
  // state.myPlayer - your player index
  // state.turnNumber - current turn
  //
  // Return: { from: areaId, to: areaId } to attack
  // Return: null to end your turn

  const myTerritory = state.myAreas.find(a => a.dice > 1);
  const target = myTerritory?.neighbors.find(n => n.owner !== state.myPlayer);

  if (myTerritory && target) {
    return { from: myTerritory.id, to: target.id };
  }
  return null; // end turn
}
```

**Key design decisions:**

- **Single function, single file** — lowest possible barrier to entry
- **Sanitized state** — bots see only what a player would see (no internal engine state)
- **Return a move or null** — no callback hell, no async required
- **No game mutation** — bots cannot modify game state, only return moves
- **Pure function** — same state should produce same move (for replay determinism)

#### 4.2 Bot sandbox (Web Worker)

- Bots run in a Web Worker — isolated from main thread and DOM
- Execution timeout: 100ms per move (prevents infinite loops)
- Memory limit enforced by Worker termination
- No network access, no file access, no `eval`
- Communication via `postMessage` with structured clone

```javascript
// Inside the worker:
importScripts('bot.js');
self.onmessage = ({ data: state }) => {
  const move = bot(state);
  self.postMessage(move);
};
```

#### 4.3 Bot validation

- Validate bot file syntax before running
- Validate returned moves (is `from` owned by player? is `to` adjacent? does `from` have >1 dice?)
- Invalid moves = turn skipped (logged for debugging)
- Crash = turn skipped with error message

#### 4.4 Arena match runner

- Run N games between a set of bots
- Configurable: number of games, player count, map seed
- Collect results: wins, losses, average territories, average turns to win
- Deterministic replays via seeded RNG

#### 4.5 Leaderboard

- ELO rating system for bots
- Win rate, games played, average placement
- Preact component displaying rankings
- Sortable by rating, wins, win rate
- Bot detail page: strategy description, recent matches, rating history

#### 4.6 Replay system

- Record all actions in a game as a compact JSON log
- Replay viewer: step through turns, play/pause, speed control
- Share replays via URL (encoded in hash or stored in localStorage)

#### 4.7 Tournament mode

- Single-elimination or round-robin brackets
- Automated tournament execution
- Results visualization (bracket diagram)
- Tournament history

### Definition of done

- A developer can write a bot in a single .js file with < 10 lines
- Bots run safely in sandboxed Workers
- Arena runs 100 games between bots and produces a leaderboard
- Replays can be viewed in the browser
- Built-in bots (default, defensive, adaptive) are available as reference implementations

---

## 10. Phase 5: Community & Polish

**Goal:** Make the project welcoming for contributors and fun for players.

### Tasks

#### 5.1 Documentation

- `README.md`: Quick start, how to play, how to write a bot (with example)
- `CONTRIBUTING.md`: How to set up dev environment, run tests, submit PRs
- `docs/BOT_GUIDE.md`: Complete bot SDK reference with examples
- `docs/GAME_RULES.md`: Official game rules and mechanics
- `docs/ARCHITECTURE.md`: How the codebase is organized
- In-code JSDoc for all public APIs

#### 5.2 Bot starter template

- `bots/` directory with example bots at different complexity levels:
  - `random-bot.js` — attacks randomly (10 lines)
  - `greedy-bot.js` — always attacks weakest neighbor (20 lines)
  - `cautious-bot.js` — only attacks with dice advantage (25 lines)
  - `strategic-bot.js` — evaluates position and risk (50 lines)
- Each bot has inline comments explaining the strategy
- `npm run arena` command to run bots against each other locally

#### 5.3 CLI tools

- `npm run arena -- --bots random,greedy,adaptive --games 100` — run arena from command line
- `npm run new-bot <name>` — scaffold a new bot from template
- `npm run validate-bot <file>` — check a bot file for errors
- `npm run benchmark-bot <file>` — measure bot performance (ms/move)

#### 5.4 Visual polish

- Smooth territory transitions (fade between colors on capture)
- Particle effects on battle victory
- Screen shake on large battles
- Animated reinforcement distribution
- Win celebration animation
- Dark mode / light mode toggle

#### 5.5 Accessibility

- Keyboard navigation for territory selection
- Screen reader announcements for game events
- Color-blind safe player color palette option
- Adjustable animation speed

#### 5.6 GitHub community

- Issue templates (bug report, feature request, bot submission)
- PR template
- Code of conduct
- License (MIT)
- GitHub Pages deployment for playable demo
- Bot showcase in README

---

## 11. What We Keep vs. Rewrite

### Keep (port to new architecture)

| What                          | From                                                         | Notes                                                |
| ----------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| Map generation algorithm      | `game.js:make_map()`, `percolate()`                          | Proven procedural generation — port to pure function |
| Border tracing algorithm      | `game.js:set_area_line()`                                    | Draws territory outlines — port to pure function     |
| Union-find (connected groups) | `game.js:set_area_tc()`                                      | Calculates largest connected territory group         |
| Hex neighbor calculation      | `game.js:next_cel()`                                         | Offset hex grid adjacency                            |
| Battle resolution             | `game.js` battle logic + `src/mechanics/battleResolution.js` | Dice rolling and comparison                          |
| AI strategies                 | `src/ai/*.js`                                                | All 4 bots — adapt to new state format               |
| AI config/registry            | `src/ai/aiConfig.js`                                         | Dynamic loading pattern                              |
| Error hierarchy               | `src/mechanics/errors/`                                      | Custom error classes                                 |
| Event system                  | `src/mechanics/eventSystem.js`                               | EventEmitter with middleware                         |
| Test infrastructure           | `tests/`                                                     | Mocks, benchmarks, test patterns                     |
| Sound files                   | `sound/*.wav`                                                | 8 audio assets                                       |
| CI/CD pipeline                | `.github/workflows/`                                         | GitHub Actions — update commands                     |
| Player color scheme           | `main.js` color arrays                                       | The 8-color palette                                  |
| Game constants                | `game.js` XMAX, YMAX, AREA_MAX, etc.                         | Grid dimensions, limits                              |

### Rewrite

| What                              | Why                                                  |
| --------------------------------- | ---------------------------------------------------- |
| Rendering (CreateJS → PixiJS)     | CreateJS is a dead-end Flash bridge                  |
| Sprites (areadice.js, mc.js)      | Adobe Animate exports, not editable                  |
| Bridge layer (src/bridge/)        | Fundamentally broken async/sync mismatch             |
| Game loop (main.js state machine) | Global function pointers, not composable             |
| UI (canvas-drawn buttons/text)    | Move to Preact for menus, keep canvas for game board |
| Build system (Webpack → Vite)     | Simpler config, faster dev server, native ES modules |

### Delete

| What                        | Why                                                   |
| --------------------------- | ----------------------------------------------------- |
| `src/state/`                | Written but never used — new StateManager replaces it |
| `src/enhanced/`             | Map-based alternatives never integrated — delete      |
| `src/bridge/`               | Broken bridge — delete entirely                       |
| `src/adapters/MCAdapter.js` | Wraps CreateJS MovieClip — no longer needed           |
| `config-ai-vs-ai.js`        | Replaced by arena mode                                |
| Old docs in `docs/`         | Replaced by this roadmap and new docs                 |

---

## 12. File Structure

Final directory layout after modernization:

```
dicewarsjs/
├── index.html                    # Single page entry point
├── vite.config.js                # Build configuration
├── vitest.config.js              # Test configuration
├── package.json
├── .eslintrc.js
├── .prettierrc.js
├── .github/
│   └── workflows/
│       ├── ci.yml                # Lint, test, build
│       └── deploy.yml            # GitHub Pages
├── src/
│   ├── index.js                  # App entry point
│   ├── engine/                   # Pure game logic
│   │   ├── Game.js
│   │   ├── MapGenerator.js
│   │   ├── BattleResolver.js
│   │   ├── StateManager.js
│   │   ├── TurnManager.js
│   │   ├── constants.js
│   │   └── types.js              # JSDoc type definitions
│   ├── ai/                       # AI system
│   │   ├── index.js
│   │   ├── registry.js
│   │   ├── sandbox.js            # Web Worker sandbox
│   │   ├── worker.js             # Worker entry point
│   │   └── strategies/
│   │       ├── default.js
│   │       ├── defensive.js
│   │       ├── adaptive.js
│   │       └── example.js
│   ├── renderer/                 # PixiJS rendering
│   │   ├── GameRenderer.js
│   │   ├── HexGrid.js
│   │   ├── DiceSprites.js
│   │   ├── BattleAnimation.js
│   │   ├── Camera.js
│   │   └── themes/
│   │       └── classic.js
│   ├── ui/                       # Preact components
│   │   ├── App.jsx
│   │   ├── TitleScreen.jsx
│   │   ├── GameHUD.jsx
│   │   ├── Settings.jsx
│   │   ├── BotArena.jsx
│   │   └── Leaderboard.jsx
│   ├── audio/
│   │   └── SoundManager.js
│   ├── events/
│   │   └── EventBus.js
│   └── store/
│       └── GameStore.js
├── bots/                         # Example bots & starter templates
│   ├── random-bot.js
│   ├── greedy-bot.js
│   ├── cautious-bot.js
│   └── strategic-bot.js
├── sound/                        # Audio assets (keep existing)
│   ├── button.wav
│   ├── click.wav
│   ├── dice.wav
│   ├── success.wav
│   ├── fail.wav
│   ├── myturn.wav
│   ├── over.wav
│   └── clear.wav
├── tests/
│   ├── engine/                   # Game engine tests
│   ├── ai/                       # AI strategy tests
│   ├── renderer/                 # Rendering tests
│   ├── arena/                    # Arena/tournament tests
│   ├── mocks/                    # Test utilities
│   ├── benchmarks/               # Performance benchmarks
│   └── regression/               # Regression tests
├── docs/
│   ├── MODERNIZATION_ROADMAP.md  # This document
│   ├── BOT_GUIDE.md              # How to write a bot
│   ├── GAME_RULES.md             # Official game rules
│   └── ARCHITECTURE.md           # Codebase architecture
├── scripts/                      # Build/dev scripts
│   └── check-bundle-size.js
├── legacy/                       # Archived legacy code (reference only)
│   ├── game.js
│   ├── main.js
│   ├── areadice.js
│   ├── mc.js
│   └── README.md                 # "This is archived legacy code"
├── CLAUDE.md
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

---

## 13. Bot SDK Design

### State object provided to bots

```javascript
/**
 * @typedef {Object} BotState
 * @property {number} myPlayer - Your player index
 * @property {number} turnNumber - Current turn number
 * @property {number} totalPlayers - Number of players (including eliminated)
 * @property {number} activePlayers - Number of still-playing players
 * @property {BotArea[]} myAreas - Territories you own
 * @property {BotArea[]} allAreas - All territories on the map
 * @property {BotPlayer[]} players - All player stats
 * @property {string} gamePhase - 'early' | 'mid' | 'late'
 */

/**
 * @typedef {Object} BotArea
 * @property {number} id - Territory ID
 * @property {number} owner - Player who owns this territory
 * @property {number} dice - Number of dice on this territory (1-8)
 * @property {number[]} neighbors - IDs of adjacent territories
 * @property {boolean} isBorder - True if adjacent to enemy territory
 */

/**
 * @typedef {Object} BotPlayer
 * @property {number} id - Player index
 * @property {number} territories - Number of territories owned
 * @property {number} totalDice - Total dice across all territories
 * @property {number} connectedTerritories - Largest connected group size
 * @property {number} reinforcements - Dice in reserve
 * @property {boolean} eliminated - Whether this player has been eliminated
 */

/**
 * @typedef {Object} BotMove
 * @property {number} from - Territory ID to attack from
 * @property {number} to - Territory ID to attack
 */
```

### Example bots

**Simplest possible bot (random):**

```javascript
export default function randomBot(state) {
  for (const area of state.myAreas) {
    if (area.dice <= 1) continue;
    const enemy = area.neighbors.find(id => {
      const target = state.allAreas.find(a => a.id === id);
      return target && target.owner !== state.myPlayer;
    });
    if (enemy) return { from: area.id, to: enemy };
  }
  return null;
}
```

**Greedy bot (always attacks weakest):**

```javascript
export default function greedyBot(state) {
  let bestMove = null;
  let bestAdvantage = 0;

  for (const area of state.myAreas) {
    if (area.dice <= 1) continue;
    for (const neighborId of area.neighbors) {
      const target = state.allAreas.find(a => a.id === neighborId);
      if (!target || target.owner === state.myPlayer) continue;
      const advantage = area.dice - target.dice;
      if (advantage > bestAdvantage) {
        bestAdvantage = advantage;
        bestMove = { from: area.id, to: neighborId };
      }
    }
  }
  return bestMove;
}
```

### Bot lifecycle

1. Bot file is loaded and validated (syntax check, export check)
2. Bot function is passed to a Web Worker
3. Each turn, Worker receives sanitized `BotState` via `postMessage`
4. Bot function is called with `BotState`
5. Return value is sent back via `postMessage`
6. Main thread validates the move
7. If valid: execute attack. If invalid/timeout/crash: skip turn
8. Repeat until bot returns `null` (end turn) or makes invalid move

---

## 14. Arena System Design

### Local arena (Phase 4)

Run entirely in the browser. No server needed.

```
┌──────────────────────────────────────────┐
│              Arena Controller             │
│  - Load bot files                        │
│  - Configure match (games, players, seed)│
│  - Run matches in sequence               │
│  - Collect results                       │
│  - Calculate ELO ratings                 │
│  - Display leaderboard                   │
└──────────┬───────────────────────────────┘
           │
     ┌─────┴─────┐
     │Match Runner│ (one game at a time)
     └─────┬─────┘
           │
   ┌───────┴───────┐
   │  Game Engine   │ (headless, fast)
   │  + Bot Workers │ (one per bot)
   └───────────────┘
```

**Match configuration:**

```javascript
{
  bots: ['random-bot.js', 'greedy-bot.js', 'adaptive'],
  gamesPerMatch: 100,
  playersPerGame: 4,    // randomly assign bots to player slots
  mapSeed: null,        // null = random, number = fixed seed
  moveTimeout: 100,     // ms per bot decision
  visualize: false,     // true = show games in renderer
}
```

**Results:**

```javascript
{
  bots: [
    { name: 'adaptive', wins: 45, losses: 55, avgPlacement: 1.8, elo: 1523 },
    { name: 'greedy-bot', wins: 30, losses: 70, avgPlacement: 2.2, elo: 1487 },
    { name: 'random-bot', wins: 25, losses: 75, avgPlacement: 2.9, elo: 1412 },
  ],
  totalGames: 100,
  averageTurns: 47,
}
```

### Future: Online arena (post-Phase 5, optional)

If there's community interest, a server-side arena could be added:

- **Node.js server** running the game engine headlessly
- **Bot submission** via GitHub PR to a `community-bots/` directory
- **Scheduled tournaments** (daily/weekly)
- **Persistent leaderboard** stored in a database or flat file
- **GitHub Actions integration** — new bot PRs automatically trigger a tournament run

This is explicitly out of scope for the initial modernization but the architecture supports it: the game engine runs in Node.js, bots are sandboxed, results are serializable.

---

## 15. Migration Sequence

### How to execute this plan

Each phase produces a working, deployable application. At no point is the game broken.

```
Phase 1: Foundation
  ├── Vite + Vitest setup
  ├── New directory structure (empty shells)
  ├── PixiJS + Preact proof of life
  └── CI updated
       │
Phase 2: Engine
  ├── Pure game engine extracted
  ├── All AI strategies ported
  ├── Headless game simulation works
  └── Tests pass
       │
Phase 3: Rendering
  ├── PixiJS hex grid renderer
  ├── Dice sprites (hand-drawn, replacing areadice.js)
  ├── Battle animation
  ├── Preact UI (menus, HUD)
  ├── Sound system
  └── Full game playable in browser → DEPLOY (replaces current version)
       │
Phase 4: Arena
  ├── Bot SDK defined
  ├── Web Worker sandbox
  ├── Arena match runner
  ├── Leaderboard
  ├── Replay system
  └── Example bots
       │
Phase 5: Community
  ├── Documentation
  ├── CLI tools
  ├── Visual polish
  ├── Accessibility
  └── GitHub community setup
```

### Legacy code handling

During migration:

1. Legacy files (`game.js`, `main.js`, `areadice.js`, `mc.js`) remain in the root directory and continue to work
2. The current game is still playable via the existing `index.html`
3. New code is built in `src/` with the new structure
4. When Phase 3 is complete and the new renderer achieves feature parity, the new version replaces the old
5. Legacy files are moved to `legacy/` for reference, then eventually deleted

### Parallel development strategy

Because the game engine (Phase 2) has no dependency on rendering (Phase 3), these can be developed in parallel:

- **Track A**: Engine + AI (Phases 2 + 4 bot SDK)
- **Track B**: Renderer + UI (Phase 3)

Both tracks merge when Phase 3 wires the renderer to the engine.

---

## 16. Open Questions

Decisions to make as implementation proceeds:

1. **Map sizes**: Should we support different map sizes (small/medium/large)? The current 28x32 grid with 32 territories is fixed. Variable maps would be more interesting for competitive play.

2. **Fog of war**: Should bots only see territories adjacent to their own? This would add strategic depth but increase complexity for bot authors.

3. **Bot persistence**: Should bots be allowed to maintain state between turns (memory of past moves)? Current AI contract is stateless. Adding state would allow learning bots but complicates the sandbox.

4. **Multiplayer**: Should the game support real-time multiplayer (WebSocket)? This is a large scope increase but would make the game much more engaging. Could be a Phase 6.

5. **Map editor**: Should players be able to create and share custom maps? Would add replayability and community engagement.

6. **Bot language**: Should bots be limited to JavaScript, or should we support WASM (allowing bots written in Rust, C, Python via compile-to-WASM)? JS-only is simpler; WASM opens it to more communities.

7. **Ranking persistence**: Where should ELO ratings be stored? Options: localStorage (local only), GitHub Pages JSON file (shared but read-only), or a simple server (requires hosting).

---

## Appendix: Existing AI Strategies Reference

These are the 4 AI implementations that will be ported to the new bot SDK format. They serve as reference implementations and competitive baselines.

| Strategy    | Difficulty | Lines | Key Behavior                                                                                                                    |
| ----------- | ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `example`   | 1/5        | 74    | Attacks randomly when advantaged. Educational baseline.                                                                         |
| `default`   | 3/5        | 185   | Ranks players, detects dominant player, 90% chance to attack with equal dice.                                                   |
| `defensive` | 2/5        | 163   | Pre-computes neighbor info, prioritizes territories with single enemy neighbor, avoids counter-attacks.                         |
| `adaptive`  | 4/5        | 851   | Game phase detection (early/mid/late), threat analysis, choke point identification, endgame specialization. Most sophisticated. |

All four use the same interface: `function ai(game) → 0 | undefined`. They will be adapted to the new `function bot(state) → Move | null` interface.

---

_This document is the single source of truth for the DiceWarsJS modernization. All prior planning documents (`ES6_MIGRATION_PLAN.md`, `ROADMAP.md`, `BRIDGE_ARCHITECTURE.md`, `PHASE2_TESTING_PLAN.md`, etc.) are superseded by this roadmap._
