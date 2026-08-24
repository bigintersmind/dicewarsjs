# Expected-value AI

The expected-value (EV) strategy is the approach behind the `ai_strategist` bot
(`src/ai/ai_strategist.js`, authored by Claude Opus 4.8). Instead of a
hand-ordered list of tactical rules, it
reduces every candidate move to a single number, the expected change in the
player's position, and plays the move that maximizes it. The tactical ideas
from the rest of this guide (dice advantage, choke-point cutting, border
security, reinforcement value) all reappear here, but as _terms in one scoring
function_ rather than as separate code paths.

## Core concept

Every legal attack is scored as an expectation over its two outcomes:

```
EV = P(win) * value(win) - P(loss) * cost(loss)
```

The bot evaluates this for all (attacker, defender) pairs and plays the single
highest-scoring move, or ends its turn if nothing clears a small threshold.
There is no randomness: given a board, the move is deterministic (ties break
toward the lowest area index), which also makes the bot reproducible under test.

Two things make this stronger than a rule-based bot: the probabilities are
_exact_, and the "value" of a capture is measured in the currency that actually
wins Dice Wars: reinforcement income, not raw territory count.

## Exact win probabilities

When `a` attacker dice meet `d` defender dice, all dice are rolled and the
higher sum wins, **ties going to the defender**. The probability the attacker
wins is fixed for each `(a, d)` pair and can be computed exactly by convolving
the distributions of two dice-sum totals. No simulation or sigmoid
approximation is required.

The exact 8×8 odds table is built once at module load in `diceOdds.js`;
`ai_strategist` re-exports it as `winProbability(attackerDice, defenderDice)`:

```javascript
import { winProbability } from '../../src/ai/ai_strategist.js';

winProbability(2, 1); // 0.8380...  classic 2-vs-1
winProbability(3, 3); // 0.4536...  equal dice favor the DEFENDER
winProbability(8, 1); // 1          8 dice (min sum 8) always beat 1 die (max 6)
```

The key consequence: **equal dice are a losing attack** (every `winProbability(n, n)`
is below 0.5), because ties break to the defender. A rule that says "attack when
dice are equal or greater" is systematically giving away coin-flips that are
worse than coin-flips. The EV bot never makes that mistake because the
sub-0.5 probability is baked directly into the score.

## Connectivity is the real currency

Reinforcements at end of turn equal the size of a player's **largest connected
territory group** (see [Territory connections](../basic/territory-connections.md)).
That single rule means territory count is a poor proxy for strength: ten
scattered cells generate less income than six connected ones. The EV bot scores
captures by their effect on _income_, not on the territory tally:

- **Merging your own groups.** Capturing a cell that is adjacent to two or more
  of your separate components fuses them. The bot credits the move with the
  resulting jump in your largest-group size.
- **Cutting the enemy's largest group.** Capturing an enemy articulation point
  (a [choke point](./choke-point-control.md)) can split their group in two,
  permanently lowering their reinforcement income. The bot credits the move with
  the drop in _their_ largest-group size.
- **Chokepoint awareness on defense.** Leaving the attacking cell at 1 die is
  charged as exposure, and, if that cell is one of _your_ articulation
  points, also as the income you would lose if it were then recaptured.

These connectivity terms are what separate the EV bot from a bot that merely
"attacks the weakest neighbor." They are computed with a connected-component
labeling pass over the board each turn, memoized per target cell.

## The scoring function

For an attack from a cell with `a` dice onto an enemy cell with `d` dice, let
`p = winProbability(a, d)`. The bot computes, in dice-equivalent units:

| Term               | Meaning                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| Territory value    | Base worth of holding one more cell                                                  |
| Income gain        | Increase in _my_ largest connected group from merging                                |
| Income denial      | Decrease in the _enemy's_ largest group from cutting                                 |
| Dice destroyed     | Defender dice removed from the board                                                 |
| Elimination bonus  | Large bonus if the target is a player's last territory                               |
| Gang-up bonus      | Extra value for attacking a dominant leader (anti-runaway)                           |
| Recapture discount | Gains scaled down by the chance the captured cell (now `a-1` dice) is retaken        |
| Source exposure    | Cost of leaving the attacking cell at 1 die, weighted by any income lost if it falls |

`value(win)` sums the gains and applies the recapture discount and source
exposure; `cost(loss)` is the attacker's burned dice plus that source exposure.
The final score is `p * value(win) - (1 - p) * cost(loss)`.

### Strategic posture

A leading bot should press; a trailing bot should be picky. The EV threshold a
move must clear is modulated by game state:

