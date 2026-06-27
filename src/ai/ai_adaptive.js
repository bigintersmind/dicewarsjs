/**
 * Adaptive AI Strategy for Dice Wars
 *
 * This AI dynamically adjusts its strategy based on game state analysis,
 * providing responsive decision-making that adapts to changing game conditions.
 * The AI considers:
 * - Game phase (early, mid, late)
 * - Player rankings and relative strength
 * - Territory connectivity and border security
 * - Choke points and strategic territory value
 * - Attack risk and potential rewards
 */
import { getPlayerCount } from './playerCount.js';

export const ai_adaptive = game => {
  // Get current player number
  const pn = game.get_pn();

  // Step 1: Analyze the game state
  const gameState = analyzeGameState(game);

  // Step 2: Determine appropriate strategy based on game state
  const strategy = determineStrategy(game, gameState, pn);

  // Step 3: Generate and evaluate possible moves
  const moves = generateMoves(game, strategy, pn);

  // Step 4: End turn if no valid moves available
  if (moves.length === 0) return 0;

  // Step 5: Select the best move based on the current strategy
  const bestMove = selectBestMove(moves, strategy);

  // Step 6: Execute the selected move
  game.area_from = bestMove.from;
  game.area_to = bestMove.to;
};

/**
 * Analyze the current game state to inform strategic decisions
 * Gathers comprehensive data about territories, players, and game progress
 *
 * @param {Object} game - The game state object
 * @returns {Object} Analysis of the current game state
 */
const analyzeGameState = game => {
  const pmax = getPlayerCount(game);
  const state = {
    playerStats: [],
    territories: {
      total: 0,
      byPlayer: new Array(pmax).fill(0),
    },
    dice: {
      total: 0,
      byPlayer: new Array(pmax).fill(0),
    },
    borderTerritories: new Array(pmax).fill(0),
    playerRankings: [],
    dominantPlayer: -1,
    averageDicePerTerritory: new Array(pmax).fill(0),
    gamePhase: 'early',
    remainingPlayers: 0,
    chokePoints: [],
    playerThreatLevel: new Array(pmax).fill(0),
  };

  // Get territories data
  const { adat, AREA_MAX, player } = game;

  // Calculate territory and dice statistics using array methods
  const validTerritories = [...Array(AREA_MAX).keys()]
    .slice(1) // Territories start at index 1
    .filter(i => adat[i].size !== 0);

  // Process valid territories
  validTerritories.forEach(i => {
    const { arm, dice } = adat[i];

    // Count territories and dice by owning army
    state.territories.total++;
    state.territories.byPlayer[arm]++;

    state.dice.total += dice;
    state.dice.byPlayer[arm] += dice;

    // Check if this is a border territory using some() for early exit
    const isBorder = validTerritories.some(j => i !== j && adat[i].join[j] && adat[j].arm !== arm);

    if (isBorder) {
      state.borderTerritories[arm]++;
    }
  });

  // Calculate average dice per territory and count active players
  for (let i = 0; i < pmax; i++) {
    if (state.territories.byPlayer[i] > 0) {
      state.averageDicePerTerritory[i] = state.dice.byPlayer[i] / state.territories.byPlayer[i];
      state.remainingPlayers++;

      // Store player stats for easier access
      state.playerStats[i] = {
        territories: state.territories.byPlayer[i],
        dice: state.dice.byPlayer[i],
        borderTerritories: state.borderTerritories[i],
        averageDice: state.averageDicePerTerritory[i],
        connectedTerritories: player[i].area_tc,
      };
    }
  }

  // Rank players by dice count (index 0 = highest ranking player)
  state.playerRankings = Array(pmax)
    .fill()
    .map((_, i) => i)
    .filter(i => state.territories.byPlayer[i] > 0) // Only include active players
    .sort((a, b) => state.dice.byPlayer[b] - state.dice.byPlayer[a]);

  // Identify dominant player (has >35% of total dice)
  state.dominantPlayer =
    state.playerRankings.find(i => state.dice.byPlayer[i] > state.dice.total * 0.35) ?? -1;

  // Calculate threat level each player poses to others
  state.playerRankings.forEach(i => {
    // Base threat on dice count, average dice, and territory percentage
    const territoryPercentage = state.territories.byPlayer[i] / state.territories.total;

    state.playerThreatLevel[i] =
      state.dice.byPlayer[i] * 0.6 +
      state.averageDicePerTerritory[i] * 10 +
      territoryPercentage * 50;
  });

  // Determine game phase based on territory occupation and player count
  if (state.territories.total > 0) {
    // Territory claim percentage - assumes about 30 territories total
    const territoriesClaimed = state.territories.total / 30;

    // Game phase depends on territory claim percentage and player count
    state.gamePhase =
      state.remainingPlayers > 5 || territoriesClaimed < 0.6
        ? 'early'
        : state.remainingPlayers > 3 || territoriesClaimed < 0.9
          ? 'mid'
          : 'late';
  }

  // Detect choke points
  state.chokePoints = identifyChokePoints(game);

  return state;
};

