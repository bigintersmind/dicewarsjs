# Reinforcement optimization strategy

Reinforcement dice arrive at the end of every turn, and you never choose where they land. What you do choose is how many you earn and how much of your board can hold them. Both are decided by the attacks you make.

## Core concept

Income is the size of your largest connected territory group, so every attack is also an income decision. This strategy covers:

1. How the engine actually grants and places reinforcements
2. Measuring the income of any board, so you can score what an attack would do to it
3. Preferring the captures that extend the group you already have
4. Keeping room on the board for the dice you earn

## How the engine grants reinforcements

At the end of a player's turn, `calculateReinforcements` and `distributeReinforcements` in `src/engine/TurnManager.js` do the following:

1. Income equals the number of territories in your largest connected group. Ten territories in one block earns 10 dice. The same ten split into a block of 6 and a block of 4 earns 6.
2. Those dice are added to your stock, which is capped at 64.
3. The engine places them one at a time, each on a territory picked at random from the ones you own that are below the 8-dice cap. A territory that reaches 8 stops being eligible.
4. If every territory of yours hits 8 before the stock runs out, the remainder stays in stock for later turns.

Nothing in that sequence asks the bot for a preference. There is no deployment call, no priority list, and no way to steer a die to a particular territory. The two levers are income in step 1 and how much room your board has to absorb it in step 3.

The legacy game view exposes the current income as `game.player[pn].area_tc` and the carried-over reserve as `game.player[pn].stock`. Note that `game.set_area_tc()` is a no-op on the modern adapter: `area_tc` is snapshotted when the view is built, so it does not change as you simulate moves. Compute the value yourself when you need it for a hypothetical board.

## Implementation approach

### 1. Income for a hypothetical board

```javascript
// Size of the player's largest connected group, which is exactly their income
function largestGroupSize(game, player) {
  const seen = new Set();
  let largest = 0;

  for (let start = 1; start < game.AREA_MAX; start++) {
    if (game.adat[start].size === 0) continue;
    if (game.adat[start].arm !== player) continue;
    if (seen.has(start)) continue;

    // Flood fill the group containing this territory
    let size = 0;
    const queue = [start];
    seen.add(start);

    while (queue.length > 0) {
      const current = queue.pop();
      size++;

      for (let i = 1; i < game.AREA_MAX; i++) {
        if (seen.has(i)) continue;
        if (game.adat[i].size === 0) continue;
        if (game.adat[i].arm !== player) continue;
        if (!game.adat[current].join[i]) continue;

        seen.add(i);
        queue.push(i);
      }
    }

    if (size > largest) largest = size;
  }

  return largest;
}
```

### 2. Scoring an attack by its income impact

```javascript
function evaluateAttackWithIncomeImpact(game, from, to) {
  const player = game.get_pn();
  const currentIncome = largestGroupSize(game, player);

  // Simulate a successful attack: the target changes hands, the attacker
  // keeps one die and the rest move onto the captured territory
  const originalToOwner = game.adat[to].arm;
  const originalToDice = game.adat[to].dice;
  const originalFromDice = game.adat[from].dice;

  game.adat[to].arm = player;
  game.adat[to].dice = originalFromDice - 1;
  game.adat[from].dice = 1;

  const newIncome = largestGroupSize(game, player);

  // Restore the board before returning
  game.adat[to].arm = originalToOwner;
  game.adat[to].dice = originalToDice;
  game.adat[from].dice = originalFromDice;

  return {
    from: from,
    to: to,
    diceAdvantage: originalFromDice - originalToDice,
    incomeGain: newIncome - currentIncome,
    score: originalFromDice - originalToDice + (newIncome - currentIncome) * 2,
  };
}
```

Editing the live view and putting it back works, but it is easy to get wrong once the function grows. Copy the fields you need instead if the restore starts looking fragile.

### 3. Finding the captures that connect

Every capture adds a territory. Only some of them add income, and a capture that bridges two groups you already own adds a lot of it:

```javascript
function findConsolidationAttacks(game) {
  const player = game.get_pn();
  const currentIncome = largestGroupSize(game, player);
  const targets = [];

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;
    if (game.adat[i].dice <= 1) continue;

    for (let j = 1; j < game.AREA_MAX; j++) {
      if (game.adat[j].size === 0) continue;
      if (game.adat[j].arm === player) continue;
      if (!game.adat[i].join[j]) continue;
      if (game.adat[j].dice >= game.adat[i].dice) continue;

      // Only ownership matters for connectivity, so only `arm` has to move
      const originalOwner = game.adat[j].arm;
      game.adat[j].arm = player;
      const incomeGain = largestGroupSize(game, player) - currentIncome;
      game.adat[j].arm = originalOwner;

      targets.push({
        from: i,
        to: j,
        incomeGain: incomeGain,
        diceAdvantage: game.adat[i].dice - game.adat[j].dice,
      });
    }
  }

  // Prefer income, break ties on how safe the attack is
  targets.sort((a, b) => b.incomeGain - a.incomeGain || b.diceAdvantage - a.diceAdvantage);

  return targets;
}
```

### 4. Leaving room for the dice you earn

Income you cannot place sits in stock instead of on the map, where it defends nothing:

```javascript
// How many dice your territories can still absorb before they all hit the cap
function absorptionCapacity(game, player) {
  let room = 0;

  for (let i = 1; i < game.AREA_MAX; i++) {
    if (game.adat[i].size === 0) continue;
    if (game.adat[i].arm !== player) continue;
    room += 8 - game.adat[i].dice;
  }

  return room;
}
```

When capacity is below your stock plus this turn's income, some of what you earn idles. Attacking out of a territory that is already at 8 dice fixes that: win or lose, the attacker drops to 1, which frees at least seven slots for next turn's placement. It is the one situation where a marginal attack is worth making for reasons that have nothing to do with the target.

## Strategic considerations

### 1. Your own attacks never cost you income

An attack changes ownership only when it succeeds, and only for the territory it captures. A failed attack leaves both territories with their owners and simply drops the attacker to 1 die (see `applyAction` in `src/engine/StateManager.js`). So your income never falls because of a move you made. It falls when an opponent takes a territory that was holding your largest group together, which is what makes those linking territories worth defending and worth not stripping to 1 die on a speculative attack.

### 2. Which capture, not whether to capture

The real trade is between captures. One that extends your largest group pays income every turn from here on. One that lands off to the side adds a territory and a fresh border to hold, and pays nothing until it connects:

```javascript
function pickIncomeAwareAttack(game) {
  const candidates = findConsolidationAttacks(game);
  if (candidates.length === 0) return null;

  // A safe attack that adds nothing to the group is worth less than a
  // slightly riskier one that grows it, but not at any price: every
  // candidate already has a one-die edge, so ask for two before paying for income
  const best = candidates.find(c => c.incomeGain > 0 && c.diceAdvantage >= 2);

  return best || candidates[0];
}
```

## When to use

1. In the mid to late game, once territory patterns are established
2. When your territories are fragmented and need consolidation
3. When your board is close to the dice cap and income is going to waste
4. When planning multi-turn strategies

## Combining with other strategies

Reinforcement optimization works well with:

1. **Territory connections** - The largest connected group is what sets your income
2. **Border security** - Names the territories whose loss would cut that group
3. **Choke point control** - Finds the single territories a whole group hangs on
4. **Player ranking** - Tells you whose income is worth attacking first
