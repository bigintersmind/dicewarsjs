# DiceWarsJS Game Rules

DiceWarsJS is a turn-based territory conquest game played on a hexagonal grid. Players roll dice to attack adjacent territories. The last player standing wins.

## Setup

- The board is a hexagonal grid divided into **territories** (default: up to 32)
- Each territory is assigned to a random player
- Each territory starts with a random number of dice (1-8)
- There are **7 players** by default (configurable from 2-8)
- Turn order is randomized at the start of each game

## Turn Structure

Each turn has two phases:

### 1. Attack Phase

On your turn, you may make as many attacks as you want. To attack:

- Choose one of **your** territories with **more than 1 die**
- Choose an **adjacent enemy** territory
- Both sides roll their dice and sum the results
- **Attacker wins** if their total is **strictly greater** than the defender's total (ties go to the defender)

If the attacker wins:

- The defending territory is captured (changes ownership)
- The captured territory receives the attacker's dice count minus 1. The source territory is left with exactly 1 die.

If the attacker loses:

- The attacking territory is reduced to **1 die**
- The defending territory keeps all its dice

You may attack multiple times per turn with different territories. When you're done attacking (or have no valid attacks), your turn ends.

### 2. Reinforcement Phase

After your attack phase ends, you receive reinforcement dice equal to the size of your **largest connected group** of territories. For example, if you own 10 territories but only 6 of them form a connected chain, you receive 6 reinforcement dice.

Reinforcements are distributed **randomly** across your territories that have fewer than 8 dice (the maximum). Any excess reinforcements that can't be placed are saved in a **stock** (up to 64) and carried over to future turns.

## Winning

The game ends when only one player has territories remaining. That player wins.

If no player has been eliminated after 500 turns (the default limit, configurable), the game is declared a **stalemate**.

## Key Numbers

| Constant                | Value         |
| ----------------------- | ------------- |
| Max dice per territory  | 8             |
| Max reinforcement stock | 64            |
| Default player count    | 7             |
| Default max territories | 32            |
| Default grid size       | 28 x 32 cells |
| Stalemate turn limit    | 500           |

## Strategy Tips

- **Connected territories matter**: Your reinforcements equal your largest connected group, so keeping territories connected is more valuable than owning isolated ones.
- **Dice advantage**: Attacking with more dice than the defender gives you better odds, but it's never guaranteed.
- **Border defense**: Territories on your border are vulnerable. High-dice border territories deter attacks.
- **Don't overextend**: Attacking leaves your source territory with 1 die, making it an easy target.
- **Timing**: Sometimes it's better to end your turn early and collect reinforcements than to make a risky attack.
