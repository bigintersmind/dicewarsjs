/**
 * Engine Constants
 *
 * Shared numeric constants for the game engine.
 *
 * @module engine/constants
 */

/** Default map width in cells */
export const DEFAULT_XMAX = 28;

/** Default map height in cells */
export const DEFAULT_YMAX = 32;

/** Default maximum number of territories */
export const DEFAULT_AREA_MAX = 32;

/** Maximum dice per territory */
export const MAX_DICE = 8;

/**
 * Maximum luck-handicap level (issue #179) — the ceiling `createGame` enforces
 * on `config.handicap.level`.
 *
 * Set to MAX_DICE: the handicapped seat rolls `n + level` dice and drops the
 * `level` lowest, so more extra dice than a full stack holds has no meaning. It
 * is also the guard that keeps an untrusted record (a replay JSON claiming
 * `level: 1e9`) from stalling the battle reducer in `rollAdvantage`.
 */
export const MAX_HANDICAP_LEVEL = MAX_DICE;

/** Maximum reinforcement stock a player can hold */
export const STOCK_MAX = 64;

/** Default number of players */
export const DEFAULT_PLAYER_COUNT = 7;

/** Default average dice placed per territory at start */
export const DEFAULT_DICE_PER_AREA = 3;

/** Minimum territory size in cells (areas smaller than this are discarded) */
export const MIN_TERRITORY_SIZE = 6;

/** Number of hex directions (0-5) */
export const HEX_DIRECTIONS = 6;

/** Action type constants for state transitions */
export const ACTION_TYPES = Object.freeze({
  ATTACK: 'ATTACK',
  END_TURN: 'END_TURN',
});

/** Game phase constants */
export const GAME_PHASES = Object.freeze({
  PLAYING: 'playing',
  GAME_OVER: 'gameOver',
});
