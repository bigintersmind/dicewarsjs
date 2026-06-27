"""Tiny tracer PPO run — the smallest end-to-end self-play RL loop (PLAN step 6).

    python -m dicewars_ppo.train_tracer \
        --checkpoint checkpoints/v2-base/bc_model.pt \
        --timesteps 2048 --out checkpoints/ppo-tracer.pt

What this proves (and what it does NOT). It closes the loop: warm-start the
``EdgePolicyNet``-trunk policy from the v2-BC checkpoint, run ``MaskablePPO``
against a *fixed* heterogeneous JS-baseline field over the Node env-server with a
**sparse terminal-win reward** ([D-19] decision 3), take a handful of gradient
updates, then **repack** the trained actor back to the BC checkpoint format and
verify it reloads into a bare ``EdgePolicyNet`` (the step-7 export target). It is a
*tracer*, not a strength run: tiny budget, no PFSP league, no reward shaping, no
from-scratch control — those are the Phase-3 scaling tasks. The headline gate
(``arena:sweep`` win% vs ``ai_lookahead``) is step 7, not here.

Reward / bootstrapping. The only non-zero reward is ``+1`` at a terminal the
learner won. A ``maxTurns`` stalemate cap arrives as a Gym **truncation**
(``terminated=False, truncated=True``), so SB3 bootstraps ``V(s)`` there instead of
treating the cut-off game as a real 0-reward terminal — the wire ``truncated`` flag
this step also added (see ``wire.py`` / ``ppo-env.mjs``). A win or the learner's
elimination is a genuine terminal (``terminated=True``).

Warm-start protection ([D-19] decision 1). The default ``--lr`` is low so a short
run can't wreck the warm-started actor, and ``--freeze-trunk`` pins the BC
trunk+edge-head entirely (critic-only warm-up) — in that mode the repacked actor is
byte-identical to the warm-start, a useful sanity floor.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.vec_env import DummyVecEnv

from dicewars_bc.model import EdgePolicyNet, ModelConfig

from .env import DiceWarsEnv
from .policy import (
    MaskableEdgePolicy,
    load_bc_checkpoint,
    repack_to_bc_checkpoint,
    warm_start_from_bc,
)
from .snapshot_callback import SnapshotCallback

# Fixed, seed-pure, heterogeneous baseline field ([D-15]: strong bots in every game
# keep it decisive; no Math.random bots so episodes stay reproducible). resolveOpponents
# cycles this list to fill the (player_count - 1) opponent seats.
DEFAULT_OPPONENTS = "ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive"


def _make_env_thunk(cfg: ModelConfig, args: argparse.Namespace, env_index: int):
    """A zero-arg env factory for ``DummyVecEnv`` — each launches its own env-server.

    The env's ``player_count`` MUST equal the BC config's (the players-tensor height the
    obs frame carries; ``_check_dims`` rejects a mismatch), so it's taken from ``cfg``,
    not a free flag. Each env gets a disjoint ``seed_base`` block so parallel envs don't
    replay identical episodes.
    """

    # All vec-env servers poll the SAME producer manifest, so they share one snapshot pool ([D-22]).
    # `snapshot_dir` is resolved absolute in _validate_args so producer (this process) and consumers
    # (the Node servers, cwd=repo-root) agree on the path regardless of cwd.
    snapshot_manifest = (
        str(Path(args.snapshot_dir) / "manifest.json") if args.snapshot_dir else None
    )

    def _thunk() -> DiceWarsEnv:
        return DiceWarsEnv(
            max_areas=cfg.max_areas,
            player_count=cfg.player_count,
            server_kwargs={
                "opponents": args.opponents,
                "max_turns": args.max_turns,
                "learner_seat": args.learner_seat,
                "seed_base": args.seed_base + env_index * 1_000_000,
                "snapshot_manifest": snapshot_manifest,
                "snapshot_pool_cap": args.snapshot_pool_cap,
                "reserve_baselines": args.reserve_baselines,
                "pfsp_epsilon": args.pfsp_epsilon,
                "pfsp_k": args.pfsp_k,
            },
        )

    return _thunk


def build_model(
    cfg: ModelConfig, ckpt: dict, args: argparse.Namespace
) -> tuple[MaskablePPO, DummyVecEnv]:
    """Construct the vec-env + warm-started ``MaskablePPO``. Returns ``(model, venv)``."""
    venv = DummyVecEnv([_make_env_thunk(cfg, args, i) for i in range(args.n_envs)])

    model = MaskablePPO(
        MaskableEdgePolicy,
        venv,
        learning_rate=args.lr,
        n_steps=args.n_steps,
        batch_size=args.batch_size,
        n_epochs=args.n_epochs,
        gamma=args.gamma,
        gae_lambda=args.gae_lambda,
        ent_coef=args.ent_coef,
        vf_coef=args.vf_coef,
        max_grad_norm=0.5,
        policy_kwargs={"bc_config": cfg},
        seed=args.seed,
        device=args.device,
        verbose=1,
    )

    # Load the BC trunk + edge_head into the actor (the fresh scalar critic stays at init).
    warm_start_from_bc(model.policy, ckpt)
    n_total = sum(p.numel() for p in model.policy.parameters())
    n_actor = sum(p.numel() for p in model.policy.bc_net.parameters())
    print(f"warm-started actor from BC checkpoint: {n_actor:,} actor params, {n_total:,} total")

    if args.freeze_trunk:
        for p in model.policy.bc_net.parameters():
            p.requires_grad_(False)
        print("froze BC trunk+edge_head (critic-only warm-up) — actor is unchanged at repack")

    return model, venv


def _verify_repack_exportable(out_path: Path, cfg: ModelConfig) -> None:
    """Reload the saved checkpoint into a bare ``EdgePolicyNet`` — the step-7 export gate.

    This is the real end-to-end proof: a *trained* policy round-trips to the exact
    format ``dicewars_bc.export_weights`` / ``export_onnx`` consume, so the graded bot
    will be the trained policy (the [D-19] gate-breaking gap, checked against reality).
    """
    saved = torch.load(out_path, map_location="cpu", weights_only=True)
    if saved.get("encoding_version") != 2:
        raise AssertionError(
            f"repacked checkpoint encoding_version={saved.get('encoding_version')!r} != 2"
        )
    reloaded = EdgePolicyNet(ModelConfig(**saved["config"]))
    reloaded.load_state_dict(saved["state_dict"], strict=True)  # strict ⇒ exact key/shape match
    if ModelConfig(**saved["config"]) != cfg:
        raise AssertionError("repacked config drifted from the warm-start config")
    print(f"repack verified: {out_path} reloads into a bare EdgePolicyNet (export-ready)")


def train(args: argparse.Namespace) -> Path:
    cfg, ckpt = load_bc_checkpoint(args.checkpoint)
    print(
        f"loaded BC checkpoint {args.checkpoint}: encoding_version==2, "
        f"max_areas={cfg.max_areas} player_count={cfg.player_count} "
        f"context_hidden={cfg.context_hidden}"
    )
    print(
        f"tracer config: n_envs={args.n_envs} opponents=[{args.opponents}] "
        f"timesteps={args.timesteps} n_steps={args.n_steps} lr={args.lr} gamma={args.gamma}"
    )

    # PFSP snapshot publisher (B3): periodically repack+export the live actor so the env-servers'
    # leagues hot-load it as a self-play opponent. Off unless --snapshot-dir is given (fixed-field).
    callback = None
    if args.snapshot_dir:
        callback = SnapshotCallback(args.snapshot_dir, args.snapshot_every, teacher="ppo-snapshot")
        print(
            f"snapshot publisher: every {args.snapshot_every} steps → {args.snapshot_dir} "
            f"(consumer pool_cap={args.snapshot_pool_cap})"
        )

    model, venv = build_model(cfg, ckpt, args)
    try:
        model.learn(total_timesteps=args.timesteps, progress_bar=False, callback=callback)
    finally:
        # Always reap the env-servers (each DiceWarsEnv owns a Node child) even on error.
        venv.close()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    repacked = repack_to_bc_checkpoint(
        model.policy,
        extra={
            "teacher": "ppo-tracer",
            "ppo_timesteps": int(args.timesteps),
            "ppo_lr": float(args.lr),
            "ppo_gamma": float(args.gamma),
            "warm_started_from": str(args.checkpoint),
        },
    )
    torch.save(repacked, out_path)
    print(f"saved repacked BC-format checkpoint → {out_path}")

    _verify_repack_exportable(out_path, cfg)
    return out_path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument(
        "--checkpoint",
        default="checkpoints/v2-base/bc_model.pt",
        help="v2-BC checkpoint to warm-start from (the deployed ai_bc).",
    )
    p.add_argument(
        "--out", default="checkpoints/ppo-tracer.pt", help="Repacked BC-format output .pt"
    )
    p.add_argument("--opponents", default=DEFAULT_OPPONENTS, help="CSV of fixed baseline bot ids")
    p.add_argument("--learner-seat", type=int, default=0, help="Seat the learner occupies")
    p.add_argument(
        "--n-envs", type=int, default=1, help="Parallel DummyVecEnv envs (1-2 for a tracer)"
    )
    # Budget — kept tiny: total_timesteps / (n_steps * n_envs) = number of PPO updates.
    p.add_argument(
        "--timesteps", type=int, default=2048, help="Total env steps (a handful of updates)"
    )
    p.add_argument(
        "--n-steps", type=int, default=512, help="Rollout length per env before each update"
    )
    p.add_argument(
        "--batch-size", type=int, default=128, help="Minibatch (must divide n_steps*n_envs)"
    )
    p.add_argument("--n-epochs", type=int, default=4, help="PPO epochs per rollout")
    # Low LR by default so a short run can't wreck the warm-started actor ([D-19] decision 1).
    p.add_argument(
        "--lr", type=float, default=1e-4, help="Learning rate (low; protects the warm start)"
    )
    p.add_argument(
        "--gamma", type=float, default=0.999, help="Discount (high: sparse terminal-win signal)"
    )
    p.add_argument("--gae-lambda", type=float, default=0.95)
    p.add_argument(
        "--ent-coef", type=float, default=0.0, help="Entropy bonus (0 keeps the warm start stable)"
    )
    p.add_argument("--vf-coef", type=float, default=0.5)
    p.add_argument(
        "--freeze-trunk",
        action="store_true",
        help="Freeze the BC trunk+edge_head (train the fresh critic only; actor unchanged).",
    )
    p.add_argument("--max-turns", type=int, default=500, help="Stalemate cap (→ Gym truncation)")
    p.add_argument("--seed", type=int, default=0, help="PPO/torch seed")
    p.add_argument("--seed-base", type=int, default=1, help="Env-server episode seed base")
    p.add_argument("--device", default="cpu", help="torch device (cpu is fine — the net is tiny)")
    # PFSP snapshots (B3 / [D-22]). --snapshot-dir off ⇒ fixed-field (task A) empty-pool mode.
    p.add_argument(
        "--snapshot-dir",
        default=None,
        help="Publish snapshots (weights + manifest.json) here for the league to hot-load; "
        "unset ⇒ fixed-field (no PFSP).",
    )
    p.add_argument(
        "--snapshot-every",
        type=int,
        default=50_000,
        help="Snapshot cadence in total env steps (only used with --snapshot-dir).",
    )
    p.add_argument(
        "--snapshot-pool-cap",
        type=int,
        default=40,
        help="Max snapshots the env-server league holds live (FIFO-by-step; forwarded).",
    )
    # PFSP sampler knobs (B4 / [D-23]). Only bite with --snapshot-dir (a non-empty pool); forwarded
    # to the env-server league's draw(). w(S) = max(eps, 1 - learnerWinRate(S)) ** k.
    p.add_argument(
        "--reserve-baselines",
        type=int,
        default=3,
        help="R aggressive baselines reserved per drawn field (turtle-equilibrium defense; "
        "distinct, no-replacement). Only used with --snapshot-dir.",
    )
    p.add_argument(
        "--pfsp-epsilon",
        type=float,
        default=0.05,
        help="PFSP weight floor eps in (0, 1] for w(S)=max(eps,1-winRate)**k. Only used with "
        "--snapshot-dir.",
    )
    p.add_argument(
        "--pfsp-k",
        type=float,
        default=2.0,
        help="PFSP weight exponent k (>= 0) for w(S)=max(eps,1-winRate)**k. Only used with "
        "--snapshot-dir.",
    )
    return p


def _validate_args(args: argparse.Namespace) -> None:
    rollout = args.n_steps * args.n_envs
    if rollout % args.batch_size != 0:
        raise SystemExit(
            f"--batch-size {args.batch_size} must divide n_steps*n_envs = {rollout} "
            f"(n_steps={args.n_steps}, n_envs={args.n_envs})."
        )
    if args.n_envs < 1:
        raise SystemExit("--n-envs must be >= 1.")
    if not Path(args.checkpoint).is_file():
        raise SystemExit(f"--checkpoint not found: {args.checkpoint}")
    # PFSP knobs (B4): validate UNCONDITIONALLY — the Node-side makeLeague guards (ppo-league.mjs)
    # run on every launch regardless of the pool, so a bad value is rejected even in fixed-field
    # mode (where the knob is forwarded as a no-op) rather than silently swallowed. math.isfinite
    # mirrors Node's Number.isFinite so inf/nan fail here, not later at server spawn.
    if args.reserve_baselines < 0:
        raise SystemExit("--reserve-baselines must be >= 0.")
    if not 0.0 < args.pfsp_epsilon <= 1.0:
        raise SystemExit("--pfsp-epsilon must be in (0, 1].")
    if not math.isfinite(args.pfsp_k) or args.pfsp_k < 0:
        raise SystemExit("--pfsp-k must be a finite number >= 0.")
    if args.snapshot_dir is not None:
        if args.snapshot_every <= 0:
            raise SystemExit("--snapshot-every must be > 0 when --snapshot-dir is set.")
        if args.snapshot_pool_cap <= 0:
            raise SystemExit("--snapshot-pool-cap must be > 0.")
        # Absolutize so the producer (this process) and the Node consumers (cwd=repo-root)
        # resolve the same manifest path; create it now so env-servers can stat() it from ep 0.
        args.snapshot_dir = str(Path(args.snapshot_dir).resolve())
        Path(args.snapshot_dir).mkdir(parents=True, exist_ok=True)


def main() -> None:
    # Line-buffer stdout/stderr so progress AND a fatal traceback flush immediately even when
    # redirected to a file. Block buffering (the default for a non-tty) otherwise swallows the
    # final traceback on a crash — which masked a fatal env desync as a silent "process gone" for
    # several runs before this was added.
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    args = build_parser().parse_args()
    _validate_args(args)
    train(args)


if __name__ == "__main__":
    main()