/**
 * Identify territories that are strategic choke points
 * These are territories that connect different regions and control movement
 *
 * @param {Object} game - The game state object
 * @returns {Array} List of choke point territories with their strategic value
 */
const identifyChokePoints = game => {
  const { adat, AREA_MAX } = game;
  const validTerritories = [...Array(AREA_MAX).keys()].slice(1).filter(i => adat[i].size !== 0);

  // Calculate connectivity for all territories
  const areaConnectivity = validTerritories.reduce((acc, i) => {
    // Count connections to other territories
    const connections = validTerritories.filter(j => j !== i && adat[i].join[j]).length;
    acc[i] = connections;
    return acc;
  }, []);

  // Identify potential choke points
  const chokePoints = validTerritories
    .map(i => {
      // Count neighbors by player
      const neighborsByPlayer = validTerritories
        .filter(j => j !== i && adat[i].join[j])
        .reduce((counts, j) => {
          const playerIndex = adat[j].arm;
          counts[playerIndex] = (counts[playerIndex] || 0) + 1;
          return counts;
        }, new Array(8).fill(0));

      // Count different players connected by this territory
      const differentPlayers = neighborsByPlayer.filter(count => count > 0).length;

      // Calculate strategic value
      const strategicValue = differentPlayers * 3 + (areaConnectivity[i] > 3 ? 2 : 0);

      return {
        territory: i,
        strategicValue,
        connectivity: areaConnectivity[i],
        owner: adat[i].arm,
        dice: adat[i].dice,
        // Only return if it meets threshold
        isChokePoint: strategicValue >= 4,
      };
    })
    .filter(point => point.isChokePoint);

  // Sort by strategic value (highest first)
  return chokePoints.sort((a, b) => b.strategicValue - a.strategicValue);
};

/**
 * Determine the optimal strategy based on game state
 * Adjusts aggression, expansion focus, risk tolerance, and target selection
 *
 * @param {Object} game - The game state object
 * @param {Object} gameState - The analyzed game state
 * @param {number} pn - Current player number
 * @returns {Object} Strategy parameters to guide decision making
 */
