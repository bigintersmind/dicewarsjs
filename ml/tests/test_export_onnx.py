"""ONNX export: it traces, the sidecar contract is written, ORT matches torch,
and the edges axis is genuinely dynamic."""

import importlib
import json
import os
import sys

import numpy as np
import pytest

_REQUIRE_ONNX = os.environ.get("REQUIRE_ONNX") == "1"


def _require(modname: str):
    """Import ``modname``; skip this module if it's missing — unless REQUIRE_ONNX=1,
    in which case a missing module is a hard failure, so a CI job meant to verify
    the ONNX↔PyTorch parity gate can't silently go green by skipping it."""
    try:
        return importlib.import_module(modname)
    except ImportError:
        if _REQUIRE_ONNX:
            raise
        pytest.skip(f"{modname} not installed (set REQUIRE_ONNX=1 to make this a failure)")


torch = _require("torch")
_require("onnx")
ort = _require("onnxruntime")

from dicewars_bc.export_onnx import INPUT_NAMES, OUTPUT_NAMES, export  # noqa: E402
from dicewars_bc.model import EdgePolicyNet, ModelConfig  # noqa: E402


def _make_checkpoint(tmp_path):
    config = ModelConfig(
        max_areas=8, node_features=5, player_features=6, board_features=5, edge_features=4
    )
    model = EdgePolicyNet(config)
    ckpt = {
        "state_dict": model.state_dict(),
        "config": config.to_dict(),
        "encoding_version": 1,
        "feature_names": {"node": [], "player": [], "board": [], "edge": []},
        "teacher": "Lookahead",
    }
    ckpt_path = tmp_path / "bc_model.pt"
    torch.save(ckpt, ckpt_path)
    return ckpt_path, config


def test_export_writes_model_and_sidecar(tmp_path):
    ckpt_path, _ = _make_checkpoint(tmp_path)
    onnx_path = tmp_path / "bc_policy.onnx"
    # export() runs the PyTorch-vs-ORT parity check internally and raises on mismatch.
    export(ckpt_path, onnx_path)

    assert onnx_path.is_file()
    sidecar = onnx_path.with_suffix(".onnx.json")
    assert sidecar.is_file()

    meta = json.loads(sidecar.read_text())
    assert meta["encodingVersion"] == 1
    assert meta["teacher"] == "Lookahead"
    assert [i["name"] for i in meta["io"]["inputs"]] == INPUT_NAMES
    assert [o["name"] for o in meta["io"]["outputs"]] == OUTPUT_NAMES
    # The parity gate ran (onnxruntime is present in this test module) and the
    # sidecar records it so a downstream consumer can refuse an unverified model.
    assert meta["parityChecked"] is True
    assert meta["parity"]["checked"] is True
    assert meta["parity"]["maxLogitErr"] <= meta["parity"]["tol"]


def test_export_without_onnxruntime_marks_model_unverified(tmp_path, monkeypatch):
    """FIX #1: a missing onnxruntime must NOT silently pass the parity gate.

    Simulate ort being absent (setting sys.modules['onnxruntime'] = None makes
    ``import onnxruntime`` raise ImportError inside ``_check_parity``). The export
    still produces a model, but the sidecar must record it as UNVERIFIED; and
    ``require_parity=True`` (the --require-parity flag) must turn that into a hard
    failure. onnx itself stays present so ``torch.onnx.export`` still traces.
    """
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    ckpt_path, _ = _make_checkpoint(tmp_path)
    onnx_path = tmp_path / "bc_policy.onnx"

    # Non-strict: export succeeds but stamps the model as unverified.
    export(ckpt_path, onnx_path)
    meta = json.loads(onnx_path.with_suffix(".onnx.json").read_text())
    assert meta["parityChecked"] is False
    assert meta["parity"]["checked"] is False
    assert meta["parity"]["reason"] == "onnxruntime-not-installed"

    # Strict: a parity gate that can't run is a hard failure.
    with pytest.raises(RuntimeError, match="require-parity"):
        export(ckpt_path, onnx_path, require_parity=True)


