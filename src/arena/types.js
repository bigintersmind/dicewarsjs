/**
 * Arena Type Definitions (JSDoc only — no runtime code)
 *
 * @module arena/types
 */

/**
 * Sanitized game state provided to bot functions.
 * Contains only information a player could observe by looking at the board.
 *
 * @typedef {Object} BotState
 * @property {number}      myPlayer       - Current player ID
 * @property {number}      turnNumber     - Current turn number (full-roster rounds)
 * @property {number}      turnsTaken     - Completed player-turns so far — the unit the match
 *   runner's turn count and its truncation cap use (turnNumber counts rounds, a different unit)
 * @property {number}      totalPlayers   - Total player count (including eliminated)
 * @property {number}      activePlayers  - Non-eliminated player count
 * @property {'early'|'mid'|'late'} gamePhase - Estimated game phase
 * @property {BotArea[]}   myAreas        - Territories owned by this player
 * @property {BotArea[]}   allAreas       - All territories on the board
 * @property {BotPlayer[]} players        - All player stats
 */

/**
 * Sanitized territory data visible to bots.
 *
 * @typedef {Object} BotArea
 * @property {number}   id        - Territory ID (1-based)
 * @property {number}   owner     - Player index who owns this territory
 * @property {number}   dice      - Current dice count (1–8)
 * @property {number[]} neighbors - IDs of adjacent territories
 * @property {boolean}  isBorder  - True if any neighbor has a different owner
 */

/**
 * Sanitized player data visible to bots.
 *
 * @typedef {Object} BotPlayer
 * @property {number}  id                   - Player index (0-based)
 * @property {number}  territories          - Number of territories owned
 * @property {number}  totalDice            - Total dice across all territories
 * @property {number}  connectedTerritories - Size of largest connected group
 * @property {number}  reinforcements       - Dice in reserve stock
 * @property {boolean} eliminated           - Whether this player has been eliminated
 * @property {number}  turnsUntilActs       - Turn-advances until this player acts, skipping
 *   eliminated seats (0 = the acting player; eliminated players are 0, disambiguated by
 *   `eliminated`)
 */

/**
 * A move returned by a bot function.
 *
 * @typedef {Object} BotMove
 * @property {number} from - Attacking territory ID
 * @property {number} to   - Defending territory ID
 */
