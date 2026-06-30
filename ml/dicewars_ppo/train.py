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
``MaskablePPO`` is constructed (which inits CUDA) — in that order, so CUDA is never live
at fork time and no worker can inherit a half-initialized CUDA context. ``forkserver`` is
the default (``spawn`` the portable fallback) because the training parent is multithreaded
once ``torch`` is imported, and forking *that* process (plain ``fork``) is the classic
fork-after-threads hazard — forkserver/spawn instead start each worker from a separate,
quiescent process. What the extraction actually guarantees is narrower but load-bearing:
the env-thunk lives in the torch-free ``_train_common`` and captures only primitives, so a
worker UNPICKLES it without importing ``torch`` — the [D-26] Q4 invariant the tests pin.
(The worker *process* is not torch-free regardless of start method: ``torch`` rides in via
the re-imported/preloaded ``__main__`` = this module; the workers just never touch it —
each only drives a Node env-server over a socket.) ``VecMonitor`` wraps in the PARENT so
episode stats still surface.

``--from-scratch`` ([D-26] Q6, [D-19] control). Skip the BC warm-start and train the
actor from a fresh init — a short control run that proves a gate win is real PPO learning,
not fixed-field BC exploitation. It still loads ``--checkpoint`` for the architecture
(``ModelConfig``), is mutually exclusive with ``--freeze-trunk``, and relaxes the
``--lr``/``--ent-coef`` defaults (see ``_train_common.resolve_from_scratch``).

Idempotent checkpoint/resume (PR-5, [D-26] Q3). Pass ``--state-dir`` to make a run resumable:
``ResumeCheckpointCallback`` checkpoints policy + optimizer + ``num_timesteps`` + process RNG every
``--checkpoint-every`` steps (atomic ``latest.json`` written LAST, the crash hinge — see
``resume.py``). A relaunch of the SAME command auto-resumes from a valid ``latest.json``; a
present-but-REJECTED pointer (corrupt/version/encoding skew) HALTS with ``EXIT_POINTER_REJECTED``
(PR-6) so the auto-restart launcher alerts instead of silently restarting from step 0, and a corrupt
newest ``.zip`` falls back to the retained prior pair. Resume goes through ``MaskablePPO.load`` and
``learn(reset_num_timesteps=False, total_timesteps=_remaining_timesteps(...))`` so the absolute
``--timesteps`` budget is honored across crashes (HOLE-D), not made additive. The Node league's own
resume half (``--league-state-dir`` etc.) is independent ([D-26] Q3) and forwarded via
``_train_common``. CSV is per-session (``progress-<resumed_step>.csv``) so a resume never truncates
a prior session; TensorBoard stays one continuous run (merged by ``num_timesteps``). The committed
shodan launcher + schtasks runbook is PR-6.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import torch
from stable_baselines3.common.callbacks import CallbackList
from stable_baselines3.common.logger import (
    CSVOutputFormat,
    HumanOutputFormat,
    Logger,
    TensorBoardOutputFormat,
)
from stable_baselines3.common.vec_env import SubprocVecEnv, VecMonitor

from . import _train_common
from .policy import load_bc_checkpoint, repack_to_bc_checkpoint
from .resume import (
    RESUME_ACTION_HALT,
    RESUME_ACTION_RESUME,
    ResumeCheckpointCallback,
    ResumeCheckpointError,
    classify_latest_pointer,
    describe_pointer_rejection,
    load_resume_checkpoint,
    resume_action,
)
from .snapshot_callback import SnapshotCallback
from .train_tracer import _verify_repack_exportable, build_model

