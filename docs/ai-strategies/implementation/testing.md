# Testing and tuning

How to test a DiceWars bot and improve it systematically.

The code below runs against the live engine, and the blocks build on each other in order: each one imports only what it adds and reuses the helpers defined above it. Import paths are written as they look from a file in `scripts/` or `tests/`, so add one `../` per extra directory level. Every bot in this series uses the legacy contract, a function that reads a mutable `game` view, writes `game.area_from` and `game.area_to`, and returns `0` to end its turn. `simulateGame` takes those directly, and `runAI` accepts either contract. For the modern `state => { from, to } | null` contract, see [the bot guide](../../BOT_GUIDE.md).

## Testing challenges

Testing a game AI is harder than testing ordinary code:

1. **Randomness** - Dice rolls make exact test cases difficult
2. **Emergent complexity** - Simple rules produce behavior you didn't write
3. **Game-long effects** - An early decision may not show its cost until the endgame
4. **Situational strength** - A bot can dominate one map shape and collapse on another
5. **Multi-agent dynamics** - Behavior changes with the mix of opponents

## Testing approaches

### 1. AI vs. AI tournaments

The single most informative test is letting your bot play against other implementations, many times. `simulateGame` plays a whole game headlessly: hand it a config, one AI per seat, and a seed.

```javascript
import { simulateGame } from '../src/engine/GameRunner.js';
import { ai_default } from '../src/ai/ai_default.js';
import { ai_defensive } from '../src/ai/ai_defensive.js';
import { ai_example } from '../src/ai/ai_example.js';

// A small board keeps a game in the low milliseconds, so a 50-game run is instant.
const MATCH_CONFIG = { mapWidth: 20, mapHeight: 20, maxAreas: 20 };
const BASE_SEED = 20260825;

function runTournament(aiList, numGames = 50, baseSeed = BASE_SEED) {
  const wins = new Array(aiList.length).fill(0);
  const territories = new Array(aiList.length).fill(0);
  let draws = 0;

  for (let i = 0; i < numGames; i++) {
    /*
     * aiAssignments is indexed by player id, so aiList[p] plays seat p.
     * One seed per game, so the whole run repeats exactly when you rerun it.
     */
    const result = simulateGame({
      config: { ...MATCH_CONFIG, playerCount: aiList.length },
      aiAssignments: aiList,
      seed: baseSeed + i,
      maxTurns: 300,
    });

    // completed is false when the turn cap hit first: a draw, not a loss for anyone.
    if (result.completed && result.winner !== null) wins[result.winner]++;
    else draws++;

    for (let p = 0; p < aiList.length; p++) {
      territories[p] += result.finalState.players[p].territoryCount;
    }
  }

  return {
    draws,
    standings: aiList.map((ai, p) => ({
      seat: p,
      name: ai.name,
      wins: wins[p],
      winRate: wins[p] / numGames,
      avgTerritories: territories[p] / numGames,
    })),
  };
}

const tournament = runTournament([ai_default, ai_defensive, ai_example], 50);
for (const entry of tournament.standings) {
  console.log(
    `seat ${entry.seat} ${entry.name}: ${entry.wins} wins ` +
      `(${(entry.winRate * 100).toFixed(1)}%), avg territories ${entry.avgTerritories.toFixed(1)}`
  );
}
console.log(`draws: ${tournament.draws}`);
```

Two things this loop does not do. It never rotates seats, so whatever advantage a seat has on a given map lands on the same bot every game. And it reports raw win counts with no measure of how much of the gap is noise.

The repo's arena tools measure the noise (`arena:sweep` reports confidence intervals across seeds), but they share the fixed seating: `runMatch` maps `bots[i]` to seat `i`, in every game. For a seat-fair measurement, every bot in every seat on every map, `npm run arena:ml` and `npm run ppo:gate` replay each seed through every rotation of the field.

```bash
npm run arena                            # deterministic ELO ranking across the player-visible roster
npm run arena:sweep                      # multi-seed sweep: win% and ELO with 95% confidence intervals
npm run benchmark-bot -- bots/my-bot.js  # one bot: timing, win rate, ELO, placement
```

Use those to decide whether a bot is stronger. Use the loop above to understand what they are doing. [The bot guide](../../BOT_GUIDE.md) covers the command-line workflow for a community bot end to end, and [the testing guide](../../TESTING.md) covers the project's test suite.

### 2. Specific scenario testing

