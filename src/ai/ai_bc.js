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

import {
  assertPolicyEncodingCompatible,
  encodeObservationForInference,
} from '../arena/encodeObservation.js';

import { argmax, forward } from './bcForward.js';
import { BC_POLICY } from './bcPolicyWeights.js';

/*
 * Fail fast if the exported model cannot run against the live encoder: an
 * incompatible layout would feed the net mis-columned tensors and silently
 * corrupt every move. Since encoding-v3 ([D-31], append-only) this is a
 * SUPPORTED-set check, not strict equality — a v2-stamped policy is valid
 * because the v2 columns are an exact prefix of v3 and `forward`'s linear()
 * ignores the appended tail (weights drive the loop bounds).
 */
assertPolicyEncodingCompatible(BC_POLICY, 'ai_bc');

const CTX = { maxAreas: BC_POLICY.config.maxAreas };

/**
 * Build a BC bot, optionally with an inference-time STOP-logit bias.
 *
 * `stopBias` is subtracted from the trailing STOP edge's logit *before* the argmax,
 * so a positive value makes the bot less willing to end its turn (more aggressive);
 * `stopBias = 0` is the plain clone — and, since encoding-v2 ([D-18]), the shipped
 * default: the v2 features cured the turtle natively (native arena STOP ~53% at
 * `stopBias 0`, already near the teacher), so the clone wins ~12.5% vs Lookahead's ~17%
 * with NO bias and positive bias now only hurts. The knob is retained as a **no-retrain**
 * diagnostic — sweeping it over the *existing* exported weights probes whether a residual
 * gap is just a miscalibrated STOP threshold, without paying for a GPU retrain. (Under v1
 * it was a needed correction: the v1 clone over-predicted STOP (~68% of val decisions vs
 * the teacher's ~45%) and turtled to ~3.6% arena win until biased.) See
 * `scripts/bc-stopbias-sweep.mjs`.
 *
 * NB: a constant additive penalty, **not** a softmax temperature — a single global
 * temperature is argmax-invariant and would have no effect on the deployed argmax.
 *
 * @param {Object} [opts]
 * @param {number} [opts.stopBias=0] - Subtracted from the STOP logit before argmax.
 * @param {(stopped: boolean) => void} [opts.onDecision] - Called once per decision with
 *   whether the bot chose STOP — lets a sweep tally the realized STOP rate.
 * @param {import('./bcPolicyWeights.js').BC_POLICY} [opts.policy=BC_POLICY] - Override the
 *   deployed weights with an alternate exported policy. Used by the ml-bot capacity probe to
 *   arena-evaluate candidate checkpoints (e.g. wider nets) without overwriting the shipped
 *   `bcPolicyWeights.js`. Must be stamped with a SUPPORTED_ENCODING_VERSIONS entry.
 * @returns {(botState: import('../arena/types.js').BotState) => ({ from: number, to: number } | null)}
 */
export function makeBC({ stopBias = 0, onDecision, policy = BC_POLICY } = {}) {
  /*
   * A candidate policy must be runnable against the live encoder's feature layout,
   * exactly like the deployed default checked at import — an incompatible policy
   * would silently read mis-columned (or missing → NaN) tensors.
   */
  assertPolicyEncodingCompatible(policy, 'makeBC');
  const ctx = policy === BC_POLICY ? CTX : { maxAreas: policy.config.maxAreas };
  return function bc(botState) {
    const encoded = encodeObservationForInference(botState, ctx);
    const { logits } = forward(policy, encoded);

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
