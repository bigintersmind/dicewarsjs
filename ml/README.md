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

The export pins the **legacy TorchScript exporter** (`dynamo=False`, feature-detected
so the floor stays torch 2.1) so it keeps the stable `dynamic_axes` graph contract
across torch versions — torch ≥ 2.9 otherwise defaults to the dynamo exporter, which
needs `onnxscript` and a different dynamic-shape API. (Exports stay numerically
identical to the parity tolerance, asserted by the ONNX↔PyTorch check; the raw protobuf
may still differ across torch versions.) Expect a deprecation warning; migrating to the
dynamo exporter is future work.

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

## Phase 3 — self-play PPO (`dicewars_ppo/`)

The sibling package `dicewars_ppo/` is the **Phase-3 self-play learner** (DECISIONS
[D-19]/[D-20]). It trains a PPO policy — reusing this package's `EdgePolicyNet` trunk
— against the persistent Node env-server (`scripts/ppo-env-server.mjs`), which runs the
opponent seats in-process and speaks a compact binary socket protocol.

```bash
cd ml && pip install -e .[rl]    # gymnasium + stable-baselines3 + sb3-contrib + pettingzoo
```

> **torch on a fresh GPU box.** `[rl]` pulls `torch` transitively (via SB3), and
> `pip install -e .[rl]` **re-resolves torch from PyPI** — it does _not_ respect an
> already-installed CUDA build (on shodan it upgraded `2.5.1+cu121` → `2.12.1+cu130`;
> pre-installing the CUDA wheel first does **not** prevent this). Recent torch wheels
> bundle the CUDA runtime, so it generally Just Works (`torch.cuda.is_available()` stays
> `True`). To hold a _specific_ CUDA build, pin it with a constraints file:
> `pip install -c constraints.txt -e .[rl]` (with a `torch==<ver>+cuXXX` line). shodan
> currently runs **torch 2.12.1+cu130** (validated working for both BC and the PPO env).

- `constants.py` — the wire/encoding contract mirrored from
  [`../src/arena/encodeObservation.js`](../src/arena/encodeObservation.js): v2 feature
  widths, the `ENCODING_VERSION` guard, and `MAX_EDGES = 64` ([D-20]).
- `wire.py` — a Python port of [`../scripts/lib/obs-frame.mjs`](../scripts/lib/obs-frame.mjs)
  (`parse_frame`/`serialize_frame`) plus the length-prefixed socket framing.
- `env_server.py` — launch + supervise a `ppo-env-server.mjs` subprocess.
- `env.py` — `DiceWarsEnv`, a **single-agent** `gymnasium.Env` (`Discrete(MAX_EDGES)`
  + `action_masks()`) over the socket. It's single-agent because the env-server exposes
  only the learner seat (opponents run in-process in Node) — exactly what sb3-contrib
  `MaskablePPO` consumes; no PettingZoo wrapper is needed.

The cross-language wire codec has a hermetic byte-exact parity test
(`tests/test_ppo_wire.py`, parses a committed golden frame); the end-to-end env smoke
(`tests/test_ppo_env.py`) launches a real server and skips where `gymnasium`/`node`
are absent (so it runs on shodan, not in the BC CI). Regenerate the golden frame after
any `obs-frame.mjs` / encoding change: `node tests/fixtures/gen_obs_frame_fixture.mjs`.

The custom SB3 policy + warm-start (step 5), the tiny PPO run (step 6), and the
repack→export→register→gate (step 7) are the remaining Phase-3 tracer steps — see
[`../docs/ml-bot/PLAN.md`](../docs/ml-bot/PLAN.md).

## Tests

```bash
cd ml && pytest          # hermetic — builds a tiny synthetic corpus, no real data needed
cd ml && ruff check .    # lint (ruff is pinned in the dev extra for a reproducible gate)
```

Tests that need `torch` / `onnxruntime` skip automatically if those aren't installed.
Set `REQUIRE_ONNX=1` to turn a missing `onnx`/`onnxruntime` into a hard failure
instead of a skip — use it in CI so the ONNX↔PyTorch parity gate can't silently
pass by being skipped.

CI runs both on every PR that touches `ml/**`: [`.github/workflows/ml-ci.yml`](../.github/workflows/ml-ci.yml)
installs CPU torch + `.[onnx,dev]` on Python 3.11 and runs `ruff check` then
`REQUIRE_ONNX=1 pytest`. (Requires Python ≥ 3.10 — the code uses `zip(strict=…)`.)
