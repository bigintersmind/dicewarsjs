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

import math
import shutil

import numpy as np
import pytest

gym = pytest.importorskip("gymnasium")  # skip the whole module if SB3/gym deps absent

if shutil.which("node") is None:
    pytest.skip(
        "`node` not on PATH — env-server smoke needs the JS engine", allow_module_level=True
    )

from dicewars_ppo.constants import DEFAULT_MAX_AREAS, EDGE_W, MAX_EDGES, NODE_W  # noqa: E402
from dicewars_ppo.env import DiceWarsEnv, step_reward  # noqa: E402

PLAYERS = 4
EPISODES = 3


def _stop_index(mask: np.ndarray) -> int:
    """STOP is the last legal slot (== num_edges - 1)."""
    legal = np.flatnonzero(mask)
    assert legal.size >= 1, "every decision must have at least the STOP action"
    return int(legal[-1])


def _first_attack_or_stop(mask: np.ndarray) -> int:
    """The first legal attack (slot 0) when one exists, else STOP (the lone legal slot).

    A deliberately aggressive driver for the shaped-reward e2e: attacking wins or loses border
    tiles, so the learner's owned-territory count actually moves turn to turn — a non-trivial dense
    ``delta_territory`` signal — where a STOP-only seat can settle into a stable-territory
    stalemate.
    """
    legal = np.flatnonzero(mask)
    assert legal.size >= 1, "every decision must have at least the STOP action"
    return int(legal[0]) if legal.size > 1 else int(legal[-1])


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


def test_shaped_episode_round_trips_dense_signals() -> None:
    """A ``--reward-shaping`` run round-trips the bite-G dense wire end-to-end (issue #84).

    The hermetic JS test (``tests/ml/ppo-env-server-shaping.test.js``) pins the Node emission glue —
    the per-decision/terminal ``.territories`` reads, the ``recordTurn``-before-``failIfLost``
    ordering, the per-episode ``reset()``, the shaped-tail threading — and is the CI-gating check
    (the JS suite runs in CI; this Python e2e skips there because the ML CI job installs no
    ``node``). This is the matching LIVE integration: a managed env-server launched with
    ``--reward-shaping=1`` (auto-forwarded by a non-zero dense coef), one episode driven through the
    real ``DiceWarsEnv``, asserting the shaped frame round-trips through the real socket + Python
    parser (the +8-byte header tail), the raw ``delta_territory``/``elims_by_learner`` signals
    surface in ``info``, and the per-step reward is exactly the persona weighting of them.

    The learner ATTACKS (``_first_attack_or_stop``) so its owned-territory count actually moves — a
    non-trivial dense signal — rather than settling into a stable-territory stalemate as a STOP-only
    seat can. We do not seed-hunt for a kill: the deterministic JS test owns the
    Predator/game-ending-kill path; here the elimination wire field is still parsed + validated on
    every frame (``elims_by_learner >= 0``), just not relied on to be non-zero. ``episodes=0``
    (run-until-disconnect) so a zero-decision seed is skipped server-side and ``reset()`` always
    lands on a real first decision.
    """
    coef = 0.02
    env = DiceWarsEnv(
        player_count=PLAYERS,
        # A non-zero dense coef flips the env to the shaped wire AND forwards --reward-shaping=1 to
        # the managed server, so both ends agree without the caller wiring the flag by hand.
        territory_reward_coef=coef,
        server_kwargs={"opponents": "ai_bc", "seed_base": 100, "episodes": 0},
    )
    assert env._shaped is True
    assert env._server_kwargs.get("reward_shaping") is True

    deltas: list[float] = []
    try:
        obs, info = env.reset()
        _assert_obs(obs)
        assert info["terminal"] == 0
        # The episode's first decision frame is the baseline → no realized interval yet.
        assert info["delta_territory"] == 0.0
        assert info["elims_by_learner"] == 0

        terminated = truncated = False
        reward = 0.0
        while not (terminated or truncated):
            obs, reward, terminated, truncated, info = env.step(
                _first_attack_or_stop(env.action_masks())
            )
            _assert_obs(obs)
            # Every shaped frame carries well-formed raw signals (the env validates >= 0 / finite).
            assert info["elims_by_learner"] >= 0
            assert math.isfinite(info["delta_territory"])
            deltas.append(info["delta_territory"])
            shaping = step_reward(
                delta_territory=info["delta_territory"],
                elims_by_learner=info["elims_by_learner"],
                territory_coef=coef,
            )
            if not (terminated or truncated):
                # Mid-episode: the reward IS the dense per-step shaping (no terminal outcome yet).
                assert reward == pytest.approx(shaping)
            else:
                # Terminal: the sparse-win outcome (win mode ⇒ float(won)) PLUS the realized
                # dense interval.
                assert reward == pytest.approx(float(info["won"]) + shaping)

        assert info["terminal"] == 1
        assert info["won"] in (0, 1)
        # The dense territory signal is genuinely non-trivial — an attacking learner wins/loses
        # border tiles, so its count moves at least once (not the all-zero stalemate stream).
        assert deltas, "the learner must surface at least one shaped step frame"
        assert any(d != 0.0 for d in deltas), "an attacking learner must move its territory count"
    finally:
        env.close()


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
