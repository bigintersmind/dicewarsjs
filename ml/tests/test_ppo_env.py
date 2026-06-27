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


def test_zero_decision_episode_does_not_desync() -> None:
    """A zero-decision episode must not desync reset() (the bug that killed every tracer run).

    On some seeds the learner seat is conquered before its turn ever comes up, so it takes NO action
    and the episode emits no obs frame. The env-server streams ``(obs*, terminal)`` per episode, so
    such an episode would otherwise put a BARE terminal where the client's ``reset()`` expects the
    next episode's first obs → the desync ``RuntimeError`` in :meth:`DiceWarsEnv.reset`. The
    server-side fix skips zero-decision episodes. With the full 7-player training field, seed 35 is
    a zero-decision episode (anchored by the JS test ``tests/ml/ppo-env.test.js``); seeding at
    ``seed_base=35`` puts it first, so the very first ``reset()`` would crash on the old server.
    ``episodes=0`` (run-until-disconnect) is required: a skipped episode still advances the seed
    counter, so a fixed quota could surface fewer episodes than requested.
    """
    env = DiceWarsEnv(
        player_count=7,
        server_kwargs={
            "opponents": "ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive",
            "seed_base": 35,  # episode 0 (seed 35) is zero-decision — the server must skip it
            "episodes": 0,
        },
    )
    completed = 0
    try:
        for _ in range(3):
            obs, info = env.reset()
            _assert_obs(obs)
            # The crux: a real first decision, never a leaked bare terminal from a skipped episode.
            assert info["terminal"] == 0
            terminated = truncated = False
            while not (terminated or truncated):
                obs, reward, terminated, truncated, info = env.step(_stop_index(env.action_masks()))
                _assert_obs(obs)
            assert info["terminal"] == 1
            assert info["won"] in (0, 1)
            completed += 1
    finally:
        env.close()

    assert completed == 3, "every surfaced episode should complete cleanly past the skipped one"


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
