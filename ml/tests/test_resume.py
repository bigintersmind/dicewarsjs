"""SB3-coupled resume tests (``dicewars_ppo.resume``, PR-5, [D-26]) — SHODAN-ONLY.

Gates on ``sb3_contrib`` (absent in lean CI), so these run on shodan alongside the other torch/sb3
tiers (test_train_args / test_ppo_policy). They cover the parts the sb3-free
``test_resume_state.py`` cannot: the real ``MaskablePPO.load`` round-trip (restores
``num_timesteps`` + optimizer + policy in one call — PATH A, HOLE-C) and the HOLE-D budget cap at
SB3's own ``_setup_learn`` seam (the absolute ``--timesteps`` is honored across a resume, not made
additive).

Hermetic: builds a tiny v2-shaped ``MaskablePPO`` over a no-Node stub env (the real DiceWars Dict
spaces; ``reset`` returns one valid masked obs — enough to construct the model + run
``_setup_learn``, which resets but does NOT roll out, so no live env-server is needed).
"""

from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")
gym = pytest.importorskip("gymnasium")
pytest.importorskip("sb3_contrib")

from sb3_contrib import MaskablePPO  # noqa: E402

import dicewars_ppo.resume as rz  # noqa: E402
from dicewars_bc.model import ModelConfig  # noqa: E402
from dicewars_ppo._train_common import _remaining_timesteps  # noqa: E402
from dicewars_ppo.constants import (  # noqa: E402
    BOARD_W,
    EDGE_W,
    MAX_EDGES,
    NODE_W,
    PLAYER_W,
)
from dicewars_ppo.env import DiceWarsEnv  # noqa: E402
from dicewars_ppo.policy import MaskableEdgePolicy  # noqa: E402


def _v2_config(**overrides) -> ModelConfig:
    base = dict(
        max_areas=32,
        node_features=NODE_W,
        player_features=PLAYER_W,
        board_features=BOARD_W,
        edge_features=EDGE_W,
        player_count=7,
        node_hidden=16,
        player_hidden=8,
        context_hidden=24,
        edge_hidden=16,
    )
    base.update(overrides)
    return ModelConfig(**base)


class _StubEnv(gym.Env):
    """No-Node env with the REAL DiceWars Dict spaces; reset returns one valid masked obs.

    Enough to BUILD MaskablePPO and run _setup_learn (which resets but does not roll out). step() is
    a trivial terminal so the env is well-formed, but the resume tests never collect a rollout.
    """

    def __init__(self, cfg: ModelConfig) -> None:
        real = DiceWarsEnv(max_areas=cfg.max_areas, player_count=cfg.player_count)
        self.observation_space = real.observation_space
        self.action_space = real.action_space
        self._cfg = cfg
        self._mask = np.zeros(MAX_EDGES, dtype=np.int8)
        self._mask[0] = 1  # at least one legal action

    def _obs(self):
        a, p = self._cfg.max_areas, self._cfg.player_count
        return {
            "nodes": np.zeros((a, NODE_W), np.float32),
            "players": np.zeros((p, PLAYER_W), np.float32),
            "board": np.zeros((BOARD_W,), np.float32),
            "edge_feat": np.zeros((MAX_EDGES, EDGE_W), np.float32),
            "edge_from": np.zeros((MAX_EDGES,), np.int32),
            "edge_to": np.zeros((MAX_EDGES,), np.int32),
            "edge_mask": self._mask.copy(),
        }

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        return self._obs(), {}

    def step(self, action):
        return self._obs(), 0.0, True, False, {}

    def action_masks(self):
        return self._mask.astype(bool)


def _build_model(cfg: ModelConfig, device: str = "cpu") -> MaskablePPO:
    from stable_baselines3.common.vec_env import DummyVecEnv

    venv = DummyVecEnv([lambda: _StubEnv(cfg)])
    return MaskablePPO(
        MaskableEdgePolicy,
        venv,
        policy_kwargs={"bc_config": cfg},
        n_steps=16,
        batch_size=8,
        device=device,
        seed=0,
    )


