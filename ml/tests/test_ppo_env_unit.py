"""Hermetic unit tests for ``DiceWarsEnv`` guard logic — no Node server.

Exercises the pure, socket-free branches (constructor validation, the gym-contract
step guards, observation padding/masking, the mask dtype contract, and ``_check_dims``)
by calling methods directly with a hand-parsed golden frame. Requires only
``gymnasium`` (the env module imports it at load), so it's skipped in the hermetic BC
CI and runs wherever the ``[rl]`` extra is present. The live socket/episode path stays
in ``test_ppo_env`` (which also needs ``node``).
"""

from __future__ import annotations

import dataclasses
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


# --- step() terminal: the terminated/truncated mapping (the PPO bootstrap gate) -----


def _drive_step_with_terminal(monkeypatch, env, term_frame):
    """Drive one ``env.step()`` whose server reply is ``term_frame`` (no live socket).

    Patches the socket I/O the env imported (``send_action``/``recv_frame``) so the
    terminal frame flows through the REAL ``step()`` body — the point is to exercise the
    actual terminated/truncated mapping, not re-implement it. The env is primed so the
    action passes the legality guard.
    """
    monkeypatch.setattr("dicewars_ppo.env.send_action", lambda _sock, _idx: None)
    # `**_kw` swallows the `shaped=` kwarg step() passes (bite G) so this harness works for both the
    # base and shaped wire variants.
    monkeypatch.setattr("dicewars_ppo.env.recv_frame", lambda _sock, _max, **_kw: term_frame)
    env._awaiting_reset = False
    env._mask = np.array([True] + [False] * (env.max_edges - 1))  # action 0 legal
    return env.step(0)


def _drive_step_with_obs(monkeypatch, env, obs_frame):
    """Drive one ``env.step()`` whose server reply is a NON-terminal ``obs_frame`` — exercises the
    per-step reward branch (0 by default; the dense shaping reward when a persona coef is set)."""
    monkeypatch.setattr("dicewars_ppo.env.send_action", lambda _sock, _idx: None)
    monkeypatch.setattr("dicewars_ppo.env.recv_frame", lambda _sock, _max, **_kw: obs_frame)
    env._awaiting_reset = False
    env._mask = np.array([True] + [False] * (env.max_edges - 1))
    return env.step(0)


@pytest.mark.parametrize(
    ("won", "truncated", "exp_terminated", "exp_truncated", "exp_reward"),
    [
        (1, 0, True, False, 1.0),  # genuine win → terminated, value bootstrap 0
        (0, 0, True, False, 0.0),  # genuine loss (elimination) → terminated
        (0, 1, False, True, 0.0),  # maxTurns stalemate CAP → truncated, bootstrap V(s)
    ],
)
def test_step_terminal_maps_truncated_to_gym_tuple(
    golden_frame, monkeypatch, won, truncated, exp_terminated, exp_truncated, exp_reward
):
    """A swap here (``terminated = bool(frame.truncated)``) silently breaks SB3 bootstrapping.

    ``frozen=True`` ObsFrame ⇒ build the terminal via ``dataclasses.replace`` (mutation raises).
    """
    env = _env()
    term = dataclasses.replace(golden_frame, terminal=1, winner=0, won=won, truncated=truncated)

    _obs, reward, terminated, trunc, info = _drive_step_with_terminal(monkeypatch, env, term)

    assert (terminated, trunc) == (exp_terminated, exp_truncated)
    assert reward == exp_reward
    assert info["truncated"] == truncated  # the raw flag rides in info too
    assert env._awaiting_reset is True  # a terminal step re-arms the reset guard


def test_step_terminal_rejects_invalid_truncated(golden_frame, monkeypatch):
    # A corrupt truncated flag (not 0/1) must fail loud, not poison the bootstrap decision.
    env = _env()
    term = dataclasses.replace(golden_frame, terminal=1, winner=0, won=0, truncated=2)
    with pytest.raises(ValueError, match="truncated=2 not in"):
        _drive_step_with_terminal(monkeypatch, env, term)


def test_step_terminal_rejects_won_and_truncated(golden_frame, monkeypatch):
    # won=1 and truncated=1 are each individually legal but contradictory: a stalemate cap is
    # never a win. The pair must fail loud rather than bootstrap a win as a truncation (which
    # would inflate the value target and poison the critic) — the gap the per-field guards miss.
    env = _env()
    term = dataclasses.replace(golden_frame, terminal=1, winner=0, won=1, truncated=1)
    with pytest.raises(ValueError, match="both truncated and won"):
        _drive_step_with_terminal(monkeypatch, env, term)


