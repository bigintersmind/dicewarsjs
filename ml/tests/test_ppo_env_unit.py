"""Hermetic unit tests for ``DiceWarsEnv`` guard logic — no Node server.

Exercises the pure, socket-free branches (constructor validation, the gym-contract
step guards, observation padding/masking, the mask dtype contract, and ``_check_dims``)
by calling methods directly with a hand-parsed golden frame. Requires only
``gymnasium`` (the env module imports it at load), so it's skipped in the hermetic BC
CI and runs wherever the ``[rl]`` extra is present. The live socket/episode path stays
in ``test_ppo_env`` (which also needs ``node``).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("gymnasium")  # skip the whole module if the [rl] extra is absent

from dicewars_ppo.env import DiceWarsEnv  # noqa: E402
from dicewars_ppo.wire import parse_frame  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN_BIN = FIXTURES / "obs_frame_v2.bin"


@pytest.fixture(scope="module")
def golden_frame():
    # The committed golden frame: maxAreas=3, playerCount=2, numEdges=2 (attack + STOP).
    return parse_frame(GOLDEN_BIN.read_bytes())


def _env(**kw):
    # managed=False + host/port constructs without launching/connecting to a server;
    # the tests below never touch the socket.
    return DiceWarsEnv(max_areas=3, player_count=2, managed=False, host="x", port=1, **kw)


# --- constructor validation -------------------------------------------------


def test_unmanaged_requires_host_and_port():
    with pytest.raises(ValueError, match="requires explicit host and port"):
        DiceWarsEnv(managed=False)
    with pytest.raises(ValueError, match="requires explicit host and port"):
        DiceWarsEnv(managed=False, host="x")


def test_unmanaged_does_not_inject_server_dims():
    # Only the managed path pins the server to the env's dims.
    env = DiceWarsEnv(managed=False, host="x", port=1)
    assert "players" not in env._server_kwargs and "max_areas" not in env._server_kwargs


# --- step-contract guards ---------------------------------------------------


def test_step_before_reset_raises():
    env = _env()
    with pytest.raises(RuntimeError, match="before reset"):
        env.step(0)


def test_illegal_action_raises():
    env = _env()
    env._awaiting_reset = False
    env._mask = np.array([True, True] + [False] * (env.max_edges - 2))
    with pytest.raises(ValueError, match="illegal action"):
        env.step(2)  # masked pad index, in range
    with pytest.raises(ValueError, match="illegal action"):
        env.step(env.max_edges)  # out of range (high)
    with pytest.raises(ValueError, match="illegal action"):
        env.step(-1)  # out of range (low)


# --- observation padding + mask dtype ---------------------------------------


def test_frame_to_obs_pads_and_masks(golden_frame):
    env = _env()
    obs = env._frame_to_obs(golden_frame)
    n = golden_frame.num_edges  # 2

    assert obs["edge_feat"].shape == (env.max_edges, 7)
    np.testing.assert_array_equal(obs["edge_feat"][:n], golden_frame.edges)
    assert not obs["edge_feat"][n:].any()  # pad rows zeroed
    np.testing.assert_array_equal(obs["edge_from"][:n], golden_frame.edge_index[:, 0])
    np.testing.assert_array_equal(obs["edge_to"][:n], golden_frame.edge_index[:, 1])
    # Legal slots are a contiguous prefix [0, n); the pad tail is masked off.
    assert obs["edge_mask"][:n].all() and not obs["edge_mask"][n:].any()
    assert obs["edge_mask"].dtype == np.int8  # MultiBinary's required dtype


def test_action_masks_is_bool_and_a_copy(golden_frame):
    env = _env()
    env._frame_to_obs(golden_frame)
    mask = env.action_masks()
    assert mask.dtype == bool  # MaskableCategorical expects bool
    mask[0] = not mask[0]  # mutating the returned copy must not touch env state
    assert env._mask[0] != mask[0]


# --- dim checks -------------------------------------------------------------


def test_check_dims_rejects_max_areas_mismatch(golden_frame):
    env = DiceWarsEnv(max_areas=4, player_count=2, managed=False, host="x", port=1)
    with pytest.raises(ValueError, match="max_areas"):
        env._frame_to_obs(golden_frame)


def test_check_dims_rejects_player_count_mismatch(golden_frame):
    env = DiceWarsEnv(max_areas=3, player_count=3, managed=False, host="x", port=1)
    with pytest.raises(ValueError, match="player_count"):
        env._frame_to_obs(golden_frame)


def test_check_dims_rejects_edge_overflow(golden_frame):
    # num_edges=2 > max_edges=1 → the documented [D-20] error, not a cryptic broadcast.
    env = DiceWarsEnv(max_areas=3, player_count=2, max_edges=1, managed=False, host="x", port=1)
    with pytest.raises(ValueError, match="MAX_EDGES"):
        env._frame_to_obs(golden_frame)