def _build_venv(cfg: ModelConfig):
    from stable_baselines3.common.vec_env import DummyVecEnv

    return DummyVecEnv([lambda: _StubEnv(cfg)])


# --- MaskablePPO.load round-trip (PATH A, HOLE-C) ----------------------------------------------


def test_load_resume_restores_num_timesteps_and_policy(tmp_path):
    cfg = _v2_config()
    model = _build_model(cfg)
    model.num_timesteps = 12_345  # simulate a partly-trained model
    rz.save_resume_checkpoint(model, tmp_path, model.num_timesteps)

    loaded = rz.load_resume_checkpoint(tmp_path, _build_venv(cfg), "cpu")

    # num_timesteps restored in the load (so SnapshotCallback rehydrates the resumed step, not 0)
    assert loaded.num_timesteps == 12_345
    # policy weights byte-identical
    src, dst = model.policy.state_dict(), loaded.policy.state_dict()
    assert src.keys() == dst.keys()
    assert all(torch.equal(src[k], dst[k]) for k in src)


def test_load_resume_survives_corrupt_rng_sidecar(tmp_path, capsys):
    # A torn/bit-rotted RNG sidecar must NOT brick a resume: MaskablePPO.load has already restored
    # policy + optimizer + num_timesteps, so load_resume_checkpoint degrades to a fresh RNG stream
    # (loud warn) rather than raising (which would crash-loop under the PR-6 auto-restart).
    cfg = _v2_config()
    model = _build_model(cfg)
    model.num_timesteps = 999
    rz.save_resume_checkpoint(model, tmp_path, model.num_timesteps)
    ptr = rz.read_latest_pointer(tmp_path)
    (tmp_path / ptr["rng"]).write_bytes(b"not a torch checkpoint")  # corrupt ONLY the sidecar

    loaded = rz.load_resume_checkpoint(tmp_path, _build_venv(cfg), "cpu")  # must NOT raise

    assert loaded.num_timesteps == 999  # model/optimizer/step still restored
    assert "FRESH RNG stream" in capsys.readouterr().err


def test_load_resume_falls_back_to_prior_pair_on_corrupt_zip(tmp_path, capsys):
    # PR-6 corrupt-.zip fallback: a bit-rotted NEWEST .zip at a VALID pointer must not crash-loop
    # the auto-restart — load_resume_checkpoint rolls back to the retained keep=2 prior pair (one
    # cadence of progress lost) and loudly says so.
    cfg = _v2_config()
    model = _build_model(cfg)
    model.num_timesteps = 1000
    rz.save_resume_checkpoint(model, tmp_path, 1000, keep=2)
    model.num_timesteps = 2000
    rz.save_resume_checkpoint(model, tmp_path, 2000, keep=2)  # latest.json → 2000
    ptr = rz.read_latest_pointer(tmp_path)
    assert ptr["step"] == 2000
    (tmp_path / ptr["ckpt"]).write_bytes(b"not a real zip")  # corrupt ONLY the newest .zip

    loaded = rz.load_resume_checkpoint(tmp_path, _build_venv(cfg), "cpu")  # must NOT raise

    assert loaded.num_timesteps == 1000  # rolled back to the retained prior pair
    # latest.json is the crash hinge — NOT rewritten on fallback (the next checkpoint moves it
    # forward; a repeat crash before then just re-runs this cheap fallback).
    assert rz.read_latest_pointer(tmp_path)["step"] == 2000
    err = capsys.readouterr().err
    assert "failed to load" in err  # the newest pair's failure was surfaced
    assert "RETAINED prior checkpoint" in err  # the rollback was surfaced


def test_load_resume_raises_when_all_retained_pairs_corrupt(tmp_path):
    # When EVERY retained .zip is unreadable, fallback is exhausted ⇒ ResumeCheckpointError, which
    # train.py turns into EXIT_POINTER_REJECTED (halt-and-alert) rather than letting the launcher
    # bounds-retry bytes that will never heal.
    cfg = _v2_config()
    model = _build_model(cfg)
    for step in (1000, 2000):
        model.num_timesteps = step
        rz.save_resume_checkpoint(model, tmp_path, step, keep=2)
    for zip_path in tmp_path.glob("ckpt-*.zip"):
        zip_path.write_bytes(b"torn")  # corrupt BOTH retained pairs
    with pytest.raises(rz.ResumeCheckpointError, match="failed to load"):
        rz.load_resume_checkpoint(tmp_path, _build_venv(cfg), "cpu")