# --- step() terminal: the persona reward modes wired through the REAL step() body ------------
# These pin the frame-field → terminal_reward-arg wiring (placement/turn_number/truncated +
# the env's reward_mode/speed_bonus/speed_ref). The pure terminal_reward unit tests bypass
# step(), so a miswire there (e.g. won into the placement slot) would pass them but fail here.


def test_step_terminal_placement_mode_pays_scaled_rank(golden_frame, monkeypatch):
    # Survivor: a genuine (non-truncated) loss pays the scaled rank, NOT 0 — proves step() feeds
    # frame.placement into terminal_reward under reward_mode="placement".
    env = _env(reward_mode="placement")
    term = dataclasses.replace(
        golden_frame, terminal=1, winner=0, won=0, truncated=0, placement=0.5
    )
    _obs, reward, terminated, trunc, _info = _drive_step_with_terminal(monkeypatch, env, term)
    assert (terminated, trunc) == (True, False)  # a real loss is a genuine terminal (bootstrap 0)
    assert reward == 0.5


def test_step_terminal_placement_mode_truncation_pays_zero(golden_frame, monkeypatch):
    # C1: a maxTurns CAP in placement mode must pay 0 (truncated → SB3 bootstraps V(s)), NOT the
    # non-zero rank-at-cap on the wire — otherwise the survival signal is double-counted and the
    # Survivor is biased toward stalling to the cap. Exercised through the real step() body.
    env = _env(reward_mode="placement")
    term = dataclasses.replace(
        golden_frame, terminal=1, winner=0, won=0, truncated=1, placement=0.67
    )
    _obs, reward, terminated, trunc, _info = _drive_step_with_terminal(monkeypatch, env, term)
    assert (terminated, trunc) == (False, True)  # truncation → bootstrap, not a genuine terminal
    assert reward == 0.0


def test_step_terminal_speed_bonus_scales_a_fast_win(golden_frame, monkeypatch):
    # Blitz: step() must thread frame.turn_number + the env's speed_bonus/speed_ref into
    # terminal_reward. A win at turn 50 of a 200-turn ref pays 1*(1 + 0.5*clip(1-50/200)) = 1.375.
    # The turn_number is a DISTINCTIVE non-zero value (≠ winner/truncated/placement on this frame),
    # so a miswire sourcing the turn_number kwarg from any other (zero-or-other-valued) field would
    # produce a different reward and fail — uniquely pinning the frame.turn_number wire.
    env = _env(terminal_speed_bonus=0.5, speed_ref=200)
    term = dataclasses.replace(
        golden_frame, terminal=1, winner=0, won=1, truncated=0, placement=1.0, turn_number=50
    )
    _obs, reward, terminated, trunc, _info = _drive_step_with_terminal(monkeypatch, env, term)
    assert (terminated, trunc) == (True, False)
    assert reward == pytest.approx(1.375)


# --- step() dense shaping (bite G) wired through the REAL step() body -------------------------
# Pin the shaped-frame field → step_reward-arg wiring on BOTH the non-terminal and terminal paths,
# plus that an unshaped env never reads (or pays) the dense fields.


def test_step_nonterminal_expansionist_pays_territory_delta(golden_frame, monkeypatch):
    # A non-terminal step under territory_reward_coef pays coef × delta_territory (and is NOT a
    # terminal — terminated/truncated stay False, the env stays awaiting the next step).
    env = _env(territory_reward_coef=0.02)
    assert env._shaped is True
    obs_frame = dataclasses.replace(golden_frame, terminal=0, delta_territory=4, elims_by_learner=0)
    _obs, reward, terminated, trunc, info = _drive_step_with_obs(monkeypatch, env, obs_frame)
    assert (terminated, trunc) == (False, False)
    assert reward == pytest.approx(0.08)
    assert info["delta_territory"] == pytest.approx(4) and info["elims_by_learner"] == 0


def test_step_nonterminal_predator_pays_kill_bounty(golden_frame, monkeypatch):
    env = _env(elim_bounty=0.1)
    obs_frame = dataclasses.replace(golden_frame, terminal=0, delta_territory=0, elims_by_learner=2)
    _obs, reward, _terminated, _trunc, _info = _drive_step_with_obs(monkeypatch, env, obs_frame)
    assert reward == pytest.approx(0.2)


