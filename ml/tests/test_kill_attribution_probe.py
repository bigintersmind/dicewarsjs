"""Hermetic tests for the §10.3 kill-attribution probe's pure machinery.

Everything here is torch-free: the probe keeps torch/sb3 imports inside
``collect_rollouts``, so the GAE / detection / re-timing / scoring functions test
against hand-computed values without a checkpoint or env-server.
"""

import numpy as np
import pytest

from dicewars_ppo.kill_attribution_probe import (
    EpisodeMetrics,
    aggregate,
    compute_gae,
    detect_kill_events,
    mean_ci,
    paid_transition_for_kill,
    retime_rewards,
    score_episode,
    shaping_component,
    turn_ids_from_stops,
)


class TestComputeGae:
    def test_terminated_hand_computed(self):
        # T=2, gamma=0.5, lam=0.5, genuine terminal (bootstrap 0):
        #   delta_1 = 1 + 0.5*0   - 0.4 = 0.6            -> A_1 = 0.6
        #   delta_0 = 0 + 0.5*0.4 - 0.2 = 0.0            -> A_0 = 0 + (0.5*0.5)*0.6 = 0.15
        adv = compute_gae(np.array([0.0, 1.0]), np.array([0.2, 0.4]), 9.9, True, gamma=0.5, lam=0.5)
        np.testing.assert_allclose(adv, [0.15, 0.6])

    def test_truncated_bootstraps_terminal_value(self):
        #   delta_1 = 1 + 0.5*1.0 - 0.4 = 1.1            -> A_1 = 1.1
        #   delta_0 = 0 + 0.5*0.4 - 0.2 = 0.0            -> A_0 = 0.25*1.1 = 0.275
        adv = compute_gae(
            np.array([0.0, 1.0]), np.array([0.2, 0.4]), 1.0, False, gamma=0.5, lam=0.5
        )
        np.testing.assert_allclose(adv, [0.275, 1.1])


class TestTurnIds:
    def test_groups_runs_ending_at_stop(self):
        stops = np.array([False, False, True, False, True, False])
        np.testing.assert_array_equal(turn_ids_from_stops(stops), [0, 0, 0, 1, 1, 2])


class TestDetectKillEvents:
    def test_within_turn_flip_attributed_to_the_action(self):
        frames = np.array([[0, 0, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]])
        stops = np.array([False, False, True])
        assert detect_kill_events(frames, stops, learner_row=0) == [{"t": 0, "n_kills": 1}]

    def test_flip_across_stop_boundary_ignored(self):
        # Player 2 dies between the STOP (t=1) and the next turn's first frame: an
        # opponents-interval death, not a learner kill.
        frames = np.array([[0, 0, 0], [0, 0, 0], [0, 0, 1], [0, 0, 1]])
        stops = np.array([False, True, False])
        assert detect_kill_events(frames, stops, learner_row=0) == []

    def test_learner_own_death_excluded(self):
        frames = np.array([[0, 0, 0], [1, 0, 0]])
        stops = np.array([False])
        assert detect_kill_events(frames, stops, learner_row=0) == []

    def test_terminal_frame_kill_attributed_to_final_attack(self):
        # Game ends on the killing attack: the terminal frame follows it directly.
        frames = np.array([[0, 0, 0], [0, 0, 1]])
        stops = np.array([False])
        assert detect_kill_events(frames, stops, learner_row=0) == [{"t": 0, "n_kills": 1}]

    def test_double_kill_in_one_interval(self):
        frames = np.array([[0, 0, 0], [0, 1, 1]])
        stops = np.array([False])
        assert detect_kill_events(frames, stops, learner_row=0) == [{"t": 0, "n_kills": 2}]


class TestPaidTransition:
    def test_current_wire_pays_at_turn_final_transition(self):
        turn_ids = turn_ids_from_stops(np.array([False, True, False, True]))
        elims = np.array([0, 0, 0, 2])
        assert paid_transition_for_kill(2, turn_ids, elims) == 3

    def test_retimed_wire_pays_at_the_kill_itself(self):
        turn_ids = turn_ids_from_stops(np.array([False, True, False, True]))
        elims = np.array([0, 0, 2, 0])
        assert paid_transition_for_kill(2, turn_ids, elims) == 2

    def test_unpaid_turn_returns_none(self):
        turn_ids = turn_ids_from_stops(np.array([False, True, False, True]))
        elims = np.array([0, 0, 0, 2])
        assert paid_transition_for_kill(0, turn_ids, elims) is None


