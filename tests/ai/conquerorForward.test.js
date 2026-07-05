/**
 * JS↔Python parity for the exported **Conqueror** policy (the [D-31] encoding-v3 net).
 *
 * Conqueror's weights are the `ppo-v3-scratch` actor — a bare `EdgePolicyNet` exported
 * by `ml/dicewars_bc/export_weights.py` (`npm run conqueror:export`) to
 * `src/ai/conquerorPolicyWeights.js` + the `tests/fixtures/bc/conquerorForwardCases.json`
 * parity fixture. This asserts the in-browser JS forward reproduces the Python reference
 * logits (and picks the same action), exactly as `ppoForward.test.js` does for the hidden
 * PPO baseline — with one v3-specific addition: the weights must be stamped
 * `encodingVersion: 3` (the first shipped net on the [D-31] observation).
 *
 * Skips cleanly until those artifacts exist (this Mac has no torch to produce them —
 * they come from the `npm run conqueror:export` step on a torch box). Once committed,
 * this runs in the normal suite and guards the export from silently breaking.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExportedPolicy } from '../../scripts/lib/load-bc-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const WEIGHTS = resolve(root, 'src/ai/conquerorPolicyWeights.js');
const FIXTURE = resolve(root, 'tests/fixtures/bc/conquerorForwardCases.json');
const present = existsSync(WEIGHTS) && existsSync(FIXTURE);

describe.skipIf(!present)('conquerorForward — JS↔Python parity (encoding-v3 export)', () => {
  it('the JS forward reproduces the Python reference logits + argmax for every case', async () => {
    /*
     * loadExportedPolicy runs the full parity pre-flight (per-logit tolerance +
     * exact argmax match) and throws on any mismatch.
     */
    const { policy, parity, params } = await loadExportedPolicy({
      weightsPath: WEIGHTS,
      fixturePath: FIXTURE,
      label: 'Conqueror',
    });
    expect(policy.encodingVersion).toBe(3);
    expect(params).toBeGreaterThan(0);
    expect(parity).toBeLessThan(1e-3);
  });
});

// Always-present marker so the file is never an empty/zero-test suite when skipped.
describe('conquerorForward fixture presence', () => {
  it(
    present
      ? 'Conqueror export artifacts are present'
      : 'Conqueror export artifacts absent — parity skipped',
    () => {
      expect(typeof present).toBe('boolean');
    }
  );
});
