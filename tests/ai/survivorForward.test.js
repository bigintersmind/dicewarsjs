/**
 * JS↔Python parity for the exported **Survivor** persona policy (docs/ml-bot/PERSONAS.md).
 *
 * Survivor is a self-play net warm-started from `ppo-long` and fine-tuned on a placement
 * reward (the only persona to beat `ppo-long` head-to-head), exported by
 * `ml/dicewars_bc/export_weights.py` to `src/ai/survivorPolicyWeights.js` + the
 * `tests/fixtures/bc/survivorForwardCases.json` parity fixture. This asserts the
 * in-browser JS forward reproduces the Python reference logits (and picks the same action)
 * for the Survivor net exactly as `ppoForward.test.js` does for the PPO net.
 *
 * Skips cleanly until those artifacts exist (a torch box produces the fixture).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExportedPolicy } from '../../scripts/lib/load-bc-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const WEIGHTS = resolve(root, 'src/ai/survivorPolicyWeights.js');
const FIXTURE = resolve(root, 'tests/fixtures/bc/survivorForwardCases.json');
const present = existsSync(WEIGHTS) && existsSync(FIXTURE);

describe.skipIf(!present)('survivorForward — JS↔Python parity (Survivor export)', () => {
  it('the JS forward reproduces the Python reference logits + argmax for every case', async () => {
    /*
     * loadExportedPolicy runs the full parity pre-flight (per-logit tolerance +
     * exact argmax match) and throws on any mismatch.
     */
    const { policy, parity, params } = await loadExportedPolicy({
      weightsPath: WEIGHTS,
      fixturePath: FIXTURE,
      label: 'Survivor',
    });
    expect(policy.encodingVersion).toBe(2);
    expect(params).toBeGreaterThan(0);
    expect(parity).toBeLessThan(1e-3);
  });
});

// Always-present marker so the file is never an empty/zero-test suite when skipped.
describe('survivorForward fixture presence', () => {
  it(
    present
      ? 'Survivor export artifacts are present'
      : 'Survivor export artifacts absent — parity skipped',
    () => {
      expect(typeof present).toBe('boolean');
    }
  );
});