def test_step_terminal_adds_dense_to_terminal_reward(golden_frame, monkeypatch):
    # Predator's winning kill: a terminal WIN (terminal_reward 1.0) PLUS the dense bounty for the
    # game-ending eliminations carried on the terminal frame (3 × 0.1) = 1.3.
    env = _env(elim_bounty=0.1)
    term = dataclasses.replace(
        golden_frame, terminal=1, winner=0, won=1, truncated=0, placement=1.0, elims_by_learner=3
    )
    _obs, reward, terminated, trunc, _info = _drive_step_with_terminal(monkeypatch, env, term)
    assert (terminated, trunc) == (True, False)
    assert reward == pytest.approx(1.0 + 0.3)


def test_step_terminal_truncation_still_pays_dense(golden_frame, monkeypatch):
    # The dense signal is REALIZED, so unlike the terminal OUTCOME reward (which terminal_reward
    # zeroes on a truncation to avoid double-counting V(s)), the per-step shaping IS paid at a
    # maxTurns cap. Pins the comment claim "paid on a truncation too": coef × delta = 0.02 × 5 =
    # 0.1, NOT the 0.0 the unshaped truncation test asserts. trunc stays True (SB3 bootstraps).
    env = _env(territory_reward_coef=0.02)
    term = dataclasses.replace(
        golden_frame, terminal=1, winner=0, won=0, truncated=1, placement=0.67, delta_territory=5
    )
    _obs, reward, terminated, trunc, _info = _drive_step_with_terminal(monkeypatch, env, term)
    assert (terminated, trunc) == (False, True)  # truncation → bootstrap, not a genuine terminal
    assert reward == pytest.approx(0.1)  # the realized dense interval, NOT zeroed like the outcome


def test_step_terminal_loss_pays_negative_territory_wipe(golden_frame, monkeypatch):
    # The learner's own elimination: a genuine (non-truncated) loss in win mode pays terminal_reward
    # 0, plus the negative dense interval for the territory it lost down to 0 (the honest cost of
    # overextending). 0.02 × -4 = -0.08 — proves a shaped loss carries the negative signal, not 0.
    env = _env(territory_reward_coef=0.02)
    term = dataclasses.replace(
        golden_frame, terminal=1, winner=0, won=0, truncated=0, placement=0.0, delta_territory=-4
    )
    _obs, reward, terminated, trunc, _info = _drive_step_with_terminal(monkeypatch, env, term)
    assert (terminated, trunc) == (True, False)  # a real loss is a genuine terminal (bootstrap 0)
    assert reward == pytest.approx(-0.08)


def test_step_unshaped_env_ignores_dense_fields(golden_frame, monkeypatch):
    # An env with no dense coef is NOT shaped: a non-terminal step pays 0 even if the (stub) frame
    # happens to carry dense values — step() never reads them, so a base run stays byte-identical.
    env = _env()
    assert env._shaped is False
    obs_frame = dataclasses.replace(golden_frame, terminal=0, delta_territory=9, elims_by_learner=5)
    _obs, reward, _terminated, _trunc, _info = _drive_step_with_obs(monkeypatch, env, obs_frame)
    assert reward == 0.0


def test_step_dense_clip_bounds_a_big_swing(golden_frame, monkeypatch):
    # shaping_clip caps the per-step magnitude (PERSONAS §6): a +100 territory swing × 0.02 = 2.0
    # clamps to the 0.05 cap.
    env = _env(territory_reward_coef=0.02, shaping_clip=0.05)
    obs_frame = dataclasses.replace(
        golden_frame, terminal=0, delta_territory=100, elims_by_learner=0
    )
    _obs, reward, _terminated, _trunc, _info = _drive_step_with_obs(monkeypatch, env, obs_frame)
    assert reward == pytest.approx(0.05)


def test_step_shaped_rejects_negative_elims(golden_frame, monkeypatch):
    # A corrupt negative kill count must fail loud rather than feed a poisoned reward (mirrors the
    # won/placement/truncated terminal guards, but validated on EVERY shaped frame).
    env = _env(elim_bounty=0.1)
    obs_frame = dataclasses.replace(
        golden_frame, terminal=0, delta_territory=0, elims_by_learner=-1
    )
    with pytest.raises(ValueError, match="elims_by_learner=-1"):
        _drive_step_with_obs(monkeypatch, env, obs_frame)
