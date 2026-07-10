/**
 * AI Configuration Module
 *
 * Central configuration for all AI strategies in the game.
 * This module provides a registry of AI strategies, metadata,
 * and utility functions for accessing them.
 *
 * `AI_STRATEGIES`' General (hand-written) entries are ordered strongest first, and
 * entries flagged `hidden` (the #164 roster trim) are filtered out of the title-screen
 * picker by {@link getAIStrategiesByCategory} while staying resolvable by id.
 *
 * Since #167, Defensive/Basic are picker-visible again (Easy-mode ingredients) while
 * staying hidden on the arena side — the two registries' hidden sets intentionally differ.
 */

// Loader functions for each AI strategy using dynamic import
export const load_ai_default = async () => (await import('./ai_default.js')).ai_default;
export const load_ai_defensive = async () => (await import('./ai_defensive.js')).ai_defensive;
export const load_ai_example = async () => (await import('./ai_example.js')).ai_example;
export const load_ai_adaptive = async () => (await import('./ai_adaptive.js')).ai_adaptive;
export const load_ai_strategist = async () => (await import('./ai_strategist.js')).ai_strategist;
export const load_ai_lookahead = async () => (await import('./ai_lookahead.js')).ai_lookahead;
export const load_ai_expectimax = async () => (await import('./ai_expectimax.js')).ai_expectimax;
/*
 * Personas (docs/ml-bot/PERSONAS.md) are modern `(BotState) => move` neural bots, not
 * legacy mutable-game-view AIs, so their loaders return them pre-wrapped by
 * `adaptModernBot` — the same reverse adapter community bots use. That tags them
 * `__modernBot` so the in-game `runAI` loop drives them with a sanitized BotState
 * instead of a legacy game view (which they cannot read — an unwrapped modern bot would
 * throw every turn). The arena/tournament screens use the RAW bots from `builtInBots.js`,
 * whose consumers already call `fn(botState)` directly, so no wrapper is needed there.
 *
 * Each persona ships its own weights: Conqueror the encoding-v3 net ([D-31], the strongest
 * net overall); Blitz and Survivor their v2 fine-tuned checkpoints. The internal
 * `ai_ppo`/`ai_bc` nets are NOT in this player-facing picker — they stay in
 * `builtInBots.js` (hidden) for the dev harness.
 */
export const load_ai_conqueror = async () => {
  const { ai_conqueror } = await import('./ai_conqueror.js');
  const { adaptModernBot } = await import('../arena/modernBotAdapter.js');
  return adaptModernBot(ai_conqueror, 'ai_conqueror');
};
export const load_ai_blitz = async () => {
  const { ai_blitz } = await import('./ai_blitz.js');
  const { adaptModernBot } = await import('../arena/modernBotAdapter.js');
  return adaptModernBot(ai_blitz, 'ai_blitz');
};
export const load_ai_survivor = async () => {
  const { ai_survivor } = await import('./ai_survivor.js');
  const { adaptModernBot } = await import('../arena/modernBotAdapter.js');
  return adaptModernBot(ai_survivor, 'ai_survivor');
};

/**
 * AI Strategy Registry
 *
 * Contains all available AI strategies with metadata.
 * Each entry provides:
 * - id: Unique identifier string for the AI
 * - name: Human-readable name
 * - description: Brief description of the AI's strategy
 * - difficulty: Relative difficulty (1-5)
 * - implementation: The actual AI function
 * - hidden: (optional) excluded from the player picker; still resolvable by id
 */