const determineStrategy = (game, gameState, pn) => {
  // Default strategy with medium settings
  const strategy = {
    aggression: 0.5, // 0 (defensive) to 1 (aggressive)
    expansion: 0.5, // 0 (consolidate) to 1 (expand)
    riskTolerance: 0.5, // 0 (risk-averse) to 1 (risk-seeking)
    targetSelection: {
      dominantPlayer: false,
      weakestPlayer: false,
      specificPlayer: -1,
    },
    reinforcementFocus: 'balanced', // 'offensive', 'defensive', or 'balanced'
    prioritizeChokePoints: false,
  };

  // Find our ranking among players
  const myRanking = gameState.playerRankings.indexOf(pn);

  // Strategy adjustment based on game phase
  const adjustStrategyByPhase = () => {
    const { gamePhase, remainingPlayers, playerRankings } = gameState;

    // Adjust based on game phase
    switch (gamePhase) {
      case 'early':
        // Early game: focus on expansion and territory acquisition
        strategy.aggression = 0.7;
        strategy.expansion = 0.8;
        strategy.riskTolerance = 0.6;

        // If we're significantly behind already, be more aggressive
        if (myRanking > 2 && remainingPlayers > 4) {
          strategy.aggression = 0.8;
          strategy.riskTolerance = 0.7;
        }
        break;

      case 'mid':
        // Mid game: balanced approach
        strategy.aggression = 0.5;
        strategy.expansion = 0.5;
        strategy.prioritizeChokePoints = true;

        // Position-specific adjustments
        if (myRanking === 0) {
          // Leading - be more conservative
          Object.assign(strategy, {
            aggression: 0.4,
            riskTolerance: 0.3,
            expansion: 0.4,
          });
        } else if (myRanking > 0 && myRanking < remainingPlayers - 1) {
          // Middle of pack - target player ahead
          Object.assign(strategy, {
            aggression: 0.7,
            riskTolerance: 0.6,
            targetSelection: {
              ...strategy.targetSelection,
              specificPlayer: playerRankings[myRanking - 1],
            },
          });
        } else if (myRanking === remainingPlayers - 1) {
          // Last place - target weakest
          Object.assign(strategy, {
            aggression: 0.8,
            riskTolerance: 0.7,
            targetSelection: {
              ...strategy.targetSelection,
              weakestPlayer: true,
            },
          });
        }
        break;

      case 'late':
        // Late game: position-based strategy

        // Special endgame handling with only 2 players left
        const activePlayerCount = Object.values(game.player).filter(p => p.area_c > 0).length;
        if (activePlayerCount <= 2) {
          // In a two-player endgame, use extremely aggressive tactics to break stalemates
          Object.assign(strategy, {
            aggression: 0.95, // More aggressive
            expansion: 0.85, // Focus on expansion
            riskTolerance: 0.9, // Much higher risk tolerance
            targetSelection: {
              ...strategy.targetSelection,
              specificPlayer: playerRankings[myRanking === 0 ? 1 : 0], // Target the other player
            },
          });
        } else {
          // Normal late game strategy for 3+ players
          if (myRanking === 0) {
            // Leading - eliminate second place
            Object.assign(strategy, {
              aggression: 0.8,
              expansion: 0.6,
              targetSelection: {
                ...strategy.targetSelection,
                specificPlayer: playerRankings[1],
              },
            });
          } else if (myRanking === 1) {
            // Second place - target leader
            Object.assign(strategy, {
              aggression: 0.8, // Increased from 0.7
              riskTolerance: 0.7, // Increased from 0.6
              targetSelection: {
                ...strategy.targetSelection,
                specificPlayer: playerRankings[0],
              },
            });
          } else {
            // Far behind - high risk strategy
            Object.assign(strategy, {
              aggression: 0.9,
              riskTolerance: 0.8,
              targetSelection: {
                ...strategy.targetSelection,
                weakestPlayer: true,
              },
            });
          }
        }
        break;
    }
  };

  // Apply game phase strategy adjustments
  adjustStrategyByPhase();

  // Adjust for dominant player presence
  if (gameState.dominantPlayer !== -1) {
    if (gameState.dominantPlayer === pn) {
      // We're dominant, play more defensively to maintain lead
      strategy.aggression = Math.max(0.3, strategy.aggression - 0.2);
      strategy.riskTolerance = Math.max(0.3, strategy.riskTolerance - 0.2);
    } else {
      // Someone else is dominant, focus on them
      strategy.targetSelection.dominantPlayer = true;
      strategy.aggression = Math.min(0.8, strategy.aggression + 0.1);
    }
  }

  // Adjust for territory connectivity
  const { player } = game;
  const { territories } = gameState;
  const consolidationRatio = player[pn].area_tc / territories.byPlayer[pn];

  if (consolidationRatio < 0.7) {
    // Our territories are fragmented, focus on consolidation
    strategy.expansion = Math.max(0.2, strategy.expansion - 0.3);
  }

  // Adjust for border pressure
  const borderRatio = gameState.borderTerritories[pn] / territories.byPlayer[pn];

  if (borderRatio > 0.7) {
    // Many border territories, need defensive reinforcement
    strategy.reinforcementFocus = 'defensive';
    strategy.aggression = Math.max(0.3, strategy.aggression - 0.1);
  } else if (strategy.aggression > 0.7) {
    // Highly aggressive, reinforce for offense
    strategy.reinforcementFocus = 'offensive';
  }

  // Adjust for stock (available reinforcement dice)
  if (player[pn].stock > 4) {
    // We have reinforcements, can be more aggressive
    strategy.riskTolerance = Math.min(0.8, strategy.riskTolerance + 0.1);
  }

  return strategy;
};

