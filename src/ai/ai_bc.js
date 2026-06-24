/**
 * BC — the behavioral-cloning bot (ml-bot Phase 2).
 *
 * A small neural net trained to imitate the strongest heuristic (`ai_lookahead`)
 * from self-play, running fully in-browser as just another modern bot:
 * `(BotState) => { from, to } | null`. It encodes the live observation the same way
 * the trainer did (`encodeObservationForInference`), runs the synchronous pure-JS
 * forward pass (`bcForward.js`) over the exported weights (`bcPolicyWeights.js`), and
 * picks the argmax edge — an attack `{from,to}` or STOP (`null`, ending the turn).
 *
 * Inference is synchronous on purpose: the arena/in-game bot contract is sync, so we
 * run a hand-written forward rather than (async) ONNX Runtime Web. The ONNX export is
 * the canonical numeric reference the forward is cross-checked against (see
 * `tests/ai/bcForward.test.js`). Weights + their parity fixture are regenerated
 * together by `ml/dicewars_bc/export_weights.py`.
 *
 * @module ai/ai_bc
 */

import { ENCODING_VERSION, encodeObservationForInference } from '../arena/encodeObservation.js';

import { argmax, forward } from './bcForward.js';
import { BC_POLICY } from './bcPolicyWeights.js';

/*
 * Fail fast if the exported model and the live encoder disagree on the feature
 * layout: a version skew would feed the net mis-columned tensors and silently
 * corrupt every move. ENCODING_VERSION bumps in lockstep with the encoder.
 */
if (BC_POLICY.encodingVersion !== ENCODING_VERSION) {
  throw new Error(
    `ai_bc: model encodingVersion ${BC_POLICY.encodingVersion} != encoder ENCODING_VERSION ` +
      `${ENCODING_VERSION} — retrain/re-export the BC model against the current encoding.`
  );
}

const CTX = { maxAreas: BC_POLICY.config.maxAreas };

/**
 * The BC bot move function.
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export function ai_bc(botState) {
  const encoded = encodeObservationForInference(botState, CTX);
  const { logits } = forward(BC_POLICY, encoded);
  /*
   * moves[i] is {from,to} for an attack, null for the STOP edge — so argmax → STOP
   * naturally returns null (end turn). No masking needed: every edge is legal.
   */
  return encoded.moves[argmax(logits)];
}

export default ai_bc;
