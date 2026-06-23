"""Export a trained BC checkpoint to ONNX for in-browser inference (D-4).

    python -m dicewars_bc.export_onnx --ckpt checkpoints/bc_model.pt --out bc_policy.onnx

The exported graph is **logits-only** for a single decision step: given one
observation's tensors (B=1) and its legal edges, it returns one raw logit per
edge (last edge = STOP) plus the aux value. The in-browser bot (a follow-up
slice, ONNX Runtime Web) argmaxes the edge logits — every edge is legal (the
legal set is ``getValidMoves`` + STOP), so no masking is needed at inference;
``argmax → {from, to}`` or STOP→``null``.

We export with dynamic ``batch`` and ``edges`` axes, then run the graph under
onnxruntime in Python and assert it agrees with PyTorch (the cross-bridge
parity the Phase-2 acceptance criteria call for). A sidecar ``<out>.json``
records the I/O contract + encoding version so the JS wrapper can assert
compatibility before trusting the model.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from .model import EdgePolicyNet, ModelConfig

INPUT_NAMES = ["nodes", "players", "board", "edge_feat", "edge_from", "edge_to", "edge_batch"]
OUTPUT_NAMES = ["edge_logits", "value"]


def _example_inputs(config: ModelConfig, n_edges: int = 6, seed: int = 0):
    """A single valid decision step (B=1, ``n_edges`` legal moves incl. STOP).

    Random feature values, but structurally valid: a present-mask, in-range
    territory ids, and a trailing STOP edge — enough to trace the graph and to
    drive a meaningful PyTorch-vs-ORT parity check.
    """
    g = torch.Generator().manual_seed(seed)
    a, p = config.max_areas, 7  # player_count isn't on config; globals width is from features
    # players height is data-defined, not on ModelConfig; infer a plausible 7 for the example.
    nodes = torch.rand(1, a, config.node_features, generator=g)
    nodes[..., EdgePolicyNet.PRESENT_COL] = (torch.rand(1, a, generator=g) > 0.3).float()
    players = torch.rand(1, p, config.player_features, generator=g)
    board = torch.rand(1, config.board_features, generator=g)

    edge_feat = torch.rand(n_edges, config.edge_features, generator=g)
    edge_feat[-1] = torch.tensor([0.0, 0.0, 0.0, 1.0])  # STOP edge (isStop=1)
    # Valid in-range territory ids; STOP references the sentinel node 0.
    edge_from = torch.randint(1, a, (n_edges,), generator=g)
    edge_to = torch.randint(1, a, (n_edges,), generator=g)
    edge_from[-1] = 0
    edge_to[-1] = 0
    edge_batch = torch.zeros(n_edges, dtype=torch.int64)
    return (nodes, players, board, edge_feat, edge_from, edge_to, edge_batch)


def export(ckpt_path: str | Path, out_path: str | Path, opset: int = 17) -> Path:
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    config = ModelConfig(**ckpt["config"])
    model = EdgePolicyNet(config)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    example = _example_inputs(config)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    dynamic_axes = {
        "nodes": {0: "batch"},
        "players": {0: "batch"},
        "board": {0: "batch"},
        "edge_feat": {0: "edges"},
        "edge_from": {0: "edges"},
        "edge_to": {0: "edges"},
        "edge_batch": {0: "edges"},
        "edge_logits": {0: "edges"},
        "value": {0: "batch"},
    }

    torch.onnx.export(
        model,
        example,
        str(out_path),
        input_names=INPUT_NAMES,
        output_names=OUTPUT_NAMES,
        dynamic_axes=dynamic_axes,
        opset_version=opset,
        do_constant_folding=True,
    )
    print(f"Exported ONNX → {out_path}")

    _check_parity(model, example, out_path)
    _write_sidecar(out_path, ckpt, config, opset)
    return out_path


def _check_parity(model, example, out_path: Path) -> None:
    """Assert onnxruntime reproduces PyTorch's outputs (the cross-bridge gate)."""
    try:
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime not installed — skipping the ORT parity check (install ml[onnx]).")
        return

    with torch.no_grad():
        torch_logits, torch_value = model(*example)

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    feeds = {name: t.numpy() for name, t in zip(INPUT_NAMES, example)}
    ort_logits, ort_value = sess.run(OUTPUT_NAMES, feeds)

    logit_err = float(np.abs(ort_logits - torch_logits.numpy()).max())
    value_err = float(np.abs(ort_value - torch_value.numpy()).max())
    tol = 1e-4
    if logit_err > tol or value_err > tol:
        raise RuntimeError(
            f"ONNX/PyTorch parity FAILED: max |Δlogits|={logit_err:.2e}, "
            f"max |Δvalue|={value_err:.2e} (tol {tol:.0e})."
        )
    print(f"ORT parity OK: max |Δlogits|={logit_err:.2e}, max |Δvalue|={value_err:.2e}")


def _write_sidecar(out_path: Path, ckpt: dict, config: ModelConfig, opset: int) -> None:
    """Write ``<out>.json`` — the contract the JS bot asserts against."""
    sidecar = {
        "encodingVersion": ckpt.get("encoding_version"),
        "teacher": ckpt.get("teacher"),
        "opset": opset,
        "modelConfig": config.to_dict(),
        "featureNames": ckpt.get("feature_names"),
        "io": {
            "inputs": [
                {"name": "nodes", "dtype": "float32", "shape": ["batch", config.max_areas, config.node_features]},
                {"name": "players", "dtype": "float32", "shape": ["batch", "players", config.player_features]},
                {"name": "board", "dtype": "float32", "shape": ["batch", config.board_features]},
                {"name": "edge_feat", "dtype": "float32", "shape": ["edges", config.edge_features]},
                {"name": "edge_from", "dtype": "int64", "shape": ["edges"]},
                {"name": "edge_to", "dtype": "int64", "shape": ["edges"]},
                {"name": "edge_batch", "dtype": "int64", "shape": ["edges"]},
            ],
            "outputs": [
                {"name": "edge_logits", "dtype": "float32", "shape": ["edges"]},
                {"name": "value", "dtype": "float32", "shape": ["batch", 2]},
            ],
        },
        "notes": [
            "Single-step inference: B=1, edge_batch all zeros. The last edge is STOP.",
            "Every edge is legal (legal set = getValidMoves + STOP); argmax(edge_logits) "
            "→ {from,to} from edge_index, or STOP → null. No masking needed.",
            "edge_from/edge_to are territory ids; build them from getValidMoves the same "
            "way src/arena/encodeObservation.js does (winProb, atk/8, def/8, isStop).",
        ],
    }
    sidecar_path = out_path.with_suffix(out_path.suffix + ".json")
    sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n")
    print(f"Wrote contract sidecar → {sidecar_path}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Export a BC checkpoint to ONNX (DiceWarsJS ml-bot)")
    p.add_argument("--ckpt", required=True, help="Trained checkpoint (.pt from train.py)")
    p.add_argument("--out", default="bc_policy.onnx", help="Output .onnx path")
    p.add_argument("--opset", type=int, default=17)
    return p


def main() -> None:
    args = build_parser().parse_args()
    export(args.ckpt, args.out, opset=args.opset)


if __name__ == "__main__":
    main()