export const AI_STRATEGIES = {
  /*
   * General (hand-written) heuristics, strongest first — getAIStrategiesByCategory()
   * preserves this insertion order, and the title-screen picker renders it (#164).
   */
  ai_lookahead: {
    id: 'ai_lookahead',
    name: 'Lookahead AI',
    description: 'Searches win/loss branches with exact dice odds and board-value evaluation',
    difficulty: 5,
    loader: load_ai_lookahead,
    implementation: null,
  },
  ai_strategist: {
    id: 'ai_strategist',
    name: 'Strategist AI',
    description: 'Scores every attack by exact expected value of income and risk',
    difficulty: 5,
    loader: load_ai_strategist,
    implementation: null,
  },
  ai_adaptive: {
    id: 'ai_adaptive',
    name: 'Adaptive AI',
    description: 'Adapts strategy based on game conditions',
    difficulty: 4,
    loader: load_ai_adaptive,
    implementation: null,
  },
  ai_default: {
    id: 'ai_default',
    name: 'Balanced AI',
    description: 'A balanced approach that weighs attack and defense equally',
    difficulty: 3,
    loader: load_ai_default,
    implementation: null,
  },

  /*
   * Revived for the difficulty-mode lineups (#167): weak bots the Easy preset
   * uses, listed at the bottom of the picker's General section so Custom mode
   * can reproduce and tweak any preset. They stay OFF competitive surfaces —
   * builtInBots.js still flags them `hidden` there, so Arena/Tournament, the
   * CLI arena field, and the online tournament keep the curated 7. The two
   * registries' hidden flags diverge deliberately: aiConfig.hidden = "not
   * offered in the game-setup picker"; builtInBots.hidden = "not on
   * competitive surfaces".
   */
  ai_defensive: {
    id: 'ai_defensive',
    name: 'Defensive AI',
    description: 'Prioritizes protecting vulnerable territories',
    difficulty: 2,
    loader: load_ai_defensive,
    implementation: null,
  },
  ai_example: {
    id: 'ai_example',
    name: 'Basic AI',
    description: 'Simple implementation for educational purposes',
    difficulty: 1,
    loader: load_ai_example,
    implementation: null,
  },

  /*
   * Hidden from the player picker: at strength-parity with Lookahead, so it
   * reads as a duplicate (#164) — that reasoning covers Custom mode too (#167).
   * getAIStrategiesByCategory() filters `hidden`, but the entry stays
   * registered: getAIById/getAIImplementation still resolve it, and the mirror
   * flag lives in builtInBots.js for the arena side.
   */
  ai_expectimax: {
    id: 'ai_expectimax',
    name: 'Expectimax AI',
    description: 'Chance-node expectimax over win/loss outcomes weighted by exact dice odds',
    difficulty: 5,
    hidden: true,
    loader: load_ai_expectimax,
    implementation: null,
  },

  /*
   * Personas — the player-facing self-play roster (docs/ml-bot/PERSONAS.md). Each is a
   * single reactive forward pass (no search), so it plays on learned instinct. Conqueror
   * is the balanced flagship — since the [D-31] encoding-v3 ship, the strongest net
   * overall; Blitz closes games fast; Survivor outlasts the field. The internal PPO/BC
   * nets are hidden — see builtInBots.js.
   *
   * The rank claims in the descriptions are measured, not aspirational (#157 ladder
   * honesty; RESULTS.md 2026-07-10 fresh-seed matrix): in the shipped six-bot field
   * Blitz takes the most outright wins (35.3%), Survivor the best average placement
   * (2.66, top-2 in 55% of games), and Conqueror — who ties Blitz on placement — keeps
   * the head-to-head title from the [D-31]/[D-35] gates. Flat `difficulty: 5` across
   * the strong pack is deliberate: rank is carried by this copy and by section order,
   * because win-rate rank is field-dependent (§10.5) and a single number would lie.
   *
   * `category: 'self-play'` groups them under the picker's **Self-Play** section (shown
   * above the hand-written **General** bots) — see {@link getAIStrategiesByCategory}.
   */
  ai_conqueror: {
    id: 'ai_conqueror',
    name: 'Conqueror',
    description: 'Balanced self-play net that plays the long game — the strongest bot head-to-head',
    difficulty: 5,
    category: 'self-play',
    loader: load_ai_conqueror,
    implementation: null,
  },
  ai_blitz: {
    id: 'ai_blitz',
    name: 'Blitz',
    description:
      'Aggressive self-play net that ends games fast — most outright wins in the bot field',
    difficulty: 5,
    category: 'self-play',
    loader: load_ai_blitz,
    implementation: null,
  },
  ai_survivor: {
    id: 'ai_survivor',
    name: 'Survivor',
    description:
      'Patient self-play net that outlasts rivals — best average placement in the bot field',
    difficulty: 5,
    category: 'self-play',
    loader: load_ai_survivor,
    implementation: null,
  },
};

