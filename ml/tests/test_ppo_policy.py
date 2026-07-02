"""Tests for the Phase-3 PPO policy (warm-start + repack parity, masked forward).

Hermetic: builds a tiny synthetic v2 BC checkpoint (no real corpus/data) and
exercises the policy purely in-process. Needs the `[rl]` stack (sb3-contrib +
gymnasium) and torch, so it runs on shodan and skips in the BC CI — same split as
the live env smoke (`test_ppo_env.py`).

The headline test is the **repack round-trip**: warm-start the policy from a BC
checkpoint, then `repack_to_bc_checkpoint` and reload into a bare `EdgePolicyNet`
— the actor must be byte-identical to the source. That is the [D-19] gate
constraint (the graded bot == the trained policy) asserted early.
"""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("gymnasium")
pytest.importorskip("sb3_contrib")

from dicewars_bc.model import EdgePolicyNet, ModelConfig  # noqa: E402
from dicewars_ppo.constants import (  # noqa: E402
    BOARD_W,
    EDGE_W,
    MAX_EDGES,
    NODE_W,
    PLAYER_W,
)
from dicewars_ppo.env import DiceWarsEnv  # noqa: E402
from dicewars_ppo.policy import (  # noqa: E402
    build_policy,
    load_bc_checkpoint,
    repack_to_bc_checkpoint,
    warm_start_from_bc,
)


def _v2_config(**overrides) -> ModelConfig:
    """A small but v2-shaped ModelConfig (feature widths must match the wire)."""
    base = dict(
        max_areas=32,
        node_features=NODE_W,
        player_features=PLAYER_W,
        board_features=BOARD_W,
        edge_features=EDGE_W,
        player_count=7,
        # tiny hidden sizes keep the test fast; the policy is size-agnostic
        node_hidden=16,
        player_hidden=8,
        context_hidden=24,
        edge_hidden=16,
    )
    base.update(overrides)
    return ModelConfig(**base)


def _make_bc_checkpoint(cfg: ModelConfig, *, encoding_version: int = 3, seed: int = 0) -> dict:
    """A BC-format checkpoint dict (state_dict + config) from a fresh EdgePolicyNet."""
    torch.manual_seed(seed)
    net = EdgePolicyNet(cfg)
    return {
        "state_dict": net.state_dict(),
        "config": cfg.to_dict(),
        "encoding_version": encoding_version,
        "teacher": "Lookahead",
    }


def _spaces(cfg: ModelConfig):
    """The env's real observation/action spaces (no server is launched)."""
    env = DiceWarsEnv(max_areas=cfg.max_areas, player_count=cfg.player_count)
    return env.observation_space, env.action_space


def _build_warm_started(cfg: ModelConfig, ckpt: dict):
    obs_space, act_space = _spaces(cfg)
    policy = build_policy(obs_space, act_space, cfg)
    warm_start_from_bc(policy, ckpt)
    return policy


def _fake_obs_batch(cfg: ModelConfig, *, n: int = 2, n_edges: int = 3, max_edges: int = MAX_EDGES):
    """A padded obs batch with `n_edges` legal slots (last = STOP) and its mask."""
    a, p = cfg.max_areas, cfg.player_count
    rng = np.random.default_rng(7)
    nodes = rng.standard_normal((n, a, NODE_W)).astype(np.float32)
    nodes[:, :6, 0] = 1.0  # first 6 territories present (col 0 = present)
    nodes[:, 6:, 0] = 0.0
    players = rng.standard_normal((n, p, PLAYER_W)).astype(np.float32)
    board = rng.standard_normal((n, BOARD_W)).astype(np.float32)

    edge_feat = np.zeros((n, max_edges, EDGE_W), np.float32)
    edge_from = np.zeros((n, max_edges), np.int32)
    edge_to = np.zeros((n, max_edges), np.int32)
    mask = np.zeros((n, max_edges), np.int8)
    for b in range(n):
        # n_edges-1 attacks then a trailing STOP edge (from=to=0, isStop @ col 3)
        edge_feat[b, : n_edges - 1] = rng.standard_normal((n_edges - 1, EDGE_W)).astype(np.float32)
        edge_from[b, : n_edges - 1] = rng.integers(1, 6, n_edges - 1)
        edge_to[b, : n_edges - 1] = rng.integers(1, 6, n_edges - 1)
        edge_feat[b, n_edges - 1, 3] = 1.0  # STOP
        mask[b, :n_edges] = 1

    obs = {
        "nodes": torch.as_tensor(nodes),
        "players": torch.as_tensor(players),
        "board": torch.as_tensor(board),
        "edge_feat": torch.as_tensor(edge_feat),
        "edge_from": torch.as_tensor(edge_from),
        "edge_to": torch.as_tensor(edge_to),
        "edge_mask": torch.as_tensor(mask),
    }
    return obs, torch.as_tensor(mask).bool(), n_edges


