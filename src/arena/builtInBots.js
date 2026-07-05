/**
 * Built-in Bot Registry
 *
 * Shared list of built-in bots adapted from legacy AI strategies.
 *
 * Two audiences read this list, distinguished by per-entry flags:
 *  - **Players** see {@link PLAYER_VISIBLE_BOTS} — everything except `hidden` bots.
 *    ArenaScreen and TournamentScreen import that derived list. `ai_bc`/`ai_ppo` are
 *    `hidden: true`: BC is an early imitation run and PPO is an internal training name,
 *    so neither is shown in-game; the player-facing nets are the three personas.
 *  - **The dev ML eval harness** (`ppo:gate`, `behavior:profile`, the PFSP league)
 *    imports the full `BUILT_IN_BOTS`, so `PPO` stays available as the strength baseline.
 *    The gate's reference field excludes `persona`-tagged bots (see `ppo-gate-core.js`)
 *    so adding personas here does NOT change the canonical gate table.
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
import { ai_conqueror } from '../ai/ai_conqueror.js';
import { ai_blitz } from '../ai/ai_blitz.js';
import { ai_survivor } from '../ai/ai_survivor.js';

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
   * `hidden`: an early imitation run, kept for the eval harness but not shown to players.
   */
  { id: 'ai_bc', name: 'BC', fn: ai_bc, hidden: true },
  /*
   * PPO — the self-play RL net (Phase 3), aka `ppo-long`. Like BC, already a modern
   * `(BotState) => move` bot, so it registers RAW. `hidden`: "PPO" is an internal
   * training name, so it's not shown in-game — but it stays in BUILT_IN_BOTS as the
   * strength baseline the ML gate measures personas against. (Its v2 `ppo-long`
   * weights are frozen for that role; the player-facing Conqueror moved on to the
   * stronger encoding-v3 net in 2026-07, so the two are no longer the same policy.)
   */
  { id: 'ai_ppo', name: 'PPO', fn: ai_ppo, hidden: true },
  /*
   * Personas (docs/ml-bot/PERSONAS.md) — the player-facing self-play roster, each a
   * RAW modern bot. `persona: true` keeps them out of the canonical `ppo:gate` reference
   * field (so the documented baselines stay fixed) while still appearing in the in-game
   * arena/tournament and the online tournament. Each ships its own weights: Conqueror
   * the encoding-v3 net ([D-31] — the strongest net overall), Blitz/Survivor their v2
   * fine-tuned checkpoints.
   */
  { id: 'ai_conqueror', name: 'Conqueror', fn: ai_conqueror, persona: true },
  { id: 'ai_blitz', name: 'Blitz', fn: ai_blitz, persona: true },
  { id: 'ai_survivor', name: 'Survivor', fn: ai_survivor, persona: true },
];

/**
 * The player-facing roster: every built-in bot except those flagged `hidden`
 * (the dev-only `BC`/`PPO` nets). The Arena and Tournament screens render this list;
 * the ML eval harness keeps using the full {@link BUILT_IN_BOTS}.
 */
export const PLAYER_VISIBLE_BOTS = BUILT_IN_BOTS.filter(b => !b.hidden);
