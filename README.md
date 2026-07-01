# DiceWarsJS

A modern, browser-based territory conquest game played on a hexagonal grid. Players (human or AI) roll dice to attack adjacent territories. The last player standing wins.

[**Play the game online**](https://bigintersmind.github.io/dicewarsjs/)

Built on the original [Dice Wars](https://www.gamedesign.jp/games/dicewars/) by GameDesign.jp and [Chris Raff's fork](https://github.com/chrisraff/dicewarsjs) that added custom AI capabilities.

## Features

- **Play or spectate** — play against AI opponents or watch bots battle each other
- **Choose your opponents** — pick a bot per slot before each game (Customize players), including the curated community bots — duplicates allowed
- **Configurable map size** — pick Small (20×24), Medium (28×32, default) or Large (36×40) before each game
- **Bot SDK** — write a bot in a single function and compete in the arena
- **Arena mode** — run tournaments with ELO ratings and match replays
- **10 built-in AI bots** — from random to exact-odds EV, chance-node search, and self-play neural-net personas
- **PixiJS rendering** — WebGL-accelerated hex grid with dice animations
- **Mobile-friendly** — responsive design with touch support

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## Write a Bot

A bot is a function that looks at the board and decides what to attack:

```javascript
// Find your strongest border territory with a weak neighbor, and attack
const myBorders = state.myAreas.filter(a => a.dice > 1 && a.isBorder);

for (const area of myBorders) {
  const enemies = area.neighbors
    .map(id => state.allAreas.find(a => a.id === id))
    .filter(a => a && a.owner !== state.myPlayer);

  const weakest = enemies.sort((a, b) => a.dice - b.dice)[0];
  if (weakest && area.dice > weakest.dice) {
    return { from: area.id, to: weakest.id };
  }
}

return null; // end turn
```

- Return `{ from, to }` to attack an adjacent enemy territory
- Return `null` to end your turn
- Your function is called repeatedly until you end your turn

See the [Bot Guide](docs/BOT_GUIDE.md) for the full SDK reference and the [`bots/`](bots/) directory for example bots at different complexity levels.

### Test your bot

Test and benchmark your bot from the command line:

```bash
npm run validate-bot -- bots/my-bot.js   # check syntax + runtime
npm run benchmark-bot -- bots/my-bot.js  # win rate, ELO, placement
npm run arena                            # 100 games, all built-in bots
npm run arena -- --games 50              # 50 games
npm run arena -- --bots Default,Adaptive # specific bots
```

To enter the **daily online tournament** with ELO rankings, submit your bot via GitHub — see [Submitting Your Bot](docs/BOT_GUIDE.md#submitting-your-bot).

## Available Scripts

```bash
npm run dev             # Start dev server (port 3000)
npm run build           # Production build
npm run preview         # Preview production build

npm test                # Run all tests
npm run test:watch      # Tests in watch mode
npm run test:coverage   # Coverage report
npm run test:benchmark  # AI benchmark tests

npm run lint            # Check linting
npm run lint:fix        # Auto-fix lint issues
npm run format          # Format with Prettier
npm run format:check    # Check formatting

npm run arena           # Run bot arena from CLI
npm run benchmark       # Run AI strategy benchmarks
```

## Project Architecture

```
src/
├── engine/       Pure game logic (state, battles, maps, turns) — no DOM
├── renderer/     PixiJS rendering (hex grid, dice, animations)
├── ui/           Preact components (screens, HUD, overlays)
├── arena/        Bot SDK (validation, execution, tournaments, ELO, replays)
├── ai/           AI bots: 7 heuristic + the self-play persona roster (Conqueror, Blitz, Survivor); PPO/BC kept for the dev harness
├── store/        Observable GameStore (pub/sub shared state)
├── controller/   GameController (game loop orchestrator)
├── audio/        Web Audio sound manager
└── utils/        Game configuration — map-size presets
```

See [Architecture](docs/ARCHITECTURE.md) for how data flows through the system.

## AI Strategies

| Bot                                 | Strategy                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| **Example** (`ai_example.js`)       | Simple implementation to learn from                          |
| **Default** (`ai_default.js`)       | Original game's balanced AI                                  |
| **Defensive** (`ai_defensive.js`)   | Prioritizes protecting vulnerable territories                |
| **Adaptive** (`ai_adaptive.js`)     | Adjusts strategy based on game state                         |
| **Strategist** (`ai_strategist.js`) | Exact expected value using odds and income                   |
| **Lookahead** (`ai_lookahead.js`)   | Shallow expectimax over win/loss branches                    |
| **Expectimax** (`ai_expectimax.js`) | Chance-node expectimax over the exact battle distribution    |
| **Conqueror** (`ai_conqueror.js`)   | Self-play net — balanced, plays the long game to win         |
| **Blitz** (`ai_blitz.js`)           | Self-play net — aggressive, presses hard and ends games fast |
| **Survivor** (`ai_survivor.js`)     | Self-play net — patient, outlasts rivals (the strongest)     |
| _PPO / BC_ (dev-only)               | Internal training nets — hidden from players (eval harness)  |

> **Strategist** and **Lookahead** are the strongest _heuristic_ built-in bots, each authored by an AI coding assistant: Strategist by **Claude Opus 4.8** and Lookahead by **GPT-5.5**. The names describe their technique (expected-value scoring vs. shallow search) rather than the tool that wrote them.
>
> **Expectimax** and the **self-play personas** make up the playable side of the [ML-bot initiative](docs/ml-bot/). **Expectimax** is the search-first baseline — a depth-2 chance-node search that scores the positions resulting from each attack's win/loss outcomes, weighted by exact dice odds. **Conqueror**, **Blitz**, and **Survivor** are neural nets trained by self-play reinforcement learning against a league of opponents; all three beat Lookahead head-to-head. They share the same in-browser forward pass and differ only in their training reward: Conqueror plays balanced to win (the strongest balanced net), Blitz on a short horizon to finish fast, and Survivor for placement — Survivor is the strongest, beating the earlier flagship net head-to-head. The internal **PPO** and **BC** nets that this roster grew out of are kept in the repo as the dev eval-harness baseline but are **hidden from players** ("PPO" is an internal training name; Conqueror ships its weights under a friendlier one). See [docs/ml-bot/](docs/ml-bot/) for the full story.

## Documentation

- [**Bot Guide**](docs/BOT_GUIDE.md) — how to write a bot, full SDK reference
- [**Game Rules**](docs/GAME_RULES.md) — how the game works
- [**Architecture**](docs/ARCHITECTURE.md) — codebase organization and data flow
- [**Modernization Roadmap**](docs/MODERNIZATION_ROADMAP.md) — project vision and phase plan
- [**AI Strategies**](docs/ai-strategies/README.md) — detailed AI strategy patterns
- [**AI Developer Guide**](docs/ai/DEVELOPER_GUIDE.md) — guide for AI development
- [**Code Style**](docs/CODE_STYLE.md) — coding standards
- [**Testing Strategy**](docs/TESTING.md) — testing approach

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, conventions, and how to submit a bot.

The easiest way to contribute is to [write a bot](docs/BOT_GUIDE.md) and share it.

## License

[MIT](LICENSE)

## Acknowledgments

- Original game design by [GameDesign.jp](https://www.gamedesign.jp/games/dicewars/)
- Initial JavaScript implementation by [Chris Raff](https://github.com/chrisraff/dicewarsjs)
