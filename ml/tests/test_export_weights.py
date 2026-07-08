"""export_weights: a (repacked-PPO-format) BC checkpoint → JS weights + parity fixture.

The Phase-3 gate (PLAN step 7) repacks a trained PPO actor into the *exact*
bare-``EdgePolicyNet`` checkpoint format ``export_weights`` consumes — a
``state_dict`` + ``config`` + ``encoding_version`` plus provenance ``extra`` keys
(``teacher``/``ppo_timesteps``/…). This asserts that path works end-to-end without
sb3 in the loop: build a tiny v2 net, save a repack-shaped checkpoint, export, and
check the JS module + fixture are well-formed and the provenance flows through.

It also covers the two on-disk formats (issue #51): the legacy self-contained
``--no-packed`` JSON (used by PPO-league snapshots) and the default compact
``--packed`` base64-float32 module that the shipped weights now use — including that
the packed blob decodes back to the *identical* weights and that ``--repack-js``
re-emits an existing module without a checkpoint.

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

from dicewars_bc.export_weights import _read_js_payload, export, repack_js  # noqa: E402
from dicewars_bc.model import EdgePolicyNet, ModelConfig  # noqa: E402

# v3 wire widths (mirror dicewars_ppo.constants / encodeObservation.js).
_V3 = dict(node_features=13, player_features=7, board_features=7, edge_features=10)

# The packed format imports a sibling ./unpackPolicyWeights.js; a stub satisfies the
# export-time existence check (the Python tests decode the blob directly, never via JS).
_DECODER_STUB = "// test stub for export-time sibling check\nexport const unpackPolicy = x => x;\n"


def _with_decoder(dir_path):
    (dir_path / "unpackPolicyWeights.js").write_text(_DECODER_STUB)


def _repacked_checkpoint() -> dict:
    """A checkpoint shaped exactly like ``repack_to_bc_checkpoint`` output."""
    config = ModelConfig(max_areas=8, player_count=7, **_V3)
    model = EdgePolicyNet(config)
    return {
        "state_dict": model.state_dict(),
        "config": config.to_dict(),
        "encoding_version": 3,
        # Provenance `extra` the repack stamps — must be ignored by export, not break it.
        "teacher": "ppo-tracer",
        "ppo_timesteps": 2048,
        "ppo_lr": 1e-4,
        "warm_started_from": "checkpoints/v2-base/bc_model.pt",
    }


def _save_repacked(tmp_path):
    ckpt_path = tmp_path / "ppo-tracer.pt"
    torch.save(_repacked_checkpoint(), ckpt_path)
    return ckpt_path


def _assert_payload_well_formed(payload: dict):
    # The version + provenance the gate's makeBC / header rely on.
    assert payload["encodingVersion"] == 3
    assert payload["teacher"] == "ppo-tracer"

    # Config dims the JS encoder/forward need.
    cfg = payload["config"]
    assert cfg["maxAreas"] == 8
    assert cfg["nodeFeatures"] == _V3["node_features"]
    assert cfg["edgeFeatures"] == _V3["edge_features"]
    assert cfg["presentCol"] == EdgePolicyNet.PRESENT_COL

    # All five MLP heads present, each a list of {w,b,relu} layers.
    assert set(payload["layers"]) == {
        "nodeEncoder",
        "playerEncoder",
        "context",
        "edgeHead",
        "valueHead",
    }
    for head in payload["layers"].values():
        assert head, "head has no layers"
        for layer in head:
            assert set(layer) == {"w", "b", "relu"}
            assert len(layer["w"]) == len(layer["b"])  # [out,in] rows == [out] biases


def _assert_fixture_well_formed(fixture: dict):
    assert fixture["config"]["maxAreas"] == 8
    assert len(fixture["cases"]) == 6
    for case in fixture["cases"]:
        assert {"nodes", "players", "board", "edges", "edgeIndex", "logits", "value"} <= set(case)
        assert len(case["logits"]) == len(case["edges"])  # one logit per edge
        assert len(case["value"]) == 2  # BC aux value head is (won, placement)


def test_export_packed_default_writes_decodable_js_and_fixture(tmp_path):
    """The default (packed) export imports the decoder and round-trips to valid weights."""
    _with_decoder(tmp_path)
    ckpt_path = _save_repacked(tmp_path)

    out_path = tmp_path / "ppoPolicyWeights.js"
    fixture_path = tmp_path / "ppoForwardCases.json"
    export(ckpt_path, out_path, fixture_path=fixture_path)

    text = out_path.read_text()
    # Packed module: imports the sibling decoder and wraps a compact payload.
    assert "import { unpackPolicy } from './unpackPolicyWeights.js';" in text
    assert re.search(r"export const BC_POLICY = unpackPolicy\(\{.*\}\);", text, re.DOTALL)

    # _read_js_payload decodes the base64 blob back to the materialized weights.
    _assert_payload_well_formed(_read_js_payload(text))
    _assert_fixture_well_formed(json.loads(fixture_path.read_text()))


def test_packed_and_no_packed_decode_to_identical_weights(tmp_path):
    """Packed (base64-float32) and legacy JSON forms reconstruct the exact same payload."""
    ckpt_path = _save_repacked(tmp_path)

    plain_path = tmp_path / "plain.js"
    export(ckpt_path, plain_path, fixture_path=None, packed=False)
    plain_text = plain_path.read_text()
    assert "unpackPolicy" not in plain_text
    assert re.search(r"export const BC_POLICY = \{.*\};", plain_text, re.DOTALL)

    packed_dir = tmp_path / "ai"
    packed_dir.mkdir()
    _with_decoder(packed_dir)
    packed_path = packed_dir / "packed.js"
    export(ckpt_path, packed_path, fixture_path=None, packed=True)

    # Float32 is lossless across the round-trip, so the materialized payloads are equal.
    assert _read_js_payload(packed_text := packed_path.read_text()) == _read_js_payload(plain_text)
    # And the compact form is meaningfully smaller on disk — the point of the change.
    assert len(packed_text) < len(plain_text)


def test_packed_requires_sibling_decoder(tmp_path):
    """A packed export into a dir without the decoder fails loud, not silently broken."""
    ckpt_path = _save_repacked(tmp_path)
    with pytest.raises(FileNotFoundError, match="unpackPolicyWeights"):
        export(ckpt_path, tmp_path / "nodecoder.js", fixture_path=None, packed=True)


def test_repack_js_round_trips_without_a_checkpoint(tmp_path):
    """--repack-js re-emits an existing module (either direction) preserving the weights."""
    ckpt_path = _save_repacked(tmp_path)
    plain_path = tmp_path / "plain.js"
    export(ckpt_path, plain_path, fixture_path=None, packed=False)
    original = _read_js_payload(plain_path.read_text())

    ai_dir = tmp_path / "ai"
    ai_dir.mkdir()
    _with_decoder(ai_dir)
    packed_path = ai_dir / "packed.js"
    repack_js(plain_path, packed_path, packed=True)
    assert _read_js_payload(packed_path.read_text()) == original
    assert packed_path.stat().st_size < plain_path.stat().st_size

    # …and back from packed → plain reconstructs the original module's weights too.
    back_path = tmp_path / "back.js"
    repack_js(packed_path, back_path, packed=False)
    assert _read_js_payload(back_path.read_text()) == original


def test_repack_js_rejects_fixture_via_cli(tmp_path, monkeypatch):
    """--fixture with --repack-js is rejected (no model to sample a fixture from)."""
    from dicewars_bc import export_weights

    monkeypatch.setattr(
        "sys.argv",
        ["export_weights", "--repack-js", "x.js", "--out", "y.js", "--fixture", "f.json"],
    )
    with pytest.raises(SystemExit, match="--fixture is not supported with --repack-js"):
        export_weights.main()


def test_export_rejects_encoding_version_skew(tmp_path):
    """A stale-version checkpoint fails fast rather than emitting wrong JS weights."""
    ckpt = _repacked_checkpoint()
    ckpt["encoding_version"] = 1  # pretend a v1 checkpoint slipped through
    ckpt_path = tmp_path / "stale.pt"
    torch.save(ckpt, ckpt_path)

    with pytest.raises(ValueError, match="encoding_version"):
        export(ckpt_path, tmp_path / "out.js", fixture_path=None)


def test_export_rejects_non_finite_weights(tmp_path):
    """A NaN/Inf checkpoint (training divergence) is refused at export, not silently shipped.

    Without the guard it would decode into a legal but degenerate all-NaN-logits bot that
    argmaxes to index 0 every turn, with nothing pointing at the corrupt weights (issue #93)."""
    config = ModelConfig(max_areas=8, player_count=7, **_V3)
    model = EdgePolicyNet(config)
    sd = model.state_dict()
    # Poison one weight with NaN — the training-divergence signature.
    key = next(k for k in sd if k.endswith("weight"))
    sd[key] = sd[key].clone()
    sd[key].view(-1)[0] = float("nan")
    ckpt = {
        "state_dict": sd,
        "config": config.to_dict(),
        "encoding_version": 3,
        "teacher": "nan-test",
    }
    ckpt_path = tmp_path / "nan.pt"
    torch.save(ckpt, ckpt_path)

    # packed=False avoids the decoder-sibling requirement; the guard runs before either branch.
    with pytest.raises(ValueError, match="non-finite"):
        export(ckpt_path, tmp_path / "out.js", fixture_path=None, packed=False)


def test_export_without_fixture_is_optional(tmp_path):
    """--fixture is optional; omitting it still writes a valid weights module."""
    ckpt_path = _save_repacked(tmp_path)
    out_path = tmp_path / "ppoPolicyWeights.js"

    export(ckpt_path, out_path, fixture_path=None, packed=False)

    assert out_path.exists()
    assert not (tmp_path / "ppoForwardCases.json").exists()
    assert _read_js_payload(out_path.read_text())["encodingVersion"] == 3
