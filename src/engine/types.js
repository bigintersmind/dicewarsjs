/**
 * Engine Type Definitions (JSDoc only — no runtime code)
 *
 * @module engine/types
 */

/**
 * @typedef {Object} GameConfig
 * @property {number} [mapWidth=28]          - Grid width in cells
 * @property {number} [mapHeight=32]         - Grid height in cells
 * @property {number} [maxAreas=32]          - Maximum number of territories
 * @property {number} [playerCount=7]        - Number of players
 * @property {number} [dicePerArea=3]        - Average starting dice per territory
 * @property {number} [seed]                 - RNG seed (random if omitted)
 * @property {LuckHandicap|null} [handicap=null] - Optional per-seat advantage dice (issue #179);
 *                                             null (default) means no handicap.
 * @property {boolean} [recordHistory=true]  - When false (training mode), suppresses the
 *                                             per-move history append; requires an explicit seed.
 */

/**
 * Luck handicap: the named seat rolls `n + level` dice and drops the `level`
 * lowest, both when attacking and when defending. Never set on competitive
 * surfaces (arena / tournament / leaderboard).
 *
 * @typedef {Object} LuckHandicap
 * @property {number} playerId - Seat index that gets the advantage dice
 * @property {number} level    - Extra dice rolled and dropped (integer >= 1)
 */

/**
 * @typedef {Object} HexGrid
 * @property {number}     width     - Grid width in cells
 * @property {number}     height    - Grid height in cells
 * @property {number}     cellCount - Total cells (width * height)
 * @property {number[][]} adjacency - adjacency[cellIndex] → array of 6 neighbor indices (-1 if out of bounds)
 */

/**
 * @typedef {Object} Area
 * @property {number}   id        - Territory ID (1-based)
 * @property {number}   size      - Number of cells in this territory
 * @property {number}   owner     - Player index who owns this territory (-1 = unowned)
 * @property {number}   dice      - Current dice count (1–8)
 * @property {number[]} neighborAreaIds - IDs of adjacent territories
 * @property {number}   centerCell - Cell index nearest the territory center
 * @property {number[]} cells     - Cell indices belonging to this territory
 */

/**
 * @typedef {Object} Player
 * @property {number}  id             - Player index (0-based)
 * @property {number}  territoryCount - Number of territories owned
 * @property {number}  diceCount      - Total dice across all territories
 * @property {number}  largestGroup   - Size of largest connected territory group
 * @property {number}  stock          - Reinforcement dice in reserve
 * @property {boolean} eliminated     - Whether this player has been eliminated
 */

/**
 * @typedef {'playing'|'gameOver'} GamePhase
 */

/**
 * @typedef {Object} GameState
 * @property {GameConfig} config             - Configuration this game was created with
 * @property {HexGrid}    grid               - Hex grid geometry
 * @property {Area[]}     areas              - Territory data (index 0 unused; 1..maxAreas)
 * @property {Player[]}   players            - Player data (index 0..playerCount-1)
 * @property {number[]}   turnOrder          - Shuffled player indices
 * @property {number}     currentPlayerIndex - Index into turnOrder for current player
 * @property {number}     turnNumber         - Increments each full round
 * @property {number}     turnsTaken         - Completed player-turns (one per END_TURN — the unit
 *                                             matchRunner's turnCount/truncation cap uses)
 * @property {GamePhase}  phase              - Current game phase
 * @property {HistoryEntry[]} history         - All actions applied so far
 * @property {number}     rngState           - Current RNG state (uint32)
 * @property {number|null} winner            - Winning player index, or null
 */

/**
 * @typedef {AttackAction|EndTurnAction} Action
 *
 * Note: Player elimination is handled implicitly by recalcPlayerStats
 * after territory ownership changes, not via an explicit action.
 */

/**
 * @typedef {Object} AttackAction
 * @property {'ATTACK'} type
 * @property {number}   from - Attacking territory ID
 * @property {number}   to   - Defending territory ID
 */

/**
 * @typedef {Object} EndTurnAction
 * @property {'END_TURN'} type
 */

/**
 * @typedef {Object} AttackHistoryEntry
 * @property {'ATTACK'} type
 * @property {number}   from   - Attacking territory ID
 * @property {number}   to     - Defending territory ID
 * @property {BattleResult} result - Battle outcome (added by applyAttack)
 */

/**
 * @typedef {AttackHistoryEntry|EndTurnAction} HistoryEntry
 */

/**
 * @typedef {Object} BattleResult
 * @property {{values: number[], total: number, dropped: number[]}} attackerRoll
 * @property {{values: number[], total: number, dropped: number[]}} defenderRoll
 * @property {boolean} success - True if attacker wins
 */

/**
 * @typedef {Object} Move
 * @property {number} from         - Attacking territory ID
 * @property {number} to           - Defending territory ID
 * @property {number} attackerDice - Dice in attacking territory
 * @property {number} defenderDice - Dice in defending territory
 */