Fixed boards answer questions a win rate cannot: does the bot take a free capture, does it end its turn when it has no legal attack. `createGame` builds a board from a seed, and `runAI` asks a bot for a single decision on it without playing the game out.

```javascript
import { createGame } from '../src/engine/GameRunner.js';
import { runAI } from '../src/engine/AIAdapter.js';
import { getValidMoves } from '../src/engine/StateManager.js';

/*
 * Engine state is plain data, so structuredClone gives a safe scratch copy.
 * There is no engine helper for "set the dice on this territory": the engine only
 * recomputes per-player totals inside applyAction, so a hand-patched board has to
 * keep players[].diceCount in step itself or a bot reads a stale total.
 */
function setDice(state, areaId, dice) {
  const patched = structuredClone(state);
  const area = patched.areas[areaId];
  if (area.size === 0) throw new Error(`area ${areaId} is not on the board`);
  if (dice < 1 || dice > 8) throw new Error(`dice must be 1 to 8, got ${dice}`);
  patched.players[area.owner].diceCount += dice - area.dice;
  area.dice = dice;
  return patched;
}

// A board where the acting player has exactly one launchpad and one soft target.
function freeCaptureScenario(seed = 4242) {
  let state = createGame({ ...MATCH_CONFIG, playerCount: 3, seed });
  const me = state.turnOrder[state.currentPlayerIndex];

  const moves = getValidMoves(state);
  if (moves.length === 0) throw new Error(`seed ${seed}: acting player has no legal attack`);
  const { from, to } = moves[0];

  // Every other stack down to one die, so `from` is the only territory that can attack.
  for (const area of state.areas) {
    if (area.owner === me && area.id !== from) state = setDice(state, area.id, 1);
  }
  state = setDice(state, from, 8);
  state = setDice(state, to, 1);
  /*
   * Every other enemy neighbor of `from` maxed out, so 8 against 1 is the best move by
   * dice odds. It is not the only legal one: 8 against 8 stays legal, and a bot that ranks
   * targets by connectivity rather than odds may prefer it. The three built-in bots agree on
   * seed 4242; on other seeds they often do not, which is what section 4 below is for.
   */
  for (const id of state.areas[from].neighborAreaIds) {
    if (id !== to && state.areas[id].owner !== me) state = setDice(state, id, 8);
  }

  return { state, me, from, to };
}

function testTakesFreeCapture(aiFunction) {
  const { state, from, to } = freeCaptureScenario();
  const move = runAI(state, aiFunction);

  if (!move) return `FAIL: ${aiFunction.name} passed on an 8 against 1 capture`;
  if (move.from !== from || move.to !== to) {
    return `FAIL: ${aiFunction.name} attacked ${move.from} to ${move.to}, expected ${from} to ${to}`;
  }
  return `PASS: ${aiFunction.name} took the free capture`;
}

function testEndsTurnWithNoAttacks(aiFunction) {
  let { state, me } = freeCaptureScenario();
  for (const area of state.areas) {
    if (area.owner === me) state = setDice(state, area.id, 1);
  }

  const move = runAI(state, aiFunction);
  return move === null
    ? `PASS: ${aiFunction.name} ended its turn`
    : `FAIL: ${aiFunction.name} proposed ${move.from} to ${move.to} with no legal attack`;
}

for (const ai of [ai_default, ai_defensive, ai_example]) {
  console.log(testTakesFreeCapture(ai));
  console.log(testEndsTurnWithNoAttacks(ai));
}
```

`runAI` returns `{ from, to }` or `null` for "end turn", whichever calling convention the bot uses, so a scenario test reads the same for a legacy AI and a modern bot. It builds a fresh game view per call and never mutates the state you pass in, which is why the same `state` can be reused across tests.

`testTakesFreeCapture` is pinned to the seed-4242 board. A scenario test fixes one board and one expected answer, and it is only as general as that board: change the seed and two of the three built-in bots pick an 8-against-8 into a better-connected target on many boards, and `ai_default` sometimes declines the capture outright rather than empty a territory that holds its group together. `testEndsTurnWithNoAttacks` holds across seeds because it tests a rule, not a preference.

Two rules keep hand-patched boards honest. Change as little as possible, because every field you set is a fact you now have to keep true. And remember which derived values the engine will not recompute for you: `players[].territoryCount`, `diceCount`, and `largestGroup` are snapshots, refreshed only inside `applyAction`.

### 3. Unit testing strategy components

Test the individual pieces of your AI in isolation, and check them against the engine rather than against your own reading of the rules.