class TestRetimeRewards:
    def test_moves_bounty_and_conserves_total(self):
        rewards = np.array([0.0, 0.0, 0.3, 0.5])  # 0.3 = bounty*2 paid at the STOP (t=2)
        elims = np.array([0, 0, 2, 0])
        events = [{"t": 0, "n_kills": 2}]
        out = retime_rewards(rewards, elims, events, bounty=0.15, clip=1.0)
        np.testing.assert_allclose(out, [0.3, 0.0, 0.0, 0.5])
        assert out.sum() == pytest.approx(rewards.sum())

    def test_clip_applies_per_step(self):
        assert shaping_component(2, bounty=0.25, clip=0.4) == pytest.approx(0.4)
        assert shaping_component(2, bounty=0.25, clip=None) == pytest.approx(0.5)


class TestScoreEpisode:
    def test_lag_sharpness_and_paid_contrast(self):
        # One turn of 3 transitions (kill at t=0, STOP at t=2 pays it), then terminal.
        stops = np.array([False, False, True])
        elims = np.array([0, 0, 1])
        adv = np.array([0.1, 0.2, 0.9])
        events = [{"t": 0, "n_kills": 1}]
        m = score_episode(adv, events, stops, elims, window=0)
        assert m.lags == [2]
        assert m.sharpness == [pytest.approx(0.1 - (0.2 + 0.9) / 2)]
        assert m.top_rank == [False]
        assert m.stop_minus_kill == [pytest.approx(0.8)]
        # window=0 covers only t=0: mass 0.1/1.2 vs uniform 1/3 -> ratio 0.25.
        assert m.mass_ratio == pytest.approx((0.1 / 1.2) / (1 / 3))

    def test_no_kills_yields_empty_metrics(self):
        m = score_episode(
            np.array([0.5, 0.5]), [], np.array([False, True]), np.array([0, 0]), window=2
        )
        assert m.lags == [] and m.mass_ratio is None


class TestRetimedMechanism:
    def test_retiming_sharpens_the_killing_action(self):
        # A flat-critic episode: one 4-transition turn, kill at t=1, paid at the STOP
        # (t=3). Under the current wire GAE peaks at the STOP; after re-timing it must
        # peak at the killing action — the mechanism the frame-level fix claims.
        stops = np.array([False, False, False, True])
        elims = np.array([0, 0, 0, 1])
        values = np.zeros(4)
        rewards = np.array([0.0, 0.0, 0.0, 0.15])
        adv = compute_gae(rewards, values, 0.0, True, gamma=0.999, lam=0.95)
        assert int(np.argmax(adv)) == 3  # STOP gets the sharpest credit today

        events = [{"t": 1, "n_kills": 1}]
        retimed = retime_rewards(rewards, elims, events, bounty=0.15, clip=1.0)
        adv_rt = compute_gae(retimed, values, 0.0, True, gamma=0.999, lam=0.95)
        assert int(np.argmax(adv_rt)) == 1  # the killing action, after the fix

        m = score_episode(adv, events, stops, elims, window=0)
        retimed_elims = np.array([0, 1, 0, 0])
        m_rt = score_episode(adv_rt, events, stops, retimed_elims, window=0)
        assert m_rt.sharpness[0] > m.sharpness[0]
        assert m.top_rank == [False] and m_rt.top_rank == [True]
        assert m.lags == [2] and m_rt.lags == [0]


class TestAggregation:
    def test_mean_ci_shapes(self):
        assert mean_ci([]) == {"n": 0, "mean": None, "ci95": None}
        assert mean_ci([2.0])["ci95"] is None
        two = mean_ci([1.0, 3.0])
        assert two["mean"] == pytest.approx(2.0)
        assert two["ci95"][0] < 2.0 < two["ci95"][1]

    def test_aggregate_clusters_by_episode(self):
        a = EpisodeMetrics(lags=[0, 4], sharpness=[1.0], top_rank=[True], mass_ratio=2.0)
        b = EpisodeMetrics(lags=[2], sharpness=[3.0], top_rank=[False], mass_ratio=4.0)
        agg = aggregate([a, b, EpisodeMetrics()])
        assert agg["killEvents"] == 3
        assert agg["lag"]["n"] == 2  # episodes with kills, not raw events
        assert agg["lag"]["mean"] == pytest.approx((2.0 + 2.0) / 2)
        assert agg["lagZeroFrac"] == pytest.approx(1 / 3)
        assert agg["sharpness"]["mean"] == pytest.approx(2.0)
        assert agg["massRatio"]["mean"] == pytest.approx(3.0)
