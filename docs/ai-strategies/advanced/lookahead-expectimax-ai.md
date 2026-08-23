# Lookahead expectimax AI

The `ai_lookahead` bot (`src/ai/ai_lookahead.js`) is a competitive built-in
strategy that scores every legal attack with a shallow expectimax search over
its win and loss branches and plays the highest-scoring move. It is a standalone
strategy: it shares only the exact dice-odds table with the other built-in
bots and makes its own decision end to end. (Authored by GPT-5.5.)

## Strategy

Lookahead scores legal attacks with exact dice odds and a board evaluation built
around the Dice Wars economy:

- largest connected group, because that controls reinforcement income
- territory count and total dice
- cohesion, so fragmented empires are discounted
- exposed border risk from neighboring enemy dice
- leader pressure and player elimination opportunities

For each candidate attack, Lookahead evaluates the expected value of the win
branch and the loss branch. It also adds one-ply continuation value, which lets
the bot recognize captures that create a strong same-turn follow-up attack. The
search is intentionally shallow: because the AI is called again after every
attack, one-ply continuation is enough to value chain captures without making
arena runs expensive.

## Move selection

Lookahead plays the single highest-scoring searched move, provided that move
clears a posture-dependent attack threshold; otherwise it ends its turn.

The weights are tuned (via `scripts/arena-sweep.mjs`) to make the bot **patient**.
An unconstrained one-ply searcher over-extends in a crowd. It grabs locally
attractive captures that leave it exposed, then gets dismantled. Strong safety
terms counteract that: a high border-threat weight, a steep penalty on attacks
below a minimum-odds floor (a soft discouragement, not a hard cutoff), and a
steep base attack threshold mean Lookahead commits dice only to high-confidence,
low-exposure captures and otherwise waits.

The attack threshold follows a **U-shaped posture**: lowest when winning
(press to close the game out, accepting even slightly negative moves), still low
when losing badly (take near-even fights to claw back), and highest in a
balanced game, the common case, where the bot stays patient rather than
gambling a level position. Move selection is fully deterministic: ties break
toward the lowest `(from, to)` area indices.

The per-player tables are sized to the actual number of players each turn, so
the bot is correct in larger games such as the 9-bot online tournament (a fixed
8-player assumption would drop a player from its census and crash on that
player's turn).

## Relationship to Strategist

Lookahead and [Strategist](./expected-value-ai.md) both build on exact dice odds
and connectivity economics, but they decide differently: Strategist scores each
move by a one-shot expected-value formula, while Lookahead runs a shallow
expectimax search over the resulting board values (including a one-ply
continuation). They are independent bots; Lookahead does **not** call Strategist
or fall back to it.

Use the arena sweep command to tune or compare changes:

```bash
npm run arena:sweep -- --bots Lookahead,Strategist
```
