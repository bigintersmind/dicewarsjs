"""End-to-end smoke for ``DiceWarsEnv`` over a real Node env-server.

The Python analog of ``scripts/ppo-env-smoke.mjs``: launch a real
``ppo-env-server.mjs`` (4-player FFA, ai_bc opponents), drive a few STOP-only
episodes through the Gymnasium env, and assert the obs shapes, action masks, and
terminal rewards are well-formed end-to-end (socket + JS encoder + Python parser
+ padding all wired together).

Skipped automatically where it can't run — ``gymnasium`` not installed, or
``node`` not on PATH — so the hermetic ``dicewars_bc`` suite is unaffected. It is
the real integration check on the GPU box (shodan) once the ``[rl]`` extra is
installed.
"""

from __future__ import annotations

import shutil

import numpy as np
import pytest

gym = pytest.importorskip("gymnasium")  # skip the whole module if SB3/gym deps absent

if shutil.which("node") is None:
    pytest.skip(
        "`node` not on PATH — env-server smoke needs the JS engine", allow_module_level=True
    )

from dicewars_ppo.constants import DEFAULT_MAX_AREAS, EDGE_W, MAX_EDGES, NODE_W  # noqa: E402
from dicewars_ppo.env import DiceWarsEnv  # noqa: E402

PLAYERS = 4
EPISODES = 3


def _stop_index(mask: np.ndarray) -> int:
    """STOP is the last legal slot (== num_edges - 1)."""
    legal = np.flatnonzero(mask)
    assert legal.size >= 1, "every decision must have at least the STOP action"
    return int(legal[-1])


def test_stop_only_episodes_run_end_to_end() -> None:
    env = DiceWarsEnv(
        player_count=PLAYERS,
        server_kwargs={"opponents": "ai_bc", "seed_base": 100, "episodes": EPISODES},
    )
    decisions = 0
    terminals = []
    try:
        for _ in range(EPISODES):
            obs, info = env.reset()
            _assert_obs(obs)
            assert info["terminal"] == 0

            terminated = truncated = False
            while not (terminated or truncated):
                action = _stop_index(env.action_masks())
                obs, reward, terminated, truncated, info = env.step(action)
                _assert_obs(obs)
                if not (terminated or truncated):
                    assert reward == 0.0  # sparse: no reward mid-episode
                    decisions += 1

            assert info["terminal"] == 1
            assert info["won"] in (0, 1)
            assert reward == float(info["won"])
            assert 0.0 <= info["placement"] <= 1.0
            terminals.append(info)
    finally:
        env.close()

    assert len(terminals) == EPISODES
    assert decisions > 0, "a STOP-only learner should still make at least one decision"


def _assert_obs(obs: dict) -> None:
    assert obs["nodes"].shape == (DEFAULT_MAX_AREAS, NODE_W)
    assert obs["edge_feat"].shape == (MAX_EDGES, EDGE_W)
    assert obs["edge_from"].shape == (MAX_EDGES,)
    assert obs["edge_to"].shape == (MAX_EDGES,)
    assert obs["edge_mask"].shape == (MAX_EDGES,)
    mask = obs["edge_mask"].astype(bool)
    n = int(mask.sum())
    # The legal slots are a contiguous prefix [0, n); the pad tail is masked off.
    assert mask[:n].all() and not mask[n:].any()
    # Pad edge rows are zeroed.
    assert not obs["edge_feat"][n:].any()
