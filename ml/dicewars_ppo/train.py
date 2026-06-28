"""Real PPO training driver — the scaling counterpart to ``train_tracer`` (PLAN task C/E, [D-26]).

    python -m dicewars_ppo.train \
        --checkpoint checkpoints/v2-base/bc_model.pt \
        --timesteps 1000000 --n-envs 8 --lr 2.5e-4 --ent-coef 0.01 \
        --snapshot-dir checkpoints/league --log-dir runs/ppo-long \
        --out checkpoints/ppo.pt

What this is (and how it differs from ``train_tracer``). The tracer is the smallest
end-to-end loop — one ``DummyVecEnv``, no logging, deliberately non-learning HPs — that
proves the JS↔Py↔ONNX pipeline closes. THIS driver is for the long BEAT run: it runs
envs across cores under ``SubprocVecEnv(forkserver)`` (one Node env-server per worker
process), wraps them in ``VecMonitor`` so ``rollout/ep_rew_mean`` logs, and writes
TensorBoard event files + a flat ``progress.csv`` under ``--log-dir``. The PPO update,
warm-start, repack, and the export-gate verification are SHARED with the tracer
(``build_model`` / ``_verify_repack_exportable`` imported from ``train_tracer``) and the
CLI surface + env factory + validation are SHARED via ``_train_common`` — one source of
truth, so the green CI tracer stays byte-identical ([D-26] Q1).

Process model ([D-26] Q4). ``SubprocVecEnv`` forks the env workers, then
``MaskablePPO`` is constructed (which inits CUDA) — in that order. ``forkserver`` is the
default start method because CUDA inits AFTER the fork, so a plain ``fork`` could inherit
a half-initialized context; ``spawn`` is the portable fallback. Each worker imports only
the torch-free ``dicewars_ppo.env`` (via the pickled thunk in ``_train_common``), never
the learner stack. ``VecMonitor`` wraps in the PARENT so episode stats still surface.

``--from-scratch`` ([D-26] Q6, [D-19] control). Skip the BC warm-start and train the
actor from a fresh init — a short control run that proves a gate win is real PPO learning,
not fixed-field BC exploitation. It still loads ``--checkpoint`` for the architecture
(``ModelConfig``), is mutually exclusive with ``--freeze-trunk``, and relaxes the
``--lr``/``--ent-coef`` defaults (see ``_train_common.resolve_from_scratch``).

Scope (PR-4). Fresh runs only. Full idempotent checkpoint/resume (policy + optimizer +
RNG + ``num_timesteps`` + league pool/book, ``reset_num_timesteps=False``, CSV
continuation) is PR-5; the committed shodan launcher + schtasks runbook is PR-6. See the
``TODO(PR-5)`` at ``model.learn`` and ``_train_common.resolve_from_scratch``'s note on
production HPs.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import torch
from stable_baselines3.common.logger import configure
from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

from . import _train_common
from .policy import load_bc_checkpoint, repack_to_bc_checkpoint
from .snapshot_callback import SnapshotCallback
from .train_tracer import _verify_repack_exportable, build_model


def build_parser() -> argparse.ArgumentParser:
    """The training CLI — the shared ``_train_common`` surface plus this driver's own flags.

    Overrides two defaults vs the tracer: ``--out`` (a distinct file so a bare run can't clobber
    a tracer checkpoint) and the ``--lr``/``--ent-coef`` sentinel (``None``) that lets
    ``resolve_from_scratch`` relax them per mode while an explicit value always sticks. The
    tracer never touches ``set_defaults``/these flags, so its parser is byte-identical.
    """
    p = _train_common.build_parser(__doc__)
    p.set_defaults(out="checkpoints/ppo.pt", lr=None, ent_coef=None)
    p.add_argument(
        "--from-scratch",
        action="store_true",
        help="Skip the BC warm-start: train the actor from a fresh init (the [D-19] control). "
        "Still loads --checkpoint for the architecture; mutually exclusive with --freeze-trunk; "
        "relaxes --lr/--ent-coef when those are not given explicitly.",
    )
    p.add_argument(
        "--log-dir",
        default=None,
        help="Directory for the flat progress.csv + TensorBoard event files. Unset ⇒ stdout only.",
    )
    p.add_argument(
        "--no-tensorboard",
        action="store_true",
        help="With --log-dir set, write only the CSV sink (skip TensorBoard event files).",
    )
    p.add_argument(
        "--start-method",
        default="forkserver",
        choices=("forkserver", "spawn", "fork"),
        help="SubprocVecEnv worker start method (CUDA inits at MaskablePPO construction, AFTER the "
        "envs fork — [D-26] Q4). forkserver is the safe default; spawn is the portable fallback.",
    )
    return p


def _validate(args: argparse.Namespace) -> None:
    _train_common._validate_args(args)
    _train_common.resolve_from_scratch(args)


def _tensorboard_available() -> bool:
    """Is the ``tensorboard`` package importable? (SB3's TB sink hard-imports it — see below.)"""
    return importlib.util.find_spec("tensorboard") is not None


def _make_logger(args: argparse.Namespace):
    """Configure the SB3 logger sinks for ``--log-dir`` (or ``None`` to keep SB3's stdout default).

    Returns a configured ``Logger`` (caller passes it to ``model.set_logger`` BEFORE ``learn``) or
    ``None`` when ``--log-dir`` is unset. ``VecMonitor`` (not this logger) is what populates the
    ``rollout/ep_rew_mean`` / ``ep_len_mean`` keys these sinks then record.

    SB3's ``TensorBoardOutputFormat`` HARD-imports the ``tensorboard`` package and RAISES if it
    is absent (it does NOT silently no-op). ``tensorboard`` is in the ``[rl]`` extra, so the normal
    path has it; but rather than crash a long run on a partial env, degrade to CSV-only with a loud
    warning when it is missing (``--no-tensorboard`` opts out of the TB sink entirely).
    """
    if args.log_dir is None:
        return None
    sinks = ["stdout", "csv"]
    if not args.no_tensorboard:
        if _tensorboard_available():
            sinks.append("tensorboard")
        else:
            print(
                "WARNING: --log-dir set but the `tensorboard` package is not installed; writing "
                "CSV only. Install the [rl] extra for TensorBoard, or pass --no-tensorboard."
            )
    # NOTE: SB3's CSVOutputFormat opens <log_dir>/progress.csv for writing and TRUNCATES it on each
    # run, and configure() resets the TB event stream. PR-4 is fresh-run only; cross-session
    # continuation (re-set_logger after a resume load) is PR-5's resume work, not this seam.
    return configure(str(Path(args.log_dir)), sinks)


def train(args: argparse.Namespace) -> Path:
    cfg, ckpt = load_bc_checkpoint(args.checkpoint)
    print(
        f"loaded BC checkpoint {args.checkpoint}: encoding_version==2, "
        f"max_areas={cfg.max_areas} player_count={cfg.player_count} "
        f"context_hidden={cfg.context_hidden}"
    )
    mode = "from-scratch" if args.from_scratch else "warm-start"
    print(
        f"train config: mode={mode} n_envs={args.n_envs} start_method={args.start_method} "
        f"opponents=[{args.opponents}] timesteps={args.timesteps} n_steps={args.n_steps} "
        f"lr={args.lr} ent_coef={args.ent_coef} gamma={args.gamma}"
    )

    # PFSP snapshot publisher (B3): periodically repack+export the live actor so the env-servers'
    # leagues hot-load it as a self-play opponent. Off unless --snapshot-dir is given (fixed-field).
    callback = None
    if args.snapshot_dir:
        callback = SnapshotCallback(
            args.snapshot_dir,
            args.snapshot_every,
            pool_cap=args.snapshot_pool_cap,
            teacher="ppo-snapshot",
        )
        print(
            f"snapshot publisher: every {args.snapshot_every} steps → {args.snapshot_dir} "
            f"(consumer pool_cap={args.snapshot_pool_cap})"
        )

    # SubprocVecEnv (one Node env-server per worker process) THEN VecMonitor, both in the PARENT
    # ([D-26] Q4). Each disjoint seed_base block (env_index * 1e6 inside the thunk) keeps parallel
    # envs from replaying identical episodes AND gives each Node worker a distinct
    # league-state-<seedBase>.json under persistence (PR-5/6).
    venv = SubprocVecEnv(
        [_train_common._make_env_thunk(cfg, args, i) for i in range(args.n_envs)],
        start_method=args.start_method,
    )
    venv = VecMonitor(venv)

    # build_model constructs MaskablePPO on this venv (CUDA inits here, after the fork) and either
    # warm-starts or, with --from-scratch, leaves the fresh init.
    model, venv = build_model(cfg, ckpt, args, venv=venv)

    logger = _make_logger(args)
    if logger is not None:
        model.set_logger(logger)  # must precede learn()
        sinks = "csv" if args.no_tensorboard else "csv+tensorboard"
        print(f"logging: stdout + {sinks} → {args.log_dir}")

    try:
        # PR-4 trains FRESH runs only: reset_num_timesteps defaults True ⇒ num_timesteps starts at 0
        # and --timesteps is the absolute budget. TODO(PR-5 / [D-26] HOLE-D): resume must pass
        # reset_num_timesteps=False AND cap remaining = max(timesteps - num_timesteps, 0), else a
        # crash-loop makes --timesteps additive and trains unbounded.
        model.learn(total_timesteps=args.timesteps, progress_bar=False, callback=callback)
    finally:
        # Always reap the env workers (each owns a Node child) even on error.
        venv.close()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    repacked = repack_to_bc_checkpoint(
        model.policy,
        extra={
            "teacher": "ppo",
            "ppo_timesteps": int(args.timesteps),
            "ppo_lr": float(args.lr),
            "ppo_ent_coef": float(args.ent_coef),
            "ppo_gamma": float(args.gamma),
            "from_scratch": bool(args.from_scratch),
            # None when from-scratch (no BC prior); the checkpoint path otherwise (provenance only).
            "warm_started_from": None if args.from_scratch else str(args.checkpoint),
        },
    )
    torch.save(repacked, out_path)
    print(f"saved repacked BC-format checkpoint → {out_path}")

    _verify_repack_exportable(out_path, cfg)
    return out_path


def main() -> None:
    # Line-buffer stdout/stderr so progress AND a fatal traceback flush immediately even when
    # redirected to a file (block buffering otherwise swallows the final traceback on a crash).
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    args = build_parser().parse_args()
    _validate(args)
    train(args)


if __name__ == "__main__":
    main()
