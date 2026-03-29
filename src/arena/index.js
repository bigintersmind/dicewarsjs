/**
 * Arena barrel export
 *
 * @module arena
 */

export { createBotState } from './botState.js';
export { validateBotSource, validateMove } from './botValidator.js';
export { adaptLegacyBot } from './legacyBotAdapter.js';
export { runBotDirect, createBotWorker, runBotMove } from './botRunner.js';
export { runMatch } from './matchRunner.js';
export { runArena } from './arenaRunner.js';
export { updateEloRatings, expectedScore, DEFAULT_RATING, DEFAULT_K } from './elo.js';
export {
  createReplay,
  createReplayFromState,
  serializeReplay,
  deserializeReplay,
  replayToState,
  getReplayLength,
} from './replayFormat.js';
export { runRoundRobin, runSingleElimination } from './tournament.js';
// types.js is JSDoc-only — no runtime exports