# Re-export the UNRECOVERABLE-resume exit code so `tr.EXIT_POINTER_REJECTED` resolves; the single
# source of truth (and the lean-CI canary that pins its value for the launcher) lives in the
# torch-free _train_common.
EXIT_POINTER_REJECTED = _train_common.EXIT_POINTER_REJECTED


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
    # Idempotent resume (PR-5, [D-26] Q3). --state-dir holds the SB3 zip + RNG sidecar + latest.json
    # (the crash hinge). Set it to make the run resumable: a relaunch of the SAME command resumes
    # from a valid latest.json (a present-but-rejected one HALTs with EXIT_POINTER_REJECTED per the
    # PR-6 safety guard; an ABSENT pointer starts fresh). This is the PYTHON resume half; it is
    # INDEPENDENT of the Node league's --league-state-dir (the other half).
    p.add_argument(
        "--state-dir",
        default=None,
        help="Directory for the Python resume checkpoint (SB3 zip + RNG sidecar + latest.json). "
        "Unset ⇒ no checkpointing/resume. Independent of --league-state-dir ([D-26] Q3).",
    )
    p.add_argument(
        "--checkpoint-every",
        type=int,
        default=50_000,
        help="Resume-checkpoint cadence in total env steps (only with --state-dir). Defaults to "
        "50000 (the same default as --snapshot-every, but NOT dynamically coupled to it — set this "
        "explicitly if you change --snapshot-every and want checkpoints to follow).",
    )
    # Reward shaping for the persona roster (bite D, docs/ml-bot/PERSONAS.md). All wire-free and
    # default to the [D-19] sparse terminal-win, so an omitted flag is byte-identical to today.
    p.add_argument(
        "--reward-mode",
        choices=("win", "placement"),
        default="win",
        help="Terminal reward objective: 'win' = sparse terminal-win ([D-19] default, Conqueror); "
        "'placement' = scaled finishing rank in [0,1] (Survivor). Reads wire fields already "
        "present — no ENCODING_VERSION bump.",
    )
    p.add_argument(
        "--terminal-speed-bonus",
        type=float,
        default=0.0,
        help="Blitz's optional secondary lever: scale a WIN by how fast it came — "
        "reward *= 1 + b*clip(1 - turns/speed_ref, 0, 1). Default 0 = off (byte-identical). "
        "Multiplicative + win-gated (a per-step time penalty would let the bot throw games). Lower "
        "--gamma FIRST; add this only if that isn't punchy enough.",
    )
    p.add_argument(
        "--speed-ref",
        type=int,
        default=None,
        help="Turn-count reference T_ref (player-turns) for --terminal-speed-bonus; REQUIRED when "
        "that is > 0. A win at turns >= T_ref earns no speed bonus; calibrate from the Conqueror "
        "control's mean turns-to-win.",
    )
    # Dense per-step shaping (bite G — Expansionist/Predator). Both default 0 ⇒ no shaping ⇒ base
    # (unshaped) wire, byte-identical to today. A non-zero coef flips the env to parse shaped frames
    # AND launches the env-server with --reward-shaping. Unlike --reward-mode/--terminal-speed-bonus
    # (which read fields already on the wire), these add a wire-frame variant — but NOT an
    # ENCODING_VERSION bump (the observation tensor is unchanged; see PERSONAS.md §2/§8).
    p.add_argument(
        "--territory-reward-coef",
        type=float,
        default=0.0,
        help="Expansionist (bite G): dense reward = coef × NET learner-territory change per step. "
        "> 0 ⇒ shaped frames (env-server --reward-shaping). Default 0 = off (unshaped wire).",
    )
    p.add_argument(
        "--elim-bounty",
        type=float,
        default=0.0,
        help="Predator (bite G): dense reward += bounty × players the learner eliminated per step "
        "(incl. the game-ending kill). > 0 ⇒ shaped frames. Keep small vs the terminal win "
        "(PERSONAS §6) so the bot won't take losing fights for a kill. Default 0 = off.",
    )
    p.add_argument(
        "--shaping-clip",
        type=float,
        default=None,
        help="Optional per-step cap on the dense shaping magnitude → [-clip, +clip] (PERSONAS §6 "
        "'cap per-turn'); bounds the variance of a big swing (e.g. the territory wipe at the "
        "learner's elimination). Unset = unbounded.",
    )
    return p


