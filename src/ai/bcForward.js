/**
 * Pure-JS, synchronous forward pass for the behavioral-cloning policy net.
 *
 * This is a hand-written re-implementation of `EdgePolicyNet.forward`
 * (`ml/dicewars_bc/model.py`) — a masked per-edge MLP + aux value head. We run the
 * net this way, rather than via ONNX Runtime Web, because the bot contract
 * `(BotState) -> {from,to}|null` is **synchronous** everywhere in the arena
 * (`botRunner.js`, `runAI`, the self-play workers) while ORT's `session.run` is
 * async. For this tiny net a pure-JS forward is trivially fast, needs no WASM
 * bundle, and keeps the sync contract. The Python ONNX export remains the canonical
 * numeric reference: `tests/ai/bcForward.test.js` cross-checks this implementation
 * against logits produced by the PyTorch model (`tests/fixtures/bc/forwardCases.json`).
 *
 * Weights come from `ml/dicewars_bc/export_weights.py` as a `BC_POLICY` object: each
 * `nn.Linear` is `{ w: [out][in], b: [out], relu }`, where `relu` says whether a ReLU
 * follows it in that MLP. The forward math mirrors PyTorch op-for-op; we compute in
 * JS doubles (PyTorch uses float32), so cross-checks allow a small tolerance.
 *
 * @module ai/bcForward
 */

/**
 * One `nn.Linear`: `y = W·x + b`. `w` is row-major `[out][in]` (PyTorch's native
 * weight shape), `b` is `[out]`.
 * @param {number[]} x   - input vector, length `in`
 * @param {number[][]} w - weight, `[out][in]`
 * @param {number[]} b   - bias, `[out]`
 * @returns {number[]} output vector, length `out`
 */
function linear(x, w, b) {
  const out = new Array(w.length);
  for (let o = 0; o < w.length; o++) {
    const row = w[o];
    let sum = b[o];
    for (let i = 0; i < row.length; i++) sum += row[i] * x[i];
    out[o] = sum;
  }
  return out;
}

/**
 * Apply a sequence of `{ w, b, relu }` layers (a PyTorch `nn.Sequential` of
 * Linear/ReLU). ReLU is applied in place after a layer whose `relu` flag is set.
 * @param {Array<{w:number[][], b:number[], relu:boolean}>} layers
 * @param {number[]} x
 * @returns {number[]}
 */
function applyMlp(layers, x) {
  let h = x;
  for (const layer of layers) {
    h = linear(h, layer.w, layer.b);
    if (layer.relu) {
      for (let i = 0; i < h.length; i++) if (h[i] < 0) h[i] = 0;
    }
  }
  return h;
}

/**
 * One encoded decision step (B=1), matching the in-order columns the Python
 * trainer consumes (see `src/arena/encodeObservation.js`).
 * @typedef {Object} EncodedObservation
 * @property {number[][]} nodes     - [maxAreas][nodeFeatures]; col 0 is the present-mask
 * @property {number[][]} players   - [numSeats][playerFeatures]
 * @property {number[]}   board      - [boardFeatures]
 * @property {number[][]} edges      - [numEdges][edgeFeatures]; last row is STOP
 * @property {number[][]} edgeIndex  - [numEdges][2] (fromId, toId); STOP → [0, 0]
 */

/**
 * Forward pass → one raw logit per edge (last = STOP) plus the aux value.
 * Mirrors `EdgePolicyNet.forward` (model.py) op-for-op:
 *   - per-node encoder → masked mean-pool over *present* nodes,
 *   - per-player encoder → mean-pool over seats (seat-symmetric),
 *   - context MLP over (node pool, player pool, board),
 *   - per-edge head over (ctx, from-node emb, to-node emb, edge features).
 *
 * @param {import('./bcPolicyWeights.js').BC_POLICY} policy - weights + config
 * @param {EncodedObservation} obs
 * @returns {{ logits: number[], value: number[] }} `logits` length = edges; `value` length 2
 */
export function forward(policy, obs) {
  const { layers, config } = policy;
  const presentCol = config.presentCol;
  const { nodes, players, board, edges, edgeIndex } = obs;

  /*
   * Per-node embeddings + masked mean-pool over present nodes only (absent ids
   * would otherwise inject a constant encoder(0) bias into the pool).
   */
  const nodeHidden = layers.nodeEncoder[layers.nodeEncoder.length - 1].b.length;
  const nodeEmb = new Array(nodes.length);
  const nodeSum = new Array(nodeHidden).fill(0);
  let presentCount = 0;
  for (let i = 0; i < nodes.length; i++) {
    const emb = applyMlp(layers.nodeEncoder, nodes[i]);
    nodeEmb[i] = emb;
    const present = nodes[i][presentCol];
    if (present !== 0) {
      presentCount += present;
      for (let h = 0; h < nodeHidden; h++) nodeSum[h] += emb[h] * present;
    }
  }
  const denom = presentCount > 1 ? presentCount : 1; // clamp(min=1), matching torch
  const nodePool = nodeSum.map(s => s / denom);

  // Per-player embeddings → mean over seats (permutation-invariant).
  const playerHidden = layers.playerEncoder[layers.playerEncoder.length - 1].b.length;
  const playerSum = new Array(playerHidden).fill(0);
  for (let p = 0; p < players.length; p++) {
    const emb = applyMlp(layers.playerEncoder, players[p]);
    for (let h = 0; h < playerHidden; h++) playerSum[h] += emb[h];
  }
  const playerPool = playerSum.map(s => s / players.length);

  // Context MLP over concat(node pool, player pool, board).
  const ctx = applyMlp(layers.context, [...nodePool, ...playerPool, ...board]);

  // Per-edge head: concat(ctx, from-emb, to-emb, edge features) → 1 logit.
  const logits = new Array(edges.length);
  for (let e = 0; e < edges.length; e++) {
    const fromEmb = nodeEmb[edgeIndex[e][0]];
    const toEmb = nodeEmb[edgeIndex[e][1]];
    const edgeIn = [...ctx, ...fromEmb, ...toEmb, ...edges[e]];
    logits[e] = applyMlp(layers.edgeHead, edgeIn)[0];
  }

  const value = applyMlp(layers.valueHead, ctx);

  /*
   * Loud non-finite gate: a weights/observation width mismatch (a weight row wider
   * than its input reads undefined → NaN) or a corrupt export would otherwise flow
   * NaN logits into argmax, which returns index 0 for an all-NaN array — a silent
   * "zombie bot" that plays the first edge every turn. One O(edges) pass; trivial
   * next to the matmuls above.
   */
  for (let e = 0; e < logits.length; e++) {
    if (!Number.isFinite(logits[e])) {
      throw new Error(
        `bcForward: non-finite logit ${logits[e]} at edge ${e} — the policy weights do not ` +
          `match the encoded observation widths (or the export is corrupt).`
      );
    }
  }
  for (let i = 0; i < value.length; i++) {
    if (!Number.isFinite(value[i])) {
      throw new Error(
        `bcForward: non-finite value-head output ${value[i]} at index ${i} — the policy ` +
          `weights do not match the encoded observation widths (or the export is corrupt).`
      );
    }
  }
  return { logits, value };
}

/**
 * Index of the maximum-logit edge (first-occurrence tie-break, matching
 * `torch.argmax`). The chosen action is the edge at this index.
 * @param {number[]} logits
 * @returns {number}
 */
export function argmax(logits) {
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  return best;
}
