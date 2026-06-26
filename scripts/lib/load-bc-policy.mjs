/**
 * Load + parity-check an exported `EdgePolicyNet` policy (`BC_POLICY`) module.
 *
 * Both the ml-bot capacity probe (`_probe-capacity-arena.mjs`) and the Phase-3 PPO
 * gate (`ppo-gate.mjs`) arena-evaluate a policy exported by
 * `ml/dicewars_bc/export_weights.py`. Before trusting any such net in the arena they
 * MUST cross-check its pure-JS forward (`bcForward.js`) against the Python reference
 * logits shipped alongside it (the `--fixture` JSON). This module is the single
 * source of truth for that "trust this exported policy" step so the probe and the
 * gate can't drift apart.
 *
 * The parity pre-flight is not optional: it is the only thing standing between a
 * numerically broken export (wrong dims, stale encoding, a botched repack) and a
 * fake win-rate signal. Fail loud rather than silently grading an un-cross-checked
 * net.
 *
 * @module scripts/lib/load-bc-policy
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { forward, argmax } from '../../src/ai/bcForward.js';

/**
 * Default max absolute logit error tolerated between the JS forward and the
 *  Python reference. float32 (torch) vs double (JS) accumulation slack is ~1e-6 for
 *  this tiny net; 1e-3 is a loose trust bound that still catches a broken export.
 */
export const PARITY_TOL = 1e-3;

/**
 * Derive the sibling parity-fixture path for an exported weights module.
 *
 * Convention: `foo.weights.js` ↔ `foo.fixture.json` (the capacity probe's layout).
 * A weights file not ending in `.weights.js` (e.g. the deployed
 * `bcPolicyWeights.js`, whose fixture lives under `tests/fixtures/bc/`) has no
 * sibling fixture — callers must pass `fixturePath` explicitly for those.
 *
 * @param {string} weightsPath
 * @returns {string} the sibling `.fixture.json` path
 */
export function siblingFixturePath(weightsPath) {
  return weightsPath.replace(/\.weights\.js$/, '.fixture.json');
}

/**
 * Count trainable params in an exported policy (sum over every Linear's W + b).
 * @param {{ layers: Record<string, Array<{w:number[][], b:number[]}>> }} policy
 * @returns {number}
 */
export function countParams(policy) {
  let n = 0;
  for (const head of Object.values(policy.layers)) {
    for (const layer of head) n += layer.w.length * layer.w[0].length + layer.b.length;
  }
  return n;
}

/**
 * Replay a parity fixture through the JS forward and return the worst logit error.
 *
 * Asserts the JS forward reproduces the Python reference logits within `tol` AND
 * picks the same argmax (the actually-chosen action) on every case — the practical
 * invariant the deployed bot relies on. Throws on the first violation.
 *
 * @param {object} policy - the exported `BC_POLICY`
 * @param {{ cases: Array<object> }} fixture - parsed `--fixture` JSON
 * @param {object} [opts]
 * @param {number} [opts.tol=PARITY_TOL]
 * @param {string} [opts.label='policy'] - name used in error messages
 * @returns {number} the max absolute logit error across all cases
 */
