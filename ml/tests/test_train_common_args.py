"""Torch-free unit tests for the shared PPO training core (``dicewars_ppo._train_common``).

These run in the LEAN ``ml-test`` CI tier (gymnasium only, NO torch/sb3 — mirroring
``test_env_server_argv.py``): ``_train_common`` is deliberately torch-free so a
``SubprocVecEnv(forkserver)`` worker can import its env-thunk's module without dragging the
learner stack into the worker's address space ([D-26] Q4). The torch/sb3-gated behavior of the
drivers that consume this module lives in ``test_train_tracer_args.py`` (the tracer) and
``test_train_args.py`` (``train.py``).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# _train_common imports dicewars_ppo.env → gymnasium (pure-Python; installed in lean CI). It must
# NOT import torch/sb3 (the whole point), so do NOT importorskip those.
pytest.importorskip("gymnasium")

import dicewars_ppo._train_common as tc  # noqa: E402

ML_DIR = Path(__file__).resolve().parents[1]


def _args(tmp_path, extra=None, **overrides):
    """Parse a minimal valid argv (real checkpoint file) with optional knob overrides."""
    ckpt = tmp_path / "ckpt.pt"
    ckpt.write_bytes(b"x")
    argv = ["--checkpoint", str(ckpt)]
    for key, val in overrides.items():
        argv += [f"--{key.replace('_', '-')}", str(val)]
    argv += extra or []
    return tc.build_parser().parse_args(argv)


# --- the torch-free invariant (load-bearing for SubprocVecEnv forkserver workers) -------------


def test_import_train_common_does_not_pull_torch_or_sb3():
    # Assert in a FRESH interpreter: a shared pytest session has torch loaded by the BC tests, so
    # checking THIS process's sys.modules would be meaningless. A SubprocVecEnv worker that imports
    # the pickled env-thunk's module must not load the learner stack ([D-26] Q4) — guard it here.
    code = (
        "import sys, dicewars_ppo._train_common\n"
        "leaked = [m for m in ('torch', 'sb3_contrib', 'stable_baselines3') if m in sys.modules]\n"
        "assert not leaked, f'learner stack leaked into _train_common: {leaked}'\n"
    )
    env = {**os.environ, "PYTHONPATH": str(ML_DIR)}
    r = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env, cwd=str(ML_DIR)
    )
    assert r.returncode == 0, f"torch-free import invariant failed:\n{r.stdout}\n{r.stderr}"


def test_env_thunk_closure_captures_only_primitives(tmp_path):
    # The LOAD-BEARING invariant is not just "the module imports torch-free" but "the pickled
    # env-thunk unpickles torch-free in a SubprocVecEnv worker". cloudpickle serializes the
    # closure's captured cells, so if the thunk closed over the torch-ful ModelConfig the worker
    # would import torch on unpickle. Assert structurally that every captured cell is a primitive /
    # stdlib Namespace and that `cfg` is not a free var — FAILS if the thunk recaptures cfg.* .
    # (A SimpleNamespace stand-in is fine: it is NOT in the allowlist, so a cfg-capturing thunk
    # still trips the assertion — unlike a type-module check, which false-passes on 'types'.)
    import argparse

    cfg = SimpleNamespace(max_areas=32, player_count=7)
    a = _args(tmp_path)
    thunk = tc._make_env_thunk(cfg, a, 2)

    freevars = thunk.__code__.co_freevars or ()
    assert "cfg" not in freevars, f"thunk captured `cfg`; it must capture only scalars: {freevars}"
    allowed = (int, float, str, bool, type(None), argparse.Namespace)
    for cell in thunk.__closure__ or ():
        val = cell.cell_contents
        assert isinstance(val, allowed), (
            f"thunk closure captured a non-primitive {type(val)!r}; a SubprocVecEnv worker would "
            f"import its module on unpickle (torch-leak risk)"
        )


# --- parser defaults (must equal the Node makeLeague defaults / production) --------------------


def test_parser_pfsp_defaults_match_makeleague(tmp_path):
    # These argparse defaults govern production; drift here silently retunes runs and diverges from
    # the Node makeLeague defaults (scripts/lib/ppo-league.mjs).
    a = _args(tmp_path)
    assert a.reserve_baselines == 3
    assert a.pfsp_epsilon == 0.05
    assert a.pfsp_k == 2.0


def test_parser_core_defaults(tmp_path):
    a = _args(tmp_path)
    # The tracer-protective numeric defaults; train.py overrides --lr/--ent-coef to a None sentinel.
    assert a.lr == 1e-4
    assert a.ent_coef == 0.0
    assert a.n_envs == 1
    assert a.gamma == 0.999
    assert a.opponents == tc.DEFAULT_OPPONENTS
    assert "ai_lookahead" in tc.DEFAULT_OPPONENTS


def test_build_parser_threads_description():
    # Each driver stamps its own --help description through the shared parser.
    p = tc.build_parser("MY DESCRIPTION")
    assert p.description == "MY DESCRIPTION"


# --- _validate_args bounds --------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides,needle",
    [
        ({"reserve_baselines": -1}, "reserve-baselines"),
        ({"pfsp_epsilon": 0}, "pfsp-epsilon"),
        ({"pfsp_epsilon": 1.5}, "pfsp-epsilon"),
        ({"pfsp_k": -1}, "pfsp-k"),
        ({"pfsp_k": "nan"}, "pfsp-k"),  # math.isfinite mirrors Node's Number.isFinite
        ({"pfsp_k": "inf"}, "pfsp-k"),
    ],
)
def test_validate_args_rejects_bad_pfsp_knobs(tmp_path, overrides, needle):
    a = _args(tmp_path, **overrides)
    with pytest.raises(SystemExit, match=needle):
        tc._validate_args(a)


def test_validate_args_rejects_indivisible_batch(tmp_path):
    a = _args(tmp_path, n_steps=512, n_envs=1, batch_size=100)
    with pytest.raises(SystemExit, match="must divide"):
        tc._validate_args(a)


def test_validate_args_rejects_zero_envs(tmp_path):
    a = _args(tmp_path, n_envs=0, batch_size=1)  # batch divides 0; the n_envs guard must still fire
    with pytest.raises(SystemExit, match="n-envs"):
        tc._validate_args(a)


@pytest.mark.parametrize(
    "overrides,needle",
    [
        ({"batch_size": 0}, "batch-size"),  # guarded BEFORE the modulo (no raw ZeroDivisionError)
        ({"batch_size": -4}, "batch-size"),
        ({"lr": 0}, "--lr"),  # lr<=0 ⇒ a no-op training run
        ({"lr": -0.001}, "--lr"),  # lr<0 ⇒ gradient ASCENT
        ({"ent_coef": -0.1}, "--ent-coef"),  # ent<0 ⇒ malformed objective
    ],
)
def test_validate_args_rejects_bad_hp_bounds(tmp_path, overrides, needle):
    # The costliest explicit misconfigs (silently wasted GPU runs) — each must fail loud, not slip
    # through. ent_coef==0 stays VALID (the warm-start default), so only ent<0 is rejected.
    a = _args(tmp_path, **overrides)
    with pytest.raises(SystemExit, match=needle):
        tc._validate_args(a)


def test_validate_args_accepts_zero_ent_coef(tmp_path):
    # ent_coef==0.0 is the protective warm-start default; the ent>=0 guard must NOT reject it.
    a = _args(tmp_path, ent_coef=0)
    tc._validate_args(a)  # no raise


def test_validate_args_rejects_missing_checkpoint():
    a = tc.build_parser().parse_args(["--checkpoint", "/no/such/file.pt"])
    with pytest.raises(SystemExit, match="not found"):
        tc._validate_args(a)


def test_validate_args_absolutizes_and_creates_snapshot_dir(tmp_path):
    rel = tmp_path / "league"
    a = _args(tmp_path, snapshot_dir=str(rel))
    tc._validate_args(a)
    assert Path(a.snapshot_dir).is_absolute()
    assert Path(a.snapshot_dir).is_dir()


# --- _make_env_thunk forwards server_kwargs (PATCH _train_common.DiceWarsEnv, not a driver) ----


def test_make_env_thunk_forwards_pfsp_into_server_kwargs(tmp_path, monkeypatch):
    captured = {}

    class FakeEnv:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    a = _args(tmp_path, reserve_baselines=4, pfsp_epsilon=0.2, pfsp_k=1.5)
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tc._make_env_thunk(cfg, a, 0)()  # invoke the zero-arg env factory

    sk = captured["server_kwargs"]
    assert sk["reserve_baselines"] == 4
    assert sk["pfsp_epsilon"] == 0.2
    assert sk["pfsp_k"] == 1.5
    # dims come from cfg, not free flags (the env pins the server to the BC config's shape).
    assert captured["max_areas"] == 32
    assert captured["player_count"] == 7


def test_make_env_thunk_offsets_seed_base_per_index(tmp_path, monkeypatch):
    seeds = []

    class FakeEnv:
        def __init__(self, **kwargs):
            seeds.append(kwargs["server_kwargs"]["seed_base"])

    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    a = _args(tmp_path, seed_base=5)
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tc._make_env_thunk(cfg, a, 0)()
    tc._make_env_thunk(cfg, a, 3)()
    # Disjoint per-worker blocks so parallel envs don't replay identical episodes AND each Node
    # worker keys a distinct league-state-<seedBase>.json under SubprocVecEnv.
    assert seeds == [5, 5 + 3 * 1_000_000]


def test_make_env_thunk_snapshot_manifest_set_and_unset(tmp_path, monkeypatch):
    captured = {}

    class FakeEnv:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    cfg = SimpleNamespace(max_areas=32, player_count=7)

    a = _args(tmp_path, snapshot_dir=str(tmp_path / "league"))
    tc._validate_args(a)  # absolutizes + mkdir
    tc._make_env_thunk(cfg, a, 0)()
    assert captured["server_kwargs"]["snapshot_manifest"] == str(
        Path(a.snapshot_dir) / "manifest.json"
    )

    captured.clear()
    b = _args(tmp_path)  # no --snapshot-dir ⇒ fixed-field (empty-pool) mode
    tc._make_env_thunk(cfg, b, 0)()
    assert captured["server_kwargs"]["snapshot_manifest"] is None


# --- resolve_from_scratch (mutex + per-mode LR/ent-coef relaxation, [D-26] Q6) ----------------


def test_resolve_from_scratch_mutex_with_freeze_trunk():
    args = SimpleNamespace(from_scratch=True, freeze_trunk=True, lr=None, ent_coef=None)
    with pytest.raises(SystemExit, match="mutually exclusive"):
        tc.resolve_from_scratch(args)


def test_resolve_from_scratch_relaxes_when_omitted():
    args = SimpleNamespace(from_scratch=True, freeze_trunk=False, lr=None, ent_coef=None)
    tc.resolve_from_scratch(args)
    assert args.lr == 1e-3
    assert args.ent_coef == 0.01


def test_resolve_warm_start_fills_protective_defaults_when_omitted():
    args = SimpleNamespace(from_scratch=False, freeze_trunk=False, lr=None, ent_coef=None)
    tc.resolve_from_scratch(args)
    assert args.lr == 1e-4
    assert args.ent_coef == 0.0


def test_resolve_explicit_values_stick():
    # An explicit --lr/--ent-coef must survive resolution (None is the "omitted" sentinel).
    args = SimpleNamespace(from_scratch=True, freeze_trunk=False, lr=7e-4, ent_coef=0.05)
    tc.resolve_from_scratch(args)
    assert args.lr == 7e-4
    assert args.ent_coef == 0.05


def test_resolve_no_from_scratch_attr_is_noop_warm_start():
    # The tracer's Namespace has no `from_scratch`; getattr defaults False ⇒ warm-start fill.
    args = SimpleNamespace(freeze_trunk=False, lr=None, ent_coef=None)
    tc.resolve_from_scratch(args)
    assert args.lr == 1e-4
    assert args.ent_coef == 0.0


# --- B6 league-persistence flag forwarding (PR-5 / task E, [D-26]) -----------------------------


def test_league_persistence_flags_default_none(tmp_path):
    # All three default None ⇒ the OFF path is byte-identical to B5 (EnvServerProcess None-gates
    # each in the Node argv), and the tracer's golden surface is unchanged.
    a = _args(tmp_path)
    assert a.snapshot_store is None
    assert a.league_state_dir is None
    assert a.league_dump_every is None


def test_snapshot_store_choices_reject_bogus(tmp_path):
    # argparse `choices=("memory","disk")` rejects anything else at parse time.
    with pytest.raises(SystemExit):
        _args(tmp_path, snapshot_store="bogus")


@pytest.mark.parametrize("bad", [0, -1])
def test_validate_rejects_nonpositive_league_dump_every(tmp_path, bad):
    a = _args(tmp_path, league_dump_every=bad)
    with pytest.raises(SystemExit, match="league-dump-every"):
        tc._validate_args(a)


def test_validate_rejects_disk_store_without_a_dir(tmp_path):
    # --snapshot-store=disk needs a derivable shared dir (--league-state-dir or --snapshot-dir);
    # with neither, fail HERE (Node would otherwise throw at spawn → opaque startup timeout).
    a = _args(tmp_path, snapshot_store="disk")
    with pytest.raises(SystemExit, match="shared directory"):
        tc._validate_args(a)


def test_validate_accepts_disk_store_with_league_state_dir(tmp_path):
    rel = tmp_path / "league"
    a = _args(tmp_path, snapshot_store="disk", league_state_dir=str(rel))
    tc._validate_args(a)  # no raise
    assert Path(a.league_state_dir).is_absolute()
    assert Path(a.league_state_dir).is_dir()


def test_validate_accepts_disk_store_with_snapshot_dir(tmp_path):
    # --snapshot-dir alone satisfies the disk-store dir requirement (Node derives the league dir
    # from the manifest's dir), even without an explicit --league-state-dir.
    a = _args(tmp_path, snapshot_store="disk", snapshot_dir=str(tmp_path / "snaps"))
    tc._validate_args(a)  # no raise


def test_validate_absolutizes_and_creates_league_state_dir(tmp_path):
    rel = tmp_path / "lstate"
    a = _args(tmp_path, league_state_dir=str(rel))
    tc._validate_args(a)
    assert Path(a.league_state_dir).is_absolute()
    assert Path(a.league_state_dir).is_dir()


def test_make_env_thunk_forwards_league_persistence(tmp_path, monkeypatch):
    captured = {}

    class FakeEnv:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    a = _args(
        tmp_path,
        snapshot_store="disk",
        league_state_dir=str(tmp_path / "lstate"),
        league_dump_every=20,
    )
    tc._validate_args(a)  # absolutizes league_state_dir
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tc._make_env_thunk(cfg, a, 0)()

    sk = captured["server_kwargs"]
    assert sk["snapshot_store"] == "disk"
    assert sk["league_state_dir"] == a.league_state_dir  # the absolutized value
    assert sk["league_dump_every"] == 20


def test_make_env_thunk_shares_league_state_dir_across_workers(tmp_path, monkeypatch):
    # Per-worker uniqueness is the Node-side league-state-<seedBase>.json filename, NOT a per-env
    # subdir: every env_index gets the SAME league_state_dir.
    dirs = []

    class FakeEnv:
        def __init__(self, **kwargs):
            dirs.append(kwargs["server_kwargs"]["league_state_dir"])

    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    a = _args(tmp_path, league_state_dir=str(tmp_path / "lstate"))
    tc._validate_args(a)
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tc._make_env_thunk(cfg, a, 0)()
    tc._make_env_thunk(cfg, a, 3)()
    assert dirs == [a.league_state_dir, a.league_state_dir]


def test_make_env_thunk_league_persistence_none_when_unset(tmp_path, monkeypatch):
    captured = {}

    class FakeEnv:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    a = _args(tmp_path)  # no league flags ⇒ trio None (byte-identical OFF path)
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tc._make_env_thunk(cfg, a, 0)()
    sk = captured["server_kwargs"]
    assert sk["snapshot_store"] is None
    assert sk["league_state_dir"] is None
    assert sk["league_dump_every"] is None


# --- _remaining_timesteps (HOLE-D budget cap, [D-26]) -----------------------------------------


def test_remaining_timesteps_caps_absolute_budget():
    assert tc._remaining_timesteps(1000, 0) == 1000  # fresh
    assert tc._remaining_timesteps(1000, 400) == 600  # mid-run resume
    assert tc._remaining_timesteps(1000, 1000) == 0  # budget exactly met ⇒ no-op
    assert tc._remaining_timesteps(1000, 1500) == 0  # overshoot clamps to 0, never negative


def test_exit_pointer_rejected_matches_launcher():
    """EXIT_POINTER_REJECTED is a cross-language HALT contract ([D-26]/PR-6): train.py raises it and
    the shodan launcher (scripts/shodan/ppo-train.sh) hard-codes the SAME value as its do-not-retry
    signal. Pin the Python value AND assert the bash copy agrees, so a change to one side forces
    updating the other — a silent drift would make the launcher mis-handle (retry) an unrecoverable
    HALT."""
    assert tc.EXIT_POINTER_REJECTED == 3  # the canonical value
    launcher = ML_DIR.parent / "scripts" / "shodan" / "ppo-train.sh"
    m = re.search(r"^EXIT_POINTER_REJECTED=(\d+)", launcher.read_text(), re.MULTILINE)
    assert m is not None, "ppo-train.sh must define EXIT_POINTER_REJECTED=<n>"
    assert int(m.group(1)) == tc.EXIT_POINTER_REJECTED
