/**
 * Runtime decoder for the COMPACT (base64 Float32) policy-weights format.
 *
 * The exported bots (`ai_bc`, `ai_ppo`) used to ship their ~102k-param net as raw
 * JSON-in-JS floats — ~2.1 MB per file, statically folded into the eager main bundle
 * chunk (issue #51). The exporter (`ml/dicewars_bc/export_weights.py`, packed mode)
 * now emits the same weights as a single base64-encoded little-endian `Float32`
 * blob + a tiny shape descriptor — ~74% smaller on disk — and the generated module is
 * just `export const BC_POLICY = unpackPolicy({ … });`.
 *
 * `unpackPolicy` reconstructs the EXACT materialized object the rest of the pipeline
 * already consumes (`bcForward.js`'s `forward`, `makeBC`, the parity loaders, the PPO
 * league snapshot loader): `{ encodingVersion, teacher, …, config, layers: { head:
 * [{ w:[out][in], b:[out], relu }] } }`. Nothing downstream changes — only the wire
 * format does. The float32 round-trip is lossless: PyTorch weights are float32, so the
 * decimal JSON values were already exact float32, and reading them back through a
 * `Float32Array` recovers the identical doubles `forward` computed with before.
 *
 * Pure JS, no imports — runs identically in the browser bundle, the Node arena CLI,
 * and Vitest (the base64→bytes step feature-detects `Buffer` vs `atob`).
 *
 * @module ai/unpackPolicyWeights
 */

/**
 * Decode a base64 string of little-endian float32 bytes into a `Float32Array`.
 *
 * Works in Node (`Buffer`) and the browser (`atob`). The decoded bytes are copied into
 * a fresh `ArrayBuffer` before the `Float32Array` view is taken: a `Buffer` returned
 * from Node's pool can sit at a non-4-byte-aligned `byteOffset`, which would make
 * `new Float32Array(buf.buffer, buf.byteOffset, …)` throw — the copy guarantees a
 * 4-aligned, zero-offset backing buffer.
 *
 * @param {string} b64
 * @returns {Float32Array}
 */
function base64ToFloat32Array(b64) {
  /*
   * Node's `Buffer.from(b64, 'base64')` silently DROPS chars outside the base64 alphabet
   * (a truncated/corrupt blob decodes to garbage of a plausible length), whereas the
   * browser's `atob` throws — a behavior gap that would let corruption pass on the server
   * path only. Validate the (standard, unwrapped) alphabet up front so both paths reject
   * malformed input identically and loudly (issue #93).
   */
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error('unpackPolicy: `data` is not valid base64 (corrupt weight blob).');
  }
  let bytes;
  if (typeof Buffer !== 'undefined') {
    bytes = Buffer.from(b64, 'base64');
  } else {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(
      `unpackPolicy: base64 blob is ${bytes.byteLength} bytes, not a multiple of 4 (corrupt float32 data).`
    );
  }
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Float32Array(buf);
}

/**
 * Reconstruct the materialized `BC_POLICY` object from its packed form.
 *
 * The packed object carries every field of the old format verbatim EXCEPT the per-layer
 * `w`/`b` float arrays: those move into a single base64 `data` blob, and `layers` holds
 * only a shape descriptor — `{ head: [[outDim, inDim, relu], …] }`. The floats are laid
 * out head-by-head in the descriptor's own key order, and within each layer as the full
 * row-major `w` ([out][in]) followed by `b` ([out]) — the exact order the exporter wrote
 * them, so the walk here consumes them back identically.
 *
 * @param {Object} packed - the packed payload (everything but `data`/`layers` is metadata)
 * @param {string} packed.data - base64 little-endian float32 blob of all `w`/`b` values
 * @param {Object<string, Array<[number, number, boolean]>>} packed.layers - per-head shape
 * @returns {Object} the materialized policy: `{ …meta, config, layers: { head: [{ w, b, relu }] } }`
 */
export function unpackPolicy(packed) {
  const { data, layers: shape, ...meta } = packed;
  if (typeof data !== 'string' || !shape) {
    throw new Error('unpackPolicy: packed payload missing `data` (base64) or `layers` (shape).');
  }
  /*
   * `config` (net dims: maxAreas, presentCol, feature widths) is reconstructed verbatim
   * into the materialized object and read straight away by the bots (`BC_POLICY.config
   * .maxAreas` in ai_bc.js / ai_ppo.js). Without it those reads throw an opaque
   * `Cannot read properties of undefined` far from here — name the failure at the source
   * (issue #93). encodingVersion is separately defended by makeBC's compatibility guard.
   */
  if (!meta.config) {
    throw new Error('unpackPolicy: packed payload missing `config` (net dims the bots read).');
  }
  const f32 = base64ToFloat32Array(data);
  /*
   * Defense-in-depth against a NaN/Inf blob (training divergence or corruption): those
   * decode cleanly into a silent all-NaN-logits bot that argmaxes to index 0 every turn.
   * The producer already refuses to export non-finite weights (export_weights.py
   * `_assert_finite_weights`); this catches a blob that went bad after export. O(n) over
   * ~100k floats — negligible at the one-time module load.
   */
  for (let i = 0; i < f32.length; i++) {
    if (!Number.isFinite(f32[i])) {
      throw new Error(`unpackPolicy: non-finite weight at float index ${i} (corrupt weights).`);
    }
  }

  let off = 0;
  const layers = {};
  for (const head of Object.keys(shape)) {
    layers[head] = shape[head].map(([outDim, inDim, relu]) => {
      const w = new Array(outDim);
      for (let o = 0; o < outDim; o++) {
        const row = new Array(inDim);
        for (let i = 0; i < inDim; i++) row[i] = f32[off++];
        w[o] = row;
      }
      const b = new Array(outDim);
      for (let o = 0; o < outDim; o++) b[o] = f32[off++];
      return { w, b, relu };
    });
  }

  if (off !== f32.length) {
    throw new Error(
      `unpackPolicy: shape describes ${off} floats but the blob holds ${f32.length} — shape/data mismatch.`
    );
  }
  return { ...meta, layers };
}

export default unpackPolicy;
