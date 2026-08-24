# AI developer guide

This guide explains how to write a custom AI for DiceWarsJS: the AI interface, the game state your function receives, and patterns for building a competitive strategy.

## Getting started

### Basic structure

Each AI implementation must export a single function with the following signature:

```javascript
/**
 * AI strategy function
 *
 * @param {Object} game - Game state object
 * @returns {Object|number} Action object or 0 to end turn
 */
export function ai_custom(game) {
  // Your AI implementation
}
```

The function should:

1. Analyze the current game state
2. Decide on an action to take
3. Return the action object or 0 to end the turn

### Examples

Look at the existing AI implementations to understand different approaches:

- **ai_example.js**: simple random AI (good starting point)
- **ai_default.js**: balanced strategy with basic territory evaluation
- **ai_defensive.js**: focuses on defensive play and territory consolidation
- **ai_adaptive.js**: adjusts strategy based on game phase and position

## Game state

The `game` object passed to your AI function provides access to the game state:

### Key properties

- `game.adat`: array of territory objects
- `game.player`: array of player objects
- `game.get_pn()`: get current player number
- `game.jun`: array of player order
- `game.ban`: current index in the player order

### Territory information

Each territory (`game.adat[i]`) has these properties:

- `size`: number of cells in the territory
- `arm`: player ID who owns this territory (0-7)
- `dice`: number of dice in this territory
- `join`: array indicating adjacency to other territories

Example of accessing territory information:

```javascript
function ai_custom(game) {
  const pn = game.get_pn(); // My player number
  const myTerritories = [];

  // Find territories owned by this player
  for (let i = 1; i < game.adat.length; i++) {
    if (game.adat[i].arm === pn) {
      myTerritories.push(i);
    }
  }

  // Further decision logic...
}
```

## Making decisions

Your AI should return an action or end its turn.

### Attack action

To attack another territory, return an action object:

```javascript
return {
  from: fromTerritoryId,
  to: targetTerritoryId,
};
```

### End turn

To end the turn without further actions, return 0:

```javascript
return 0;
```

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

for (let i = 1; i < game.adat.length; i++) {
  const area = game.adat[i];

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
  for (let toId = 1; toId < from.join.length; toId++) {
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

if (possibleAttacks.length > 0) {
  return {
    from: possibleAttacks[0].from,
    to: possibleAttacks[0].to,
  };
}

return 0; // End turn if no good attacks
```

## Performance considerations

- Your AI has limited time to make decisions
- Optimize expensive calculations
- Consider caching results where appropriate
- Focus computation on promising moves

## Testing and debugging

To test your AI:

1. Implement your strategy in a new file (e.g., `src/ai/ai_myCustom.js`)
2. Add your AI to the centralized AI configuration in `src/ai/aiConfig.js`:
   ```javascript
   export const AI_STRATEGIES = {
     // Add your new AI strategy
     ai_myCustom: {
       id: 'ai_myCustom',
       name: 'My Custom AI',
       description: 'Brief description of your AI strategy',
       difficulty: 3, // Rate from 1-5
       implementation: ai_myCustom,
     },
     // Existing strategies...
   };
   ```
3. Update the configuration to use your AI by changing `aiAssignments` in the config:
   ```javascript
   config.aiAssignments[2] = 'ai_myCustom'; // Assign to player 2
   ```
4. Run games against existing AIs to test performance

## Submission guidelines

When the AI Championship Platform is ready, you'll be able to submit your AI through a web interface. For now:

1. Name your AI function descriptively (e.g., `ai_territorial`, `ai_aggressive`)
2. Include detailed comments explaining your strategy
3. Keep your code well-structured and readable
4. Include a brief strategy description in a comment block at the top

## Resources

- Existing AI implementations in `src/ai/`
- Centralized AI configuration in `src/ai/aiConfig.js`
- Game engine in `src/engine/`
- AI integration in `src/engine/AIAdapter.js`
- Test framework for AI performance testing in `tests/ai/`

## Future work

As the AI Championship Platform develops, we'll add:

- Standardized testing environments
- Performance metrics and analysis tools
- ELO rating system
- Tournament infrastructure
- Replay analysis tools
