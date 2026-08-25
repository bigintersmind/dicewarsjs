# Example Bots

These bots demonstrate the DiceWarsJS Bot SDK at increasing levels of complexity. Each one can be copy-pasted directly into the **Arena > Custom Bot** input in the game UI.

## Bots

| Bot                                  | Lines | Strategy                                                           |
| ------------------------------------ | ----- | ------------------------------------------------------------------ |
| [random-bot.js](random-bot.js)       | ~25   | Picks a random attack each turn. Simplest possible bot.            |
| [greedy-bot.js](greedy-bot.js)       | ~25   | Always attacks the weakest enemy neighbor.                         |
| [cautious-bot.js](cautious-bot.js)   | ~30   | Only attacks with strict dice advantage. Never takes risky fights. |
| [strategic-bot.js](strategic-bot.js) | ~65   | Adapts by game phase, prioritizes territory connection.            |

## How to Use

### In the browser

1. Run `npm run dev` and open the game
2. Go to the **Arena** screen
3. Paste the contents of any bot file into the custom bot input
4. Select opponents and run a match

### From the command line

```bash
npm run arena
```

This runs all built-in bots for 100 games and prints an ELO ranking table. To test a custom bot, paste its code into the Arena screen in the browser UI.

## Write Your Own

See the [Bot Guide](../docs/BOT_GUIDE.md) for the full SDK reference, or start by copying one of these bots and modifying the strategy.

Your bot is a function body that receives a `state` parameter:

- `state.myAreas`: territories you own
- `state.allAreas`: all territories on the board
- `state.players`: all player stats
- Return `{ from, to }` to attack, or `null` to end your turn

## Submit Your Bot

- Open an issue using the **Bot Submission** template
- Or add your bot file here and open a PR