def test_onnx_dynamic_edges_axis(tmp_path):
    """The exported graph runs for an edge count different from the trace."""
    ckpt_path, config = _make_checkpoint(tmp_path)
    onnx_path = tmp_path / "bc_policy.onnx"
    export(ckpt_path, onnx_path)

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    for n_edges in (1, 3, 11):  # the export example used 6
        a = config.max_areas
        nodes = np.random.rand(1, a, 5).astype(np.float32)
        nodes[..., 0] = (np.random.rand(1, a) > 0.3).astype(np.float32)
        feeds = {
            "nodes": nodes,
            "players": np.random.rand(1, 7, 6).astype(np.float32),
            "board": np.random.rand(1, 5).astype(np.float32),
            "edge_feat": np.random.rand(n_edges, 4).astype(np.float32),
            "edge_from": np.random.randint(0, a, n_edges).astype(np.int64),
            "edge_to": np.random.randint(0, a, n_edges).astype(np.int64),
            "edge_batch": np.zeros(n_edges, dtype=np.int64),
        }
        edge_logits, value = sess.run(OUTPUT_NAMES, feeds)
        assert edge_logits.shape == (n_edges,)
        assert value.shape == (1, 2)


def test_onnx_dynamic_players_axis(tmp_path):
    """The exported graph accepts a seat count different from the trace — the model
    mean-pools over seats, so the seat axis must stay dynamic (regression for the
    seat-axis-frozen-at-7 bug)."""
    ckpt_path, config = _make_checkpoint(tmp_path)  # config.player_count defaults to 7
    onnx_path = tmp_path / "bc_policy.onnx"
    export(ckpt_path, onnx_path)

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    a = config.max_areas
    n_edges = 5
    for n_seats in (2, 4, 8):  # the trace used config.player_count (7)
        nodes = np.random.rand(1, a, 5).astype(np.float32)
        nodes[..., 0] = 1.0
        feeds = {
            "nodes": nodes,
            "players": np.random.rand(1, n_seats, 6).astype(np.float32),
            "board": np.random.rand(1, 5).astype(np.float32),
            "edge_feat": np.random.rand(n_edges, 4).astype(np.float32),
            "edge_from": np.random.randint(0, a, n_edges).astype(np.int64),
            "edge_to": np.random.randint(0, a, n_edges).astype(np.int64),
            "edge_batch": np.zeros(n_edges, dtype=np.int64),
        }
        edge_logits, value = sess.run(OUTPUT_NAMES, feeds)
        assert edge_logits.shape == (n_edges,)
        assert value.shape == (1, 2)


def test_onnx_matches_torch_on_a_real_step(tmp_path):
    """Independent ORT-vs-PyTorch check on a freshly built single step."""
    ckpt_path, config = _make_checkpoint(tmp_path)
    onnx_path = tmp_path / "bc_policy.onnx"
    export(ckpt_path, onnx_path)

    model = EdgePolicyNet(config)
    model.load_state_dict(torch.load(ckpt_path, weights_only=True)["state_dict"])
    model.eval()

    a = config.max_areas
    g = torch.Generator().manual_seed(7)
    nodes = torch.rand(1, a, 5, generator=g)
    nodes[..., 0] = 1.0
    players = torch.rand(1, 7, 6, generator=g)
    board = torch.rand(1, 5, generator=g)
    edge_feat = torch.rand(4, 4, generator=g)
    edge_from = torch.tensor([1, 2, 3, 0])
    edge_to = torch.tensor([2, 3, 1, 0])
    edge_batch = torch.zeros(4, dtype=torch.int64)

    with torch.no_grad():
        t_logits, t_value = model(nodes, players, board, edge_feat, edge_from, edge_to, edge_batch)

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    feeds = dict(
        zip(
            INPUT_NAMES,
            [t.numpy() for t in (nodes, players, board, edge_feat, edge_from, edge_to, edge_batch)],
            strict=True,
        )
    )
    o_logits, o_value = sess.run(OUTPUT_NAMES, feeds)
    np.testing.assert_allclose(o_logits, t_logits.numpy(), atol=1e-4)
    np.testing.assert_allclose(o_value, t_value.numpy(), atol=1e-4)
