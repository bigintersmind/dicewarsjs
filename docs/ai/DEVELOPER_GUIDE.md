# AI developer guide

This guide explains how to write a built-in AI for DiceWarsJS: the AI interface, the game state your function receives, and patterns for building a competitive strategy.

## Which contract this guide covers

Two bot contracts exist, and they are not interchangeable.

- **Built-in AIs** (`src/ai/`, the ones this guide covers) use the legacy interface. Your function receives a mutable game view, declares an attack by writing `game.area_from` and `game.area_to`, and returns `0` when it has nothing left to do.
- **Arena and community bots** use the modern interface: they receive a sanitized `BotState` and return `{ from, to }` or `null`. If that is what you want to write, read the [bot guide](../BOT_GUIDE.md) instead. It is the shorter path, and it is the one that feeds the daily online tournament.

`src/engine/AIAdapter.js` runs both. It picks the modern path only for functions tagged `__modernBot` by `adaptModernBot`, so a plain function in `src/ai/` always gets the legacy treatment described below.

## Getting started

### Basic structure

Each AI implementation exports a single function. The export name has to match the name your loader imports (see [Registering your AI](#registering-your-ai)):

```javascript
/**
 * AI strategy function
 *
 * Declares an attack by setting game.area_from and game.area_to.
 *
 * @param {Object} game - Mutable game view for this decision
 * @returns {number|undefined} 0 to end the turn, otherwise undefined
 */
export function ai_custom(game) {
  // Your AI implementation
}
```

The adapter calls your function once per attack, not once per turn. Each call works like this:

1. Analyze the current game state
2. Pick one attack
3. Set `game.area_from` and `game.area_to`, then return
4. Return `0` when no attack is worth making, which ends the turn

The adapter applies the attack you set, then calls you again with a freshly built view of the new state. Nothing carries over between calls except the board itself.

The game view is a throwaway copy, so writing to any field other than `area_from` and `area_to` has no effect on the real game state.

### Examples

Look at the existing AI implementations to understand different approaches:

- **ai_example.js**: picks a random attack where it has more dice than the defender (good starting point)
- **ai_default.js**: the original game's strategy, a random pick from a filtered attack list
- **ai_defensive.js**: prioritizes protecting vulnerable territories
- **ai_adaptive.js**: adjusts strategy based on game phase and position
- **ai_strategist.js**: scores every attack by expected value using exact dice odds
- **ai_lookahead.js**: shallow expectimax search over win and loss branches

## Game state

The `game` object passed to your AI function provides access to the game state:

### Key properties

- `game.adat`: array of territory objects, indexed by territory ID from 1
- `game.AREA_MAX`: one past the highest territory ID, so loops run `for (let i = 1; i < game.AREA_MAX; i++)`
- `game.player`: array of player objects, each with `area_c` (territory count), `dice_c` (total dice), `area_tc` (largest connected group), `dice_jun` (rank; the view always hands you 0, so compute and write it yourself the way `ai_default` does), and `stock` (reserve dice)
- `game.get_pn()`: get current player number
- `game.jun`: array of player order
- `game.ban`: current index in the player order
- `game.random()`: seeded replacement for `Math.random`, returning a float in `[0, 1)`

Do not call `Math.random()` anywhere in your AI. Matches are replayed from a seed, and an unseeded call breaks reproducibility for the arena, replays, and the tests. Use `game.random()` for every random choice.

Do not assume eight players either. The online tournament seats larger fields, so size any per-player array you build with `getPlayerCount(game)` from `src/ai/playerCount.js` rather than a hard-coded 8.

### Territory information

Each territory (`game.adat[i]`) has these properties:

- `size`: number of cells in the territory, or 0 for an unused slot. On the arena path (step 4 below) it is always 1 for a real territory, because `BotState` does not carry cell counts, so don't weight a strategy by it
- `arm`: player ID who owns this territory
- `dice`: number of dice in this territory
- `join`: array indexed by territory ID, where 1 means adjacent

Skip any territory with `size === 0`. Those slots are map-generation leftovers, not real territory: they are owned by nobody and adjacent to nothing.

Example of accessing territory information:

```javascript
function ai_custom(game) {
  const pn = game.get_pn(); // My player number
  const myTerritories = [];

  // Find territories owned by this player
  for (let i = 1; i < game.AREA_MAX; i++) {
    const area = game.adat[i];
    if (area.size === 0) continue;
    if (area.arm === pn) {
      myTerritories.push(i);
    }
  }

  // Further decision logic...
}
```

## Making decisions

Each call either declares one attack or ends the turn.

### Attack action

To attack, write both territory IDs onto the game view and return. The adapter reads them back:

```javascript
game.area_from = fromTerritoryId;
game.area_to = targetTerritoryId;
```

Set both. The adapter only treats the pair as a move when `area_from` and `area_to` are both greater than 0, so leaving one at its default of 0 silently ends the turn.

Returning an object does not work. `return { from, to }` is the modern bot contract from the [bot guide](../BOT_GUIDE.md), and a built-in AI that returns one ends its turn, every call. In the game you get a console warning ("returned unexpected value"); in the arena the legacy wrapper returns `null` with no message at all.

Here is the shape every built-in follows, matching `src/ai/ai_default.js`:

```javascript
export const ai_custom = game => {
  const attacks = findValidAttacks(game);

  // Nothing worth attacking: end the turn
  if (attacks.length === 0) return 0;

  const chosen = attacks[Math.floor(game.random() * attacks.length)];

  game.area_from = chosen.from;
  game.area_to = chosen.to;
  // No return value needed: the adapter reads the two IDs above
};
```

### End turn

To end the turn, return 0 without setting `area_from` or `area_to`:

```javascript
return 0;
```

Illegal moves are never applied. The in-game and arena runners skip the move and end your turn after three invalid ones in a row; `runFullAITurn` in the adapter ends it on the first. A turn is also capped at 100 decisions, invalid ones included, so an AI that never returns 0 still loses the turn.

## Strategy considerations

When designing your AI, consider these elements:

### 1. Territory evaluation

Territories have different strategic values based on:

- Size (number of cells)
- Position on the map
- Border with enemy territories
- Connection to other friendly territories

### 2. Attack evaluation

Consider these factors when choosing attacks:

- Dice advantage (attacker vs defender)
- Strategic value of target territory
- Risk of counter-attack
- Effect on territorial integrity

### 3. Game phases

The game typically has distinct phases that require different strategies:

- **Early game**: expand and establish position
- **Mid game**: consolidate territories and target weak opponents
- **Late game**: target leading players and secure strong positions

### 4. Player analysis

Analyze other players to inform your strategy:

- Identify the strongest players (most territories/dice)
- Detect player positions (who borders whom)
- Observe player behavior patterns

## Recommended patterns

### State analysis

Analyze the game state efficiently:

```javascript
// Get all my territories
const myTerritories = [];
const enemyBorders = new Set();

for (let i = 1; i < game.AREA_MAX; i++) {
  const area = game.adat[i];

  if (area.size === 0) continue;

  if (area.arm === pn) {
    myTerritories.push(i);

    // Find enemy neighbors
    for (let j = 1; j < area.join.length; j++) {
      if (area.join[j] === 1 && game.adat[j].arm !== pn) {
        enemyBorders.add(j);
      }
    }
  }
}
```

### Prioritizing attacks

Evaluate and rank possible attacks:

```javascript
// Find all possible attacks
const possibleAttacks = [];

for (const fromId of myTerritories) {
  const from = game.adat[fromId];

  // Skip territories with only 1 die (can't attack)
  if (from.dice <= 1) continue;

  // Check all adjacent territories
  for (let toId = 1; toId < game.AREA_MAX; toId++) {
    if (from.join[toId] === 1) {
      const to = game.adat[toId];

      // Must be enemy territory
      if (to.arm === pn) continue;

      // Calculate attack score
      const diceAdvantage = from.dice - to.dice;
      const strategicValue = calculateStrategicValue(toId, game);
      const score = diceAdvantage * 5 + strategicValue;

      possibleAttacks.push({
        from: fromId,
        to: toId,
        score: score,
      });
    }
  }
}

// Sort by score and choose the best attack
possibleAttacks.sort((a, b) => b.score - a.score);

if (possibleAttacks.length === 0) return 0; // End turn if no good attacks

game.area_from = possibleAttacks[0].from;
game.area_to = possibleAttacks[0].to;
```

## Performance considerations

- No timeout is enforced, but your AI runs synchronously on the same thread as the game, so a slow decision freezes the board
- Optimize expensive calculations
- Consider caching results where appropriate, keeping in mind that the game view is rebuilt for every call
- Focus computation on promising moves
- The arena runs 100 games back to back by default, so per-call cost adds up quickly there

## Registering your AI

1. Implement your strategy in a new file, for example `src/ai/ai_myCustom.js`
2. Add a loader and a registry entry in `src/ai/aiConfig.js`. Strategies load on demand, so the entry holds a `loader` and starts with `implementation: null`, which `getAIImplementation()` fills in on first use:

   ```javascript
   export const load_ai_myCustom = async () => (await import('./ai_myCustom.js')).ai_myCustom;

   export const AI_STRATEGIES = {
     // Existing strategies...

     ai_myCustom: {
       id: 'ai_myCustom',
       name: 'My Custom AI',
       description: 'Brief description of your AI strategy',
       difficulty: 3, // Rate from 1-5
       loader: load_ai_myCustom,
       implementation: null,
     },
   };
   ```

3. That is enough to make it selectable per player in the title screen's AI picker, which reads the registry through `getAIStrategiesByCategory()`. Anything flagged `hidden` is left out of the picker but stays resolvable by ID. The picker order is pinned in `tests/ai/aiConfig.test.js`, so add your entry to the expected lists there or those tests fail.
4. To also run it in the arena and tournament, register it in `src/arena/builtInBots.js` wrapped in `adaptLegacyBot(ai_myCustom, 'My Custom')`, and place its id in that file's `STRENGTH_ORDER` (or flag the entry `hidden`). An un-hidden bot missing from `STRENGTH_ORDER` throws at import and takes every consumer of the module down with it. The adapter is what lets a legacy AI read the arena's `BotState`.

`docs/ai/AI_CONFIG_NOTES.md` covers the config system in more detail, including `createAIFunctionMapping()` for driving games from code.

## Testing and debugging

```bash
npx vitest run tests/ai/           # unit tests for the built-in strategies
npm run benchmark                  # AI performance benchmarks
npm run arena                      # ELO ranking across the built-in field
npm run arena:sweep                # multi-seed sweep with confidence intervals
```

`npm run arena` and `npm run arena:sweep` only field bots registered in `src/arena/builtInBots.js`, and by default only the ones not flagged `hidden`. Pass `--bots` to name a specific field.

Copy an existing test in `tests/ai/` as a starting point. `tests/mocks/gameMock.js` builds a legacy game view you can assert against without running a whole game.

## Style guidelines

1. Name your AI function descriptively, for example `ai_territorial` or `ai_aggressive`
2. Match the export name to what the loader imports
3. Explain the strategy in a comment block at the top of the file, as the existing AIs do
4. Take every random choice through `game.random()`

## What already exists

The infrastructure an AI needs is already built and running:

- **ELO ratings**: `src/arena/elo.js`, applied by the arena and tournament runners
- **Tournaments**: `src/arena/tournament.js` for round-robin and single-elimination, plus the daily online tournament in `scripts/run-online-tournament.mjs`
- **Standard testing environment**: `npm run arena` for one deterministic ranking, `npm run arena:sweep` for a multi-seed sweep with confidence intervals
- **Per-bot metrics**: `npm run benchmark-bot` reports timing, win rate, ELO, and placement, and `npm run validate-bot` checks a bot compiles and runs
- **Replays**: `src/arena/replayFormat.js` records matches, and `src/ui/ReplayViewer.jsx` plays them back in the browser
- **In-game screens**: Arena, Tournament, and Leaderboard, in `src/ui/`

Most of that is aimed at the arena bot contract, so read the [bot guide](../BOT_GUIDE.md) if you want your strategy ranked publicly. Community bots are submitted by pull request, described in the bot guide and [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Resources

- Existing AI implementations in `src/ai/`
- Centralized AI configuration in `src/ai/aiConfig.js`
- Game engine in `src/engine/`
- AI integration in `src/engine/AIAdapter.js`, which is the source of truth for both contracts
- Unit tests for the built-in AIs in `tests/ai/`, benchmarks in `tests/benchmarks/`
- Game rules in [docs/GAME_RULES.md](../GAME_RULES.md)
