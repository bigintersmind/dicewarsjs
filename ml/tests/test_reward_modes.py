"""Persona reward-shaping ([D-bite], docs/ml-bot/PERSONAS.md) — the wire-free terminal-reward modes.

Lean tier (torch-free): exercises the pure ``terminal_reward`` math, the ``DiceWarsEnv`` constructor
validation, and the launch-time ``validate_reward_args`` guard — none of which need torch, sb3, or a
live Node env-server (``DiceWarsEnv`` connects lazily, so constructing one only sets attrs/spaces).
The flags' parser wiring (train.py) is covered in the torch-gated test_train_args.py.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from dicewars_ppo._train_common import validate_reward_args
from dicewars_ppo.env import REWARD_MODES, DiceWarsEnv, terminal_reward

# --- terminal_reward: the pure objective math --------------------------------------------------


def test_win_mode_is_sparse_terminal_win():
    # Default mode reproduces [D-19] exactly: +1 on a win, 0 otherwise.
    assert terminal_reward(won=1, placement=1.0, turn_number=50) == 1.0
    assert terminal_reward(won=0, placement=0.5, turn_number=50) == 0.0
    # placement is ignored in win mode even when it's high.
    assert terminal_reward(won=0, placement=0.99, turn_number=50, reward_mode="win") == 0.0


def test_placement_mode_returns_scaled_rank():
    # Survivor: the reward IS the scaled finishing rank, independent of `won`.
    assert terminal_reward(won=0, placement=0.5, turn_number=50, reward_mode="placement") == 0.5
    assert terminal_reward(won=1, placement=1.0, turn_number=50, reward_mode="placement") == 1.0
    assert terminal_reward(won=0, placement=0.0, turn_number=50, reward_mode="placement") == 0.0


def test_speed_bonus_scales_a_faster_win_more():
    # reward *= 1 + b*clip(1 - turns/ref, 0, 1). b=0.5, ref=200.
    # turns=0   → factor 1 + 0.5*1   = 1.5
    fast = terminal_reward(won=1, placement=1.0, turn_number=0, speed_bonus=0.5, speed_ref=200)
    # turns=100 → factor 1 + 0.5*0.5 = 1.25
    mid = terminal_reward(won=1, placement=1.0, turn_number=100, speed_bonus=0.5, speed_ref=200)
    assert fast == pytest.approx(1.5)
    assert mid == pytest.approx(1.25)
    assert fast > mid  # the faster win is worth strictly more


def test_speed_bonus_clips_to_zero_at_or_beyond_ref():
    # turns >= ref → clip(1 - turns/ref, 0, 1) = 0 → no bonus (factor 1).
    assert (
        terminal_reward(won=1, placement=1.0, turn_number=200, speed_bonus=0.5, speed_ref=200)
        == 1.0
    )
    assert (
        terminal_reward(won=1, placement=1.0, turn_number=999, speed_bonus=0.5, speed_ref=200)
        == 1.0
    )


def test_speed_bonus_never_rewards_a_loss():
    # The bonus is win-gated: a loss is untouched no matter how fast it ended (a per-step time
    # PENALTY would instead let the bot throw games — the failure mode [D-19] avoids).
    assert (
        terminal_reward(won=0, placement=0.0, turn_number=1, speed_bonus=0.5, speed_ref=200) == 0.0
    )


def test_speed_bonus_off_is_identical_to_plain_modes():
    # speed_bonus=0 (the default) is byte-identical to the un-shaped objective.
    assert (
        terminal_reward(won=1, placement=1.0, turn_number=3, speed_bonus=0.0, speed_ref=None) == 1.0
    )
    assert (
        terminal_reward(
            won=1, placement=0.7, turn_number=3, reward_mode="placement", speed_bonus=0.0
        )
        == 0.7
    )


# --- DiceWarsEnv constructor validation (no server is started) ---------------------------------


def test_env_defaults_to_sparse_win():
    env = DiceWarsEnv()
    assert env._reward_mode == "win"
    assert env._speed_bonus == 0.0
    assert env._speed_ref is None
    assert "win" in REWARD_MODES and "placement" in REWARD_MODES


def test_env_accepts_placement_and_speed_bonus():
    env = DiceWarsEnv(reward_mode="placement", terminal_speed_bonus=0.5, speed_ref=200)
    assert env._reward_mode == "placement"
    assert env._speed_bonus == 0.5
    assert env._speed_ref == 200


@pytest.mark.parametrize(
    "kwargs, match",
    [
        ({"reward_mode": "bogus"}, "reward_mode must be one of"),
        ({"terminal_speed_bonus": -0.1}, "must be >= 0"),
        ({"terminal_speed_bonus": 0.5}, "speed_ref must be a positive int"),  # ref omitted
        ({"terminal_speed_bonus": 0.5, "speed_ref": 0}, "speed_ref must be a positive int"),
    ],
)
def test_env_rejects_bad_reward_config(kwargs, match):
    with pytest.raises(ValueError, match=match):
        DiceWarsEnv(**kwargs)


# --- validate_reward_args: the launch-time guard (front-runs the env ValueError) ---------------


def test_validate_reward_args_accepts_valid_and_defaults():
    # A valid speed-bonus config, a placement run, and a Namespace MISSING the flags (the tracer
    # case — getattr falls back to the [D-19] defaults) all pass without raising.
    validate_reward_args(SimpleNamespace(terminal_speed_bonus=0.5, speed_ref=200))
    validate_reward_args(
        SimpleNamespace(reward_mode="placement", terminal_speed_bonus=0.0, speed_ref=None)
    )
    validate_reward_args(SimpleNamespace())  # no reward attrs at all


@pytest.mark.parametrize(
    "ns, match",
    [
        (SimpleNamespace(terminal_speed_bonus=-1.0, speed_ref=None), "must be >= 0"),
        (SimpleNamespace(terminal_speed_bonus=0.5, speed_ref=None), "must be a positive integer"),
        (SimpleNamespace(terminal_speed_bonus=0.5, speed_ref=0), "must be a positive integer"),
    ],
)
def test_validate_reward_args_rejects_bad_config(ns, match):
    with pytest.raises(SystemExit, match=match):
        validate_reward_args(ns)
