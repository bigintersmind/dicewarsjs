# DiceWarsJS

A modern, browser-based territory conquest game played on a hexagonal grid. Players (human or AI) roll dice to attack adjacent territories. The last player standing wins.

[**Play the game online**](https://bigintersmind.github.io/dicewarsjs/)

Built on the original [Dice Wars](https://www.gamedesign.jp/games/dicewars/) by GameDesign.jp and [Chris Raff's fork](https://github.com/chrisraff/dicewarsjs) that added custom AI capabilities.

## Features

- **Play or spectate** — play against AI opponents or watch bots battle each other
- **Configurable map size** — pick Small (20×24), Medium (28×32, default) or Large (36×40) before each game
- **Bot SDK** — write a bot in a single function and compete in the arena
- **Arena mode** — run tournaments with ELO ratings and match replays
- **6 built-in AI strategies** — from random to exact-odds EV search
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
├── ai/           6 AI strategies (example, default, defensive, adaptive, Claude, Codex)
├── store/        Observable GameStore (pub/sub shared state)
├── controller/   GameController (game loop orchestrator)
├── audio/        Web Audio sound manager
└── utils/        Game configuration (map size, player/AI assignments)
```

See [Architecture](docs/ARCHITECTURE.md) for how data flows through the system.

## AI Strategies

| Bot                               | Strategy                                      |
| --------------------------------- | --------------------------------------------- |
| **Example** (`ai_example.js`)     | Simple implementation to learn from           |
| **Default** (`ai_default.js`)     | Original game's balanced AI                   |
| **Defensive** (`ai_defensive.js`) | Prioritizes protecting vulnerable territories |
| **Adaptive** (`ai_adaptive.js`)   | Adjusts strategy based on game state          |
| **Claude** (`ai_claude.js`)       | Exact expected value using odds and income    |
| **Codex** (`ai_codex.js`)         | Claude EV baseline with expectimax overrides  |

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
