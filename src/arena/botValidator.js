/**
 * Bot Validation
 *
 * Validates bot source code (syntax check) and bot move outputs
 * (structural and game-rule validation).
 *
 * @module arena/botValidator
 */

/**
 * Validate that bot source code can be parsed as a function body.
 *
 * @param {string} source - Bot source code
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateBotSource(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { valid: false, error: 'Bot source must be a non-empty string' };
  }

  try {
    // Attempt to parse the source as a function expression
    // eslint-disable-next-line no-new-func
    new Function('state', source);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Syntax error: ${err.message}` };
  }
}

/**
 * Validate a move returned by a bot against the current BotState.
 *
 * Checks structural validity (correct shape) and game-rule legality
 * (ownership, adjacency, dice count).
 *
 * @param {*} move - Value returned by the bot function
 * @param {import('./types.js').BotState} botState - Current sanitized state
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMove(move, botState) {
  // null means end turn — always valid
  if (move === null || move === undefined) {
    return { valid: true };
  }

  // Must be an object with numeric from and to
  if (typeof move !== 'object' || move === null) {
    return { valid: false, error: 'Move must be an object with { from, to } or null' };
  }

  const { from, to } = move;

  if (typeof from !== 'number' || typeof to !== 'number') {
    return { valid: false, error: 'Move.from and move.to must be numbers' };
  }

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { valid: false, error: 'Move.from and move.to must be integers' };
  }

  // Find the attacking territory
  const fromArea = botState.allAreas.find(a => a.id === from);
  if (!fromArea) {
    return { valid: false, error: `Territory ${from} does not exist` };
  }

  // Must own the attacking territory
  if (fromArea.owner !== botState.myPlayer) {
    return { valid: false, error: `Territory ${from} is not owned by player ${botState.myPlayer}` };
  }

  // Must have more than 1 die
  if (fromArea.dice <= 1) {
    return { valid: false, error: `Territory ${from} has only ${fromArea.dice} die (need > 1)` };
  }

  // Find the defending territory
  const toArea = botState.allAreas.find(a => a.id === to);
  if (!toArea) {
    return { valid: false, error: `Territory ${to} does not exist` };
  }

  // Must not attack own territory
  if (toArea.owner === botState.myPlayer) {
    return { valid: false, error: `Territory ${to} is owned by the same player` };
  }

  // Must be adjacent
  if (!fromArea.neighbors.includes(to)) {
    return { valid: false, error: `Territory ${from} is not adjacent to territory ${to}` };
  }

  return { valid: true };
}
