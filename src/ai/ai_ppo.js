/**
 * PPO — the self-play reinforcement-learning bot (ml-bot Phase 3).
 *
 * Same in-browser machinery as the behavioral-cloning bot (`ai_bc`): it shares the
 * identical EdgePolicyNet architecture, the synchronous pure-JS forward pass
 * (`bcForward.js`), and the v2 observation encoder, so it runs as just another
 * modern bot — `(BotState) => { from, to } | null`. The ONLY difference is the
 * weights: instead of imitating `ai_lookahead` (what BC does), these were trained
 * by reinforcement learning — PPO self-play against a field of opponent bots. For
 * the training regime, provenance, and current status see `docs/ml-bot/`; the
 * per-export specifics live in the auto-generated header of `ppoPolicyWeights.js`.
 *
 * The exported symbol in `ppoPolicyWeights.js` is named `BC_POLICY` because both
 * the BC and PPO weights are emitted by the same exporter (`export_weights.py`);
 * we alias it to `PPO_POLICY` here so the source reads honestly. `makeBC`'s
 * encoder-version guard validates these weights at import time and throws if they
 * skew from the live encoder (mis-columned tensors → silently corrupt moves).
 *
 * @module ai/ai_ppo
 */

import { makeBC } from './ai_bc.js';
import { BC_POLICY as PPO_POLICY } from './ppoPolicyWeights.js';

/**
 * The PPO bot move function — the PPO policy run through the shared forward pass.
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export const ai_ppo = makeBC({ policy: PPO_POLICY });

export default ai_ppo;
