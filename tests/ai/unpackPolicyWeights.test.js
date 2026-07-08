/**
 * Unit tests for the compact (base64 Float32) policy-weights decoder.
 *
 * `unpackPolicy` is the runtime half of the issue-#51 size cut: the exporter
 * (`ml/dicewars_bc/export_weights.py`) packs the ~102k float weights into one base64
 * little-endian float32 blob + a shape descriptor, and this decoder reconstructs the
 * materialized `BC_POLICY` object the forward pass consumes. The Python↔JS byte layout
 * is also covered end-to-end by the parity tests (bcForward/ppoForward over the real
 * packed shipped files); these lock the decoder's contract in isolation.
 */
import { unpackPolicy } from '../../src/ai/unpackPolicyWeights.js';

/** Float32-LE base64 of a flat number[] — mirrors the exporter's `_pack_payload` blob. */
function floatsToBase64(floats) {
  const buf = Buffer.alloc(floats.length * 4);
  floats.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
}

describe('unpackPolicy', () => {
  it('decodes a known little-endian float32 layout (w row-major, then b)', () => {
    // One head, one layer: out=2, in=2, relu=true. Floats are w (row-major) then b.
    const w = [
      [1.0, 2.0],
      [-0.5, 0.25],
    ];
    const b = [10.0, -20.0];
    const packed = {
      encodingVersion: 2,
      config: { maxAreas: 8, presentCol: 0 },
      layers: { onlyHead: [[2, 2, true]] },
      data: floatsToBase64([1.0, 2.0, -0.5, 0.25, 10.0, -20.0]),
    };

    const policy = unpackPolicy(packed);
    expect(policy.encodingVersion).toBe(2);
    expect(policy.config).toEqual({ maxAreas: 8, presentCol: 0 });
    expect(policy.layers.onlyHead).toEqual([{ w, b, relu: true }]);
  });

  it('decodes via the browser atob path when Buffer is unavailable', () => {
    // The decoder feature-detects `typeof Buffer !== 'undefined'`: Node/Vitest take the Buffer
    // branch, but every real browser user hits the `atob` + charCodeAt branch instead. Because
    // the whole suite runs under Node (Buffer always defined), that shipped browser path is
    // otherwise never executed — a bug in it would ship green. Force it by shadowing Buffer and
    // assert it reconstructs the exact same floats the Buffer branch does.
    const packed = {
      encodingVersion: 2,
      config: { maxAreas: 8, presentCol: 0 },
      layers: { onlyHead: [[2, 2, true]] },
      data: floatsToBase64([1.0, 2.0, -0.5, 0.25, 10.0, -20.0]), // built before we drop Buffer
    };
    const viaBuffer = unpackPolicy(packed);

    const savedBuffer = globalThis.Buffer;
    try {
      globalThis.Buffer = undefined; // → `typeof Buffer === 'undefined'`, so unpackPolicy uses atob
      expect(typeof atob).toBe('function'); // sanity: the browser primitive exists in this env
      expect(unpackPolicy(packed)).toEqual(viaBuffer);
    } finally {
      globalThis.Buffer = savedBuffer;
    }
  });

  it('round-trips a multi-head, multi-layer policy losslessly', () => {
    // float32-exact values so the round-trip is bit-exact (no float64→float32 rounding).
    const policy = {
      encodingVersion: 2,
      teacher: 'test',
      config: { maxAreas: 4, presentCol: 0 },
      layers: {
        nodeEncoder: [
          { w: [[0.5, -1.0, 2.0]], b: [0.25], relu: true },
          { w: [[1.5], [-2.5]], b: [0.0, 0.75], relu: false },
        ],
        valueHead: [{ w: [[3.0, -4.0]], b: [0.125], relu: false }],
      },
    };

    // Re-derive shape + flat float stream (the exporter's layout) and decode it.
    const floats = [];
    const shape = {};
    for (const head of Object.keys(policy.layers)) {
      shape[head] = policy.layers[head].map(({ w, b, relu }) => {
        for (const row of w) floats.push(...row);
        floats.push(...b);
        return [w.length, w[0].length, relu];
      });
    }
    const decoded = unpackPolicy({
      encodingVersion: policy.encodingVersion,
      teacher: policy.teacher,
      config: policy.config,
      layers: shape,
      data: floatsToBase64(floats),
    });

    expect(decoded).toEqual(policy);
  });

  it('throws when the blob byte length is not a multiple of 4', () => {
    // 3 bytes → not a whole number of float32 values. ('AQID' is valid base64 for 3 bytes.)
    const data = Buffer.from([1, 2, 3]).toString('base64');
    expect(() => unpackPolicy({ config: {}, layers: { h: [[1, 1, false]] }, data })).toThrow(
      /multiple of 4/
    );
  });

  it('throws when the shape describes more floats than the blob holds', () => {
    // Shape wants 2 floats (w[1x1] + b[1]); blob only has 1.
    const data = floatsToBase64([1.0]);
    expect(() => unpackPolicy({ config: {}, layers: { h: [[1, 1, false]] }, data })).toThrow(
      /shape\/data mismatch/
    );
  });

  it('throws on a malformed payload missing data or layers', () => {
    expect(() => unpackPolicy({ config: {}, layers: { h: [] } })).toThrow(/missing/);
    expect(() => unpackPolicy({ config: {}, data: floatsToBase64([]) })).toThrow(/missing/);
  });

  it('throws a named error when `config` is missing (issue #93)', () => {
    // Without config, downstream `BC_POLICY.config.maxAreas` reads throw far from here;
    // the decoder names the failure at the source instead.
    const data = floatsToBase64([1.0, 2.0, -0.5, 0.25, 10.0, -20.0]);
    expect(() => unpackPolicy({ layers: { onlyHead: [[2, 2, true]] }, data })).toThrow(/config/);
  });

  it('rejects malformed base64 identically to the browser (Node/atob parity, issue #93)', () => {
    // Node's Buffer.from silently drops non-alphabet chars where atob throws; the decoder
    // validates the alphabet up front so both reject a corrupt blob loudly.
    const bad = { config: {}, layers: { h: [[1, 1, false]] }, data: 'not valid base64!!' };
    expect(() => unpackPolicy(bad)).toThrow(/valid base64/);
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('throws on a non-finite (%s) weight blob (issue #93)', (_label, bad) => {
    // A divergent checkpoint would otherwise decode into a silent all-NaN-logits bot.
    const data = floatsToBase64([1.0, bad]); // w[1x1]=1.0, b[1]=NaN/Inf
    expect(() => unpackPolicy({ config: {}, layers: { h: [[1, 1, false]] }, data })).toThrow(
      /non-finite/
    );
  });
});
