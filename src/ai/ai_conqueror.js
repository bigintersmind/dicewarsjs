/**
 * Conqueror — the balanced, win-maximizing persona (the player-facing flagship).
 *
 * One of the three shipped self-play "personas" (`docs/ml-bot/PERSONAS.md`). Conqueror
 * is the all-around bot: it plays for the win over a long horizon, the same objective
 * the 20M `ppo-long` actor was trained on. So rather than ship a separate (and, as the
 * 2026-06-30 pilot measured, ~7.6 pp WEAKER) fine-tuned `ppo-conqueror` checkpoint,
 * Conqueror simply IS `ppo-long` — the strongest balanced net we have — exported to
 * `ppoPolicyWeights.js`. It shares those exact weights with the hidden dev-harness `PPO`
 * bot; the two are the same policy under two names (player-facing vs. eval baseline).
 *
 * Runs as just another modern bot — `(BotState) => { from, to } | null` — over the
 * shared EdgePolicyNet + synchronous pure-JS forward pass (`bcForward.js`) and the v2
 * observation encoder. `makeBC`'s encoder-version guard validates the weights at import
 * time. The exported symbol in `ppoPolicyWeights.js` is named `BC_POLICY` (same exporter
 * for BC and PPO); we alias it to `CONQUEROR_POLICY` so the source reads honestly.
 *
 * @module ai/ai_conqueror
 */

import { makeBC } from './ai_bc.js';
import { BC_POLICY as CONQUEROR_POLICY } from './ppoPolicyWeights.js';

/**
 * The Conqueror bot move function — the balanced win-objective policy.
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export const ai_conqueror = makeBC({ policy: CONQUEROR_POLICY });

export default ai_conqueror;