export function checkParity(policy, fixture, { tol = PARITY_TOL, label = 'policy' } = {}) {
  if (!fixture || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error(`parity fixture for ${label} has no cases — re-export with --fixture.`);
  }
  /*
   * Feature-layout guard: the fixture and the weights must agree on the encoding's
   * feature widths or the JS forward is fed mis-columned tensors. export_weights writes
   * both from one model, so a mismatch means a stale/hand-edited pairing — fail loud
   * here with a precise message, ahead of the per-logit check below. (That check also
   * rejects the resulting non-finite logits, but as a blunter "non-finite logit" error.)
   */
  if (fixture.config && policy.config) {
    for (const k of [
      'maxAreas',
      'nodeFeatures',
      'playerFeatures',
      'boardFeatures',
      'edgeFeatures',
    ]) {
      if (fixture.config[k] !== policy.config[k]) {
        throw new Error(
          `parity FAIL for ${label}: config.${k} mismatch (fixture=${fixture.config[k]}, ` +
            `weights=${policy.config[k]}) — fixture and weights are from different models.`
        );
      }
    }
  }
  let maxErr = 0;
  for (let ci = 0; ci < fixture.cases.length; ci++) {
    const c = fixture.cases[ci];
    const { logits } = forward(policy, {
      nodes: c.nodes,
      players: c.players,
      board: c.board,
      edges: c.edges,
      edgeIndex: c.edgeIndex,
    });
    if (logits.length !== c.logits.length) {
      throw new Error(
        `parity FAIL for ${label} (case ${ci}): JS produced ${logits.length} logits, ` +
          `fixture has ${c.logits.length} — encoder/export edge-count mismatch.`
      );
    }
    for (let i = 0; i < logits.length; i++) {
      const err = Math.abs(logits[i] - c.logits[i]);
      /*
       * Reject a non-finite diff explicitly. A NaN/Inf logit is the classic symptom of
       * a mis-dimensioned or mis-columned export, and it is silent here otherwise:
       * Math.max is NaN-sticky and `NaN > tol` is `false`, so the tolerance check below
       * would PASS a numerically broken net — the exact failure this pre-flight exists
       * to catch (the argmax check only trips if the poisoned argmax happens to differ).
       */
      if (!Number.isFinite(err)) {
        throw new Error(
          `parity FAIL for ${label} (case ${ci}, edge ${i}): non-finite logit ` +
            `(JS=${logits[i]}, ref=${c.logits[i]}) — wrong dims or a mis-columned input.`
        );
      }
      maxErr = Math.max(maxErr, err);
    }
    if (argmax(logits) !== argmax(c.logits)) {
      throw new Error(
        `parity FAIL for ${label} (case ${ci}): JS argmax ${argmax(logits)} != ` +
          `Python argmax ${argmax(c.logits)} — the JS net would pick a different action.`
      );
    }
  }
  /*
   * maxErr is finite here: the per-edge guard above throws on any non-finite diff
   * before it can reach this Math.max, so a plain tolerance compare is sufficient.
   */
  if (maxErr > tol) {
    throw new Error(
      `parity FAIL for ${label}: maxErr=${maxErr.toExponential(2)} > tol=${tol.toExponential(2)}`
    );
  }
  return maxErr;
}

/**
 * Dynamic-import an exported weights module and parity-check it against its fixture.
 *
 * @param {object} args
 * @param {string} args.weightsPath - path to a `*.weights.js` (or `bcPolicyWeights.js`) module
 * @param {string} [args.fixturePath] - parity fixture; defaults to the sibling `.fixture.json`
 * @param {number} [args.tol=PARITY_TOL]
 * @param {string} [args.label] - name for error messages (defaults to the weights filename)
 * @returns {Promise<{ policy: object, parity: number, params: number }>}
 */
export async function loadExportedPolicy({ weightsPath, fixturePath, tol = PARITY_TOL, label }) {
  const name = label ?? weightsPath;
  if (!existsSync(weightsPath)) {
    throw new Error(`weights not found: ${weightsPath}`);
  }
  const mod = await import(pathToFileURL(weightsPath).href);
  const policy = mod.BC_POLICY;
  if (!policy) {
    throw new Error(`${name} did not export BC_POLICY (got ${typeof policy}).`);
  }

  const fxPath = fixturePath ?? siblingFixturePath(weightsPath);
  if (!existsSync(fxPath)) {
    throw new Error(
      `parity fixture not found for ${name}: ${fxPath} — export weights with --fixture so the ` +
        `JS forward can be cross-checked before this net is trusted in the arena.`
    );
  }
  const fixture = JSON.parse(readFileSync(fxPath, 'utf8'));
  const parity = checkParity(policy, fixture, { tol, label: name });
  return { policy, parity, params: countParams(policy) };
}
