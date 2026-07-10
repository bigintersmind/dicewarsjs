/**
 * Difficulty Modes (#167)
 *
 * Preset opponent lineups for the game-setup difficulty ladder. Each mode is
 * an explicit ordered 8-slot lineup of picker bot ids — slot 0 is the human
 * seat (null) — and the title screen slices it to the chosen player count, so
 * slot 1 is the mode's most representative opponent and small games get the
 * gentlest slice. Duplicate ids are legal: each slot resolves independently,
 * and the original game was literally ai_default in every seat.
 *
 * "Custom" is deliberately NOT an entry here. It has no preset lineup — it is
 * a UI-only concept: the title screen's per-slot picker, seeded from the
 * last-selected preset.
 *
 * Lineups are validated at import time against the picker registry
 * (AI_STRATEGIES): every id must resolve and must not be picker-hidden, so
 * Custom mode can always reproduce and tweak any preset. A typo'd id fails
 * the test suite at import, not a player's game — the same idiom as
 * builtInBots.js's STRENGTH_ORDER guards (#164).
 *
 * Future difficulty-tuned bots (the deliberate Standard→Hard strength gap —
 * see #167) land here as a data edit: register the bot, swap an id.
 *
 * @module ai/difficultyModes
 */

import { AI_STRATEGIES } from './aiConfig.js';

/** Every lineup covers the maximum table: 1 human seat + 7 AI seats. */
export const LINEUP_SLOTS = 8;

export const DIFFICULTY_MODES = {
  easy: {
    id: 'easy',
    name: 'Easy',
    description: 'Forgiving opponents — a first game you can win',
    lineup: [
      null,
      'ai_example',
      'ai_defensive',
      'ai_example',
      'ai_default',
      'ai_defensive',
      'ai_example',
      'ai_default',
    ],
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    description: 'The classic Dice Wars experience — the original game AI in every seat',
    lineup: [
      null,
      'ai_default',
      'ai_default',
      'ai_default',
      'ai_default',
      'ai_default',
      'ai_default',
      'ai_default',
    ],
  },
  hard: {
    id: 'hard',
    name: 'Hard',
    description: 'The strongest roster: the self-play personas lead the field',
    lineup: [
      null,
      'ai_conqueror',
      'ai_blitz',
      'ai_survivor',
      'ai_lookahead',
      'ai_strategist',
      'ai_adaptive',
      'ai_default',
    ],
  },
};

/**
 * Throw unless `lineup` is a valid preset: exactly LINEUP_SLOTS entries,
 * slot 0 null (the human seat), and every other slot a picker-visible bot id.
 *
 * Exported so tests can exercise the failure paths directly — the module's
 * own import-time pass below only ever sees valid data.
 *
 * @param {string} modeId - For the error message only.
 * @param {(string|null)[]} lineup
 * @param {Object} [registry] - AI_STRATEGIES-shaped map, injectable for tests.
 */
export function assertValidLineup(modeId, lineup, registry = AI_STRATEGIES) {
  if (!Array.isArray(lineup) || lineup.length !== LINEUP_SLOTS) {
    throw new Error(`Difficulty mode "${modeId}": lineup must have exactly ${LINEUP_SLOTS} slots`);
  }
  if (lineup[0] !== null) {
    throw new Error(`Difficulty mode "${modeId}": slot 0 is the human seat and must be null`);
  }
  for (const id of lineup.slice(1)) {
    const entry = registry[id];
    if (!entry) {
      throw new Error(`Difficulty mode "${modeId}": unknown bot id "${id}"`);
    }
    if (entry.hidden) {
      throw new Error(
        `Difficulty mode "${modeId}": bot "${id}" is hidden from the picker — Custom mode could not reproduce this preset`
      );
    }
  }
}

for (const mode of Object.values(DIFFICULTY_MODES)) {
  assertValidLineup(mode.id, mode.lineup);
}

/**
 * The preset lineup for a mode, sliced to the chosen player count.
 *
 * @param {string} modeId - A DIFFICULTY_MODES key ('custom' has no preset and throws).
 * @param {number} playerCount - 2–8; slot 0 of the result is the human seat.
 * @returns {(string|null)[]}
 */
export function lineupForMode(modeId, playerCount) {
  const mode = DIFFICULTY_MODES[modeId];
  if (!mode) {
    throw new Error(`Unknown difficulty mode "${modeId}"`);
  }
  return mode.lineup.slice(0, playerCount);
}
