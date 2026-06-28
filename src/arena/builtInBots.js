/**
 * Built-in Bot Registry
 *
 * Shared list of built-in bots adapted from legacy AI strategies.
 * Used by ArenaScreen and TournamentScreen.
 *
 * @module arena/builtInBots
 */

import { adaptLegacyBot } from './legacyBotAdapter.js';
import { ai_example } from '../ai/ai_example.js';
import { ai_default } from '../ai/ai_default.js';
import { ai_defensive } from '../ai/ai_defensive.js';
import { ai_adaptive } from '../ai/ai_adaptive.js';
import { ai_strategist } from '../ai/ai_strategist.js';
import { ai_lookahead } from '../ai/ai_lookahead.js';
import { ai_expectimax } from '../ai/ai_expectimax.js';
import { ai_bc } from '../ai/ai_bc.js';
import { ai_ppo } from '../ai/ai_ppo.js';

export const BUILT_IN_BOTS = [
  { id: 'ai_example', name: 'Example', fn: adaptLegacyBot(ai_example, 'Example') },
  { id: 'ai_default', name: 'Default', fn: adaptLegacyBot(ai_default, 'Default') },
  { id: 'ai_defensive', name: 'Defensive', fn: adaptLegacyBot(ai_defensive, 'Defensive') },
  { id: 'ai_adaptive', name: 'Adaptive', fn: adaptLegacyBot(ai_adaptive, 'Adaptive') },
  { id: 'ai_strategist', name: 'Strategist', fn: adaptLegacyBot(ai_strategist, 'Strategist') },
  { id: 'ai_lookahead', name: 'Lookahead', fn: adaptLegacyBot(ai_lookahead, 'Lookahead') },
  { id: 'ai_expectimax', name: 'Expectimax', fn: adaptLegacyBot(ai_expectimax, 'Expectimax') },
  /*
   * BC — the behavioral-cloning net. Already a modern `(BotState) => move` bot, so it
   * registers RAW: every BUILT_IN_BOTS consumer (the CLI scripts, ArenaScreen,
   * TournamentScreen) runs bots through runMatch/runBotDirect, which calls `fn(botState)`
   * — exactly ai_bc's contract. (adaptModernBot is for the in-game `runAI` loop, which
   * passes a GameState and does NOT use this list; wrapping here made BC throw every turn —
   * its wrapper dereferences `state.turnOrder`, a field a BotState lacks.)
   */
  { id: 'ai_bc', name: 'BC', fn: ai_bc },
  /*
   * PPO — the self-play RL net (Phase 3). Like BC, already a modern
   * `(BotState) => move` bot, so it registers RAW (every BUILT_IN_BOTS consumer
   * runs bots through runMatch/runBotDirect, which calls `fn(botState)`). Wrapping
   * it with adaptModernBot here would make it throw every turn — see the BC note above.
   */
  { id: 'ai_ppo', name: 'PPO', fn: ai_ppo },
];