/**
 * Generate and evaluate all possible moves based on the current strategy
 *
 * @param {Object} game - The game state object
 * @param {Object} strategy - Strategic parameters
 * @param {number} pn - Current player number
 * @returns {Array} Sorted list of possible moves with their evaluated value
 */
const generateMoves = (game, strategy, pn) => {
  // Pre-calculate territory information to avoid redundant calculations
  const areaInfo = calculateAreaInfo(game);
  const { adat, AREA_MAX, dominantPlayer } = game;

  // Finding valid attacking territories (our territories with > 1 dice)
  const attackingTerritories = [...Array(AREA_MAX).keys()]
    .slice(1)
    .filter(i => adat[i].size !== 0 && adat[i].arm === pn && adat[i].dice > 1);

  // Generate all possible moves
  const moves = [];

  // For each potential attacker, find all targets
  attackingTerritories.forEach(from => {
    // Find all enemy territories we can attack
    const targets = [...Array(AREA_MAX).keys()]
      .slice(1)
      .filter(to => adat[to].size !== 0 && adat[to].arm !== pn && adat[from].join[to]);

    targets.forEach(to => {
      // Calculate dice advantage
      const attackerDice = adat[from].dice;
      const defenderDice = adat[to].dice;
      const diceAdvantage = attackerDice - defenderDice;

      /*
       * Skip if we don't have an advantage, with special handling for endgame scenarios
       * Count active players to determine if we're in endgame
       * The remainingPlayers is stored in the analysis result rather than directly passed
       */
      const activePlayersCount = Object.values(game.player).filter(p => p.area_c > 0).length;
      const isEndgame = activePlayersCount <= 2;
      const hasMaxDice = attackerDice === 8;

      // In endgame with 2 players, be more aggressive with max dice territories
      if (diceAdvantage <= 0) {
        // Allow attacking equal or slightly stronger territories in endgame if we have max dice
        if (isEndgame && hasMaxDice && (diceAdvantage >= -1 || strategy.aggression > 0.6)) {
          // Continue with attack evaluation in endgame
        } else if (hasMaxDice && strategy.aggression > 0.7) {
          // Continue with attack for non-endgame but highly aggressive with max dice
        } else {
          return; // Skip this attack - not favorable enough
        }
      }

      // Calculate attack risk
      const attackRisk = calculateAttackRisk(game, from, to, areaInfo);

      // Skip high-risk attacks if we're risk-averse
      if (attackRisk > 0.7 && strategy.riskTolerance < 0.4) return;

      // Calculate strategic value of this attack
      const strategicValue = calculateStrategicValue(game, from, to, areaInfo, strategy);

      // Target selection scoring
      let targetValue = 0;
      const defendingPlayer = adat[to].arm;

      // Target selection adjustments
      const { targetSelection } = strategy;

      // If targeting dominant player
      if (targetSelection.dominantPlayer && defendingPlayer === dominantPlayer) {
        targetValue += 3;
      }

      // If targeting weakest player
      if (targetSelection.weakestPlayer) {
        const weakestPlayer = findWeakestPlayer(game);
        if (defendingPlayer === weakestPlayer) {
          targetValue += 2;
        }
      }

      // If targeting specific player
      if (
        targetSelection.specificPlayer !== -1 &&
        defendingPlayer === targetSelection.specificPlayer
      ) {
        targetValue += 4;
      }

      // Check if this is a choke point
      const chokePointValue = strategy.prioritizeChokePoints && isChokePoint(game, to) ? 3 : 0;

      // Calculate risk adjustment factor
      const riskAdjustment = attackRisk * (1 - strategy.riskTolerance) * 5;

      // Calculate total move value
      const moveValue =
        diceAdvantage * 2 + strategicValue * 3 + targetValue + chokePointValue - riskAdjustment;

      // Add to possible moves
      moves.push({
        from,
        to,
        value: moveValue,
        diceAdvantage,
        risk: attackRisk,
        strategicValue,
        isChokePoint: chokePointValue > 0,
      });
    });
  });

  // Sort by value (highest first)
  return moves.sort((a, b) => b.value - a.value);
};

