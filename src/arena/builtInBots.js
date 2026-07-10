/**
 * Built-in Bot Registry
 *
 * Shared list of built-in bots adapted from legacy AI strategies.
 *
 * Two audiences read this list, distinguished by per-entry flags:
 *  - **Players** see {@link PLAYER_VISIBLE_BOTS} — a strength-ordered roster of exactly 7 bots
 *    (#164): the three self-play personas first, then hand-written heuristics by measured strength.
 *    The `hidden` flag covers both internal nets (`ai_bc`/`ai_ppo`) and trimmed heuristics
 *    (`ai_example`, `ai_defensive`, `ai_expectimax`). ArenaScreen, TournamentScreen, and the CLI
 *    default arena field import that derived list.
 *  - **The dev ML eval harness** (`ppo:gate`, `behavior:profile`, the PFSP league)
 *    imports the full `BUILT_IN_BOTS`, so `PPO` stays available as the strength baseline.
 *    The gate's reference field excludes `persona`-tagged bots (see `scripts/lib/ppo-gate-core.mjs`)
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
  /*
   * Hidden from players (#164 roster trim): a near-random educational stub. Kept
   * registered for the dev harness and BOT_GUIDE references; reachable by name
   * via CLI `--bots` filters.
   */
  { id: 'ai_example', name: 'Example', fn: adaptLegacyBot(ai_example, 'Example'), hidden: true },
  { id: 'ai_default', name: 'Default', fn: adaptLegacyBot(ai_default, 'Default') },
  /*
   * Hidden from players (#164): weak, with no distinct identity next to Default.
   * Still loaded by attract mode (ATTRACT_BOT_IDS) via aiConfig, not this list.
   */
  {
    id: 'ai_defensive',
    name: 'Defensive',
    fn: adaptLegacyBot(ai_defensive, 'Defensive'),
    hidden: true,
  },
  { id: 'ai_adaptive', name: 'Adaptive', fn: adaptLegacyBot(ai_adaptive, 'Adaptive') },
  { id: 'ai_strategist', name: 'Strategist', fn: adaptLegacyBot(ai_strategist, 'Strategist') },
  { id: 'ai_lookahead', name: 'Lookahead', fn: adaptLegacyBot(ai_lookahead, 'Lookahead') },
  /*
   * Hidden from players (#164): at strength-parity with Lookahead, so it reads as a
   * duplicate in the picker. Stays registered as the ML search-first baseline for the
   * dev harness (docs/ml-bot/).
   */
  {
    id: 'ai_expectimax',
    name: 'Expectimax',
    fn: adaptLegacyBot(ai_expectimax, 'Expectimax'),
    hidden: true,
  },
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
   * the encoding-v3 base net ([D-31] — the strongest net overall), Blitz a v3 fine-tune
   * of that base ([D-32]), Survivor its v2 fine-tuned checkpoint (the v3 retrain was
   * killed — [D-32]).
   */
  { id: 'ai_conqueror', name: 'Conqueror', fn: ai_conqueror, persona: true },
  { id: 'ai_blitz', name: 'Blitz', fn: ai_blitz, persona: true },
  { id: 'ai_survivor', name: 'Survivor', fn: ai_survivor, persona: true },
];

/**
 * The player-facing roster, strongest first: the three self-play personas, then the
 * hand-written heuristics by measured strength. Every arena-side list a player sees —
 * the Arena/Tournament screens, the CLI arena default field, and the online
 * tournament — derives from this array (#164). The title-screen picker instead reads
 * the sibling aiConfig.js registry, whose insertion order must be edited by hand to
 * match this one; the cross-registry drift tests pin the two orders together.
 *
 * An explicit id list (not a `.filter`) so the order is a deliberate roster decision;
 * the guards below throw at import time if it drifts from BUILT_IN_BOTS, so adding or
 * un-hiding a bot forces a conscious placement here.
 */
const STRENGTH_ORDER = [
  'ai_conqueror',
  'ai_blitz',
  'ai_survivor',
  'ai_lookahead',
  'ai_strategist',
  'ai_adaptive',
  'ai_default',
];

export const PLAYER_VISIBLE_BOTS = STRENGTH_ORDER.map(id => {
  const bot = BUILT_IN_BOTS.find(b => b.id === id);
  if (!bot || bot.hidden) {
    throw new Error(`STRENGTH_ORDER lists a missing or hidden bot: "${id}"`);
  }
  return bot;
});

const unlisted = BUILT_IN_BOTS.filter(b => !b.hidden && !STRENGTH_ORDER.includes(b.id));
if (unlisted.length > 0) {
  throw new Error(
    `Un-hidden built-in bot(s) missing from STRENGTH_ORDER: ${unlisted.map(b => b.id).join(', ')}`
  );
}
