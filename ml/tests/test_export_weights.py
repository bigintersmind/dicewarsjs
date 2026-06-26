"""export_weights: a (repacked-PPO-format) BC checkpoint → JS weights + parity fixture.

The Phase-3 gate (PLAN step 7) repacks a trained PPO actor into the *exact*
bare-``EdgePolicyNet`` checkpoint format ``export_weights`` consumes — a
``state_dict`` + ``config`` + ``encoding_version`` plus provenance ``extra`` keys
(``teacher``/``ppo_timesteps``/…). This asserts that path works end-to-end without
sb3 in the loop: build a tiny v2 net, save a repack-shaped checkpoint, export, and
check the JS module + fixture are well-formed and the provenance flows through.

torch-only (no onnx, no sb3-contrib), so it runs in the BC CI tier.
"""

from __future__ import annotations

import importlib
import json
import re

import pytest


def _require(modname: str):
    try:
        return importlib.import_module(modname)
    except ImportError:
        pytest.skip(f"{modname} not installed")


torch = _require("torch")

from dicewars_bc.export_weights import export  # noqa: E402
from dicewars_bc.model import EdgePolicyNet, ModelConfig  # noqa: E402

# v2 wire widths (mirror dicewars_ppo.constants / encodeObservation.js).
_V2 = dict(node_features=8, player_features=6, board_features=5, edge_features=7)


def _repacked_checkpoint() -> dict:
    """A checkpoint shaped exactly like ``repack_to_bc_checkpoint`` output."""
    config = ModelConfig(max_areas=8, player_count=7, **_V2)
    model = EdgePolicyNet(config)
    return {
        "state_dict": model.state_dict(),
        "config": config.to_dict(),
        "encoding_version": 2,
        # Provenance `extra` the repack stamps — must be ignored by export, not break it.
        "teacher": "ppo-tracer",
        "ppo_timesteps": 2048,
        "ppo_lr": 1e-4,
        "warm_started_from": "checkpoints/v2-base/bc_model.pt",
    }


def _parse_js_payload(js_text: str) -> dict:
    """Pull the JSON object out of ``export const BC_POLICY = {...};``."""
    m = re.search(r"export const BC_POLICY = (\{.*\});", js_text, re.DOTALL)
    assert m, "BC_POLICY export not found in generated JS"
    return json.loads(m.group(1))


def test_export_repacked_checkpoint_writes_js_and_fixture(tmp_path):
    ckpt_path = tmp_path / "ppo-tracer.pt"
    torch.save(_repacked_checkpoint(), ckpt_path)

    out_path = tmp_path / "ppoPolicyWeights.js"
    fixture_path = tmp_path / "ppoForwardCases.json"
    export(ckpt_path, out_path, fixture_path=fixture_path)

    payload = _parse_js_payload(out_path.read_text())

    # The version + provenance the gate's makeBC / header rely on.
    assert payload["encodingVersion"] == 2
    assert payload["teacher"] == "ppo-tracer"

    # Config dims the JS encoder/forward need.
    cfg = payload["config"]
    assert cfg["maxAreas"] == 8
    assert cfg["nodeFeatures"] == _V2["node_features"]
    assert cfg["edgeFeatures"] == _V2["edge_features"]
    assert cfg["presentCol"] == EdgePolicyNet.PRESENT_COL

    # All five MLP heads present, each a list of {w,b,relu} layers.
    assert set(payload["layers"]) == {
        "nodeEncoder", "playerEncoder", "context", "edgeHead", "valueHead"
    }
    for head in payload["layers"].values():
        assert head, "head has no layers"
        for layer in head:
            assert set(layer) == {"w", "b", "relu"}
            assert len(layer["w"]) == len(layer["b"])  # [out,in] rows == [out] biases

    # The sibling parity fixture: self-consistent reference cases for the JS forward.
    fixture = json.loads(fixture_path.read_text())
    assert fixture["config"]["maxAreas"] == 8
    assert len(fixture["cases"]) == 6
    for case in fixture["cases"]:
        assert {"nodes", "players", "board", "edges", "edgeIndex", "logits", "value"} <= set(case)
        assert len(case["logits"]) == len(case["edges"])  # one logit per edge
        assert len(case["value"]) == 2  # BC aux value head is (won, placement)


def test_export_rejects_encoding_version_skew(tmp_path):
    """A stale-version checkpoint fails fast rather than emitting wrong JS weights."""
    ckpt = _repacked_checkpoint()
    ckpt["encoding_version"] = 1  # pretend a v1 checkpoint slipped through
    ckpt_path = tmp_path / "stale.pt"
    torch.save(ckpt, ckpt_path)

    with pytest.raises(ValueError, match="encoding_version"):
        export(ckpt_path, tmp_path / "out.js", fixture_path=None)


def test_export_without_fixture_is_optional(tmp_path):
    """--fixture is optional; omitting it still writes a valid weights module."""
    ckpt_path = tmp_path / "ppo-tracer.pt"
    torch.save(_repacked_checkpoint(), ckpt_path)
    out_path = tmp_path / "ppoPolicyWeights.js"

    export(ckpt_path, out_path, fixture_path=None)

    assert out_path.exists()
    assert not (tmp_path / "ppoForwardCases.json").exists()
    assert _parse_js_payload(out_path.read_text())["encodingVersion"] == 2