/**
 * Calculate territory information including neighboring territory analysis
 *
 * @param {Object} game - The game state object
 * @returns {Array} Information about each territory's neighbors
 */
const calculateAreaInfo = game => {
  const { adat, AREA_MAX } = game;
  const info = [];

  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size === 0) {
      info[i] = null;
      continue;
    }

    const owner = adat[i].arm;

    // Get all neighbors
    const neighbors = [...Array(AREA_MAX).keys()]
      .slice(1)
      .filter(j => j !== i && adat[j].size !== 0 && adat[i].join[j]);

    // Split neighbors by owner
    const friendlyNeighbors = neighbors.filter(j => adat[j].arm === owner);
    const unfriendlyNeighbors = neighbors.filter(j => adat[j].arm !== owner);

    // Calculate highest dice counts
    const highestFriendlyDice = friendlyNeighbors.length
      ? Math.max(...friendlyNeighbors.map(j => adat[j].dice))
      : 0;

    // Sort unfriendly neighbors by dice (descending)
    const unfriendlyDiceValues = unfriendlyNeighbors.map(j => adat[j].dice).sort((a, b) => b - a);

    info[i] = {
      friendly_neighbors: friendlyNeighbors.length,
      unfriendly_neighbors: unfriendlyNeighbors.length,
      highest_friendly_neighbor_dice: highestFriendlyDice,
      highest_unfriendly_neighbor_dice: unfriendlyDiceValues[0] || 0,
      second_highest_unfriendly_neighbor_dice: unfriendlyDiceValues[1] || 0,
      num_neighbors: neighbors.length,
    };
  }

  return info;
};

/**
 * Calculate the risk of an attack based on multiple factors
 *
 * @param {Object} game - The game state object
 * @param {number} from - Attacking territory ID
 * @param {number} to - Defending territory ID
 * @param {Array} areaInfo - Pre-calculated territory information
 * @returns {number} Risk factor between 0 (low risk) and 1 (high risk)
 */
const calculateAttackRisk = (game, from, to, areaInfo) => {
  const { adat } = game;
  const fromInfo = areaInfo[from];
  const toInfo = areaInfo[to];

  // Calculate various risk factors
  const riskFactors = {
    // Base risk from dice ratio (higher = more risk)
    diceRatio: (adat[to].dice / adat[from].dice) * 0.5,

    // Risk from exposing the attacking territory (more enemies = more risk)
    exposure: (fromInfo.unfriendly_neighbors / 6) * 0.3, // Normalize to 0-1

    // Risk from attacking a territory with strong friendly support
    enemySupport: toInfo.highest_friendly_neighbor_dice > adat[from].dice - 1 ? 0.3 : 0,

    // Risk from breaking a strong connected territory
    connectivity: fromInfo.friendly_neighbors === 1 ? 0.2 : 0,
  };

  // Sum all risk factors and clamp to 0-1 range
  return Math.min(
    1,
    Object.values(riskFactors).reduce((total, risk) => total + risk, 0)
  );
};

/**
 * Calculate the strategic value of an attack
 *
 * @param {Object} game - The game state object
 * @param {number} from - Attacking territory ID
 * @param {number} to - Defending territory ID
 * @param {Array} areaInfo - Pre-calculated territory information
 * @param {Object} strategy - Strategic parameters
 * @returns {number} Strategic value of the attack
 */
