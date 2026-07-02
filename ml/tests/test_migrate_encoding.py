"""v2 → v3 checkpoint migration (dicewars_bc.migrate_encoding).

The migration must (1) widen exactly the four first-layer input dims with zero
tail columns, (2) restamp config + encoding_version, and (3) be function-
preserving — the module runs that self-check internally on every migrate, so a
successful call already proves it; the tests here pin the surrounding contract.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from dicewars_bc.migrate_encoding import migrate_checkpoint  # noqa: E402
from dicewars_bc.model import EdgePolicyNet, ModelConfig  # noqa: E402

_V2_CFG = dict(
    max_areas=6,
    node_features=8,
    player_features=6,
    board_features=5,
    edge_features=7,
    player_count=2,
    node_hidden=8,
    player_hidden=8,
    context_hidden=16,
    edge_hidden=16,
)


def _v2_ckpt(seed: int = 0) -> dict:
    cfg = ModelConfig(**_V2_CFG)
    torch.manual_seed(seed)
    net = EdgePolicyNet(cfg)
    return {"state_dict": net.state_dict(), "config": cfg.to_dict(), "encoding_version": 2}


def test_migrates_widths_version_and_passes_self_check():
    out = migrate_checkpoint(_v2_ckpt())

    assert out["encoding_version"] == 3
    assert out["migrated_from_encoding"] == 2
    assert out["config"]["node_features"] == 13
    assert out["config"]["player_features"] == 7
    assert out["config"]["board_features"] == 7
    assert out["config"]["edge_features"] == 10

    sd = out["state_dict"]
    assert sd["node_encoder.0.weight"].shape == (8, 13)
    assert sd["player_encoder.0.weight"].shape == (8, 7)
    assert sd["context.0.weight"].shape == (16, 8 + 8 + 7)
    assert sd["edge_head.0.weight"].shape == (16, 16 + 2 * 8 + 10)
    # The appended tail columns are exactly zero (the function-preserving part).
    assert torch.all(sd["node_encoder.0.weight"][:, 8:] == 0)
    assert torch.all(sd["edge_head.0.weight"][:, -3:] == 0)

    # The migrated dict loads into a real v3-config net (keys and shapes line up).
    net = EdgePolicyNet(ModelConfig(**out["config"]))
    net.load_state_dict(sd)


def test_source_dict_is_not_mutated():
    src = _v2_ckpt()
    before = {k: v.clone() for k, v in src["state_dict"].items()}
    migrate_checkpoint(src)
    assert src["encoding_version"] == 2
    assert src["config"]["node_features"] == 8
    for k, v in src["state_dict"].items():
        assert torch.equal(v, before[k])


def test_rejects_non_v2_stamp():
    ckpt = _v2_ckpt()
    ckpt["encoding_version"] = 3
    with pytest.raises(ValueError, match="expected 2"):
        migrate_checkpoint(ckpt)


def test_rejects_non_v2_widths():
    ckpt = _v2_ckpt()
    ckpt["config"]["node_features"] = 5  # v1 shape under a v2 stamp
    with pytest.raises(ValueError, match="not the v2 wire width"):
        migrate_checkpoint(ckpt)