def _state_dicts_equal(a: dict, b: dict) -> bool:
    return a.keys() == b.keys() and all(torch.equal(a[k], b[k]) for k in a)


# --- warm-start ------------------------------------------------------------------


def test_warm_start_loads_actor_from_checkpoint():
    cfg = _v2_config()
    ckpt = _make_bc_checkpoint(cfg)
    policy = _build_warm_started(cfg, ckpt)

    # The actor (trunk + edge_head + BC value_head) is byte-identical to the source.
    assert _state_dicts_equal(policy.bc_net.state_dict(), ckpt["state_dict"])


def test_fresh_scalar_critic_is_separate_from_bc_value_head():
    cfg = _v2_config()
    policy = _build_warm_started(cfg, _make_bc_checkpoint(cfg))

    # The PPO critic is a fresh scalar head (context_hidden -> 1), NOT BC's
    # 2-output (won, placement) value_head.
    assert isinstance(policy.value_net, torch.nn.Linear)
    assert policy.value_net.out_features == 1
    assert policy.value_net.in_features == cfg.context_hidden
    assert policy.bc_net.value_head[-1].out_features == 2  # BC head untouched
    # value_net params are not part of the actor that gets repacked.
    actor_ids = {id(p) for p in policy.bc_net.parameters()}
    assert all(id(p) not in actor_ids for p in policy.value_net.parameters())


# --- masked forward --------------------------------------------------------------


def test_forward_shapes_and_masking():
    cfg = _v2_config()
    policy = _build_warm_started(cfg, _make_bc_checkpoint(cfg))
    obs, masks, n_edges = _fake_obs_batch(cfg)

    actions, values, log_prob = policy.forward(obs, action_masks=masks)
    n = obs["nodes"].shape[0]

    assert actions.shape == (n,)
    assert values.shape == (n, 1)
    assert log_prob.shape == (n,)
    # Every sampled action must be a legal (unmasked) slot.
    for b in range(n):
        assert masks[b, int(actions[b])].item() is True


def test_distribution_zeros_the_pad_tail():
    cfg = _v2_config()
    policy = _build_warm_started(cfg, _make_bc_checkpoint(cfg))
    obs, masks, n_edges = _fake_obs_batch(cfg)

    dist = policy.get_distribution(obs, action_masks=masks)
    probs = dist.distribution.probs  # [N, MAX_EDGES]

    assert probs.shape == (obs["nodes"].shape[0], MAX_EDGES)
    # Pad slots (>= n_edges) carry zero probability; legal slots sum to 1.
    assert torch.allclose(probs[:, n_edges:], torch.zeros_like(probs[:, n_edges:]), atol=1e-6)
    assert torch.allclose(probs[:, :n_edges].sum(dim=1), torch.ones(probs.shape[0]), atol=1e-5)


# --- forward-path parity (the warm-start fidelity loop) --------------------------