const calculateStrategicValue = (game, from, to, areaInfo, strategy) => {
  let value = 0;
  const { expansion, aggression } = strategy;
  const { adat } = game;

  // Calculate value based on expansion vs consolidation preference
  if (expansion > 0.5) {
    // Expansion value - favor territories that open up new attack options
    value += areaInfo[to].unfriendly_neighbors * 0.2 * expansion;
  } else {
    // Consolidation value - favor territories that reduce our exposed border
    const borderReduction = simulateBorderReduction(game, from, to);
    value += borderReduction * 0.3 * (1 - expansion);
  }

  // Calculate value based on aggression preference
  if (aggression > 0.5) {
    // Aggressive value - favor high-dice territories
    value += adat[to].dice * 0.1 * aggression;
  } else {
    // Defensive value - favor territories that improve our defensive position
    const defensiveImprovement = simulateDefensiveImprovement(game, from, to);
    value += defensiveImprovement * 0.2 * (1 - aggression);
  }

  // Value from connectivity improvement
  const connectivityValue = simulateConnectivityImprovement(game, from, to);
  value += connectivityValue * 0.3;

  return value;
};

/**
 * Find the weakest active player based on dice count
 *
 * @param {Object} game - The game state object
 * @returns {number} Player number of the weakest active player
 */
const findWeakestPlayer = game => {
  const { player } = game;

  // Filter active players and find the one with minimum dice
  return [...Array(getPlayerCount(game)).keys()]
    .filter(i => player[i].area_c > 0)
    .reduce((weakest, i) => (player[i].dice_c < player[weakest]?.dice_c ? i : weakest), -1);
};

/**
 * Check if a territory is a strategic choke point
 *
 * @param {Object} game - The game state object
 * @param {number} territory - Territory ID to check
 * @returns {boolean} True if the territory is a choke point
 */
const isChokePoint = (game, territory) => {
  const { adat, AREA_MAX } = game;

  // Count unique players connected to this territory
  const connectedPlayers = new Set();

  for (let i = 1; i < AREA_MAX; i++) {
    if (adat[i].size === 0 || !adat[territory].join[i]) continue;
    connectedPlayers.add(adat[i].arm);
  }

  // A territory connecting multiple players is likely a choke point
  return connectedPlayers.size >= 3;
};

/**
 * Simulate how an attack would reduce our border exposure
 *
 * @param {Object} game - The game state object
 * @param {number} from - Attacking territory ID
 * @param {number} to - Defending territory ID
 * @returns {number} Estimated border reduction factor
 */
const simulateBorderReduction = (game, from, to) => {
  const { adat, AREA_MAX } = game;
  const pn = game.get_pn();

  // Helper function to count border territories for a player
  const countBorderTerritories = () => {
    // Get all our territories
    const ourTerritories = [...Array(AREA_MAX).keys()]
      .slice(1)
      .filter(i => adat[i].size !== 0 && adat[i].arm === pn);

    // Count which ones are borders
    return ourTerritories.filter(i =>
      // A territory is a border if it has at least one enemy neighbor
      [...Array(AREA_MAX).keys()]
        .slice(1)
        .some(j => adat[j].size !== 0 && adat[i].join[j] && adat[j].arm !== pn)
    ).length;
  };

  // Count current border territories
  const currentBorders = countBorderTerritories();

  // Simulate capturing the target territory
  const originalOwner = adat[to].arm;
  adat[to].arm = pn;

  // Count borders after capture
  const newBorders = countBorderTerritories();

  // Restore original state
  adat[to].arm = originalOwner;

  // Calculate border reduction (if currentBorders is 0, return 0 to avoid division by zero)
  return currentBorders === 0 ? 0 : Math.max(0, (currentBorders - newBorders + 1) / currentBorders);
};

/**
 * Simulate how an attack would improve our defensive position
 *
 * @param {Object} game - The game state object
 * @param {number} from - Attacking territory ID
 * @param {number} to - Defending territory ID
 * @returns {number} Estimated defensive improvement factor
 */
