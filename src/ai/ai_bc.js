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
 * Build a BC bot, optionally with an inference-time STOP-logit bias.
 *
 * `stopBias` is subtracted from the trailing STOP edge's logit *before* the argmax,
 * so a positive value makes the bot less willing to end its turn (more aggressive);
 * `stopBias = 0` is the plain clone. This is a **no-retrain** calibration knob for the
 * ml-bot Phase-2 STOP-bias diagnostic: the trained clone over-predicts STOP (~68% of
 * decisions vs ~45% for the teacher) and so plays too passively to win (the corrected
 * `stopBias = 0` control wins only ~3.6% vs the teacher's ~18%). Sweeping this
 * knob over the *existing* exported weights tells us whether the failure is just a
 * miscalibrated STOP threshold — and what STOP rate to target — before paying for a
 * class-weighted/focal-CE retrain on the GPU box. See `scripts/bc-stopbias-sweep.mjs`.
 *
 * NB: a constant additive penalty, **not** a softmax temperature — a single global
 * temperature is argmax-invariant and would have no effect on the deployed argmax.
 *
 * @param {Object} [opts]
 * @param {number} [opts.stopBias=0] - Subtracted from the STOP logit before argmax.
 * @param {(stopped: boolean) => void} [opts.onDecision] - Called once per decision with
 *   whether the bot chose STOP — lets a sweep tally the realized STOP rate.
 * @returns {(botState: import('../arena/types.js').BotState) => ({ from: number, to: number } | null)}
 */
export function makeBC({ stopBias = 0, onDecision } = {}) {
  return function bc(botState) {
    const encoded = encodeObservationForInference(botState, CTX);
    const { logits } = forward(BC_POLICY, encoded);

    /*
     * The encoder appends exactly one trailing STOP edge (moves[last] === null), so the
     * STOP logit is the last one. Assert that invariant before shifting it, so a future
     * encoder change biases nothing silently rather than mis-steering a real attack edge.
     */
    const stopIdx = logits.length - 1;
    if (encoded.moves[stopIdx] !== null) {
      throw new Error(
        'makeBC: trailing edge is not STOP (moves[last] !== null) — encoder layout changed.'
      );
    }
    logits[stopIdx] -= stopBias;

    /*
     * moves[i] is {from,to} for an attack, null for the STOP edge — so argmax → STOP
     * naturally returns null (end turn). No masking needed: every edge is legal.
     */
    const choice = argmax(logits);
    if (onDecision) onDecision(choice === stopIdx);
    return encoded.moves[choice];
  };
}

/**
 * The BC bot move function — the plain clone (`makeBC()`, i.e. `stopBias = 0`).
 * @param {import('../arena/types.js').BotState} botState
 * @returns {{ from: number, to: number } | null} An attack, or null to end the turn.
 */
export const ai_bc = makeBC();

export default ai_bc;