```javascript
import assert from 'node:assert/strict';
import { createLegacyGameView } from '../src/engine/AIAdapter.js';

// The helper under test. In a real bot it lives in your AI file and is imported here.
function generateAttacks(view, pn) {
  const attacks = [];

  for (let from = 1; from < view.AREA_MAX; from++) {
    const attacker = view.adat[from];
    if (attacker.size === 0 || attacker.arm !== pn || attacker.dice < 2) continue;

    for (let to = 1; to < view.AREA_MAX; to++) {
      const defender = view.adat[to];
      if (defender.size === 0 || defender.arm === pn || attacker.join[to] === 0) continue;
      attacks.push({ from, to, edge: attacker.dice - defender.dice });
    }
  }

  return attacks;
}

function testGenerateAttacksMatchesEngine() {
  const state = createGame({ ...MATCH_CONFIG, playerCount: 3, seed: 4242 });
  const view = createLegacyGameView(state);

  const mine = generateAttacks(view, view.get_pn())
    .map(a => `${a.from}->${a.to}`)
    .sort();
  // getValidMoves is the engine's own legal-move list: the ground truth to check against.
  const engine = getValidMoves(state)
    .map(m => `${m.from}->${m.to}`)
    .sort();

  assert.deepEqual(mine, engine);
}

function testNoAttacksFromSingleDice() {
  const board = structuredClone(createGame({ ...MATCH_CONFIG, playerCount: 3, seed: 4242 }));
  const me = board.turnOrder[board.currentPlayerIndex];
  for (const area of board.areas) {
    if (area.owner === me) area.dice = 1;
  }

  assert.equal(generateAttacks(createLegacyGameView(board), me).length, 0);
}

testGenerateAttacksMatchesEngine();
testNoAttacksFromSingleDice();
console.log('unit checks passed');
```

The second test patches `area.dice` directly instead of going through `setDice`, because `generateAttacks` reads only `adat` and never touches player totals. Reach for `setDice` as soon as the code under test reads `player[].dice_c`.

These functions drop into a file under `tests/` unchanged; swap `node:assert` for Vitest's `expect` to match the rest of the suite. `tests/mocks/gameMock.js` builds a legacy game view territory by territory when you want a board with no map generator involved at all.

### 4. Comparative analysis

Give several AIs the same board and compare what they choose:

```javascript
function compareAIDecisions(aiList, state) {
  /*
   * Engine state is immutable and runAI builds a fresh legacy view per call,
   * so every bot sees the identical board. Nothing needs cloning.
   */
  const decisions = aiList.map(ai => ({ name: ai.name, move: runAI(state, ai) }));

  for (const { name, move } of decisions) {
    console.log(move ? `${name}: attacks ${move.from} to ${move.to}` : `${name}: ends turn`);
  }

  const unique = new Set(decisions.map(d => (d.move ? `${d.move.from}-${d.move.to}` : 'end')));
  console.log(
    unique.size === 1 ? 'All bots chose the same move' : `${unique.size} different choices`
  );

  return decisions;
}

compareAIDecisions(
  [ai_default, ai_defensive, ai_example],
  createGame({ ...MATCH_CONFIG, playerCount: 3, seed: 4242 })
);
```

Disagreement on an early board is normal and tells you little on its own. What is worth chasing is a board where your bot is the only one ending its turn, or the only one attacking into worse odds.

## Tuning approaches

### 1. Parameter tuning

Most strategies have parameters worth tuning. Keep them in one object so a tuning run can vary them without touching the logic:

