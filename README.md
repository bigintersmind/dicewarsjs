# DiceWarsJS

A browser-based territory conquest game played on a hexagonal grid. Players (human or AI) roll dice to attack adjacent territories. The last player standing wins.

[**Play the game online**](https://bigintersmind.github.io/dicewarsjs/)

Built on the original [Dice Wars](https://www.gamedesign.jp/games/dicewars/) by GameDesign.jp and [Chris Raff's fork](https://github.com/chrisraff/dicewarsjs) that added support for custom AIs.

## Features

- **Play or spectate.** Face AI opponents yourself, or watch bots battle each other.
- **Choose your opponents.** Pick a difficulty (Easy/Standard/Hard), or go Custom and pick a bot per slot, including the curated community bots. Duplicates are allowed.
- **Tilt the dice your way.** Custom mode has an optional luck handicap: Normal, Lucky, or Very lucky. Your seat rolls extra dice and drops as many of the lowest as it added, attacking and defending. The presets always roll fair dice.
- **Built-in rulebook.** A HOW TO PLAY card reachable from the title screen, the in-game bar, and the game-over screen.
- **Board hints.** Your territories that can attack are outlined, and picking one lights up the enemies it can reach. Toggle it under Settings.
- **Configurable map size.** Small (20×24), Medium (28×32, default) or Large (36×40), chosen before each game.
- **Bot SDK.** Write a bot in a single function and compete in the arena.
- **Arena mode.** Run tournaments with ELO ratings and match replays.
- **10 built-in AI bots.** They range from random play to exact-odds EV, chance-node search, and self-play neural-net personas.
- **PixiJS rendering.** WebGL-accelerated hex grid with dice animations.
- **Mobile-friendly.** Responsive layout with touch support.

## Quick start

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## Write a bot

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

To enter the **daily online tournament** with ELO rankings, submit your bot via GitHub. See [Submitting your bot](docs/BOT_GUIDE.md#submitting-your-bot).

## Available scripts

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

## Project architecture

```
src/
├── engine/       Pure game logic (state, battles, maps, turns), no DOM
├── renderer/     PixiJS rendering (hex grid, dice, animations)
├── ui/           Preact components (screens, HUD, overlays)
├── arena/        Bot SDK (validation, execution, tournaments, ELO, replays)
├── ai/           AI bots: picker roster (3 personas + 6 heuristics), difficulty-mode presets, hidden dev-only bots (PPO/BC, Expectimax)
├── store/        Observable GameStore (pub/sub shared state)
├── controller/   GameController (game loop orchestrator)
├── audio/        Web Audio sound manager
└── utils/        Game configuration: map-size presets
```

See [Architecture](docs/ARCHITECTURE.md) for how data flows through the system.

## AI strategies

| Bot                                 | Strategy                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Example** (`ai_example.js`)       | Simple implementation to learn from _(picker-only: Easy-mode ingredient, off competitive surfaces)_           |
| **Default** (`ai_default.js`)       | Original game's balanced AI                                                                                   |
| **Defensive** (`ai_defensive.js`)   | Prioritizes protecting vulnerable territories _(picker-only: Easy-mode ingredient, off competitive surfaces)_ |
| **Adaptive** (`ai_adaptive.js`)     | Adjusts strategy based on game state                                                                          |
| **Strategist** (`ai_strategist.js`) | Exact expected value using odds and income                                                                    |
| **Lookahead** (`ai_lookahead.js`)   | Shallow expectimax over win/loss branches                                                                     |
| **Expectimax** (`ai_expectimax.js`) | Chance-node expectimax over the exact battle distribution _(dev-only, hidden)_                                |
| **Conqueror** (`ai_conqueror.js`)   | Balanced self-play net, plays the long game (strongest head-to-head)                                          |
| **Blitz** (`ai_blitz.js`)           | Aggressive self-play net, ends games fast (most outright wins in the bot field)                               |
| **Survivor** (`ai_survivor.js`)     | Patient self-play net, outlasts rivals (best average placement in the bot field)                              |
| _PPO / BC_ (dev-only)               | Internal training nets, hidden from players (eval harness)                                                    |

> Players face a difficulty ladder (#167). **Easy** is led by Basic and Defensive (Basic is the `ai_example` stub). **Standard**, the default, puts the original game's AI in every seat. **Hard** is led by the self-play personas, the strongest roster. **Custom** lets you pick any bot per seat. The competitive surfaces (Arena, Tournament, the online leaderboard) keep a curated 7-bot roster, strongest first: Conqueror, Blitz, Survivor, Lookahead, Strategist, Adaptive, Default. Basic and Defensive appear only in the game-setup picker, Expectimax stays dev-only, and all three remain reachable by name from the CLI (`--bots`).
>
> Custom also offers **Your luck** (#179), a dice setting for your seat: **Normal** (fair dice), **Lucky**, or **Very lucky**. On the lucky rungs your seat rolls one or two extra dice and drops that many of the lowest, both attacking and defending. The Easy/Standard/Hard presets always mean fair dice, and picking one puts the rung back to Normal. To keep the Hard opponents and still win, pick **Hard**, then **Custom** (which keeps the Hard lineup), then a luck rung. The kept dice are the ones the animation shows, ties still go to the defender, and the setting is recorded in the replay. It is always off for AI-vs-AI games and on every competitive surface. See [docs/GAME_RULES.md](docs/GAME_RULES.md#luck-handicap-advantage-dice).
>
> **Strategist** and **Lookahead** are the strongest _heuristic_ built-in bots, each authored by an AI coding assistant: Strategist by Claude Opus 4.8 and Lookahead by GPT-5.5. The names describe their technique (expected-value scoring vs. shallow search) rather than the tool that wrote them.
>
> The self-play personas are the playable side of the [ML-bot initiative](docs/ml-bot/). **Expectimax** is the initiative's search-first baseline: a depth-2 chance-node search that scores the positions resulting from each attack's win/loss outcomes, weighted by exact dice odds. It has been hidden from players since the #164 roster trim but kept for the dev harness. **Conqueror**, **Blitz**, and **Survivor** are neural nets trained by self-play reinforcement learning against a league of opponents; all three beat Lookahead head-to-head. Measured in the shipped six-bot field (the #157 fresh-seed matrix), each owns a different crown: Blitz has the most outright wins (35%), Survivor the best average placement (top-2 in over half its games), and Conqueror the head-to-head title. Win-rate rank is field-dependent, so there is no single "strongest" ordering, and the picker copy says which claim each bot actually holds. All three share the same in-browser forward pass and differ in their training recipe. Conqueror plays balanced to win; trained from scratch on the richer v3 board encoding, it is the strongest net head-to-head. Blitz, fine-tuned from Conqueror on a short reward horizon, presses to finish games fast. Survivor is trained for placement and outlasts the field even from losing positions. The internal PPO and BC nets this roster grew out of stay in the repo as the dev eval-harness baseline but are hidden from players. "PPO" is an internal training name, and Conqueror shipped those weights under a friendlier name until its own v3 net replaced them. See [docs/ml-bot/](docs/ml-bot/) for the full story.

## Documentation

- [Bot Guide](docs/BOT_GUIDE.md): how to write a bot, full SDK reference
- [Game Rules](docs/GAME_RULES.md): how the game works
- [Architecture](docs/ARCHITECTURE.md): codebase organization and data flow
- [Modernization Roadmap](docs/MODERNIZATION_ROADMAP.md): project vision and phase plan
- [AI Strategies](docs/ai-strategies/README.md): detailed AI strategy patterns
- [AI Developer Guide](docs/ai/DEVELOPER_GUIDE.md): writing a custom AI (interface, game state, strategy patterns)
- [Code Style](docs/CODE_STYLE.md): coding standards
- [Testing Strategy](docs/TESTING.md): testing approach

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, conventions, and how to submit a bot.

The easiest way to contribute is to [write a bot](docs/BOT_GUIDE.md) and share it.

## License

[MIT](LICENSE)

## Acknowledgments

- Original game design by [GameDesign.jp](https://www.gamedesign.jp/games/dicewars/)
- Initial JavaScript implementation by [Chris Raff](https://github.com/chrisraff/dicewarsjs)
