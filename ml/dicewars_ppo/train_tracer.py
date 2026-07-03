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
import sys
from pathlib import Path

import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.vec_env import DummyVecEnv

from dicewars_bc.model import EdgePolicyNet, ModelConfig

from . import _train_common
from ._train_common import _make_env_thunk, _validate_args
from .constants import ENCODING_VERSION
from .policy import (
    MaskableEdgePolicy,
    load_bc_checkpoint,
    repack_to_bc_checkpoint,
    warm_start_from_bc,
)
from .snapshot_callback import SnapshotCallback

# The fixed baseline field, the env factory, the argparse surface, and the arg validation now
# live in the torch-free `_train_common` so `train.py` can share them (a SubprocVecEnv worker
# imports the env-thunk's module and must not drag torch/sb3 in — see _train_common's docstring).
# They are re-imported above so the tracer's body (and its tests, which call `tt._make_env_thunk` /
# `tt._validate_args` / `tt.build_parser`) keeps the exact same names and behavior as before.


def build_model(
    cfg: ModelConfig,
    ckpt: dict,
    args: argparse.Namespace,
    venv: DummyVecEnv | None = None,
) -> tuple[MaskablePPO, DummyVecEnv]:
    """Construct the vec-env + ``MaskablePPO`` (warm-started unless ``--from-scratch``).

    ``venv`` lets ``train.py`` inject its ``VecMonitor(SubprocVecEnv(...))`` stack; when it is
    ``None`` (the tracer's only path) a sequential ``DummyVecEnv`` is built here exactly as
    before — byte-identical. ``--from-scratch`` (set only by ``train.py``; the tracer's args
    never carry it, so ``getattr`` is ``False`` and the warm-start branch always runs) skips the
    BC warm-start so the actor trains from a fresh init — the [D-19] control that proves a gate
    win is real learning rather than warm-start exploitation. Returns ``(model, venv)``.
    """
    if venv is None:
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

    n_total = sum(p.numel() for p in model.policy.parameters())
    n_actor = sum(p.numel() for p in model.policy.bc_net.parameters())
    if getattr(args, "from_scratch", False):
        # No BC prior loaded — the actor keeps MaskableEdgePolicy._build's fresh init.
        print(f"from-scratch: skipped BC warm-start — {n_actor:,} actor params, {n_total:,} total")
    else:
        # Load the BC trunk + edge_head into the actor (the fresh scalar critic stays at init).
        warm_start_from_bc(model.policy, ckpt)
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
    if saved.get("encoding_version") != ENCODING_VERSION:
        raise AssertionError(
            f"repacked checkpoint encoding_version={saved.get('encoding_version')!r} "
            f"!= {ENCODING_VERSION}"
        )
    reloaded = EdgePolicyNet(ModelConfig(**saved["config"]))
    reloaded.load_state_dict(saved["state_dict"], strict=True)  # strict ⇒ exact key/shape match
    if ModelConfig(**saved["config"]) != cfg:
        raise AssertionError("repacked config drifted from the warm-start config")
    print(f"repack verified: {out_path} reloads into a bare EdgePolicyNet (export-ready)")


def train(args: argparse.Namespace) -> Path:
    cfg, ckpt = load_bc_checkpoint(args.checkpoint)
    print(
        f"loaded BC checkpoint {args.checkpoint}: encoding_version=={ENCODING_VERSION}, "
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
    """The tracer CLI — the shared ``_train_common`` surface stamped with this module's docstring.

    The parser body lives in ``_train_common.build_parser`` (so ``train.py`` shares it verbatim);
    passing ``__doc__`` keeps the tracer's ``--help`` text exactly as before the extraction.
    ``_validate_args`` is re-imported from ``_train_common`` (used in ``main``).
    """
    return _train_common.build_parser(__doc__)


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
