"""Export a trained BC checkpoint to ONNX for in-browser inference (D-4).

    python -m dicewars_bc.export_onnx --ckpt checkpoints/bc_model.pt --out bc_policy.onnx

The exported graph is **logits-only** for a single decision step: given one
observation's tensors (B=1) and its legal edges, it returns one raw logit per
edge (last edge = STOP) plus the aux value. The in-browser bot (a follow-up
slice, ONNX Runtime Web) argmaxes the edge logits — every edge is legal (the
legal set is ``getValidMoves`` + STOP), so no masking is needed at inference;
``argmax → {from, to}`` or STOP→``null``.

We export with dynamic ``batch`` and ``edges`` axes, then — when onnxruntime is
installed — run the graph under it and assert it agrees with PyTorch (the
cross-bridge parity the Phase-2 acceptance criteria call for). If onnxruntime is
absent the parity check cannot run: by default we warn loudly and stamp
``parityChecked: false`` (so the model is marked UNVERIFIED), and
``--require-parity`` turns that into a hard failure for an acceptance-gate run. A
sidecar ``<out>.json`` records the I/O contract, encoding version, and the parity
status so the JS wrapper can refuse — or at least warn on — an unverified model.
"""

from __future__ import annotations

import argparse
import inspect
import json
from pathlib import Path

import numpy as np
import torch

from .model import EdgePolicyNet, ModelConfig

INPUT_NAMES = ["nodes", "players", "board", "edge_feat", "edge_from", "edge_to", "edge_batch"]
OUTPUT_NAMES = ["edge_logits", "value"]


def _make_example(config: ModelConfig, edge_counts, n_seats=None, seed: int = 0):
    """A structurally valid ``B``-step batch (``B = len(edge_counts)``).

    Each step gets ``edge_counts[i]`` legal moves with a trailing STOP edge.
    Random feature values, but valid: a present-mask, in-range territory ids, a
    STOP edge per step (ids → sentinel 0). ``n_seats`` defaults to
    ``config.player_count``; pass a different value to exercise the dynamic seat
    axis. Used both to trace the graph (B=1) and to drive PyTorch-vs-ORT parity
    at B=1 and B>1 (so the cross-step ``edge_batch`` gather is actually checked).
    """
    g = torch.Generator().manual_seed(seed)
    a = config.max_areas
    p = config.player_count if n_seats is None else n_seats
    b = len(edge_counts)

    nodes = torch.rand(b, a, config.node_features, generator=g)
    nodes[..., EdgePolicyNet.PRESENT_COL] = (torch.rand(b, a, generator=g) > 0.3).float()
    players = torch.rand(b, p, config.player_features, generator=g)
    board = torch.rand(b, config.board_features, generator=g)

    total = sum(edge_counts)
    edge_feat = torch.rand(total, config.edge_features, generator=g)
    edge_from = torch.randint(1, a, (total,), generator=g)
    edge_to = torch.randint(1, a, (total,), generator=g)
    # Mark each step's LAST edge as STOP (isStop=1, ids → sentinel node 0).
    ends = torch.tensor(edge_counts).cumsum(0).tolist()
    for end in ends:
        i = end - 1
        edge_feat[i] = torch.tensor([0.0, 0.0, 0.0, 1.0])
        edge_from[i] = 0
        edge_to[i] = 0
    edge_batch = torch.repeat_interleave(torch.arange(b), torch.tensor(edge_counts))
    return (nodes, players, board, edge_feat, edge_from, edge_to, edge_batch)


def export(
    ckpt_path: str | Path, out_path: str | Path, opset: int = 17, require_parity: bool = False
) -> Path:
    # weights_only=True: our checkpoints are tensors + plain dict/list/str/num/None
    # (state_dict, config, feature_names, metadata) — no pickled classes — so the
    # restricted unpickler loads them and we never execute arbitrary pickle payloads.
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    config = ModelConfig(**ckpt["config"])
    model = EdgePolicyNet(config)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    example = _make_example(config, [6])  # B=1 single step, for tracing
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Both the seat axis (players dim 1) and edge count are per-game dynamic — the
    # net is seat-count-agnostic (mean-pool over seats), so the export must not
    # freeze either. Batch is dynamic for the B>1 parity check below.
    dynamic_axes = {
        "nodes": {0: "batch"},
        "players": {0: "batch", 1: "players"},
        "board": {0: "batch"},
        "edge_feat": {0: "edges"},
        "edge_from": {0: "edges"},
        "edge_to": {0: "edges"},
        "edge_batch": {0: "edges"},
        "edge_logits": {0: "edges"},
        "value": {0: "batch"},
    }

    export_kwargs = dict(
        input_names=INPUT_NAMES,
        output_names=OUTPUT_NAMES,
        dynamic_axes=dynamic_axes,
        opset_version=opset,
        do_constant_folding=True,
    )
    # torch>=2.9 defaults `torch.onnx.export` to the dynamo exporter, which needs
    # onnxscript and consumes `dynamic_shapes` rather than the `dynamic_axes`
    # contract above. Pin the legacy TorchScript exporter so the export is identical
    # across torch versions (and pulls no onnxscript) — but only pass the flag on
    # torch>=2.5, which is where the `dynamo` kwarg first exists (the floor is 2.1).
    # The eventual migration is to the dynamo exporter + dynamic_shapes.
    if "dynamo" in inspect.signature(torch.onnx.export).parameters:
        export_kwargs["dynamo"] = False
    torch.onnx.export(model, example, str(out_path), **export_kwargs)
    print(f"Exported ONNX → {out_path}")

    # Check parity at B=1 (the inference shape) AND B=2 — the latter is the only
    # case that exercises the cross-step `edge_batch * A` gather offset (it
    # vanishes at B=1) and confirms the dynamic batch/seat axes re-resolve.
    parity = _check_parity(
        model,
        out_path,
        [
            ("B=1 single step", example),
            ("B=2 multi-step", _make_example(config, [4, 5], seed=1)),
        ],
        strict=require_parity,
    )
    _write_sidecar(out_path, ckpt, config, opset, parity)
    return out_path