```javascript
const DEFAULT_PARAMS = {
  MIN_DICE_ADVANTAGE: 1, // attack only with at least this many dice more than the defender
  EVEN_ODDS_CHANCE: 0.5, // how often to take an even-dice attack anyway
};

function createTunedAI(overrides = {}) {
  const params = { ...DEFAULT_PARAMS, ...overrides };

  return function ai_tuned(game) {
    const pn = game.get_pn();
    let best = null;

    for (let from = 1; from < game.AREA_MAX; from++) {
      const attacker = game.adat[from];
      if (attacker.size === 0 || attacker.arm !== pn || attacker.dice < 2) continue;

      for (let to = 1; to < game.AREA_MAX; to++) {
        const defender = game.adat[to];
        if (defender.size === 0 || defender.arm === pn || attacker.join[to] === 0) continue;

        const edge = attacker.dice - defender.dice;
        if (edge < params.MIN_DICE_ADVANTAGE) {
          // Randomness inside a bot always comes from game.random(), never Math.random.
          if (edge !== 0 || game.random() >= params.EVEN_ODDS_CHANCE) continue;
        }
        if (!best || edge > best.edge) best = { from, to, edge };
      }
    }

    if (!best) return 0;
    game.area_from = best.from;
    game.area_to = best.to;
  };
}

function winRateOf(ai, opponents, numGames = 30) {
  const { standings } = runTournament([ai, ...opponents], numGames);
  return standings[0].winRate;
}

function tuneParameter(name, values) {
  const results = values.map(value => ({
    value,
    winRate: winRateOf(createTunedAI({ [name]: value }), [ai_default, ai_defensive]),
  }));

  results.sort((a, b) => b.winRate - a.winRate);
  console.log(
    `Best ${name}: ${results[0].value} (win rate ${(results[0].winRate * 100).toFixed(1)}%)`
  );
  return results;
}

tuneParameter('MIN_DICE_ADVANTAGE', [0, 1, 2, 3]);
```

Thirty games per value is enough to see a large effect and nowhere near enough to trust a small one. Once a candidate looks good, re-measure it with `npm run arena:sweep`, which reports confidence intervals across seeds.

### 2. Grid search

To tune several parameters at once, sweep the combinations:

```javascript
function generateParameterCombinations(ranges) {
  let combinations = [{}];

  for (const [key, values] of Object.entries(ranges)) {
    combinations = values.flatMap(value => combinations.map(combo => ({ ...combo, [key]: value })));
  }

  return combinations;
}

function gridSearch() {
  const ranges = {
    MIN_DICE_ADVANTAGE: [0, 1, 2],
    EVEN_ODDS_CHANCE: [0.0, 0.5, 1.0],
  };

  const results = generateParameterCombinations(ranges).map(params => ({
    params,
    winRate: winRateOf(createTunedAI(params), [ai_default, ai_defensive]),
  }));

  results.sort((a, b) => b.winRate - a.winRate);
  return results.slice(0, 3);
}

console.log(gridSearch());
```

The cost is the product of the ranges, so a grid grows out of reach fast. Three parameters at five values each is 125 tournaments.

### 3. Evolutionary algorithms

For a parameter space too large to sweep, evolve it.

The search itself needs randomness, and it needs to be reproducible: a tuning run you cannot repeat tells you nothing about whether the winning parameters were real or lucky. This harness runs outside a match, so there is no `game` object and no `game.random()` to draw from. Give it its own seeded stream from the engine's PRNG instead. Inside a bot the rule is different and stricter: draw from `game.random()`, never from a stream of your own and never from `Math.random` (issue #151).

```javascript
import { createRng } from '../src/engine/rng.js';

// One seeded stream for the whole tuning run. Keep the seed to reproduce a result,
// change it to search from a different starting point.
const rng = createRng(20260825);
const random = rng.nextFloat; // drop-in for Math.random: floats in [0, 1)

// The genome: one range per tunable parameter of createTunedAI.
const PARAM_RANGES = {
  MIN_DICE_ADVANTAGE: [0, 3],
  EVEN_ODDS_CHANCE: [0, 1],
};

// MIN_DICE_ADVANTAGE is compared against an integer dice edge, so a float there is the same
// bot as the next integer up. Round it, so the reported genome means what it says.
const INTEGER_PARAMS = new Set(['MIN_DICE_ADVANTAGE']);

function clamp(key, value) {
  const [low, high] = PARAM_RANGES[key];
  const clamped = Math.min(high, Math.max(low, value));
  return INTEGER_PARAMS.has(key) ? Math.round(clamped) : clamped;
}

function evolveParameters(numGenerations = 4, populationSize = 8) {
  let population = generateInitialPopulation(populationSize);

  for (let generation = 0; generation < numGenerations; generation++) {
    const fitnessScores = evaluatePopulationFitness(population);
    const parents = selectParents(population, fitnessScores);
    const offspring = createOffspring(parents);

    const bestIndex = fitnessScores.indexOf(Math.max(...fitnessScores));
    console.log(`Generation ${generation + 1} best:`, population[bestIndex]);

    // Keep the parents, so a generation can never be worse than the one before it.
    population = [...parents, ...offspring].slice(0, populationSize);
  }

  const finalFitness = evaluatePopulationFitness(population);
  return population[finalFitness.indexOf(Math.max(...finalFitness))];
}

function generateInitialPopulation(size) {
  const population = [];

  for (let i = 0; i < size; i++) {
    const individual = {};
    for (const [key, [low, high]] of Object.entries(PARAM_RANGES)) {
      individual[key] = clamp(key, low + random() * (high - low));
    }
    population.push(individual);
  }

  return population;
}

function evaluatePopulationFitness(population) {
  return population.map(params => winRateOf(createTunedAI(params), [ai_default, ai_defensive], 20));
}

function selectParents(population, fitnessScores) {
  return population
    .map((params, index) => ({ params, fitness: fitnessScores[index] }))
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, Math.ceil(population.length / 2))
    .map(entry => entry.params);
}

function createOffspring(parents) {
  const offspring = [];

  while (offspring.length < parents.length) {
    const parent1 = parents[Math.floor(random() * parents.length)];
    const parent2 = parents[Math.floor(random() * parents.length)];

    const child = crossover(parent1, parent2);
    mutate(child);
    offspring.push(child);
  }

  return offspring;
}

function crossover(parent1, parent2) {
  const child = {};

  // For each parameter, take the value from one parent or the other.
  for (const key of Object.keys(PARAM_RANGES)) {
    child[key] = random() < 0.5 ? parent1[key] : parent2[key];
  }

  return child;
}

function mutate(params) {
  // Small chance to nudge each parameter, clamped back into its range.
  for (const key of Object.keys(params)) {
    if (random() < 0.2) {
      const [low, high] = PARAM_RANGES[key];
      params[key] = clamp(key, params[key] + (random() - 0.5) * (high - low) * 0.2);
    }
  }
}

console.log('Best parameters:', evolveParameters());
```

