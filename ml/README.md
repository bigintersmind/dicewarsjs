# `ml/` — Behavioral-Cloning Trainer (DiceWarsJS ml-bot, Phase 2)

Python/PyTorch trainer that **clones the strongest heuristic bot (`ai_lookahead`)**
from a packed self-play tensor corpus, then exports the policy to **ONNX** for
in-browser inference. This is Phase 2 of the ML-bot initiative — the imitation
baseline that de-risks the whole JS → train → ONNX → in-browser pipeline before
any RL (see [`../docs/ml-bot/`](../docs/ml-bot/): README, PLAN, DECISIONS).

It lives in-repo (decision [D-16]) so the **encoding contract** — `manifest.json`,
`ENCODING_VERSION`, and the feature-column order in
[`../src/arena/encodeObservation.js`](../src/arena/encodeObservation.js) — and the
trainer that consumes it stay versioned together: an encoding change and the
matching trainer change land in one commit.

## Where it sits in the pipeline

```
scripts/selfplay.mjs        lean JSONL corpus (seed + actions + terminal labels)
scripts/encode-corpus.mjs   packed little-endian tensors + manifest.json   ← input to this package
ml/  (this package)         train a masked per-edge MLP → export ONNX + a contract sidecar
src/ai  (next slice)        ONNX-Runtime-Web bot wrapping the exported model  (see "The ONNX contract")
```

Everything upstream is JS and already committed. The packed tensors are produced by:

```bash
# from the repo root — generate a corpus, then expand it to tensors
npm run selfplay -- --field full --seed-start 1 --seed-count 100000 --out data/selfplay/corpus.jsonl
npm run encode-corpus -- --in data/selfplay/corpus.jsonl   # → data/selfplay/encoded/corpus/
```

(A tiny 300-game sample already exists at `data/selfplay/encoded/corpus-fullfield-300/`.)

## Setup

Training runs on the GPU box (`shodan`, WSL2 Ubuntu, RTX 4070 Ti — DECISIONS
[D-13]); a CPU box is fine for the small-corpus dev loop and the tests.

```bash
cd ml
python -m venv .venv && source .venv/bin/activate

# On the GPU box, install the CUDA build of torch FIRST:
#   pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -e .[onnx,dev]      # numpy, torch, onnx, onnxruntime, pytest, ruff
```

## Train

```bash
python -m dicewars_bc.train --corpus ../data/selfplay/encoded/corpus-fullfield-300
python -m dicewars_bc.train --corpus <dir> --epochs 20 --batch-size 512 --device cuda
```

The headline metric is **policy accuracy** — top-1 move-match with the teacher,
the imitation-fidelity proxy the Phase-2 gate rests on. The best-val-accuracy
checkpoint is written to `checkpoints/bc_model.pt`. Train/val split is **by game**
(not by step) to avoid leakage from correlated same-game steps.

## Export to ONNX

```bash
python -m dicewars_bc.export_onnx --ckpt checkpoints/bc_model.pt --out bc_policy.onnx
```

This writes `bc_policy.onnx` + `bc_policy.onnx.json` (the contract sidecar). When
onnxruntime is installed it asserts the exported graph reproduces PyTorch's
outputs (the cross-bridge parity the Phase-2 acceptance criteria require) and
records `parityChecked: true` in the sidecar; if it is absent the export still
succeeds but warns and stamps `parityChecked: false` (the model is UNVERIFIED).
Pass `--require-parity` to make a missing onnxruntime a hard failure instead —
use it for the acceptance-gate run so an unverified model can't slip through.

## The architecture (per D-Encoding)

A **masked per-edge MLP** — the simplest learner that can clone; escalate to a
1–2 layer GNN only if it can't reach parity.

- **Per-node encoder** + masked mean-pool over *present* nodes.
- **Per-player encoder** + **mean-pool over seats** — permutation-invariant, so
  the policy is seat-symmetric (owner identity is relational: `isMine`/`isMe`).
- **Context MLP** over (node pool, player pool, board scalars).
- **Edge head**: per legal edge, `MLP(ctx, from-node-emb, to-node-emb, edge-features)`
  → one logit. Softmax is **per step** over its legal set (`getValidMoves` + STOP).
- **Aux value head** regresses terminal `(won, placement)` — recommended,
  multi-task, warm-starts Phase-3 PPO.

The on-disk tensor layout (CSR edges, feature columns, dtypes) is documented in
the corpus `manifest.json` and mirrored by `dicewars_bc.manifest`.

## The ONNX contract (for the in-browser bot — next slice)

The exported graph is **logits-only for one decision step** (`B=1`). Inputs:

| name         | dtype   | shape                              |
| ------------ | ------- | ---------------------------------- |
| `nodes`      | float32 | `[batch, maxAreas, nodeFeatures]`  |
| `players`    | float32 | `[batch, players, playerFeatures]` |
| `board`      | float32 | `[batch, boardFeatures]`           |
| `edge_feat`  | float32 | `[edges, edgeFeatures]`            |
| `edge_from`  | int64   | `[edges]`                          |
| `edge_to`    | int64   | `[edges]`                          |
| `edge_batch` | int64   | `[edges]` (all zeros at inference)  |

Output `edge_logits` `[edges]` + `value` `[batch, 2]`. The `edges` and `batch`
axes are dynamic. At inference **every edge is legal** (the set is
`getValidMoves` + STOP), so the bot just `argmax`es `edge_logits`:
`argmax → {from, to}` (from `edge_index`) or the STOP edge → `null`. No masking.

**To wire the bot (the follow-up slice):** add `onnxruntime-web` to the JS deps,
build the input tensors from a live `BotState` the **same way**
`src/arena/encodeObservation.js` does (a label-free encoder extracted from
`encodeStep` — it currently requires a `chosenMove` to compute the BC label),
run the session, and `argmax`. The sidecar `bc_policy.onnx.json` carries
`encodingVersion` + the I/O contract so the wrapper can assert compatibility.

## Tests

```bash
cd ml && pytest          # hermetic — builds a tiny synthetic corpus, no real data needed
```

Tests that need `torch` / `onnxruntime` skip automatically if those aren't installed.
Set `REQUIRE_ONNX=1` to turn a missing `onnx`/`onnxruntime` into a hard failure
instead of a skip — use it in CI so the ONNX↔PyTorch parity gate can't silently
pass by being skipped.