- **Anti-runaway.** If any player holds more than ~40% of all dice on the board,
  attacks _against_ that leader are bonused and attacks against everyone else are
  slightly penalized. This is the same gang-up dynamic described in
  [Player ranking](../basic/player-ranking.md).
- **Pressing a win.** When dominant, or ahead in a two-player endgame, the bot
  accepts mildly negative-EV attacks to keep momentum rather than stalling.
- **Playing from behind.** When weak in a crowded game, it raises the bar and
  only takes clearly profitable fights.

## Evaluating a bot

A single arena run is **deterministic** (`npm run arena` seeds from a fixed
base), so it reflects exactly one block of maps. That is reproducible but it is
_one sample_: a bot can look first or third purely on map luck. To make a claim
about which bot is actually stronger, run many independent seed blocks and look
at the distribution, not a single number.

`npm run arena:sweep` does this: it runs the arena across many non-overlapping
seed blocks and reports each bot's mean win rate and ELO with a 95% confidence
interval (Student's t). Read the intervals, not only the ranks:

- **Non-overlapping intervals** between two bots are strong evidence the
  difference is real, not noise.
- **Overlapping intervals** mean the ordering of those two bots is within sampling
  error, so do not over-read it.
- **Win% and ELO can disagree** for mid-pack bots. ELO rewards average placement
  across every game (finishing 2nd vs 5th matters), while win% only counts
  outright victories. A bot that wins slightly less often but rarely finishes
  last can out-rank a bot that wins more but busts out harder. The sweep table
  sorts by ELO because it is the more complete measure.

A useful companion is a head-to-head: `npm run arena:sweep -- --bots Strategist,Defensive`
isolates two bots, removing the multi-player gang-up dynamics that shape a
free-for-all, for a cleaner "A beats B" answer.

## Benchmark snapshot

> **Dated 2026-06-12, commit `c8d4689`.** These numbers are a point-in-time
> measurement, not a guarantee. They will change if any bot, the engine, or the
> map generator is modified. **Always regenerate rather than trust this table.**
> Reproduce it with the exact command below.

```
npm run arena:sweep -- --runs 50 --games 200
```

50 runs × 200 games = 10,000 games, five built-in bots, free-for-all:

| Rank | Bot        | Win% (95% CI) | ELO (95% CI) |
| ---- | ---------- | ------------- | ------------ |
| 1    | Strategist | 33.7 ± 0.9    | 1280 ± 9     |
| 2    | Defensive  | 23.3 ± 0.8    | 1251 ± 10    |
| 3    | Example    | 13.2 ± 0.7    | 1183 ± 12    |
| 4    | Adaptive   | 13.7 ± 0.6    | 1160 ± 10    |
| 5    | Default    | 10.9 ± 0.6    | 1126 ± 11    |

Fair-share win rate with five bots is 20.0%. Observations at the time of
measurement:

- **Strategist leads decisively.** Its win-rate interval `[32.8, 34.6]` does not
  overlap the runner-up's `[22.5, 24.1]`, a ~9-point gap well outside sampling
  error. It wins at roughly 1.7× fair share.
- **Example vs Adaptive is the metric-disagreement case.** Their win-rate
  intervals overlap (a statistical tie on wins), but their ELO intervals are
  cleanly separated with Example ahead: it finishes higher on average even
  though it does not win outright more often. This is exactly the win%/ELO
  divergence described above.
- Head-to-head, Strategist beats Defensive in roughly 71% of two-player games
  (`npm run arena:sweep -- --bots Strategist,Defensive`).

## When to use this approach

The EV model is worth the extra complexity when:

1. You want a single, tunable objective rather than a brittle priority list of
   rules.
2. Reinforcement/connectivity effects matter, which is the case on most real maps.
3. You need deterministic, testable behavior (no `Math.random` in the decision).

It is heavier than the basic strategies: it does connected-component passes and
scores every legal move each turn. For a teaching example or a deliberately
weak opponent, the simpler bots in [Basic strategies](../README.md#basic-strategies)
are a better starting point.

## Combining with other strategies

The EV function already folds in most of this guide as weighted terms:

1. [Dice advantage analysis](../basic/dice-advantage.md) becomes the exact `P(win)` factor.
2. [Territory connections](../basic/territory-connections.md) becomes the income-gain term.
3. [Choke point control](./choke-point-control.md) becomes the enemy income-denial term.
4. [Border security](./border-security.md) becomes the source-exposure cost.
5. [Player ranking](../basic/player-ranking.md) becomes the anti-runaway posture.

Tuning the relative weights between these terms is where most of the bot's
behavior lives; `arena:sweep` is the tool for telling whether a weight change is
a real improvement or just seed noise.
