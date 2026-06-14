# DiceWarsJS AI Strategy Guide

This documentation provides a detailed guide on creating effective AI for DiceWarsJS. The strategies outlined here can be mixed, matched, and extended to create your own custom AI.

## Table of Contents

1. [Game Mechanics Overview](#game-mechanics-overview)
2. [Basic Strategies](#basic-strategies)
3. [Advanced Strategies](#advanced-strategies)
4. [Strategy Combinations](#strategy-combinations)
5. [Implementation Guidelines](#implementation-guidelines)

## Game Mechanics Overview

Before diving into strategies, it's important to understand the core game mechanics:

- **Territories and Ownership**: The map is divided into territories, each owned by a player and containing 1-8 dice.
- **Adjacency**: Territories can only attack adjacent territories.
- **Attack Mechanics**: When attacking, all dice from both territories are rolled. The higher total wins, with ties going to the defender.
- **Reinforcements**: Players receive reinforcement dice at the end of their turn based on their largest connected territory group.
- **Goal**: Eliminate all opponents by capturing all their territories.

## Basic Strategies

The most fundamental tactics for any DiceWars AI:

- [Dice Advantage Analysis](./basic/dice-advantage.md) - Attacking only when you have more dice than your opponent
- [Random Selection](./basic/random-selection.md) - Choosing randomly from valid moves
- [Player Ranking](./basic/player-ranking.md) - Identifying dominant players and focusing efforts
- [Territory Connections](./basic/territory-connections.md) - Managing connected territory groups for reinforcements

## Advanced Strategies

More sophisticated approaches to improve AI performance:

- [Neighbor Analysis](./advanced/neighbor-analysis.md) - Evaluating the risk of counterattacks
- [Border Security](./advanced/border-security.md) - Protecting vulnerable territories
- [Choke Point Control](./advanced/choke-point-control.md) - Identifying and controlling strategically valuable territories
- [Reinforcement Optimization](./advanced/reinforcement-optimization.md) - Maximizing the value of reinforcement dice
- [Expected-Value AI](./advanced/expected-value-ai.md) - Scoring every move by expected income/risk, plus how to benchmark bots with confidence intervals
- [Codex Expectimax AI](./advanced/codex-expectimax-ai.md) - Using a proven EV baseline with high-confidence shallow-search overrides

## Strategy Combinations

Examples of how to combine various strategies:

- [Balanced Approach](./combinations/balanced-approach.md) - Mixing offensive and defensive tactics
- [Adaptive Strategy](./combinations/adaptive-strategy.md) - Adjusting behavior based on game state
- [Specialized Focus](./combinations/specialized-focus.md) - Targeting specific weaknesses or opportunities

## Implementation Guidelines

Practical advice for implementing your own AI:

- [AI Structure](./implementation/ai-structure.md) - How to organize your AI code
- [Performance Considerations](./implementation/performance.md) - Ensuring your AI runs efficiently
- [Testing and Tuning](./implementation/testing.md) - Methods for evaluating and improving your AI
