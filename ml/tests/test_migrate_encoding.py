"""v2 → v3 checkpoint migration (dicewars_bc.migrate_encoding).

The migration must (1) widen exactly the four first-layer input dims with zero
tail columns, (2) restamp config + encoding_version, and (3) be function-
preserving — the module runs that self-check internally on every migrate, so a
successful call already proves it; the tests here pin the surrounding contract.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from dicewars_bc.migrate_encoding import (  # noqa: E402
    _assert_function_preserved,
    migrate_checkpoint,
)
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


# --- the function-preservation self-check itself ---------------------------------


def _clone_state(ckpt: dict) -> dict:
    return {**ckpt, "state_dict": {k: v.clone() for k, v in ckpt["state_dict"].items()}}


def test_self_check_fires_on_prepend_instead_of_append():
    """The self-check must actually FIRE on a broken migration, not just pass a good
    one. Corrupt a valid migrated dict the way a prepend-instead-of-append bug would:
    roll node_encoder.0's input columns so the zero columns sit at the FRONT."""
    src = _v2_ckpt()
    corrupted = _clone_state(migrate_checkpoint(src))
    w = corrupted["state_dict"]["node_encoder.0.weight"]  # [H, 13]: 8 old cols + 5 zeros
    corrupted["state_dict"]["node_encoder.0.weight"] = torch.roll(w, shifts=5, dims=1)
    with pytest.raises(AssertionError, match="function-preserving"):
        _assert_function_preserved(src, corrupted)


def _final_edge_layer_keys(state: dict) -> tuple:
    """(weight, bias) keys of edge_head's LAST Linear — found by index, not hardcoded."""
    last = max(
        int(k.split(".")[1]) for k in state if k.startswith("edge_head.") and k.endswith(".weight")
    )
    return f"edge_head.{last}.weight", f"edge_head.{last}.bias"


def _probe_max_logit(ckpt: dict) -> float:
    """Max |edge logit| of a checkpoint's net on a fixed seeded probe input."""
    cfg = ModelConfig(**ckpt["config"])
    net = EdgePolicyNet(cfg)
    net.load_state_dict(ckpt["state_dict"])
    net.eval()
    g = torch.Generator().manual_seed(123)
    a, p, e = cfg.max_areas, cfg.player_count, 5
    with torch.no_grad():
        logits, _ = net(
            torch.rand(1, a, cfg.node_features, generator=g),
            torch.rand(1, p, cfg.player_features, generator=g),
            torch.rand(1, cfg.board_features, generator=g),
            torch.rand(e, cfg.edge_features, generator=g),
            torch.randint(0, a, (e,), generator=g),
            torch.randint(0, a, (e,), generator=g),
            torch.zeros(e, dtype=torch.int64),
        )
    return logits.abs().max().item()


def _big_logit_v2_ckpt(target: float = 50.0) -> dict:
    """A v2 checkpoint scaled (via edge_head's final Linear) to |logit| ~ target —
    the large-logit regime of the real trained checkpoint the #104 fix was for."""
    ckpt = _clone_state(_v2_ckpt(seed=1))
    w_key, b_key = _final_edge_layer_keys(ckpt["state_dict"])
    factor = target / _probe_max_logit(ckpt)
    ckpt["state_dict"][w_key] = ckpt["state_dict"][w_key] * factor
    ckpt["state_dict"][b_key] = ckpt["state_dict"][b_key] * factor
    return ckpt


def _perturb_final_edge_layer(ckpt: dict, rel: float) -> dict:
    """Scale edge_head's final Linear by (1 + rel) — every logit shifts by exactly
    `rel` RELATIVE (the layer is linear in its own weights), so the diff magnitude
    is controlled deterministically instead of relying on BLAS reordering noise."""
    out = _clone_state(ckpt)
    w_key, b_key = _final_edge_layer_keys(out["state_dict"])
    out["state_dict"][w_key] = out["state_dict"][w_key] * (1.0 + rel)
    out["state_dict"][b_key] = out["state_dict"][b_key] * (1.0 + rel)
    return out


def test_self_check_tolerance_is_scale_aware():
    """Guards the #104 fix: at logit magnitude ~50, a ~1e-7 RELATIVE difference (the
    measured wider-GEMM accumulation-order noise) must PASS the self-check, while a
    genuine mismatch (relative error above 1e-3) must still FAIL."""
    src = _big_logit_v2_ckpt()
    assert _probe_max_logit(src) == pytest.approx(50.0)  # really the large-logit regime
    migrated = migrate_checkpoint(src)  # the honest migration passes at this scale

    # ~1e-7 relative at |logit| ~ 50 (≈ 5e-6 absolute): within the scale-aware bound. A
    # revert to bit-equality or a plain tiny atol would raise here.
    _assert_function_preserved(src, _perturb_final_edge_layer(migrated, 1e-7))

    # A genuine mismatch (2e-3 relative ≈ 0.1 absolute at this scale) must still fire.
    with pytest.raises(AssertionError, match="function-preserving"):
        _assert_function_preserved(src, _perturb_final_edge_layer(migrated, 2e-3))


# --- end-to-end: migrated checkpoint → PPO warm-start -----------------------------


def test_migrated_checkpoint_warm_starts_ppo_end_to_end(tmp_path):
    """The [D-31] §4 fallback arm for real: migrate a v2 checkpoint, torch.save it,
    then load + warm-start the PPO policy from the file exactly as train.py does.
    Provenance extras must survive migration AND the weights_only=True reload."""
    pytest.importorskip("gymnasium")
    pytest.importorskip("sb3_contrib")
    from dicewars_ppo.env import DiceWarsEnv
    from dicewars_ppo.policy import build_policy, load_bc_checkpoint, warm_start_from_bc

    src = _v2_ckpt()
    src["teacher"] = "x"  # a provenance extra riding along the migration
    path = tmp_path / "v3.pt"
    torch.save(migrate_checkpoint(src), path)

    cfg, ckpt = load_bc_checkpoint(path)  # asserts the live encoding_version + wire widths
    assert ckpt["teacher"] == "x"
    assert ckpt["migrated_from_encoding"] == 2

    env = DiceWarsEnv(max_areas=cfg.max_areas, player_count=cfg.player_count)
    policy = build_policy(env.observation_space, env.action_space, cfg)
    warm_start_from_bc(policy, ckpt)
    actor_state = policy.bc_net.state_dict()
    for k, v in ckpt["state_dict"].items():
        assert torch.equal(actor_state[k], v)
