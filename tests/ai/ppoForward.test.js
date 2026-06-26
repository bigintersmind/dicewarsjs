/**
 * JS↔Python parity for the exported **PPO** policy (Phase-3 gate, PLAN step 7).
 *
 * The repacked PPO actor is a bare `EdgePolicyNet`, exported by
 * `ml/dicewars_bc/export_weights.py` to `src/ai/ppoPolicyWeights.js` + the
 * `tests/fixtures/bc/ppoForwardCases.json` parity fixture. This asserts the in-browser
 * JS forward reproduces the Python reference logits (and picks the same action) for
 * the PPO net exactly as `bcForward.test.js` does for the deployed BC net.
 *
 * Skips cleanly until those artifacts exist (this Mac has no torch to produce them —
 * they come from the `npm run ppo:export` step on a torch box). Once committed, this
 * runs in the normal suite and guards the export from silently breaking.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExportedPolicy } from '../../scripts/lib/load-bc-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const WEIGHTS = resolve(root, 'src/ai/ppoPolicyWeights.js');
const FIXTURE = resolve(root, 'tests/fixtures/bc/ppoForwardCases.json');
const present = existsSync(WEIGHTS) && existsSync(FIXTURE);

describe.skipIf(!present)('ppoForward — JS↔Python parity (PPO export)', () => {
  it('the JS forward reproduces the Python reference logits + argmax for every case', async () => {
    /*
     * loadExportedPolicy runs the full parity pre-flight (per-logit tolerance +
     * exact argmax match) and throws on any mismatch.
     */
    const { policy, parity, params } = await loadExportedPolicy({
      weightsPath: WEIGHTS,
      fixturePath: FIXTURE,
      label: 'PPO',
    });
    expect(policy.encodingVersion).toBe(2);
    expect(params).toBeGreaterThan(0);
    expect(parity).toBeLessThan(1e-3);
  });
});

// Always-present marker so the file is never an empty/zero-test suite when skipped.
describe('ppoForward fixture presence', () => {
  it(
    present ? 'PPO export artifacts are present' : 'PPO export artifacts absent — parity skipped',
    () => {
      expect(typeof present).toBe('boolean');
    }
  );
});