def _validate(args: argparse.Namespace) -> None:
    _train_common._validate_args(args)
    _train_common.resolve_from_scratch(args)
    # train.py OWNS the reward-shaping flags, so they must be present on this path. Both
    # _make_env_thunk and validate_reward_args read them via getattr (to tolerate the flag-less
    # tracer/test Namespaces), which means a rename that decoupled a flag from its getattr key would
    # SILENTLY fall back to the sparse-win default and train the wrong objective for a multi-hour
    # persona run. Fail loud here instead — a missing attr on THIS path is a wiring bug, not a
    # tolerated absence.
    for _attr in (
        "reward_mode",
        "terminal_speed_bonus",
        "speed_ref",
        "territory_reward_coef",
        "elim_bounty",
        "shaping_clip",
    ):
        if not hasattr(args, _attr):
            raise SystemExit(f"internal: train.py arg '{_attr}' missing — flag/getattr key drift?")
    _train_common.validate_reward_args(args)
    if args.checkpoint_every <= 0:
        raise SystemExit(f"--checkpoint-every must be > 0 (got {args.checkpoint_every}).")
    if args.freeze_trunk and args.state_dir is not None:
        # Reject EAGERLY (not only at resume time): MaskablePPO.load does not restore the build-time
        # requires_grad freeze, so a resumed --freeze-trunk run would train the trunk it should
        # freeze. If we let the run START, every checkpoint it writes is un-resumable and the user
        # only finds out after the first crash. So fail at launch. (train() keeps a backstop guard.)
        raise SystemExit(
            "--freeze-trunk + --state-dir (resume) is unsupported: load does not restore the "
            "build-time trunk freeze, so the run could never resume. Drop one of the two flags."
        )
    if args.state_dir is not None:
        # Absolutize so resume detection (parent) and the callback agree on the path regardless of
        # cwd. Do NOT mkdir here — save_resume_checkpoint creates it, and a missing dir reads as
        # "no resume point" (fresh), which is correct.
        args.state_dir = str(Path(args.state_dir).resolve())


def _tensorboard_available() -> bool:
    """Is the ``tensorboard`` package importable? (SB3's TB sink hard-imports it — see below.)"""
    return importlib.util.find_spec("tensorboard") is not None


def _make_logger(args: argparse.Namespace, resumed_step: int = 0):
    """Build the SB3 logger for ``--log-dir`` with a PER-SESSION CSV; returns ``(logger, sinks)``.

    Returns ``(Logger, [sink names])`` — the caller passes the logger to ``model.set_logger`` BEFORE
    ``learn`` and reports the ACTUAL ``sinks`` (so the status line can't claim a sink the
    degradation path dropped) — or ``(None, [])`` when ``--log-dir`` is unset (SB3 keeps stdout).
    ``VecMonitor`` (not this logger) is what populates the ``rollout/ep_rew_mean`` / ``ep_len_mean``
    keys these sinks then record.

    Cross-session continuation (PR-5, [D-26]). SB3's ``CSVOutputFormat`` opens its target file with
    mode ``"w+t"`` (TRUNCATING it) — under ``configure()`` it is ``progress.csv``, so a resume
    into the same ``--log-dir`` would erase the prior session's rows. So we build the output formats
    EXPLICITLY (instead of ``configure()``) and point the CSV at a per-session
    ``progress-<resumed_step>.csv`` — so a session that REACHED A LATER
    CHECKPOINT (and thus resumes at a higher step) never truncates an earlier one (concatenate
    offline). The one residual collision is a crash-loop *within* a single ``--checkpoint-every``
    window: it resumes from the SAME step and re-truncates that step's CSV — bounded, observability-
    only loss (TB still merges by ``num_timesteps``). The single ``TensorBoardOutputFormat`` over
    ``--log-dir`` keeps ONE continuous TB run because, under ``learn(reset_num_timesteps=False)``,
    events merge by ``num_timesteps``.

    ``TensorBoardOutputFormat.__init__`` HARD-imports ``tensorboard`` and RAISES if absent (it does
    NOT silently no-op); ``tensorboard`` is in the ``[rl]`` extra, so the normal path has it, but
    rather than crash a long run on a partial env we degrade to CSV-only with a loud stderr warning
    when it is missing (``--no-tensorboard`` opts out of the TB sink entirely).
    """
    if args.log_dir is None:
        return None, []
    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    sinks = ["stdout", "csv"]
    csv_path = log_dir / f"progress-{int(resumed_step):09d}.csv"
    output_formats = [HumanOutputFormat(sys.stdout), CSVOutputFormat(str(csv_path))]
    if not args.no_tensorboard:
        if _tensorboard_available():
            output_formats.append(TensorBoardOutputFormat(str(log_dir)))
            sinks.append("tensorboard")
        else:
            print(
                "WARNING: --log-dir set but the `tensorboard` package is not installed; writing "
                "CSV only. Install the [rl] extra for TensorBoard, or pass --no-tensorboard.",
                file=sys.stderr,
            )
    return Logger(folder=str(log_dir), output_formats=output_formats), sinks


