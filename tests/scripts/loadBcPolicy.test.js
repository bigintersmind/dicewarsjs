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

  it('throws when the JS forward disagrees with corrupted reference logits', () => {
    const corrupted = {
      cases: fixture.cases.map(c => ({
        ...c,
        logits: c.logits.map(v => v + 5), // shift well past tolerance
      })),
    };
    expect(() => checkParity(BC_POLICY, corrupted, { label: 'bc' })).toThrow(/parity FAIL/);
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
