"""Advantage-mass-near-kill-frames diagnostic — the PERSONAS §10.3 "which hypothesis bound?" probe.

[D-33] closed the Predator persona "under the current wire" on the strength of two live
hypotheses: (H1) representability — fixed by v3's ``eliminatesDefender``, evidenced by the
v2→v3 dose-response sign flip — and (H2) turn-boundary kill-credit dilution, a wire property
of ``elimsByLearner``: the shaping tracker folds a turn's kills at the turn boundary
(``recordTurn`` via ``onTurn``), so a NON-terminal kill's bounty is paid on the first frame
of the learner's NEXT turn — which, under Gym semantics, attaches the reward to the turn's
final action (the STOP decision), never to the killing attack itself. (A GAME-ENDING kill is
the exception: the terminal frame follows the killing attack directly, so it is correctly
attributed — exactly §10.3's "non-terminal kills" phrasing.)

This probe measures whether H2 actually *bound* — i.e. whether the learning signal a killing
attack receives is distinguishable from its turn-mates' — by replaying the frozen pilot
policies through the real env stack (no training, no wire change) and computing the GAE
advantages the trainer would have seen:

1. **Collect** rollouts with ``MaskablePPO.load(<run>/state/ckpt-*.zip)`` (actor samples like
   training; the critic supplies ``V(s)``) through ``DiceWarsEnv`` configured with the arm's
   exact reward flags and its own PFSP league snapshots + reserve baselines.
2. **Detect true kill decisions** from the observation stream: the players-tensor
   ``eliminated`` column flipping 0→1 between consecutive within-turn learner frames
   attributes the kill to the exact action (only the learner acts inside its own turn).
   Cross-validated per episode against the wire's independent ``elims_by_learner`` totals.
3. **Score attribution**: GAE advantages (the run's own γ/λ) → per-kill lag from killing
   action to paid transition, within-turn advantage sharpness at the killing action, and the
   pre-registered "advantage mass near kill frames" concentration ratio.
4. **Counterfactual re-timing** — the proposed frame-level wire fix, simulated offline: move
   each bounty from its paid transition onto its killing action, recompute GAE with the SAME
   critic, re-score. If sharpness recovers, the fix has a demonstrated mechanism; if it
   barely moves, dilution wasn't what bound and Predator stays closed with evidence.

Pure functions (GAE / detection / re-timing / metrics) are torch-free and unit-tested in
``ml/tests/test_kill_attribution_probe.py``; torch/sb3 imports live inside ``collect_rollouts``
/ ``main`` so importing this module stays light.

Usage (from ``ml/``, venv active)::

    python -m dicewars_ppo.kill_attribution_probe \
        --run-dir /path/to/ml/runs/ppo-v3-pred-b15 \
        --elim-bounty 0.15 --episodes 400 --seed-base 777001 \
        --out probe-b15.json
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Players-tensor column indices (src/arena/encodeObservation.js PLAYER_FEATURES).
PLAYER_COL_IS_ME = 0
PLAYER_COL_ELIMINATED = 1

# Reserve-baseline field used by every training run (_train_common.DEFAULT_OPPONENTS).
DEFAULT_OPPONENTS = "ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive"


# --------------------------------------------------------------------------------------
# Pure per-episode machinery (torch-free, unit-tested)
# --------------------------------------------------------------------------------------


def compute_gae(
    rewards: np.ndarray,
    values: np.ndarray,
    terminal_value: float,
    terminated: bool,
    gamma: float,
    lam: float,
) -> np.ndarray:
    """GAE advantages for one complete episode, matching SB3's bootstrap semantics.

    ``rewards[t]``/``values[t]`` are the reward and ``V(s_t)`` of transition ``t``
    (t = 0..T-1); ``terminal_value`` is ``V(s_T)`` of the terminal frame. A genuine
    terminal (``terminated=True``) bootstraps 0; a maxTurns truncation bootstraps
    ``terminal_value`` (SB3 keys off ``TimeLimit.truncated``).
    """
    T = len(rewards)
    adv = np.zeros(T, dtype=np.float64)
    next_value = 0.0 if terminated else float(terminal_value)
    gae = 0.0
    for t in reversed(range(T)):
        delta = rewards[t] + gamma * next_value - values[t]
        gae = delta + gamma * lam * gae
        adv[t] = gae
        next_value = values[t]
    return adv


def turn_ids_from_stops(stop_flags: np.ndarray) -> np.ndarray:
    """Group transitions into learner turns: a turn is a maximal run ending at a STOP.

    ``stop_flags[t]`` is True when action ``t`` was the STOP decision. The transition
    AFTER a STOP starts the next turn; the trailing (possibly STOP-less, terminal-ended)
    run is its own turn.
    """
    ids = np.zeros(len(stop_flags), dtype=np.int64)
    turn = 0
    for t in range(len(stop_flags)):
        ids[t] = turn
        if stop_flags[t]:
            turn += 1
    return ids


def detect_kill_events(
    eliminated_frames: np.ndarray, stop_flags: np.ndarray, learner_row: int
) -> list[dict]:
    """Attribute kills to exact learner actions from the observation stream.

    ``eliminated_frames`` is ``(T+1, P)`` — the players-tensor ``eliminated`` column at
    every frame (T decision frames + the terminal frame). Between two consecutive frames
    of the SAME learner turn only the learner acted, so a 0→1 flip there is a kill by
    that action. Flips across a STOP boundary happened during opponents' turns and are
    ignored (the wire's ``recordTurn`` makes the same call). The learner's own row is
    excluded (it can only die during opponents' turns).
    """
    events = []
    for t in range(len(stop_flags)):
        if stop_flags[t]:
            continue
        flipped = np.flatnonzero((eliminated_frames[t] == 0) & (eliminated_frames[t + 1] == 1))
        n = int(sum(1 for p in flipped if p != learner_row))
        if n:
            events.append({"t": int(t), "n_kills": n})
    return events


def paid_transition_for_kill(t: int, turn_ids: np.ndarray, elims_stream: np.ndarray) -> int | None:
    """The transition whose reward carried the bounty for the kill at ``t``, or None.

    Wire-agnostic: the first transition at-or-after ``t`` within the same turn whose
    ``elims_stream`` entry is > 0. Under the CURRENT wire that is the turn's final
    transition (kills fold at the ``onTurn`` boundary, so the bounty rides the frame
    that follows the turn's last action — its STOP, or the killing attack itself when
    the game ends on it). Under the re-timed counterfactual it is ``t`` itself.
    """
    turn = turn_ids[t]
    for p in range(t, len(turn_ids)):
        if turn_ids[p] != turn:
            return None
        if elims_stream[p] > 0:
            return int(p)
    return None


def shaping_component(elims: float, bounty: float, clip: float | None) -> float:
    """The bounty shaping paid on one transition (mirrors ``env.step_reward``, coef 0)."""
    r = bounty * float(elims)
    if clip is not None:
        r = min(clip, max(-clip, r))
    return r


def retime_rewards(
    rewards: np.ndarray,
    elims_stream: np.ndarray,
    kill_events: list[dict],
    bounty: float,
    clip: float | None,
) -> np.ndarray:
    """The counterfactual frame-level wire: bounty paid on the killing action itself.

    Strips the realized bounty shaping from every paid transition (recoverable exactly
    from ``elims_stream`` + the arm's coefficients) and re-adds it at the detected killing
    transitions, re-applying the shaping clip per-step. Total bounty is conserved unless
    the clip binds differently under the new timing (callers report ``clip_bound`` counts).
    """
    out = rewards.astype(np.float64).copy()
    for t in range(len(out)):
        out[t] -= shaping_component(elims_stream[t], bounty, clip)
    for ev in kill_events:
        out[ev["t"]] += shaping_component(ev["n_kills"], bounty, clip)
    return out


@dataclass
class EpisodeMetrics:
    """Per-episode attribution metrics for one advantage vector."""

    lags: list[int] = field(default_factory=list)
    sharpness: list[float] = field(default_factory=list)  # A[kill] - mean(A[turn mates])
    top_rank: list[bool] = field(default_factory=list)  # A[kill] is its turn's max
    stop_minus_kill: list[float] = field(default_factory=list)  # A[paid] - A[kill]
    mass_ratio: float | None = None


def score_episode(
    advantages: np.ndarray,
    kill_events: list[dict],
    stop_flags: np.ndarray,
    elims_stream: np.ndarray,
    window: int,
) -> EpisodeMetrics:
    """Attribution metrics for one episode: lag, within-turn sharpness, mass ratio."""
    m = EpisodeMetrics()
    if not kill_events:
        return m
    turn_ids = turn_ids_from_stops(stop_flags)
    kill_ts = np.array([ev["t"] for ev in kill_events], dtype=np.int64)

    for ev in kill_events:
        t = ev["t"]
        turn = turn_ids[t]
        paid = paid_transition_for_kill(t, turn_ids, elims_stream)
        if paid is not None:
            m.lags.append(int(paid - t))
            if paid != t:
                m.stop_minus_kill.append(float(advantages[paid] - advantages[t]))
        (mates,) = np.nonzero(turn_ids == turn)
        others = mates[mates != t]
        if len(others) > 0:
            m.sharpness.append(float(advantages[t] - advantages[others].mean()))
            m.top_rank.append(bool(advantages[t] >= advantages[mates].max()))

    # Advantage-mass concentration: |A| mass within ±window of any killing transition,
    # normalized by the mass a uniform spread would put there (covered-share).
    T = len(advantages)
    covered = np.zeros(T, dtype=bool)
    for t in kill_ts:
        covered[max(0, t - window) : min(T, t + window + 1)] = True
    total_mass = float(np.abs(advantages).sum())
    if total_mass > 0 and covered.any() and not covered.all():
        mass_share = float(np.abs(advantages[covered]).sum()) / total_mass
        m.mass_ratio = mass_share / (covered.sum() / T)
    return m


def mean_ci(per_episode: list[float]) -> dict:
    """Mean ± 95% CI across episodes (normal approx; episodes are the independent unit)."""
    arr = np.asarray(per_episode, dtype=np.float64)
    n = len(arr)
    if n == 0:
        return {"n": 0, "mean": None, "ci95": None}
    mean = float(arr.mean())
    if n == 1:
        return {"n": 1, "mean": mean, "ci95": None}
    half = 1.96 * float(arr.std(ddof=1)) / math.sqrt(n)
    return {"n": n, "mean": mean, "ci95": [mean - half, mean + half]}


def aggregate(episode_metrics: list[EpisodeMetrics]) -> dict:
    """Cluster kill events by episode (per-episode means), then CI across episodes."""

    def per_ep(attr: str) -> list[float]:
        out = []
        for em in episode_metrics:
            vals = getattr(em, attr)
            if vals:
                out.append(float(np.mean(vals)))
        return out

    lags_flat = [lag for em in episode_metrics for lag in em.lags]
    return {
        "killEvents": int(sum(len(em.lags) for em in episode_metrics)),
        "lag": mean_ci(per_ep("lags")),
        "lagZeroFrac": (float(np.mean([lag == 0 for lag in lags_flat])) if lags_flat else None),
        "sharpness": mean_ci(per_ep("sharpness")),
        "topRankFrac": mean_ci(per_ep("top_rank")),
        "stopMinusKill": mean_ci(per_ep("stop_minus_kill")),
        "massRatio": mean_ci(
            [em.mass_ratio for em in episode_metrics if em.mass_ratio is not None]
        ),
    }


# --------------------------------------------------------------------------------------
# Rollout collection (torch/sb3 imported here only)
# --------------------------------------------------------------------------------------


def collect_rollouts(args: argparse.Namespace) -> dict:
    """Replay the frozen policy through the real env stack and score attribution."""
    import torch
    from sb3_contrib import MaskablePPO

    from .env import DiceWarsEnv

    run_dir = Path(args.run_dir)
    latest = json.loads((run_dir / "state" / "latest.json").read_text())
    ckpt_path = run_dir / "state" / latest["ckpt"]
    model = MaskablePPO.load(str(ckpt_path), device=args.device)
    gamma, lam = float(model.gamma), float(model.gae_lambda)
    print(
        f"loaded {ckpt_path.name} (step {latest['step']}, gamma={gamma}, "
        f"gae_lambda={lam}, device={args.device})"
    )

    manifest = args.snapshot_manifest or str(run_dir / "league" / "manifest.json")
    env = DiceWarsEnv(
        reward_mode=args.reward_mode,
        elim_bounty=args.elim_bounty,
        shaping_clip=args.shaping_clip,
        server_kwargs={
            "opponents": args.opponents,
            "snapshot_manifest": manifest,
            "reserve_baselines": args.reserve_baselines,
            "seed_base": args.seed_base,
            "max_turns": args.max_turns,
        },
    )

    real_metrics: list[EpisodeMetrics] = []
    retimed_metrics: list[EpisodeMetrics] = []
    mismatched = 0
    clip_bound = 0
    outcomes = {"episodes": 0, "wins": 0, "truncations": 0, "wire_kills": 0}

    try:
        for _ in range(args.episodes):
            obs, info = env.reset()
            values, rewards, elims_stream, stop_flags, elim_frames = [], [], [], [], []
            done = truncated = False
            while not (done or truncated):
                elim_frames.append(obs["players"][:, PLAYER_COL_ELIMINATED].astype(np.int8))
                with torch.no_grad():
                    obs_t, _ = model.policy.obs_to_tensor(obs)
                    values.append(float(model.policy.predict_values(obs_t)))
                action, _ = model.predict(
                    obs, action_masks=env.action_masks(), deterministic=args.deterministic
                )
                stop_flags.append(int(action) == info["num_edges"] - 1)
                obs, r, done, truncated, info = env.step(int(action))
                rewards.append(float(r))
                elims_stream.append(int(info["elims_by_learner"]))
            elim_frames.append(obs["players"][:, PLAYER_COL_ELIMINATED].astype(np.int8))
            with torch.no_grad():
                obs_t, _ = model.policy.obs_to_tensor(obs)
                terminal_value = float(model.policy.predict_values(obs_t))

            elim_frames_arr = np.stack(elim_frames)
            learner_row = int(np.argmax(obs["players"][:, PLAYER_COL_IS_ME]))
            stop_arr = np.asarray(stop_flags, dtype=bool)
            elims_arr = np.asarray(elims_stream, dtype=np.int64)
            rewards_arr = np.asarray(rewards, dtype=np.float64)
            values_arr = np.asarray(values, dtype=np.float64)

            kill_events = detect_kill_events(elim_frames_arr, stop_arr, learner_row)
            detected = sum(ev["n_kills"] for ev in kill_events)
            wire = int(elims_arr.sum())
            outcomes["episodes"] += 1
            outcomes["wins"] += int(info["won"])
            outcomes["truncations"] += int(info["truncated"])
            outcomes["wire_kills"] += wire
            if detected != wire:
                # Detection must agree with the wire's independent count; a mismatched
                # episode would poison attribution, so it is excluded and counted loudly.
                mismatched += 1
                continue
            for ev in kill_events:
                if (
                    args.shaping_clip is not None
                    and args.elim_bounty * ev["n_kills"] > args.shaping_clip
                ):
                    clip_bound += 1

            adv = compute_gae(rewards_arr, values_arr, terminal_value, done, gamma, lam)
            real_metrics.append(score_episode(adv, kill_events, stop_arr, elims_arr, args.window))

            retimed = retime_rewards(
                rewards_arr, elims_arr, kill_events, args.elim_bounty, args.shaping_clip
            )
            # Under the counterfactual wire the bounty rides the killing transition itself.
            retimed_elims = np.zeros_like(elims_arr)
            for ev in kill_events:
                retimed_elims[ev["t"]] += ev["n_kills"]
            adv_rt = compute_gae(retimed, values_arr, terminal_value, done, gamma, lam)
            retimed_metrics.append(
                score_episode(adv_rt, kill_events, stop_arr, retimed_elims, args.window)
            )
    finally:
        env.close()

    return {
        "runDir": str(run_dir),
        "checkpoint": latest["ckpt"],
        "step": latest["step"],
        "gamma": gamma,
        "gaeLambda": lam,
        "config": {
            "rewardMode": args.reward_mode,
            "elimBounty": args.elim_bounty,
            "shapingClip": args.shaping_clip,
            "episodes": args.episodes,
            "seedBase": args.seed_base,
            "window": args.window,
            "deterministic": args.deterministic,
            "opponents": args.opponents,
            "reserveBaselines": args.reserve_baselines,
        },
        "outcomes": outcomes,
        "mismatchedEpisodes": mismatched,
        "clipBoundKillEvents": clip_bound,
        "real": aggregate(real_metrics),
        "retimed": aggregate(retimed_metrics),
    }


def format_report(report: dict) -> str:
    """Human-readable summary of the real-vs-retimed attribution contrast."""

    def fmt(entry: dict) -> str:
        if entry["mean"] is None:
            return "n/a"
        if entry["ci95"] is None:
            return f"{entry['mean']:+.3f}"
        lo, hi = entry["ci95"]
        return f"{entry['mean']:+.3f} [{lo:+.3f}, {hi:+.3f}] (n={entry['n']})"

    o = report["outcomes"]
    lines = [
        f"== kill-attribution probe: {Path(report['runDir']).name} @ step {report['step']} ==",
        f"episodes={o['episodes']} wins={o['wins']} truncations={o['truncations']} "
        f"wireKills={o['wire_kills']} mismatched={report['mismatchedEpisodes']} "
        f"clipBound={report['clipBoundKillEvents']}",
        f"kill events scored: {report['real']['killEvents']} "
        f"(lag==0, i.e. game-ending & correctly attributed: "
        f"{report['real']['lagZeroFrac']:.1%})"
        if report["real"]["lagZeroFrac"] is not None
        else "kill events scored: 0",
        "",
        f"{'metric':<22} {'current wire':>34} {'retimed (frame-level fix)':>34}",
    ]
    for key, label in [
        ("lag", "lag (transitions)"),
        ("sharpness", "sharpness A_k-mean"),
        ("topRankFrac", "kill is turn-max A"),
        ("stopMinusKill", "A_paid - A_kill"),
        ("massRatio", "mass ratio (±w)"),
    ]:
        lines.append(
            f"{label:<22} {fmt(report['real'][key]):>34} {fmt(report['retimed'][key]):>34}"
        )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--run-dir", required=True, help="PPO run dir (state/ + league/)")
    p.add_argument("--elim-bounty", type=float, required=True, help="The arm's bounty coef")
    p.add_argument("--shaping-clip", type=float, default=1.0)
    p.add_argument("--reward-mode", default="placement", choices=["win", "placement"])
    p.add_argument("--episodes", type=int, default=400)
    p.add_argument("--seed-base", type=int, default=777001)
    p.add_argument("--window", type=int, default=2, help="±transitions for the mass metric")
    p.add_argument("--device", default="cpu")
    p.add_argument("--deterministic", action="store_true", help="argmax instead of sampling")
    p.add_argument("--opponents", default=DEFAULT_OPPONENTS)
    p.add_argument("--reserve-baselines", type=int, default=3)
    p.add_argument("--max-turns", type=int, default=500)
    p.add_argument("--snapshot-manifest", default=None, help="Override <run>/league/manifest.json")
    p.add_argument("--out", default=None, help="Write the JSON report here")
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    report = collect_rollouts(args)
    print(format_report(report))
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
        print(f"\nreport → {args.out}")


if __name__ == "__main__":
    main()