def _check_parity(model, out_path: Path, examples, strict: bool = False) -> dict:
    """Assert onnxruntime reproduces PyTorch's outputs (the cross-bridge gate),
    across each labeled (name, inputs) example.

    Returns a status dict that ``_write_sidecar`` stamps into the contract, so a
    consumer (and a human) can tell a verified model from an unverified one. If
    onnxruntime is unavailable the check cannot run: with ``strict`` we raise (an
    acceptance-gate run must fail loudly rather than ship an unverified model);
    otherwise we warn loudly and report ``checked=False``."""
    try:
        import onnxruntime as ort
    except ImportError as exc:
        msg = (
            "onnxruntime not installed — CANNOT verify ONNX↔PyTorch parity "
            "(install ml[onnx]); the exported model is UNVERIFIED."
        )
        if strict:
            raise RuntimeError(f"{msg} (--require-parity was set)") from exc
        print(f"WARNING: {msg}")
        return {"checked": False, "reason": "onnxruntime-not-installed"}

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    tol = 1e-4
    max_logit_err = 0.0
    max_value_err = 0.0
    for label, example in examples:
        with torch.no_grad():
            torch_logits, torch_value = model(*example)
        feeds = {name: t.numpy() for name, t in zip(INPUT_NAMES, example, strict=True)}
        ort_logits, ort_value = sess.run(OUTPUT_NAMES, feeds)

        logit_err = float(np.abs(ort_logits - torch_logits.numpy()).max())
        value_err = float(np.abs(ort_value - torch_value.numpy()).max())
        max_logit_err = max(max_logit_err, logit_err)
        max_value_err = max(max_value_err, value_err)
        if logit_err > tol or value_err > tol:
            raise RuntimeError(
                f"ONNX/PyTorch parity FAILED on {label}: max |Δlogits|={logit_err:.2e}, "
                f"max |Δvalue|={value_err:.2e} (tol {tol:.0e})."
            )
        print(
            f"ORT parity OK ({label}): max |Δlogits|={logit_err:.2e}, "
            f"max |Δvalue|={value_err:.2e}"
        )
    return {
        "checked": True,
        "tol": tol,
        "maxLogitErr": max_logit_err,
        "maxValueErr": max_value_err,
    }


def _write_sidecar(
    out_path: Path, ckpt: dict, config: ModelConfig, opset: int, parity: dict
) -> None:
    """Write ``<out>.json`` — the contract the JS bot asserts against.

    ``parityChecked`` records whether the ONNX↔PyTorch parity gate actually ran
    (it no-ops when onnxruntime is absent), so the JS wrapper can refuse — or at
    least warn on — a model whose numerics were never verified."""

    def spec(name: str, dtype: str, shape: list) -> dict:
        return {"name": name, "dtype": dtype, "shape": shape}

    sidecar = {
        "encodingVersion": ckpt.get("encoding_version"),
        "teacher": ckpt.get("teacher"),
        "opset": opset,
        "parityChecked": parity.get("checked", False),
        "parity": parity,
        "modelConfig": config.to_dict(),
        "featureNames": ckpt.get("feature_names"),
        "io": {
            "inputs": [
                spec("nodes", "float32", ["batch", config.max_areas, config.node_features]),
                spec("players", "float32", ["batch", "players", config.player_features]),
                spec("board", "float32", ["batch", config.board_features]),
                spec("edge_feat", "float32", ["edges", config.edge_features]),
                spec("edge_from", "int64", ["edges"]),
                spec("edge_to", "int64", ["edges"]),
                spec("edge_batch", "int64", ["edges"]),
            ],
            "outputs": [
                spec("edge_logits", "float32", ["edges"]),
                spec("value", "float32", ["batch", 2]),
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
    p.add_argument(
        "--require-parity",
        action="store_true",
        help="Fail (don't warn) if onnxruntime is unavailable to verify ONNX↔PyTorch parity",
    )
    return p


def main() -> None:
    args = build_parser().parse_args()
    export(args.ckpt, args.out, opset=args.opset, require_parity=args.require_parity)


if __name__ == "__main__":
    main()