/**
 * Get AI information by ID
 * @param {string} aiId - The AI strategy ID
 * @returns {Object} AI strategy object with metadata and implementation
 */
export function getAIById(aiId) {
  return AI_STRATEGIES[aiId] || AI_STRATEGIES.ai_default;
}

/**
 * Get AI implementation function by ID
 * @param {string} aiId - The AI strategy ID
 * @returns {Function} The AI implementation function
 */
export async function getAIImplementation(aiId) {
  const strategy = AI_STRATEGIES[aiId] || AI_STRATEGIES.ai_default;
  if (!strategy.implementation) {
    strategy.implementation = await strategy.loader();
  }
  return strategy.implementation;
}

/**
 * Get all available AI strategies
 * Includes hidden entries — use getAIStrategiesByCategory() for player-facing lists.
 * @returns {Array} Array of AI strategy objects
 */
export function getAllAIStrategies() {
  return Object.values(AI_STRATEGIES);
}

/**
 * Partition the un-hidden strategies into the picker's two built-in sections,
 * preserving registry insertion order within each. `selfPlay` is the learned
 * neural roster (`category: 'self-play'` — the personas); `general` is
 * everything else (the hand-written heuristic AIs), strongest first per the
 * registry's insertion order (#164). Entries flagged `hidden` are filtered out
 * of both — they remain resolvable via getAIById/getAIImplementation, just not
 * listed in the picker. The Title Screen renders Self-Play above General.
 *
 * @returns {{ selfPlay: Array, general: Array }}
 */
export function getAIStrategiesByCategory() {
  const visible = Object.values(AI_STRATEGIES).filter(s => !s.hidden);
  return {
    selfPlay: visible.filter(s => s.category === 'self-play'),
    general: visible.filter(s => s.category !== 'self-play'),
  };
}

/**
 * Default AI assignments — mirrors the store's default lineup, which since
 * #167 is the Standard difficulty preset (DIFFICULTY_MODES.standard.lineup in
 * difficultyModes.js — literals here because that module imports this one;
 * the sync is pinned by tests/ai/aiConfig.test.js). Slot 0 is arbitrary (the
 * store uses null — the human seat); nothing consumes it. Currently unused at runtime
 * (createAIFunctionMapping has no callers); GameController reads the store
 * config instead.
 */
export const DEFAULT_AI_ASSIGNMENTS = [
  'ai_default', // Player 0 (the store uses null here — the human seat)
  'ai_default', // Player 1
  'ai_default', // Player 2
  'ai_default', // Player 3
  'ai_default', // Player 4
  'ai_default', // Player 5
  'ai_default', // Player 6
  'ai_default', // Player 7
];

/**
 * Create a mapping of player indices to AI implementation functions
 * @param {Array} aiAssignments - Array of AI strategy IDs for each player
 * @returns {Array} Array of AI implementation functions
 */
export async function createAIFunctionMapping(aiAssignments = DEFAULT_AI_ASSIGNMENTS) {
  const mappingPromises = aiAssignments.map(async aiId => {
    if (aiId === null) return null;
    try {
      return await getAIImplementation(aiId);
    } catch (err) {
      console.error(`Failed to load AI strategy ${aiId}`, err);
      return getAIImplementation('ai_default');
    }
  });
  return Promise.all(mappingPromises);
}