The population and generation counts here are deliberately tiny so the run finishes in about a second. Real tuning wants both an order of magnitude larger, and more games per fitness evaluation, or selection chases noise.

## Performance metrics

Track more than win rate. A bot that never wins but always finishes second is very different from one that wins occasionally and busts out early the rest of the time.

The arena's own match loop, `runMatch`, already returns placements (which encode elimination order) and per-bot attack counts, so a metric run only has to add survival on top. `simulateGame` would mean deriving all of that by hand. `runMatch` takes modern-contract bots, so a legacy AI goes through `adaptLegacyBot` first. It also builds its own board from the seed at the engine's default size (28 by 32, 32 territories) and takes no map config, so its numbers are not comparable with `winRateOf`'s 20 by 20 results; compare `evaluateAI` outputs only with each other.

```javascript
import { runMatch } from '../src/arena/matchRunner.js';
import { adaptLegacyBot } from '../src/arena/legacyBotAdapter.js';

const SEAT = 0; // the seat under test; bots[i] plays player i

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function evaluateAI(aiFunction, numGames = 30, baseSeed = BASE_SEED) {
  const bots = [
    { name: 'candidate', fn: adaptLegacyBot(aiFunction, 'candidate') },
    { name: 'default-a', fn: adaptLegacyBot(ai_default, 'default-a') },
    { name: 'default-b', fn: adaptLegacyBot(ai_default, 'default-b') },
  ];

  const games = [];

  for (let i = 0; i < numGames; i++) {
    let survivalTurns = 0;

    const result = runMatch({
      bots,
      seed: baseSeed + i,
      maxTurns: 300,
      // The one metric runMatch does not already track: how long the seat stayed alive.
      onTurn: (turnCount, state) => {
        if (!state.players[SEAT].eliminated) survivalTurns = turnCount;
      },
    });

    const stats = result.botStats[SEAT];
    games.push({
      won: result.winner === SEAT,
      placement: stats.placement,
      territories: stats.finalTerritories,
      dice: stats.finalDice,
      attackWinRate: stats.attacksMade > 0 ? stats.attacksWon / stats.attacksMade : 0,
      attacksPerTurn: stats.turns > 0 ? stats.attacksMade / stats.turns : 0,
      survivalTurns,
    });
  }

  return {
    name: aiFunction.name,
    winRate: games.filter(g => g.won).length / numGames,
    avgPlacement: average(games.map(g => g.placement)),
    avgTerritories: average(games.map(g => g.territories)),
    avgDice: average(games.map(g => g.dice)),
    avgAttackWinRate: average(games.map(g => g.attackWinRate)),
    avgAttacksPerTurn: average(games.map(g => g.attacksPerTurn)),
    avgSurvivalTurns: average(games.map(g => g.survivalTurns)),
  };
}

console.log(evaluateAI(ai_default));
console.log(evaluateAI(ai_defensive));
```

