/**
 * Survivor — the patient, placement-maximizing persona.
 *
 * One of the three shipped self-play "personas" (`docs/ml-bot/PERSONAS.md`). Survivor was
 * warm-started from `ppo-long` and fine-tuned on a PLACEMENT reward (climb the FFA
 * finishing order) rather than a binary win/loss signal. Counter-intuitively this dense
 * objective produced the best all-around bot in the 2026-06-30 pilot: it posts the best
 * average placement AND the highest win rate — it does NOT turtle, it just dies early far
 * less often. It is the only persona to BEAT `ppo-long` head-to-head (paired Δ +8.4 pp), and
 * was the strongest net the game shipped until the encoding-v3 Conqueror beat it head-to-head
 * ([D-31] +5.5 pp). Its v3 retrain was killed on three independent bars — v2 stays ([D-32]).
 *
 * Runs as just another modern bot — `(BotState) => { from, to } | null` — over the
 * shared EdgePolicyNet + synchronous pure-JS forward pass (`bcForward.js`) and the v2
 * observation encoder. `makeBC`'s encoder-version guard validates the weights at import
 * time. The exported symbol in `survivorPolicyWeights.js` is named `BC_POLICY` (same
 * exporter for every net); we alias it to `SURVIVOR_POLICY` so the source reads honestly.
 *
 * @module ai/ai_survivor
 */

import { makeBC } from './ai_bc.js';
import { BC_POLICY as SURVIVOR_POLICY } from './survivorPolicyWeights.js';

/**
 * The Survivor bot move function — the placement-maximizing policy.
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export const ai_survivor = makeBC({ policy: SURVIVOR_POLICY });

export default ai_survivor;