def test_callback_rejects_nonpositive_cadence(tmp_path):
    with pytest.raises(ValueError, match="checkpoint_every"):
        rz.ResumeCheckpointCallback(tmp_path, checkpoint_every=0)
    with pytest.raises(ValueError, match="checkpoint_every"):
        rz.ResumeCheckpointCallback(tmp_path, checkpoint_every=-1)


@pytest.mark.skipif(not torch.cuda.is_available(), reason="GPU RNG path needs CUDA (shodan)")
def test_load_resume_on_cuda_restores_rng_without_crash(tmp_path):
    # Regression for the GPU-resume blocker: even when the MODEL is on cuda, the RNG sidecar must be
    # restored to CPU — torch.set_rng_state rejects a GPU-mapped tensor ("RNG state must be a
    # torch.ByteTensor"), which crashed every --device cuda resume before load_rng_sidecar was
    # pinned to CPU. This must NOT raise.
    cfg = _v2_config()
    model = _build_model(cfg, device="cuda")
    model.num_timesteps = 7
    rz.save_resume_checkpoint(model, tmp_path, model.num_timesteps)
    loaded = rz.load_resume_checkpoint(tmp_path, _build_venv(cfg), "cuda")
    assert loaded.num_timesteps == 7


# --- HOLE-D: the absolute --timesteps budget is honored across a resume ------------------------


def test_resume_setup_learn_caps_at_absolute_budget(tmp_path):
    cfg = _v2_config()
    model = _build_model(cfg)
    K, T = 400, 1000
    model.num_timesteps = K
    # Mirror train()'s resume call: total_timesteps=remaining + reset_num_timesteps=False.
    model._setup_learn(_remaining_timesteps(T, K), reset_num_timesteps=False)
    # SB3 re-adds num_timesteps under reset_num_timesteps=False, so the absolute stop point is T,
    # NOT T + K — the unbounded crash-loop HOLE-D kills. (Passing the naive T would yield T + K.)
    assert model._total_timesteps == T


def test_fresh_setup_learn_uses_absolute_budget(tmp_path):
    cfg = _v2_config()
    model = _build_model(cfg)
    model._setup_learn(2048, reset_num_timesteps=True)  # the fresh-run call
    assert model.num_timesteps == 0
    assert model._total_timesteps == 2048


# --- ResumeCheckpointCallback cadence + resume cursor -----------------------------------------


def test_resume_callback_seeds_cursor_and_fires_on_cadence(tmp_path):
    cfg = _v2_config()
    model = _build_model(cfg)
    cb = rz.ResumeCheckpointCallback(tmp_path, checkpoint_every=100)
    cb.init_callback(model)

    model.num_timesteps = 500
    cb._on_training_start()
    assert cb._last == 500  # seeded to the resumed step, not 0 (no immediate re-checkpoint)

    cb.num_timesteps = 550  # below cadence ⇒ no checkpoint yet
    assert cb._on_step() is True
    assert not rz.has_resume_checkpoint(tmp_path)

    cb.num_timesteps = 600  # crosses the 100-step cadence ⇒ checkpoint at the current step
    cb._on_step()
    assert rz.read_latest_pointer(tmp_path)["step"] == 600


def test_resume_callback_final_checkpoint_on_training_end(tmp_path):
    cfg = _v2_config()
    model = _build_model(cfg)
    cb = rz.ResumeCheckpointCallback(tmp_path, checkpoint_every=100)
    cb.init_callback(model)
    cb._on_training_start()  # _last = 0
    cb.num_timesteps = 2048  # a clean finish below the next cadence boundary
    cb._on_training_end()
    assert rz.read_latest_pointer(tmp_path)["step"] == 2048  # resumable at the true end step