Average placement is the metric that separates a solid bot from a lucky one: it moves on games your bot did not win, where win rate records nothing. Attacks per turn and attack win rate describe style rather than strength, and they are what you watch when a tuning change is supposed to make the bot more cautious.

## Visualizing results

Even crude console bar charts make patterns easier to spot than raw numbers:

```javascript
function bar(value, scale) {
  return '#'.repeat(Math.max(0, Math.round(value / scale)));
}

function visualizeResults(results) {
  console.log('Win rate');
  for (const r of results) {
    const percent = r.winRate * 100;
    console.log(`  ${r.name.padEnd(14)} ${bar(percent, 2)} ${percent.toFixed(1)}%`);
  }

  console.log('Average placement (lower is better)');
  for (const r of results) {
    console.log(`  ${r.name.padEnd(14)} ${bar(r.avgPlacement, 0.1)} ${r.avgPlacement.toFixed(2)}`);
  }

  console.log('Average turns survived');
  for (const r of results) {
    const turns = r.avgSurvivalTurns;
    console.log(`  ${r.name.padEnd(14)} ${bar(turns, 5)} ${turns.toFixed(1)}`);
  }
}

visualizeResults([evaluateAI(ai_default), evaluateAI(ai_defensive)]);
```

## Regression testing

Check that a change didn't make the bot worse before keeping it:

```javascript
function regressionTest(newAI, baselineAI, numGames = 30) {
  // Same seeds for both, so the two bots play the same boards against the same opponents.
  const baseline = evaluateAI(baselineAI, numGames);
  const candidate = evaluateAI(newAI, numGames);

  const line = (label, before, after, digits = 1) =>
    `${label.padEnd(10)} ${before.toFixed(digits)} -> ${after.toFixed(digits)} ` +
    `(${after - before >= 0 ? '+' : ''}${(after - before).toFixed(digits)})`;

  console.log(line('win rate:', baseline.winRate * 100, candidate.winRate * 100));
  console.log(line('placement:', baseline.avgPlacement, candidate.avgPlacement, 2));
  console.log(line('survival:', baseline.avgSurvivalTurns, candidate.avgSurvivalTurns));

  // Behaviour the win rate would not have caught either way.
  for (const test of [testTakesFreeCapture, testEndsTurnWithNoAttacks]) {
    console.log(`${test.name}`);
    console.log(`  baseline:  ${test(baselineAI)}`);
    console.log(`  candidate: ${test(newAI)}`);
  }

  // A bot that thinks too long stalls the game, however good its moves are.
  console.time('candidate: 10 games');
  evaluateAI(newAI, 10);
  console.timeEnd('candidate: 10 games');
}

regressionTest(ai_defensive, ai_default);
```

## Best practices

1. **Version control** - Keep every AI version and its measured performance
2. **Parameter documentation** - Note what each parameter does and its sensible range
3. **Regular benchmarking** - Re-test against standard opponents after engine or map changes
4. **Focused changes** - Change one thing at a time, or you won't know what helped
5. **Varied seeds** - Test across many random seeds; one seed is one sample
6. **A/B testing** - Compare each change against a fixed baseline
7. **Enough games** - A 55% win rate over 20 games is noise; over 1,000 games it's a result
8. **Diverse opponents** - A bot tuned only against ai_default learns to beat ai_default
9. **Edge cases** - Build scenarios for unusual situations (one territory left, one opponent left, no valid attacks)
10. **Human feedback** - Ask players whether the bot feels smart, cheap, or passive

## Common testing pitfalls

1. **Overfitting** - The bot aces your test scenarios but flops in real games
2. **Non-deterministic failures** - Bugs that only appear under some dice sequences
3. **Shallow testing** - A handful of game states proves very little
4. **Ignoring speed** - A theoretically strong bot that stalls the game loses in practice
5. **Untracked changes** - Tuning without recording results means re-learning the same lessons
6. **Fixed seating** - Leaving a bot in the same seat every game measures the seat as much as the bot

## Iterative improvement workflow

Establish a baseline, form a hypothesis, make the change, test it rigorously, compare against the baseline, tune, and write down what you found. Then start the loop again.

The command-line side of that loop for a built-in strategy, the vitest, benchmark, and arena commands, is in [the developer guide](../../ai/DEVELOPER_GUIDE.md#testing-and-debugging).
