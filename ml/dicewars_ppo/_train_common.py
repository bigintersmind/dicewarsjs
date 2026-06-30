"""Torch-free shared core for the PPO training drivers (``train_tracer`` + ``train``).

This module holds the pieces that BOTH the tiny tracer (``train_tracer.py``) and the
real training driver (``train.py``) share: the fixed baseline field, the per-env
factory (``_make_env_thunk``), the common argparse surface (``build_parser``), the
argument validation (``_validate_args``), and the ``--from-scratch`` resolution
helper (``resolve_from_scratch``). One source of truth keeps the green CI tracer
byte-identical to before the extraction ([D-26] Q1).

**Why torch-free is load-bearing.** ``train.py`` runs envs under
``SubprocVecEnv(start_method="forkserver")``: each worker process imports the module
that owns the pickled env-thunk (this one). If anything here pulled in ``torch`` /
``sb3_contrib`` at import time, unpickling the env-thunk in a worker would import the
learner stack right there — the [D-26] Q4 invariant the tests pin. (The worker process is
not otherwise torch-free: ``torch`` already rides in via the re-imported/preloaded
``__main__``; the point is that the thunk itself adds nothing and the env path stays clean.)
So this module imports ONLY argparse / math / pathlib /
``.env`` (which is itself torch-free), and the ``cfg: ModelConfig`` annotation is kept
lazy via ``from __future__ import annotations`` + a ``TYPE_CHECKING`` import — the
string annotation is never evaluated at runtime, so ``dicewars_bc.model`` (torch-ful)
is never imported here.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import TYPE_CHECKING

from .env import DiceWarsEnv

if TYPE_CHECKING:  # annotation-only; never imported at runtime (keeps this module torch-free)
    from dicewars_bc.model import ModelConfig

# Fixed, seed-pure, heterogeneous baseline field ([D-15]: strong bots in every game
# keep it decisive; no Math.random bots so episodes stay reproducible). The Node league's
# resolveBaselineField (scripts/lib/ppo-league.mjs) cycles this list to fill the
# (player_count - 1) opponent seats.
DEFAULT_OPPONENTS = "ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive"

# Distinct process exit code for an UNRECOVERABLE resume state ([D-26]/PR-6): a present-but-rejected
# latest.json (corrupt-json / version|encoding skew / dangling-ref) or a corrupt .zip whose retained
# fallbacks are also unreadable. `train.py` raises `SystemExit(EXIT_POINTER_REJECTED)` on this; the
# shodan launcher (scripts/shodan/ppo-train.sh) treats it as HALT+alert (never retry — the bytes
# will not heal), distinct from any OTHER non-zero exit (a transient crash it bounds-retries). Lives
# here in the torch-free core so a lean-CI canary pins the value AND the launcher's hard-coded copy
# has a single source of truth to track. Chosen distinct from 0 (ok) / 1 (generic raise or
# SystemExit-string) / 2 (argparse misuse). If you change it, update ppo-train.sh's copy too.
EXIT_POINTER_REJECTED = 3


def _make_env_thunk(cfg: ModelConfig, args: argparse.Namespace, env_index: int):
    """A zero-arg env factory for ``DummyVecEnv``/``SubprocVecEnv`` — each launches an env-server.

    The env's ``player_count`` MUST equal the BC config's (the players-tensor height the
    obs frame carries; ``_check_dims`` rejects a mismatch), so it's taken from ``cfg``,
    not a free flag. Each env gets a disjoint ``seed_base`` block so parallel envs don't
    replay identical episodes — and, because each Node worker keys its persistence files
    on ``seedBase`` (``league-state-<seedBase>.json``), the same offset also keeps those
    per-worker files distinct under ``SubprocVecEnv``.
    """

    # Hoist the two scalars the thunk needs OUT of cfg before building the closure. This is the
    # load-bearing detail behind the torch-free invariant: a SubprocVecEnv(forkserver/spawn) worker
    # cloudpickles this closure and unpickles it in the child. If the closure captured `cfg` (a
    # torch-ful ``dicewars_bc.model.ModelConfig`` dataclass), the child would import that module —
    # and torch with it — on unpickle, defeating the whole point of [D-26] Q4. Capturing only ints
    # (+ the stdlib Namespace + str/None below) keeps the worker's env_fn genuinely torch-free.
    max_areas = cfg.max_areas
    player_count = cfg.player_count

    # All vec-env servers poll the SAME producer manifest, so they share one snapshot pool ([D-22]).
    # `snapshot_dir` is resolved absolute in _validate_args so producer (this process) and consumers
    # (the Node servers, cwd=repo-root) agree on the path regardless of cwd.
    snapshot_manifest = (
        str(Path(args.snapshot_dir) / "manifest.json") if args.snapshot_dir else None
    )

    # Reward shaping (persona roster, [D-bite]). train.py-only flags read via getattr so the tracer
    # (whose parser lacks them) stays byte-identical: an absent flag yields the [D-19] sparse-win
    # defaults. All three are primitives (str/float/int|None) so the torch-free thunk stays
    # primitive-only, and they are env-construction kwargs (reward is computed Python-side in
    # env.step()), so NOTHING reaches the Node server_kwargs and the wire is untouched.
    reward_mode = getattr(args, "reward_mode", "win")
    terminal_speed_bonus = getattr(args, "terminal_speed_bonus", 0.0)
    speed_ref = getattr(args, "speed_ref", None)

    def _thunk() -> DiceWarsEnv:
        return DiceWarsEnv(
            max_areas=max_areas,
            player_count=player_count,
            reward_mode=reward_mode,
            terminal_speed_bonus=terminal_speed_bonus,
            speed_ref=speed_ref,
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
                # League persistence (B6 / task E). Read off `args` (already captured) — no new
                # closure free-var, so the torch-free thunk stays primitive-only. The SAME
                # league_state_dir goes to every env_index: per-worker uniqueness is the Node-side
                # `league-state-<seedBase>.json` filename (the seed_base offset above).
                "snapshot_store": args.snapshot_store,
                "league_state_dir": args.league_state_dir,
                "league_dump_every": args.league_dump_every,
            },
        )

    return _thunk


def build_parser(description: str | None = None) -> argparse.ArgumentParser:
    """The argparse surface shared by both drivers.

    ``description`` is threaded so each caller's ``--help`` shows ITS module docstring
    (the tracer passes its ``__doc__``, ``train.py`` passes its own) — the parser body
    is identical otherwise. ``train.py`` extends the returned parser with its own flags
    (``--from-scratch`` / ``--log-dir`` / …) and overrides a few defaults via
    ``set_defaults``; the tracer uses it as-is, so its argv behavior is byte-identical to
    before the extraction.
    """
    p = argparse.ArgumentParser(
        description=description, formatter_class=argparse.RawDescriptionHelpFormatter
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
        help="R baselines reserved per drawn field (turtle-equilibrium defense; distinct non-ai_bc "
        "ids, no-replacement). Only used with --snapshot-dir.",
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
    # League persistence (B6 / task E, [D-26]). The Node env-server's resume half: each worker
    # checkpoints its PFSP pool + win-rate book. All default None so an unset value yields argv
    # byte-identical to B5 (EnvServerProcess.__init__ None-gates each league-persistence flag) — the
    # tracer's golden surface is unchanged. Forwarded to the env-server via _make_env_thunk's
    # server_kwargs.
    p.add_argument(
        "--snapshot-store",
        choices=("memory", "disk"),
        default=None,
        help="League win-rate backend: 'disk' = cross-worker store, 'memory' = per-worker "
        "(the env-server default). Needs a shared dir (--league-state-dir or --snapshot-dir) when "
        "'disk'. Unset ⇒ not forwarded (env-server default).",
    )
    p.add_argument(
        "--league-state-dir",
        default=None,
        help="Directory each Node worker dumps its league pool+book into "
        "(league-state-<seedBase>.json) — enables the league-side resume half ([D-26] Q3). Unset ⇒ "
        "league persistence off.",
    )
    p.add_argument(
        "--league-dump-every",
        type=int,
        default=None,
        help="Node worker league-state dump cadence in BOOKED episodes (only used with league "
        "persistence). Unset ⇒ the env-server default (50).",
    )
    return p


def _validate_args(args: argparse.Namespace) -> None:
    if args.batch_size <= 0:
        # Guard BEFORE the modulo below: batch_size==0 would raise a raw ZeroDivisionError, and
        # batch_size<0 would slip past the divisibility check (Python's modulo follows the divisor
        # sign, e.g. 512 % -4 == 0) — so bound it here as a clean SystemExit.
        raise SystemExit(f"--batch-size must be > 0 (got {args.batch_size}).")
    rollout = args.n_steps * args.n_envs
    if rollout % args.batch_size != 0:
        raise SystemExit(
            f"--batch-size {args.batch_size} must divide n_steps*n_envs = {rollout} "
            f"(n_steps={args.n_steps}, n_envs={args.n_envs})."
        )
    if args.n_envs < 1:
        raise SystemExit("--n-envs must be >= 1.")
    # An EXPLICIT bad learning rate / entropy coef is the costliest misconfig (lr==0 ⇒ a no-op run;
    # lr<0 ⇒ gradient ASCENT; ent<0 ⇒ malformed objective) yet the only one otherwise unguarded — so
    # bound it here with the rest. `is not None` keeps this order-independent w.r.t. train.py's None
    # sentinel: an omitted lr/ent is filled to a valid constant by resolve_from_scratch AFTER this
    # runs, while the tracer's numeric defaults pass through untouched.
    if args.lr is not None and args.lr <= 0:
        raise SystemExit(f"--lr must be > 0 (got {args.lr}).")
    if args.ent_coef is not None and args.ent_coef < 0:
        raise SystemExit(f"--ent-coef must be >= 0 (got {args.ent_coef}).")
    if not Path(args.checkpoint).is_file():
        raise SystemExit(f"--checkpoint not found: {args.checkpoint}")
    # PFSP knobs (B4): validate UNCONDITIONALLY. In fixed-field mode (no --snapshot-dir) these
    # knobs are NOT forwarded to the env-server — env_server.py only appends them on the snapshot
    # branch — so Node never sees or validates the Python-supplied value. That makes THIS check the
    # sole guard there; without it a bad value would be silently dropped (Node falls back to its own
    # defaults). The bounds mirror the Node makeLeague guards so the two layers stay consistent when
    # the knobs ARE forwarded; math.isfinite mirrors Number.isFinite so inf/nan fail here.
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
    # League persistence (B6 / task E, [D-26]). Front-run the Node guards (resolveLeaguePersistence
    # + the dump-every guard, scripts/ppo-env-server.mjs) so a misconfig fails HERE at launch with a
    # clear message instead of as an opaque "exited before listening" env-server startup failure
    # after the worker spawns (Node throws BEFORE it prints PPO_ENV_SERVER LISTENING).
    if args.league_dump_every is not None and args.league_dump_every < 1:
        # Node validates this unconditionally (Number.isInteger || <1 throws); we just fail faster.
        raise SystemExit(
            f"--league-dump-every must be a positive integer (got {args.league_dump_every})."
        )
    if args.snapshot_store == "disk" and not (args.league_state_dir or args.snapshot_dir):
        # Node derives the disk dir from --league-state-dir, else the snapshot manifest's dir; with
        # neither, resolveLeaguePersistence throws at spawn (before LISTENING, so it surfaces as an
        # "exited before listening" startup failure). Like the dump-every guard above, Node ALSO
        # enforces this — we front-run both only to fail at launch with a clearer message.
        raise SystemExit(
            "--snapshot-store=disk needs a shared directory: pass --league-state-dir=<dir> "
            "or --snapshot-dir=<dir>."
        )
    if args.league_state_dir is not None:
        # Absolutize + create so this process and the Node consumers (cwd=repo-root) agree on the
        # path, mirroring the snapshot_dir handling above.
        args.league_state_dir = str(Path(args.league_state_dir).resolve())
        Path(args.league_state_dir).mkdir(parents=True, exist_ok=True)


def resolve_from_scratch(args: argparse.Namespace) -> None:
    """Resolve ``--from-scratch`` interactions for ``train.py`` (a no-op for the tracer).

    Two things happen here, both torch-free so the lean CI tier can test them:

    1. **Mutual exclusivity.** ``--from-scratch`` (skip the BC warm-start) and
       ``--freeze-trunk`` (train the critic only, actor frozen at the warm start) are
       contradictory — there is no warm start to freeze — so the pair is rejected.

    2. **Per-mode LR / entropy relaxation ([D-26] Q6).** ``train.py`` sets ``--lr`` and
       ``--ent-coef`` defaults to ``None`` (a sentinel) so an OMITTED flag relaxes per
       mode while an EXPLICIT ``--lr`` / ``--ent-coef`` always sticks — argparse can't
       distinguish an explicit value that happens to equal the default from an omission,
       hence the sentinel. A from-scratch net has no BC prior to protect, so it gets a
       higher LR and a non-zero entropy bonus to explore; a warm start keeps the
       protective low defaults. These are intentionally conservative smoke/control values;
       a production learning run passes explicit HPs (the committed launcher / runbook in
       PR-6 owns the per-run values — e.g. task A's BEAT config used ``--lr 2.5e-4
       --ent-coef 0.01``).

    The tracer never carries ``from_scratch`` and never calls this, so its numeric
    ``--lr``/``--ent-coef`` defaults stand untouched (byte-identical).
    """
    from_scratch = getattr(args, "from_scratch", False)
    if from_scratch and getattr(args, "freeze_trunk", False):
        raise SystemExit(
            "--from-scratch and --freeze-trunk are mutually exclusive: there is no warm-started "
            "trunk to freeze when training from scratch."
        )
    if getattr(args, "lr", None) is None:
        args.lr = 1e-3 if from_scratch else 1e-4
    if getattr(args, "ent_coef", None) is None:
        args.ent_coef = 0.01 if from_scratch else 0.0


def validate_reward_args(args: argparse.Namespace) -> None:
    """Validate the persona reward-shaping flags ([D-bite]) at launch (torch-free → lean-testable).

    train.py-only flags, read via ``getattr`` so this is a safe no-op for any caller (the tracer)
    that lacks them. Front-runs the env's own ``ValueError`` (raised when ``DiceWarsEnv`` is built
    inside a ``SubprocVecEnv`` worker) so a misconfig fails HERE with a clear ``SystemExit`` at
    launch — before any worker/Node server spawns — mirroring how ``_validate_args`` front-runs the
    Node league guards. ``--reward-mode`` itself is constrained by argparse ``choices``.
    """
    speed_bonus = getattr(args, "terminal_speed_bonus", 0.0)
    speed_ref = getattr(args, "speed_ref", None)
    if speed_bonus < 0:
        raise SystemExit(f"--terminal-speed-bonus must be >= 0 (got {speed_bonus}).")
    if speed_bonus > 0 and not (speed_ref is not None and speed_ref > 0):
        raise SystemExit(
            "--speed-ref must be a positive integer when --terminal-speed-bonus > 0 "
            f"(got {speed_ref})."
        )


def _remaining_timesteps(total: int, num_timesteps: int) -> int:
    """Env steps left in an absolute ``--timesteps`` budget after a resume ([D-26] HOLE-D).

    On resume ``train.py`` calls ``model.learn(total_timesteps=_remaining_timesteps(args.timesteps,
    model.num_timesteps), reset_num_timesteps=False)``. Under ``reset_num_timesteps=False`` SB3's
    ``_setup_learn`` adds ``num_timesteps`` back internally, so the run stops at the ABSOLUTE
    ``--timesteps`` rather than an extra ``num_timesteps`` per relaunch — without this cap a
    crash-loop makes ``--timesteps`` additive and trains unbounded. Clamped at 0 so an already-met
    budget is a clean no-op (``learn`` is skipped), never a negative SB3 would reject.

    Torch-free (pure arithmetic) so the lean CI tier proves the cap without importing the learner.
    """
    return max(int(total) - int(num_timesteps), 0)