def train(args: argparse.Namespace) -> Path:
    cfg, ckpt = load_bc_checkpoint(args.checkpoint)
    print(
        f"loaded BC checkpoint {args.checkpoint}: encoding_version==2, "
        f"max_areas={cfg.max_areas} player_count={cfg.player_count} "
        f"context_hidden={cfg.context_hidden}"
    )
    # Resume detection ([D-26] Q3, auto-detect). classify_latest_pointer (torch-free, CI-tested)
    # says WHY the pointer is (un)usable: VALID ⇒ continue the run; ABSENT ⇒ a fresh run; any other
    # reason ⇒ a present-but-REJECTED pointer.
    #
    # PR-6 safety guard. A rejected-but-present pointer used to warn and start fresh — but under the
    # unattended schtasks auto-restart that "fresh" run silently re-trains the WHOLE --timesteps
    # budget from step 0 (days of GPU), and worse, may overwrite the still-recoverable on-disk ckpt
    # pairs the breadcrumb points at. So we now HALT with a cause-specific, non-destructive recovery
    # message and EXIT_POINTER_REJECTED, which the launcher treats as alert-and-stop (NOT retry).
    # ABSENT stays a clean fresh run (a brand-new --state-dir has no pointer); to deliberately
    # restart a campaign, point --state-dir at a fresh/empty dir rather than leave a rejected one.
    resuming = False
    if args.state_dir:
        reason = classify_latest_pointer(args.state_dir)
        action = resume_action(reason)
        if action == RESUME_ACTION_RESUME:
            resuming = True
        elif action == RESUME_ACTION_HALT:
            print(
                f"FATAL: {args.state_dir}: {describe_pointer_rejection(reason)} "
                "Refusing to silently restart from step 0 (it would re-burn the full --timesteps "
                "budget under auto-restart). Resolve the pointer per the message above, or point "
                "--state-dir at a fresh directory to start over.",
                file=sys.stderr,
            )
            raise SystemExit(EXIT_POINTER_REJECTED)
        # else RESUME_ACTION_FRESH: ABSENT pointer ⇒ a clean fresh run (resuming stays False)
    if resuming and args.freeze_trunk:
        # MaskablePPO.load restores weights+optimizer but NOT the build-time requires_grad freeze
        # (it lives in build_model, which resume SKIPS), so a resumed --freeze-trunk run would
        # silently train the trunk it was meant to freeze. Reject rather than change the regime.
        raise SystemExit(
            "--freeze-trunk + resume is unsupported: MaskablePPO.load does not restore the "
            "build-time requires_grad freeze, so a resumed run would silently train the trunk. "
            "Re-run without --freeze-trunk, or from a fresh --state-dir."
        )

    mode = "resume" if resuming else ("from-scratch" if args.from_scratch else "warm-start")
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

    # SINGLE teardown guard from here on: once the SubprocVecEnv workers (each owning a Node
    # env-server child) start, EVERY exit path must reap them — a resume-load failure, a build_model
    # error, the rejected-pointer HALT, or a learn() crash — else the Node children leak. (PR-6
    # widened this from learn()-only: a load/build raise after the workers started used to leak.)
    try:
        if resuming:
            # PATH A ([D-26] HOLE-C/D): MaskablePPO.load restores policy + optimizer + num_timesteps
            # in one call (BEFORE learn, so SnapshotCallback rehydrates against the resumed step,
            # not 0) + the RNG sidecar. SKIP build_model entirely — load brings back the trained
            # weights, so a warm-start would clobber them. load_resume_checkpoint falls back across
            # the retained keep=N pairs on a corrupt .zip; only when ALL are unreadable does it
            # raise ResumeCheckpointError — an unrecoverable resume, so HALT-and-alert
            # (EXIT_POINTER_REJECTED) rather than let the launcher retry bytes that won't heal. The
            # SystemExit propagates through the finally below, which reaps the workers first.
            try:
                model = load_resume_checkpoint(args.state_dir, venv, args.device)
            except (ResumeCheckpointError, FileNotFoundError) as err:
                # ResumeCheckpointError: every retained pair was unreadable. FileNotFoundError:
                # classify_latest_pointer said VALID but latest.json (or a referenced file) vanished
                # before load re-read it (a single-writer TOCTOU). Either way HALT: letting a bare
                # FileNotFoundError escape as a generic exit would have the launcher RETRY, and the
                # next invocation's classify would then read ABSENT → RESUME_ACTION_FRESH → a silent
                # restart from step 0 — the exact failure this guard exists to prevent.
                print(f"FATAL: {err}", file=sys.stderr)
                raise SystemExit(EXIT_POINTER_REJECTED) from err
            print(f"resumed from {args.state_dir} at num_timesteps={model.num_timesteps}")
        else:
            # build_model constructs MaskablePPO on this venv (CUDA inits here, after the fork) and
            # either warm-starts or, with --from-scratch, leaves the fresh init.
            model, venv = build_model(cfg, ckpt, args, venv=venv)

        # Assemble the callbacks: the PFSP snapshot publisher (if any) + the resume checkpointer (if
        # --state-dir). CallbackList only when both fire; a single callback / None otherwise.
        callbacks = []
        if callback is not None:
            callbacks.append(callback)
        if args.state_dir:
            callbacks.append(ResumeCheckpointCallback(args.state_dir, args.checkpoint_every))
            print(f"resume checkpointer: every {args.checkpoint_every} steps → {args.state_dir}")
        learn_callback = (
            CallbackList(callbacks) if len(callbacks) > 1 else (callbacks[0] if callbacks else None)
        )

        # Per-session CSV keyed on the resumed step (0 for a fresh run) so a resume never truncates
        # a prior session's progress.csv ([D-26]); TensorBoard stays one continuous run.
        logger, sinks = _make_logger(args, resumed_step=int(model.num_timesteps))
        if logger is not None:
            model.set_logger(logger)  # must precede learn()
            # Report the ACTUAL sinks (the TB-missing degradation path drops "tensorboard"), so this
            # line can never disagree with the warning _make_logger may have just printed.
            print(f"logging: {' + '.join(sinks)} → {args.log_dir}")

        if resuming:
            # [D-26] HOLE-D: cap the run at the ABSOLUTE --timesteps. Under reset_num_timesteps=
            # False SB3 adds num_timesteps back internally, so passing `remaining` makes it stop at
            # --timesteps rather than training an extra num_timesteps per relaunch (an unbounded
            # crash-loop). remaining==0 ⇒ the budget is already met: skip learn(), just re-export.
            remaining = _train_common._remaining_timesteps(args.timesteps, model.num_timesteps)
            if remaining > 0:
                model.learn(
                    total_timesteps=remaining,
                    reset_num_timesteps=False,
                    progress_bar=False,
                    callback=learn_callback,
                )
            else:
                print(
                    f"resume: budget already met (num_timesteps={model.num_timesteps} >= "
                    f"--timesteps={args.timesteps}); skipping learn(), re-exporting."
                )
        else:
            # Fresh run: reset_num_timesteps defaults True ⇒ num_timesteps starts at 0 and
            # --timesteps is the absolute budget.
            model.learn(total_timesteps=args.timesteps, progress_bar=False, callback=learn_callback)
    finally:
        # Always reap the env workers (each owns a Node child) even on error/HALT. Guard the close:
        # when learn() raised because a SubprocVecEnv worker already died (the common failure here),
        # the close()'s worker-pipe ops raise EOFError/BrokenPipeError — and a raise in `finally`
        # would REPLACE the in-flight exception as the primary traceback, burying the real cause.
        # Demote any teardown error to a stderr warning so the original exception stays headline.
        try:
            venv.close()
        except Exception as close_exc:
            print(f"WARNING: venv.close() failed during teardown: {close_exc!r}", file=sys.stderr)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Provenance from `args` (the relaunch flags). On a RESUME these reflect this invocation, not
    # necessarily the original training run — MaskablePPO.load restores the model's own optimizer/HP
    # state, so a changed --lr/--gamma/--ent-coef on the relaunch is ignored but still
    # stamped here. Metadata-only (no training impact); kept simple to avoid lr-schedule-callable
    # extraction MaskablePPO would otherwise require.
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
            # Reward objective that shaped this policy (the persona axis — PERSONAS.md). Provenance
            # only; lets the behavior-eval gate / RESULTS row see which objective produced a weights
            # file without re-deriving it from the launch flags.
            "reward_mode": str(args.reward_mode),
            "terminal_speed_bonus": float(args.terminal_speed_bonus),
            "speed_ref": None if args.speed_ref is None else int(args.speed_ref),
            "territory_reward_coef": float(args.territory_reward_coef),
            "elim_bounty": float(args.elim_bounty),
            "shaping_clip": None if args.shaping_clip is None else float(args.shaping_clip),
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
