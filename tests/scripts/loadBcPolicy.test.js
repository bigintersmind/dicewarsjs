/**
 * Shared parity-checked policy loader (`scripts/lib/load-bc-policy.mjs`).
 *
 * Exercised against the REAL deployed BC weights + their fixture, so it proves the
 * loader trusts a known-good export and rejects a broken one — the contract both the
 * capacity probe and the Phase-3 PPO gate depend on before grading a net.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BC_POLICY } from '../../src/ai/bcPolicyWeights.js';
import { argmax } from '../../src/ai/bcForward.js';
import {
  checkParity,
  countParams,
  loadExportedPolicy,
  siblingFixturePath,
} from '../../scripts/lib/load-bc-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const WEIGHTS = resolve(root, 'src/ai/bcPolicyWeights.js');
const FIXTURE = resolve(root, 'tests/fixtures/bc/forwardCases.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('siblingFixturePath', () => {
  it('maps *.weights.js → *.fixture.json', () => {
    expect(siblingFixturePath('/a/b/c0_base.weights.js')).toBe('/a/b/c0_base.fixture.json');
  });
  it('leaves a non-".weights.js" path unchanged (no sibling)', () => {
    expect(siblingFixturePath('/a/b/bcPolicyWeights.js')).toBe('/a/b/bcPolicyWeights.js');
  });
});

describe('countParams', () => {
  it('counts every Linear W + b across all heads', () => {
    expect(countParams(BC_POLICY)).toBeGreaterThan(0);
  });
});

describe('checkParity', () => {
  it('passes for the deployed BC policy against its own fixture', () => {
    const maxErr = checkParity(BC_POLICY, fixture, { label: 'bc' });
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('throws when a fixture has no cases', () => {
    expect(() => checkParity(BC_POLICY, { cases: [] }, { label: 'bc' })).toThrow(/no cases/);
  });

  it('throws when the fixture config feature widths disagree with the weights', () => {
    const skewed = {
      ...fixture,
      config: { ...fixture.config, edgeFeatures: fixture.config.edgeFeatures + 1 },
    };
    expect(() => checkParity(BC_POLICY, skewed, { label: 'bc' })).toThrow(
      /config\.edgeFeatures mismatch/
    );
  });

  it('throws on a magnitude error past tolerance (uniform shift, argmax unchanged)', () => {
    /*
     * A uniform +5 shift leaves the argmax fixed, so this exercises the tolerance
     * branch specifically (not the argmax branch tested below).
     */
    const corrupted = {
      cases: fixture.cases.map(c => ({
        ...c,
        logits: c.logits.map(v => v + 5),
      })),
    };
    expect(() => checkParity(BC_POLICY, corrupted, { label: 'bc' })).toThrow(/maxErr=/);
  });

  it('throws on an argmax disagreement (a different chosen action)', () => {
    /*
     * Point each multi-edge reference case's argmax at a DIFFERENT edge than the JS
     * forward picks. A wrong *action* is the failure the deployed bot actually suffers,
     * so the per-case argmax guard must fire — the prior test only covers magnitude.
     */
    const flipped = {
      ...fixture,
      cases: fixture.cases.map(c => {
        if (c.logits.length < 2) return c; // single-edge case can't disagree
        const winner = argmax(c.logits);
        const other = (winner + 1) % c.logits.length;
        const logits = c.logits.slice();
        logits[other] = Math.max(...c.logits) + 1; // make `other` the new argmax
        return { ...c, logits };
      }),
    };
    expect(() => checkParity(BC_POLICY, flipped, { label: 'bc' })).toThrow(/argmax/);
  });

  it('throws on a non-finite reference logit (NaN cannot silently pass the tolerance check)', () => {
    /*
     * NaN is the symptom of a mis-dimensioned export. Math.max stays NaN-sticky and
     * `NaN > tol` is false, so without an explicit finiteness guard a broken net would
     * slip through. Use the first multi-edge case so a real diff is computed.
     */
    const idx = fixture.cases.findIndex(c => c.logits.length >= 2);
    const poisoned = {
      ...fixture,
      cases: fixture.cases.map((c, i) =>
        i === idx ? { ...c, logits: c.logits.map((v, j) => (j === 0 ? NaN : v)) } : c
      ),
    };
    expect(() => checkParity(BC_POLICY, poisoned, { label: 'bc' })).toThrow(/non-finite logit/);
  });
});

describe('loadExportedPolicy', () => {
  it('loads + parity-checks the deployed BC weights', async () => {
    const { policy, parity, params } = await loadExportedPolicy({
      weightsPath: WEIGHTS,
      fixturePath: FIXTURE,
      label: 'bc',
    });
    expect(policy.encodingVersion).toBe(BC_POLICY.encodingVersion);
    expect(parity).toBeLessThan(1e-3);
    expect(params).toBe(countParams(BC_POLICY));
  });

  it('throws an actionable error when the weights file is missing', async () => {
    await expect(
      loadExportedPolicy({ weightsPath: resolve(root, 'src/ai/does-not-exist.js') })
    ).rejects.toThrow(/weights not found/);
  });

  it('throws when the parity fixture is missing', async () => {
    await expect(
      loadExportedPolicy({ weightsPath: WEIGHTS, fixturePath: resolve(root, 'nope.fixture.json') })
    ).rejects.toThrow(/parity fixture not found/);
  });
});