def test_policy_forward_matches_bare_edgepolicynet():
    """The policy's forward path computes the SAME edge logits as a bare
    ``EdgePolicyNet`` on the same obs.

    ``test_repack_roundtrips_to_bare_edgepolicynet`` proves the *weights* survive the
    BC↔PPO round trip. This proves the policy's padded-``[N, ME]`` → ragged reshape /
    ``edge_batch`` synthesis / ``view`` plumbing (``_edge_logits_and_values``)
    *consumes* those weights the same way the BC forward / ONNX export does — so the
    graded bot == the trained policy through the forward path, not just the bytes. A
    ``repeat`` vs ``repeat_interleave`` slip or an ``n``/``me`` transpose would yield
    a perfectly valid masked distribution while silently breaking the warm-start;
    this is the regression pin for that class of bug.
    """
    cfg = _v2_config()
    ckpt = _make_bc_checkpoint(cfg, seed=5)
    policy = _build_warm_started(cfg, ckpt)
    obs, _masks, n_edges = _fake_obs_batch(cfg)
    n = obs["nodes"].shape[0]

    # Policy forward path → padded [N, MAX_EDGES] edge logits (pad tail is garbage).
    with torch.no_grad():
        policy_logits, _values = policy._edge_logits_and_values(obs)

    # Reference: a bare EdgePolicyNet with the SAME weights, run over the ragged
    # *legal* edges of each row — exactly the BC forward / ONNX export call. Every
    # row has n_edges legal slots; flatten row-major and batch-tag each edge with its
    # row (repeat_interleave → [0]*n_edges, [1]*n_edges, …), mirroring the legal head
    # of the policy's own [N, ME] → [N*ME] flatten.
    bare = EdgePolicyNet(cfg)
    bare.load_state_dict(ckpt["state_dict"])
    bare.eval()

    edge_feat = obs["edge_feat"][:, :n_edges, :].reshape(n * n_edges, EDGE_W)
    edge_from = obs["edge_from"][:, :n_edges].reshape(n * n_edges).long()
    edge_to = obs["edge_to"][:, :n_edges].reshape(n * n_edges).long()
    edge_batch = torch.arange(n).repeat_interleave(n_edges)
    with torch.no_grad():
        ref_logits, _ = bare(
            obs["nodes"],
            obs["players"],
            obs["board"],
            edge_feat,
            edge_from,
            edge_to,
            edge_batch,
        )
    ref_logits = ref_logits.view(n, n_edges)

    # The legal-slot logits must match the bare net's exactly (same weights, same
    # gather/Linear/ReLU ops); tolerance covers only BLAS batch-size rounding.
    assert torch.allclose(policy_logits[:, :n_edges], ref_logits, rtol=1e-4, atol=1e-6)


def test_evaluate_actions_and_predict_values_are_finite():
    cfg = _v2_config()
    policy = _build_warm_started(cfg, _make_bc_checkpoint(cfg))
    obs, masks, _ = _fake_obs_batch(cfg)

    actions, _, _ = policy.forward(obs, action_masks=masks)
    values, log_prob, entropy = policy.evaluate_actions(obs, actions, action_masks=masks)
    assert torch.isfinite(values).all()
    assert torch.isfinite(log_prob).all()
    assert torch.isfinite(entropy).all()
    assert torch.equal(policy.predict_values(obs), values)


# --- repack (the step-7 gate parity) ---------------------------------------------


def test_repack_roundtrips_to_bare_edgepolicynet():
    cfg = _v2_config()
    ckpt = _make_bc_checkpoint(cfg, seed=3)
    policy = _build_warm_started(cfg, ckpt)

    repacked = repack_to_bc_checkpoint(policy, extra={"teacher": "PPO"})
    assert repacked["encoding_version"] == 3
    assert repacked["teacher"] == "PPO"
    assert repacked["config"] == cfg.to_dict()

    # Rebuild a bare EdgePolicyNet from the repacked checkpoint exactly the way
    # export_weights.py / export_onnx.py do — it must equal the source actor.
    reloaded = EdgePolicyNet(ModelConfig(**repacked["config"]))
    reloaded.load_state_dict(repacked["state_dict"])
    assert _state_dicts_equal(reloaded.state_dict(), ckpt["state_dict"])


# --- guards ----------------------------------------------------------------------


def test_load_bc_checkpoint_rejects_non_v2(tmp_path):
    cfg = _v2_config(node_features=5, edge_features=4)  # stale encoding-v1 shapes
    ckpt = _make_bc_checkpoint(cfg, encoding_version=1)
    path = tmp_path / "v1.pt"
    torch.save(ckpt, path)
    with pytest.raises(ValueError, match="encoding_version"):
        load_bc_checkpoint(path)


def test_build_policy_rejects_non_v2_config():
    cfg = _v2_config(node_features=5)  # wrong width for the live wire
    obs_space, act_space = _spaces(_v2_config())
    with pytest.raises(ValueError, match="live wire contract"):
        build_policy(obs_space, act_space, cfg)
