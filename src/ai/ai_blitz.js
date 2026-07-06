/**
 * Blitz — the fast, aggressive persona.
 *
 * One of the three shipped self-play "personas" (`docs/ml-bot/PERSONAS.md`). Blitz was
 * warm-started from the encoding-v3 base (`ppo-v3-scratch`, the net shipped as Conqueror)
 * and fine-tuned 3M steps with the win reward at a SHORT horizon (discount γ0.99 vs. the
 * balanced bot's γ0.999), which pushes it to close games out quickly and press attacks
 * harder than the balanced Conqueror. In the 2026-07-06 v3 grading it BEAT the prior v2
 * Blitz head-to-head (paired Δ +11.6 pp), tied the Conqueror base, and stayed well ahead
 * of `ai_lookahead` (+29.6 pp) — closing games ~30 turns sooner than the base.
 *
 * Runs as just another modern bot — `(BotState) => { from, to } | null` — over the
 * shared EdgePolicyNet + synchronous pure-JS forward pass (`bcForward.js`) and the v3
 * observation encoder. `makeBC`'s encoder-version guard validates the weights at import
 * time. The exported symbol in `blitzPolicyWeights.js` is named `BC_POLICY` (same
 * exporter for every net); we alias it to `BLITZ_POLICY` so the source reads honestly.
 *
 * @module ai/ai_blitz
 */

import { makeBC } from './ai_bc.js';
import { BC_POLICY as BLITZ_POLICY } from './blitzPolicyWeights.js';

/**
 * The Blitz bot move function — the short-horizon, aggressive policy.
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export const ai_blitz = makeBC({ policy: BLITZ_POLICY });

export default ai_blitz;
