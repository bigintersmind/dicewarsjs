# Bot Guide

This guide covers everything you need to write a DiceWarsJS bot. A bot is a single JavaScript function that looks at the board and decides what to attack.

## Quick Start

A bot is a function that takes a `state` and returns a move:

```javascript
// Attack the weakest neighbor, or end the turn
const myAreas = state.myAreas.filter(a => a.dice > 1 && a.isBorder);

for (const area of myAreas) {
  const enemies = area.neighbors
    .map(id => state.allAreas.find(a => a.id === id))
    .filter(a => a && a.owner !== state.myPlayer);

  const weakest = enemies.sort((a, b) => a.dice - b.dice)[0];
  if (weakest && area.dice > weakest.dice) {
    return { from: area.id, to: weakest.id };
  }
}

return null;
```

- Return `{ from, to }` to attack: `from` is your territory ID, `to` is the enemy's
- Return `null` to end your turn
- Your function is called repeatedly until you return `null` or make an invalid move

## How to Test Your Bot

Write your bot as a file (see the [`bots/`](../bots/) examples) and test it from the command line:

```bash
npm run new-bot -- my                # scaffold bots/my-bot.js from a template
npm run validate-bot -- bots/my-bot.js   # check syntax + runtime
npm run benchmark-bot -- bots/my-bot.js  # win rate, ELO, placement
npm run arena                        # run all built-in bots head-to-head
```

The in-game **Arena** and **Tournament** screens let you watch the built-in bots compete. To see your own bot ranked against them, submit it via GitHub (see [Submitting Your Bot](#submitting-your-bot)) — it then competes in the daily online tournament.

## BotState Reference

Your function receives a `state` object with these fields:

### Top-level Fields

| Field           | Type                         | Description                          |
| --------------- | ---------------------------- | ------------------------------------ |
| `myPlayer`      | `number`                     | Your player ID                       |
| `turnNumber`    | `number`                     | Current turn number                  |
| `totalPlayers`  | `number`                     | Total players (including eliminated) |
| `activePlayers` | `number`                     | Non-eliminated player count          |
| `gamePhase`     | `'early' \| 'mid' \| 'late'` | Estimated game phase                 |
| `myAreas`       | `BotArea[]`                  | Territories you own                  |
| `allAreas`      | `BotArea[]`                  | All territories on the board         |
| `players`       | `BotPlayer[]`                | All player stats                     |

### BotArea

Each territory in `myAreas` and `allAreas`:

| Field       | Type       | Description                                |
| ----------- | ---------- | ------------------------------------------ |
| `id`        | `number`   | Territory ID (1-based)                     |
| `owner`     | `number`   | Player ID who owns it                      |
| `dice`      | `number`   | Current dice count (1-8)                   |
| `neighbors` | `number[]` | IDs of adjacent territories                |
| `isBorder`  | `boolean`  | True if any neighbor has a different owner |

### BotPlayer

Each player in `players`:

| Field                  | Type      | Description                                                                               |
| ---------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `id`                   | `number`  | Player ID (0-based)                                                                       |
| `territories`          | `number`  | Number of territories owned                                                               |
| `totalDice`            | `number`  | Total dice across all territories                                                         |
| `connectedTerritories` | `number`  | Size of largest connected group                                                           |
| `reinforcements`       | `number`  | Dice in reserve stock                                                                     |
| `eliminated`           | `boolean` | Whether this player is eliminated                                                         |
| `turnsUntilActs`       | `number`  | Turn-advances until this player acts (0 = you; eliminated players are 0 — check the flag) |

## Rules Your Bot Must Follow

1. **Attack from your territory**: `from` must be a territory you own
2. **Have enough dice**: The attacking territory must have more than 1 die
3. **Attack an enemy**: `to` must be owned by a different player
4. **Attack a neighbor**: `from` and `to` must be adjacent
5. **Return the right shape**: `{ from: number, to: number }` or `null`

Invalid moves end your turn immediately. Throwing an exception also ends your turn.

## Game Mechanics Recap

Understanding these mechanics helps you write a better bot:

- **Attacking**: You roll your dice, defender rolls theirs. If your total is strictly higher, you win. Ties go to the defender.
- **Winning an attack**: The captured territory receives your dice count minus 1. Your source territory is left with exactly 1 die.
- **Losing an attack**: Your source territory drops to 1 die. Defender keeps all their dice.
- **Reinforcements**: At the end of your turn, you receive dice equal to your **largest connected group** of territories. These are placed randomly on territories with fewer than 8 dice.
- **Stock**: Excess reinforcements (when all your territories have 8 dice) are saved in stock (max 64) for future turns.
- **Elimination**: A player with 0 territories is eliminated.
- **Winning**: Last player standing wins.

## Strategy Tips

### Connections are everything

Your reinforcements equal your largest connected group. A player with 10 scattered territories might only get 3 reinforcements, while a player with 8 connected territories gets 8. Prioritize attacks that connect your territory groups.

### Border awareness

Use `area.isBorder` to identify territories exposed to enemies. Attacking from interior territories doesn't help — focus on border territories.

### Dice advantage

The probability of winning scales with your dice advantage:

- 4 vs 2: ~94% win rate
- 3 vs 3: ~45% win rate (ties lose)
- 2 vs 4: ~4% win rate

Don't attack unless you have more dice than the defender, or you're desperate.

### Game phase

Use `state.gamePhase` to adapt your strategy:

- **Early**: Expand aggressively to claim territory
- **Mid**: Consolidate, connect groups, build up dice
- **Late**: Be cautious — one bad attack can cost the game

### Know your opponents

Check `state.players` to see who's strong and who's weak. Avoid attacking the strongest player when weaker targets are available.

## Example Bots

See the [`bots/`](../bots/) directory for complete examples at different complexity levels:

- **random-bot.js** — attacks randomly
- **greedy-bot.js** — always attacks the weakest neighbor
- **cautious-bot.js** — only attacks with dice advantage
- **strategic-bot.js** — evaluates position and adapts by game phase

## Submitting Your Bot

### Community Arena (recommended)

Submit your bot to the online arena where it competes in daily automated tournaments with ELO rankings:

1. Fork the repo and create a directory: `community-bots/<your-github-username>/`
2. Add your bot file (e.g., `my-bot.js`) — same bare function body format as the examples in `bots/`
3. Add a `my-bot.meta.json` with `name`, `author`, and `description` fields
4. Register it in `community-bots/registry.json` (see [CONTRIBUTING.md](../CONTRIBUTING.md) for the full format)
5. Open a PR — CI validates your bot automatically

Your bot will be included in the daily tournament once merged. Check the live leaderboard on the [game site](https://bigintersmind.github.io/dicewarsjs/).

Once merged, your bot is also **playable in-game**: on the title screen, expand
**Customize players** and pick it from the **Community** group of any opponent
slot (duplicates allowed). It runs through the exact same `BotState` it sees in
the arena, so its in-game behavior matches its tournament behavior.

### Other ways

- **Issue**: Open an issue using the [Bot Submission](https://github.com/bigintersmind/dicewarsjs/issues/new?template=bot_submission.md) template
- **Pull Request**: Add your bot file to the `bots/` directory and open a PR
