/**
 * JS↔Python parity for the exported **Blitz** persona policy (docs/ml-bot/PERSONAS.md).
 *
 * Blitz is a self-play net warm-started from `ppo-long` and fine-tuned on a short-horizon
 * win reward, exported by `ml/dicewars_bc/export_weights.py` to
 * `src/ai/blitzPolicyWeights.js` + the `tests/fixtures/bc/blitzForwardCases.json` parity
 * fixture. This asserts the in-browser JS forward reproduces the Python reference logits
 * (and picks the same action) for the Blitz net exactly as `ppoForward.test.js` does for
 * the PPO net.
 *
 * Skips cleanly until those artifacts exist (a torch box produces the fixture).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadExportedPolicy } from '../../scripts/lib/load-bc-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const WEIGHTS = resolve(root, 'src/ai/blitzPolicyWeights.js');
const FIXTURE = resolve(root, 'tests/fixtures/bc/blitzForwardCases.json');
const present = existsSync(WEIGHTS) && existsSync(FIXTURE);

describe.skipIf(!present)('blitzForward — JS↔Python parity (Blitz export)', () => {
  it('the JS forward reproduces the Python reference logits + argmax for every case', async () => {
    /*
     * loadExportedPolicy runs the full parity pre-flight (per-logit tolerance +
     * exact argmax match) and throws on any mismatch.
     */
    const { policy, parity, params } = await loadExportedPolicy({
      weightsPath: WEIGHTS,
      fixturePath: FIXTURE,
      label: 'Blitz',
    });
    expect(policy.encodingVersion).toBe(3);
    expect(params).toBeGreaterThan(0);
    expect(parity).toBeLessThan(1e-3);
  });
});

// Always-present marker so the file is never an empty/zero-test suite when skipped.
describe('blitzForward fixture presence', () => {
  it(
    present
      ? 'Blitz export artifacts are present'
      : 'Blitz export artifacts absent — parity skipped',
    () => {
      expect(typeof present).toBe('boolean');
    }
  );
});