const simulateDefensiveImprovement = (game, from, to) => {
  const { adat, AREA_MAX } = game;
  const pn = game.get_pn();

  // Helper function to calculate total threat (sum of enemy dice adjacent to our territories)
  const calculateThreat = () => {
    let threat = 0;

    // Get all our territories
    const ourTerritories = [...Array(AREA_MAX).keys()]
      .slice(1)
      .filter(i => adat[i].size !== 0 && adat[i].arm === pn);

    // For each of our territories, sum enemy dice adjacent to it
    ourTerritories.forEach(i => {
      // Get adjacent enemy territories
      const adjacentEnemies = [...Array(AREA_MAX).keys()]
        .slice(1)
        .filter(j => adat[j].size !== 0 && adat[i].join[j] && adat[j].arm !== pn);

      // Sum their dice
      adjacentEnemies.forEach(j => {
        threat += adat[j].dice;
      });
    });

    return threat;
  };

  // Calculate initial threat
  const initialThreat = calculateThreat();

  // Simulate capturing the target territory
  const originalOwner = adat[to].arm;
  adat[to].arm = pn;

  // Calculate new threat
  const newThreat = calculateThreat();

  // Restore original state
  adat[to].arm = originalOwner;

  // Calculate threat reduction (avoid division by zero)
  if (initialThreat === 0) return 0;

  return Math.max(0, (initialThreat - newThreat) / initialThreat);
};

/**
 * Simulate how an attack would improve our territory connectivity
 *
 * @param {Object} game - The game state object
 * @param {number} from - Attacking territory ID
 * @param {number} to - Defending territory ID
 * @returns {number} Estimated connectivity improvement factor
 */
const simulateConnectivityImprovement = (game, from, to) => {
  const { adat, player } = game;
  const pn = game.get_pn();

  // Save original connected territory count
  const originalConnected = player[pn].area_tc;

  // Simulate capturing the target territory
  const originalOwner = adat[to].arm;
  adat[to].arm = pn;

  // Recalculate connected territories
  game.set_area_tc(pn);
  const newConnected = player[pn].area_tc;

  // Restore original state
  adat[to].arm = originalOwner;
  game.set_area_tc(pn);

  // Calculate improvement ratio
  const totalTerritories = Math.max(1, player[pn].area_c);
  const improvement = (newConnected - originalConnected) / totalTerritories;

  return Math.max(0, improvement * 2);
};

/**
 * Select the best move from the evaluated options
 * Added special handling for endgame scenarios to break stalemates
 *
 * @param {Array} moves - Sorted list of possible moves
 * @param {Object} strategy - Strategic parameters
 * @returns {Object} The selected move to execute
 */
const selectBestMove = (moves, strategy) => {
  if (moves.length === 0) return null;

  // Identify if we're in an endgame scenario based on strategy aggression being very high
  const isEndgameScenario = strategy.aggression > 0.9 && strategy.riskTolerance > 0.8;

  // In endgame, introduce more randomness to break stalemates
  if (isEndgameScenario) {
    // Choose more randomly from good moves to create unpredictability
    const randomFactor = Math.min(0.7, strategy.riskTolerance);

    if (Math.random() < randomFactor) {
      // In endgame, consider a wider range of moves, up to half of all possible moves
      const endgameTopCount = Math.max(1, Math.ceil(moves.length * 0.5));
      const endgameTopMoves = moves.slice(0, Math.min(endgameTopCount, moves.length));

      // In rare cases, pick a completely random move to break patterns
      if (Math.random() < 0.2 && endgameTopMoves.length > 1) {
        return endgameTopMoves[Math.floor(Math.random() * endgameTopMoves.length)];
      }
    }
  }

  // Regular non-endgame randomness based on risk tolerance
  if (Math.random() < strategy.riskTolerance * 0.3) {
    // Select from top moves (more options with higher risk tolerance)
    const topCount = Math.max(1, Math.ceil(moves.length * strategy.riskTolerance * 0.5));
    const topMoves = moves.slice(0, Math.min(topCount, moves.length));
    return topMoves[Math.floor(Math.random() * topMoves.length)];
  }

  // Otherwise return the highest rated move
  return moves[0];
};
