# Codex Expectimax AI

The `ai_codex` bot (`src/ai/ai_codex.js`) is a competitive built-in strategy
that uses the proven `ai_claude` expected-value bot as its baseline, then allows
a shallow expectimax layer to override that move only when the searched board
value is clearly better.

## Strategy

Codex scores legal attacks with exact dice odds and a board evaluation built
around the Dice Wars economy:

- largest connected group, because that controls reinforcement income
- territory count and total dice
- cohesion, so fragmented empires are discounted
- exposed border risk from neighboring enemy dice
- leader pressure and player elimination opportunities

For each candidate attack, Codex evaluates the expected value of the win branch
and loss branch. It also adds one-ply continuation value, which lets the bot
recognize captures that create a strong same-turn follow-up attack.

## Safety Gate

The search layer is intentionally gated. `ai_claude` remains the default move.
Codex overrides it only when the searched move both clears a posture-dependent
attack threshold **and** beats Claude's move by a fixed margin — or when Claude
has no legal move at all, in which case the searched move only has to clear the
threshold. This keeps the new strategy from taking low-confidence speculative
attacks while still giving it room to exploit chain captures and tactical
board-value swings.

Use the arena sweep command to tune or compare changes:

```bash
npm run arena:sweep -- --bots Codex,Claude
```
