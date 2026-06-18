# Lookahead Expectimax AI

The `ai_lookahead` bot (`src/ai/ai_lookahead.js`) is a competitive built-in
strategy that scores every legal attack with a shallow expectimax search over
its win and loss branches and plays the highest-scoring move. It is a standalone
strategy — it shares only the exact dice-odds table with the other built-in
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

## Move Selection

Lookahead plays the single highest-scoring searched move, provided that move
clears a posture-dependent attack threshold; otherwise it ends its turn. The
threshold adapts to game state — it presses (accepting mildly negative-value
attacks) when dominant or ahead in a two-player endgame, and demands clearly
profitable fights when weak in a crowded game. A low-odds penalty discourages
speculative attacks well below even money. Move selection is fully deterministic:
ties break toward the lowest `(from, to)` area indices.

## Relationship to Strategist

Lookahead and [Strategist](./expected-value-ai.md) both build on exact dice odds
and connectivity economics, but they decide differently: Strategist scores each
move by a one-shot expected-value formula, while Lookahead runs a shallow
expectimax search over the resulting board values (including a one-ply
continuation). They are independent bots — Lookahead does **not** call Strategist
or fall back to it.

Use the arena sweep command to tune or compare changes:

```bash
npm run arena:sweep -- --bots Lookahead,Strategist
```
