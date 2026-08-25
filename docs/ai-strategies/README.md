# DiceWarsJS AI strategy guide

A guide to writing your own AI for DiceWarsJS. The strategies here can be mixed, matched, and extended into a custom bot.

## Table of contents

1. [Game mechanics overview](#game-mechanics-overview)
2. [Basic strategies](#basic-strategies)
3. [Advanced strategies](#advanced-strategies)
4. [Strategy combinations](#strategy-combinations)
5. [Implementation guidelines](#implementation-guidelines)

## Game mechanics overview

The rules every strategy builds on:

- **Territories and ownership**: The map is divided into territories, each owned by a player and containing 1-8 dice.
- **Adjacency**: Territories can only attack adjacent territories.
- **Attack mechanics**: When attacking, all dice from both territories are rolled. The higher total wins, with ties going to the defender.
- **Reinforcements**: Players receive reinforcement dice at the end of their turn equal to the size of their largest connected territory group. The dice are placed one at a time on randomly chosen territories of theirs that are below the 8-dice cap, so nobody chooses where reinforcements land.
- **Goal**: Eliminate all opponents by capturing all their territories.

## Basic strategies

Start here:

- [Dice advantage analysis](./basic/dice-advantage.md) - Attacking only when you have more dice than your opponent
- [Random selection](./basic/random-selection.md) - Choosing randomly from valid moves
- [Player ranking](./basic/player-ranking.md) - Identifying dominant players and focusing efforts
- [Territory connections](./basic/territory-connections.md) - Managing connected territory groups for reinforcements

## Advanced strategies

Techniques that build on the basics:

- [Neighbor analysis](./advanced/neighbor-analysis.md) - Evaluating the risk of counterattacks
- [Border security](./advanced/border-security.md) - Protecting vulnerable territories
- [Choke point control](./advanced/choke-point-control.md) - Identifying and controlling map bottlenecks
- [Reinforcement optimization](./advanced/reinforcement-optimization.md) - Growing the income that decides how many dice you earn, since you cannot choose where they land
- [Expected-value AI](./advanced/expected-value-ai.md) - Scoring every move by expected income/risk, plus how to benchmark bots with confidence intervals
- [Lookahead expectimax AI](./advanced/lookahead-expectimax-ai.md) - Standalone shallow expectimax over win/loss branches with board-value evaluation

## Strategy combinations

Ways to combine the pieces:

- [Balanced approach](./combinations/balanced-approach.md) - Mixing offensive and defensive tactics
- [Adaptive strategy](./combinations/adaptive-strategy.md) - Adjusting behavior based on game state
- [Specialized focus](./combinations/specialized-focus.md) - Committing to one plan, such as turtling or hunting the weakest player

## Implementation guidelines

Practical advice for writing your own bot:

- [AI structure](./implementation/ai-structure.md) - How to organize your AI code
- [Performance considerations](./implementation/performance.md) - Keeping AI turns fast
- [Testing and tuning](./implementation/testing.md) - Evaluating and improving your AI
