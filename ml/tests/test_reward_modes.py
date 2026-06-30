"""Persona reward-shaping (bite D + G, docs/ml-bot/PERSONAS.md) — the terminal modes AND the dense
per-step shaping.

Lean tier (torch-free): exercises the pure ``terminal_reward``/``step_reward`` math, the
``DiceWarsEnv`` constructor validation, and the launch-time ``validate_reward_args`` guard — none of
which need torch, sb3, or a live Node env-server (``DiceWarsEnv`` connects lazily, so constructing
one only sets attrs/spaces). The flags' parser wiring (train.py) is covered in the torch-gated
test_train_args.py; the wire codec for the shaped frames is in test_ppo_wire.py.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from dicewars_ppo._train_common import validate_reward_args
from dicewars_ppo.env import REWARD_MODES, DiceWarsEnv, step_reward, terminal_reward

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


def test_truncation_pays_zero_in_placement_mode():
    # A maxTurns stalemate CAP (truncated=1, won=0) is an artificial Gym truncation: step()
    # bootstraps V(s) there. Paying the rank-at-cap `placement` reward on top would double-count
    # the outcome and reward stalling to the cap — so the truncated terminal pays 0 in placement
    # mode despite a non-zero `placement` on the wire. (The C1 fix; see the docstring.)
    assert (
        terminal_reward(
            won=0, placement=0.67, turn_number=500, truncated=1, reward_mode="placement"
        )
        == 0.0
    )
    # Without the truncated flag, the same frame would (incorrectly) pay the rank — guards the fix.
    assert (
        terminal_reward(
            won=0, placement=0.67, turn_number=500, truncated=0, reward_mode="placement"
        )
        == 0.67
    )


def test_truncation_is_zero_in_win_mode_too_and_default_off():
    # win mode is already 0 on a cap (a cap can't be a win), so the truncated guard is a no-op
    # there — the default path stays byte-identical. truncated defaults to 0 (off).
    assert terminal_reward(won=0, placement=0.5, turn_number=500, truncated=1) == 0.0
    assert terminal_reward(won=0, placement=0.5, turn_number=500) == 0.0  # default truncated=0


def test_truncation_zeroes_even_a_would_be_speed_bonus():
    # The truncated early-return dominates EVERY other field: even a bonus-eligible win (won=1 with
    # a speed bonus configured) pays 0 on a cap, because the guard precedes the win-gated bonus.
    # won=1+truncated=1 can't occur in production (step() rejects the pair), but feeding it to the
    # pure helper pins its control-flow ordering so it never silently relies on that upstream guard.
    # Without the early return this would compute 1*(1 + 0.5*clip(1 - 1/200)) ~= 1.4975, not 0 — so
    # this test genuinely fails if the C1 guard is removed.
    assert (
        terminal_reward(
            won=1, placement=1.0, turn_number=1, truncated=1, speed_bonus=0.5, speed_ref=200
        )
        == 0.0
    )


# --- step_reward: the dense per-step objective math (bite G) ------------------------------------


def test_step_reward_off_by_default_is_zero():
    # No coefs (the Conqueror/sparse-win default) ⇒ 0 every step regardless of the raw signals.
    assert step_reward(delta_territory=5, elims_by_learner=2) == 0.0
    assert step_reward(delta_territory=-3, elims_by_learner=0) == 0.0


def test_step_reward_expansionist_scales_net_territory():
    # territory_coef × net territory delta; negative deltas (land lost / elimination) are negative.
    assert step_reward(delta_territory=4, elims_by_learner=0, territory_coef=0.02) == pytest.approx(
        0.08
    )
    assert step_reward(
        delta_territory=-10, elims_by_learner=0, territory_coef=0.02
    ) == pytest.approx(-0.2)
    # elim signal ignored when only the territory coef is set.
    assert step_reward(delta_territory=1, elims_by_learner=3, territory_coef=0.02) == pytest.approx(
        0.02
    )


def test_step_reward_predator_pays_per_kill():
    assert step_reward(delta_territory=0, elims_by_learner=2, elim_bounty=0.1) == pytest.approx(0.2)
    # territory ignored when only the bounty is set.
    assert step_reward(delta_territory=9, elims_by_learner=1, elim_bounty=0.1) == pytest.approx(0.1)


def test_step_reward_combines_both_signals():
    r = step_reward(delta_territory=3, elims_by_learner=1, territory_coef=0.02, elim_bounty=0.1)
    assert r == pytest.approx(0.02 * 3 + 0.1 * 1)


def test_step_reward_clip_bounds_the_magnitude():
    # clip caps |reward| symmetrically (PERSONAS §6 "cap per-turn"). A big negative (territory wipe)
    # and a big positive both clamp to ±clip; an in-range value passes through.
    assert step_reward(delta_territory=-100, elims_by_learner=0, territory_coef=0.02, clip=0.5) == (
        -0.5
    )
    assert (
        step_reward(delta_territory=100, elims_by_learner=0, territory_coef=0.02, clip=0.5) == 0.5
    )
    assert step_reward(
        delta_territory=10, elims_by_learner=0, territory_coef=0.02, clip=0.5
    ) == pytest.approx(0.2)


# --- DiceWarsEnv constructor validation (no server is started) ---------------------------------


def test_env_defaults_to_sparse_win():
    env = DiceWarsEnv()
    assert env._reward_mode == "win"
    assert env._speed_bonus == 0.0
    assert env._speed_ref is None
    # Dense shaping off by default ⇒ base (unshaped) wire.
    assert env._shaped is False
    assert env._territory_coef == 0.0 and env._elim_bounty == 0.0
    assert "win" in REWARD_MODES and "placement" in REWARD_MODES


def test_env_accepts_placement_and_speed_bonus():
    env = DiceWarsEnv(reward_mode="placement", terminal_speed_bonus=0.5, speed_ref=200)
    assert env._reward_mode == "placement"
    assert env._speed_bonus == 0.5
    assert env._speed_ref == 200
    # Terminal modes are wire-free — they do NOT flip the env to the shaped wire.
    assert env._shaped is False


@pytest.mark.parametrize("kwargs", [{"territory_reward_coef": 0.02}, {"elim_bounty": 0.1}])
def test_env_dense_coef_enables_shaping_and_forwards_server_flag(kwargs):
    # A non-zero dense coef flips the env to the shaped wire AND tells the managed server to emit
    # shaped frames (the reward_shaping server kwarg), so the two sides can't disagree.
    env = DiceWarsEnv(**kwargs)
    assert env._shaped is True
    assert env._server_kwargs.get("reward_shaping") is True


def test_env_unmanaged_does_not_inject_server_flag():
    # An unmanaged env (caller owns the server) must NOT mutate server_kwargs — the caller is
    # responsible for launching with --reward-shaping; a mismatch is caught by the length guard.
    env = DiceWarsEnv(managed=False, host="127.0.0.1", port=1, elim_bounty=0.1)
    assert env._shaped is True
    assert "reward_shaping" not in env._server_kwargs


@pytest.mark.parametrize(
    "kwargs, match",
    [
        ({"reward_mode": "bogus"}, "reward_mode must be one of"),
        ({"terminal_speed_bonus": -0.1}, "must be >= 0"),
        ({"terminal_speed_bonus": 0.5}, "speed_ref must be a positive int"),  # ref omitted
        ({"terminal_speed_bonus": 0.5, "speed_ref": 0}, "speed_ref must be a positive int"),
        ({"territory_reward_coef": -0.1}, "territory_reward_coef must be a finite number >= 0"),
        ({"elim_bounty": -1.0}, "elim_bounty must be a finite number >= 0"),
        ({"elim_bounty": float("inf")}, "elim_bounty must be a finite number >= 0"),
        ({"territory_reward_coef": 0.02, "shaping_clip": 0}, "shaping_clip must be a finite"),
        ({"territory_reward_coef": 0.02, "shaping_clip": -1.0}, "shaping_clip must be a finite"),
    ],
)
def test_env_rejects_bad_reward_config(kwargs, match):
    with pytest.raises(ValueError, match=match):
        DiceWarsEnv(**kwargs)


# --- validate_reward_args: the launch-time guard (front-runs the env ValueError) ---------------


def test_validate_reward_args_accepts_valid_and_defaults():
    # A valid speed-bonus config, a placement run, valid dense coefs, and a Namespace MISSING the
    # flags (a programmatic/test caller — getattr falls back to the [D-19] defaults) all pass.
    validate_reward_args(SimpleNamespace(terminal_speed_bonus=0.5, speed_ref=200))
    validate_reward_args(
        SimpleNamespace(reward_mode="placement", terminal_speed_bonus=0.0, speed_ref=None)
    )
    validate_reward_args(SimpleNamespace(territory_reward_coef=0.02, elim_bounty=0.1))
    validate_reward_args(SimpleNamespace(territory_reward_coef=0.02, shaping_clip=0.5))
    validate_reward_args(SimpleNamespace())  # no reward attrs at all


@pytest.mark.parametrize(
    "ns, match",
    [
        # reward_mode is also front-run here (not only by argparse choices), so a non-CLI Namespace
        # with a bad mode fails at launch instead of late inside a SubprocVecEnv worker.
        (SimpleNamespace(reward_mode="bogus"), "reward-mode must be one of"),
        (SimpleNamespace(terminal_speed_bonus=-1.0, speed_ref=None), "must be >= 0"),
        (SimpleNamespace(terminal_speed_bonus=0.5, speed_ref=None), "must be a positive integer"),
        (SimpleNamespace(terminal_speed_bonus=0.5, speed_ref=0), "must be a positive integer"),
        # Dense shaping coefs (bite G): front-run the env ValueError with a launch-time SystemExit.
        (SimpleNamespace(territory_reward_coef=-0.1), "territory-reward-coef must be a finite"),
        (SimpleNamespace(elim_bounty=-1.0), "elim-bounty must be a finite"),
        (SimpleNamespace(elim_bounty=float("nan")), "elim-bounty must be a finite"),
        (SimpleNamespace(shaping_clip=0), "shaping-clip must be a finite"),
        (SimpleNamespace(shaping_clip=-2.0), "shaping-clip must be a finite"),
    ],
)
def test_validate_reward_args_rejects_bad_config(ns, match):
    with pytest.raises(SystemExit, match=match):
        validate_reward_args(ns)
