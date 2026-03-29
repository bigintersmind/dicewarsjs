/**
 * Legacy Bot Adapter
 *
 * Wraps legacy AI functions (which use the mutable game-view interface)
 * into new-style bot functions that accept BotState and return a move.
 *
 * @module arena/legacyBotAdapter
 */

// eslint-disable-next-line no-unused-vars -- used in JSDoc
import './types.js';

/**
 * Build a legacy mutable game view from a BotState.
 *
 * Mirrors the shape produced by engine/AIAdapter.createLegacyGameView
 * but sourced from the sanitized BotState instead of raw engine state.
 *
 * @param {import('./types.js').BotState} botState
 * @returns {Object} Mutable legacy game view
 */
function createLegacyViewFromBotState(botState) {
  const { allAreas, players, myPlayer, totalPlayers } = botState;

  // Determine AREA_MAX (highest area ID + 1)
  let maxId = 0;
  for (const area of allAreas) {
    if (area.id > maxId) maxId = area.id;
  }
  const AREA_MAX = maxId + 1;

  // Build adat[] in legacy shape: { size, arm, dice, join[] }
  const adat = new Array(AREA_MAX);
  // Initialize index 0 as empty sentinel
  adat[0] = { size: 0, arm: -1, dice: 0, join: new Array(AREA_MAX).fill(0) };

  // Pre-fill empty entries
  for (let i = 1; i < AREA_MAX; i++) {
    adat[i] = { size: 0, arm: -1, dice: 0, join: new Array(AREA_MAX).fill(0) };
  }

  // Fill in actual area data
  for (const area of allAreas) {
    const join = new Array(AREA_MAX).fill(0);
    for (const adjId of area.neighbors) {
      join[adjId] = 1;
    }
    adat[area.id] = {
      size: 1, // nonzero means "exists" — exact size not available from BotState
      arm: area.owner,
      dice: area.dice,
      join,
    };
  }

  // Build player[] in legacy shape (padded to 8)
  const player = new Array(8);
  for (let i = 0; i < 8; i++) {
    if (i < players.length) {
      const p = players[i];
      player[i] = {
        area_c: p.territories,
        dice_c: p.totalDice,
        area_tc: p.connectedTerritories,
        dice_jun: 0,
        stock: p.reinforcements,
      };
    } else {
      player[i] = { area_c: 0, dice_c: 0, area_tc: 0, dice_jun: 0, stock: 0 };
    }
  }

  // Build turn order — we only know myPlayer is current, fill rest sequentially
  const jun = new Array(8);
  jun[0] = myPlayer;
  let slot = 1;
  for (let i = 0; i < totalPlayers; i++) {
    if (i !== myPlayer) {
      jun[slot++] = i;
    }
  }
  // Pad remaining slots
  while (slot < 8) {
    jun[slot] = slot;
    slot++;
  }

  return {
    AREA_MAX,
    adat,
    player,
    jun,
    ban: 0, // myPlayer is always at index 0 in this view's jun
    area_from: 0,
    area_to: 0,
    get_pn() {
      return this.jun[this.ban];
    },
    set_area_tc() {
      // No-op: legacy code calls this to recalculate largest connected group
    },
  };
}

/**
 * Wrap a legacy AI function into a new-style bot function.
 *
 * The returned function accepts a BotState and returns { from, to } or null.
 * Legacy AIs that return 0 are mapped to null (end turn).
 *
 * @param {Function} legacyAiFn - Legacy AI function (gameView → void|0)
 * @param {string}   [name]     - Optional name for debugging
 * @returns {Function} New-style bot: (BotState) → { from, to } | null
 */
export function adaptLegacyBot(legacyAiFn, name) {
  const botName = name || legacyAiFn.name || 'legacy_bot';

  function wrappedBot(botState) {
    const view = createLegacyViewFromBotState(botState);
    let result;

    try {
      result = legacyAiFn(view);
    } catch (err) {
      console.warn(`Legacy bot "${botName}" threw: ${err.message}`);
      return null;
    }

    // Legacy AIs return 0 to end turn
    if (result === 0) return null;

    // Legacy AIs set area_from and area_to
    if (view.area_from > 0 && view.area_to > 0) {
      return { from: view.area_from, to: view.area_to };
    }

    return null;
  }

  // Preserve name for debugging
  Object.defineProperty(wrappedBot, 'name', { value: botName });
  return wrappedBot;
}
