"""train.py-specific surface: --from-scratch, the lr/ent sentinel, SubprocVecEnv→VecMonitor order.

Torch/SB3-gated (``train`` imports them at module scope), so this runs on shodan and skips in the
lean ``ml-test`` CI job — same pattern as test_train_tracer_args.py. The shared parser/validate
core is covered lean in test_train_common_args.py; this file covers ONLY what train.py adds on top:
the ``--from-scratch`` flag and its mutex/relaxation, the None-sentinel defaults, and that
``train()`` wraps SubprocVecEnv THEN VecMonitor in the parent ([D-26] Q4) and stamps from-scratch
provenance — all WITHOUT spawning a Node env-server or running a real rollout (the live forkserver
smoke is a shodan/PR-7 concern).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

pytest.importorskip("torch")
pytest.importorskip("sb3_contrib")

import dicewars_ppo.train as tr  # noqa: E402
from dicewars_ppo.resume_state import (  # noqa: E402
    POINTER_CORRUPT_JSON,
    POINTER_DANGLING_REF,
    POINTER_ENCODING_SKEW,
    POINTER_VALID,
    POINTER_VERSION_SKEW,
)


def _args(tmp_path, extra=None):
    ckpt = tmp_path / "ckpt.pt"
    ckpt.write_bytes(b"x")
    argv = ["--checkpoint", str(ckpt)] + (extra or [])
    return tr.build_parser().parse_args(argv)


def test_parser_adds_from_scratch_and_sentinels(tmp_path):
    a = _args(tmp_path)
    assert a.from_scratch is False
    # train.py overrides --lr/--ent-coef to a None sentinel so resolve_from_scratch can relax them.
    assert a.lr is None
    assert a.ent_coef is None
    # distinct output so a bare train.py run can't clobber a tracer checkpoint
    assert a.out == "checkpoints/ppo.pt"
    assert a.start_method == "forkserver"
    # resume off by default; cadence matches --snapshot-every (PR-5)
    assert a.state_dir is None
    assert a.checkpoint_every == 50_000


def test_parser_reward_mode_defaults_and_parse(tmp_path):
    # Reward shaping (bite D) defaults to the [D-19] sparse win (byte-identical to before).
    a = _args(tmp_path)
    assert a.reward_mode == "win"
    assert a.terminal_speed_bonus == 0.0
    assert a.speed_ref is None
    # A persona run sets the alternate objective + Blitz's optional speed bonus.
    b = _args(
        tmp_path,
        extra=["--reward-mode", "placement", "--terminal-speed-bonus", "0.5", "--speed-ref", "200"],
    )
    assert b.reward_mode == "placement"
    assert b.terminal_speed_bonus == 0.5
    assert b.speed_ref == 200


def test_parser_dense_shaping_defaults_and_parse(tmp_path):
    # Dense shaping (bite G) defaults to off (both coefs 0, clip unset) → unshaped wire.
    a = _args(tmp_path)
    assert a.territory_reward_coef == 0.0
    assert a.elim_bounty == 0.0
    assert a.shaping_clip is None
    # The Expansionist / Predator runs set their coef + an optional clip.
    b = _args(
        tmp_path,
        extra=["--territory-reward-coef", "0.02", "--elim-bounty", "0.1", "--shaping-clip", "0.5"],
    )
    assert b.territory_reward_coef == 0.02
    assert b.elim_bounty == 0.1
    assert b.shaping_clip == 0.5


def test_validate_rejects_negative_dense_coef(tmp_path):
    a = _args(tmp_path, extra=["--elim-bounty", "-0.1"])
    with pytest.raises(SystemExit, match="elim-bounty"):
        tr._validate(a)


def test_validate_rejects_speed_bonus_without_ref(tmp_path):
    a = _args(tmp_path, extra=["--terminal-speed-bonus", "0.5"])
    with pytest.raises(SystemExit, match="speed-ref"):
        tr._validate(a)


def test_validate_accepts_speed_bonus_with_ref(tmp_path):
    a = _args(tmp_path, extra=["--terminal-speed-bonus", "0.5", "--speed-ref", "200"])
    tr._validate(a)  # no raise
    assert a.terminal_speed_bonus == 0.5
    assert a.speed_ref == 200


@pytest.mark.parametrize(
    "missing",
    [
        "reward_mode",
        "terminal_speed_bonus",
        "speed_ref",
        "territory_reward_coef",
        "elim_bounty",
        "shaping_clip",
    ],
)
def test_validate_rejects_missing_reward_attr_drift_guard(tmp_path, missing):
    # train.py OWNS the reward flags, and _make_env_thunk/validate_reward_args read them via getattr
    # (to tolerate flag-less tracer/test namespaces). A future rename that decoupled a flag from its
    # getattr key would SILENTLY train sparse-win; the drift guard turns that into a launch
    # SystemExit. Simulate the drift by deleting the attr the parser produced.
    a = _args(tmp_path)
    delattr(a, missing)
    with pytest.raises(SystemExit, match=missing):
        tr._validate(a)


def test_validate_rejects_from_scratch_with_freeze_trunk(tmp_path):
    a = _args(tmp_path, extra=["--from-scratch", "--freeze-trunk"])
    with pytest.raises(SystemExit, match="mutually exclusive"):
        tr._validate(a)


def test_validate_relaxes_from_scratch_hps(tmp_path):
    a = _args(tmp_path, extra=["--from-scratch"])
    tr._validate(a)
    assert a.lr == 1e-3
    assert a.ent_coef == 0.01


def test_validate_warm_start_fills_protective_hps(tmp_path):
    a = _args(tmp_path)
    tr._validate(a)
    assert a.lr == 1e-4
    assert a.ent_coef == 0.0


def test_validate_explicit_hps_stick_under_from_scratch(tmp_path):
    a = _args(tmp_path, extra=["--from-scratch", "--lr", "7e-4", "--ent-coef", "0.05"])
    tr._validate(a)
    assert a.lr == 7e-4
    assert a.ent_coef == 0.05


@pytest.mark.parametrize("from_scratch", [True, False])
def test_train_wraps_subproc_then_vecmonitor(tmp_path, monkeypatch, from_scratch):
    """train() must build SubprocVecEnv, then VecMonitor around it, in the parent, and stamp the
    from-scratch provenance — verified with fakes so no Node child spawns and no rollout runs."""
    calls = []
    fake_cfg = SimpleNamespace(max_areas=32, player_count=7, context_hidden=64)
    monkeypatch.setattr(tr, "load_bc_checkpoint", lambda ckpt: (fake_cfg, {"k": "v"}))

    class FakeSubproc:
        def __init__(self, thunks, start_method=None):
            calls.append(("SubprocVecEnv", len(thunks), start_method))

    class FakeMonitor:
        def __init__(self, venv):
            # the wrap order assertion: VecMonitor must receive the SubprocVecEnv instance
            calls.append(("VecMonitor", isinstance(venv, FakeSubproc)))

        def close(self):
            calls.append(("close",))

    monkeypatch.setattr(tr, "SubprocVecEnv", FakeSubproc)
    monkeypatch.setattr(tr, "VecMonitor", FakeMonitor)

    captured = {}

    class FakeModel:
        def __init__(self):
            self.policy = object()
            self.num_timesteps = 0  # train() reads this for the per-session CSV name (PR-5)

        def learn(self, **kwargs):
            calls.append(
                ("learn", kwargs.get("total_timesteps"), kwargs.get("reset_num_timesteps"))
            )

        def set_logger(self, logger):
            calls.append(("set_logger",))

    def fake_build_model(cfg, ckpt, args, venv=None):
        captured["venv_is_monitor"] = isinstance(venv, FakeMonitor)
        return FakeModel(), venv

    monkeypatch.setattr(tr, "build_model", fake_build_model)

    def fake_repack(policy, *, extra=None):
        captured["extra"] = extra
        return {"state_dict": {}, "config": {}, "encoding_version": 2, **(extra or {})}

    monkeypatch.setattr(tr, "repack_to_bc_checkpoint", fake_repack)
    monkeypatch.setattr(tr.torch, "save", lambda obj, path: calls.append(("save",)))
    monkeypatch.setattr(tr, "_verify_repack_exportable", lambda out, cfg: calls.append(("verify",)))

    extra = ["--start-method", "spawn", "--out", str(tmp_path / "out.pt")] + (
        ["--from-scratch"] if from_scratch else []
    )
    a = _args(tmp_path, extra=extra)
    tr._validate(a)
    tr.train(a)

    subproc = ("SubprocVecEnv", 1, "spawn")  # default --n-envs == 1
    assert subproc in calls
    assert ("VecMonitor", True) in calls  # VecMonitor wrapped the SubprocVecEnv
    assert calls.index(subproc) < calls.index(("VecMonitor", True))  # SubprocVecEnv FIRST
    assert captured["venv_is_monitor"] is True  # build_model got the monitored venv
    assert ("close",) in calls  # env workers reaped in finally
    # Fresh run: learn() gets the ABSOLUTE --timesteps and the default reset (reset_num_timesteps
    # not passed ⇒ None here), NOT the resume path's remaining/reset_num_timesteps=False.
    assert ("learn", a.timesteps, None) in calls

    assert captured["extra"]["teacher"] == "ppo"
    assert captured["extra"]["from_scratch"] is from_scratch
    if from_scratch:
        assert captured["extra"]["warm_started_from"] is None
    else:
        assert captured["extra"]["warm_started_from"] == a.checkpoint


@pytest.mark.parametrize("from_scratch", [True, False])
def test_build_model_warm_start_gated_on_from_scratch(tmp_path, monkeypatch, from_scratch):
    """build_model must SKIP warm_start_from_bc under --from-scratch and CALL it otherwise — the
    single decision that makes the [D-19] control valid. Fakes MaskablePPO so no real net/rollout
    is built; a regression that warm-started anyway would otherwise keep every other test green."""
    import dicewars_ppo.train_tracer as tt

    warm_calls = []
    monkeypatch.setattr(tt, "warm_start_from_bc", lambda policy, ckpt: warm_calls.append(True))

    class FakePolicy:
        def parameters(self):
            return []

        class _BC:
            def parameters(self):
                return []

        bc_net = _BC()

    class FakeModel:
        def __init__(self, *args, **kwargs):
            self.policy = FakePolicy()

    monkeypatch.setattr(tt, "MaskablePPO", lambda *args, **kwargs: FakeModel())

    cfg = SimpleNamespace(max_areas=32, player_count=7)
    extra = ["--from-scratch"] if from_scratch else []
    a = _args(tmp_path, extra=extra)
    tr._validate(a)
    # venv != None so build_model does not construct a DummyVecEnv (no Node spawn).
    tt.build_model(cfg, {"k": "v"}, a, venv=object())

    assert warm_calls == ([] if from_scratch else [True])


def _patch_logger_formats(monkeypatch):
    """Stub the SB3 output-format classes + Logger so _make_logger does no real file/TB I/O.

    Each fake records a tagged tuple; Logger captures its output_formats so a test can assert which
    sinks were wired and the per-session CSV filename — all without opening files or importing
    tensorboard (PR-5 builds output_formats explicitly instead of configure()).
    """
    monkeypatch.setattr(tr, "HumanOutputFormat", lambda stream: ("human",))
    monkeypatch.setattr(tr, "CSVOutputFormat", lambda path: ("csv", path))
    monkeypatch.setattr(tr, "TensorBoardOutputFormat", lambda d: ("tb", d))
    monkeypatch.setattr(
        tr, "Logger", lambda folder, output_formats: ("LOGGER", folder, output_formats)
    )


def test_make_logger_sink_selection(tmp_path, monkeypatch):
    _patch_logger_formats(monkeypatch)
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: True)

    # no --log-dir → SB3 keeps its stdout default (no configured logger, empty sink list)
    a = _args(tmp_path)
    tr._validate(a)
    assert tr._make_logger(a) == (None, [])

    # --log-dir → stdout + csv + tensorboard; the RETURNED sinks mirror the actual output_formats,
    # so train()'s status line is built from reality rather than from the --no-tensorboard flag.
    b = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(b)
    logger, sinks = tr._make_logger(b)
    assert sinks == ["stdout", "csv", "tensorboard"]
    tag, folder, formats = logger
    assert tag == "LOGGER"
    assert [f[0] for f in formats] == ["human", "csv", "tb"]

    # --log-dir + --no-tensorboard → stdout + csv only (no TB output format wired)
    c = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs"), "--no-tensorboard"])
    tr._validate(c)
    # _make_logger returns (logger, sinks); the fake Logger IS the ("LOGGER", folder, formats).
    (_, _, formats), sinks = tr._make_logger(c)
    assert sinks == ["stdout", "csv"]
    assert [f[0] for f in formats] == ["human", "csv"]

    # --log-dir but tensorboard missing → degrade to csv only (no raise); the returned sinks reflect
    # the drop, so train() reports "csv" not "csv+tensorboard" (the contradiction this guards).
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: False)
    d = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(d)
    _, sinks = tr._make_logger(d)
    assert sinks == ["stdout", "csv"]


def test_make_logger_csv_is_per_session(tmp_path, monkeypatch):
    # PR-5: the CSV is progress-<resumed_step>.csv so a resume never truncates a prior session's
    # rows. resumed_step=0 (fresh) and a non-zero resume step name distinct files.
    _patch_logger_formats(monkeypatch)
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: True)
    a = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(a)

    # _make_logger returns (logger, sinks); the fake Logger IS the ("LOGGER", folder, formats).
    (_, _, fresh_formats), _ = tr._make_logger(a, resumed_step=0)
    (_, _, resumed_formats), _ = tr._make_logger(a, resumed_step=123_456)
    fresh_csv = next(f[1] for f in fresh_formats if f[0] == "csv")
    resumed_csv = next(f[1] for f in resumed_formats if f[0] == "csv")
    assert fresh_csv.endswith("progress-000000000.csv")
    assert resumed_csv.endswith("progress-000123456.csv")
    assert fresh_csv != resumed_csv  # a resume never reuses (and truncates) the prior session's CSV


def test_train_wires_snapshot_callback_and_logger(tmp_path, monkeypatch):
    """With --snapshot-dir + --log-dir, train() must construct SnapshotCallback (forwarding the
    keyword-only pool_cap, whose name-drift would fail only on a live shodan run), hand it to
    learn(callback=...), and call set_logger BEFORE learn — all the train()-level wiring the
    isolated _make_logger / wrap-order tests don't exercise. Fakes only, so no Node child spawns."""
    calls = []
    fake_cfg = SimpleNamespace(max_areas=32, player_count=7, context_hidden=64)
    monkeypatch.setattr(tr, "load_bc_checkpoint", lambda ckpt: (fake_cfg, {"k": "v"}))
    monkeypatch.setattr(tr, "SubprocVecEnv", lambda thunks, start_method=None: SimpleNamespace())
    monkeypatch.setattr(
        tr, "VecMonitor", lambda venv: SimpleNamespace(close=lambda: calls.append(("close",)))
    )

    class FakeSnapshotCallback:
        def __init__(self, snapshot_dir, snapshot_every, *, pool_cap, teacher):
            calls.append(("SnapshotCallback", pool_cap, teacher))

    monkeypatch.setattr(tr, "SnapshotCallback", FakeSnapshotCallback)

    class FakeModel:
        def __init__(self):
            self.policy = object()
            self.num_timesteps = 0  # train() reads this for the per-session CSV name (PR-5)

        def set_logger(self, logger):
            calls.append(("set_logger", logger))

        def learn(self, **kwargs):
            # record the callback's TYPE so we prove the SnapshotCallback instance reached learn()
            calls.append(("learn", type(kwargs.get("callback")).__name__))

    monkeypatch.setattr(tr, "build_model", lambda cfg, ckpt, args, venv=None: (FakeModel(), venv))
    # PR-5 builds output_formats explicitly (no configure()); stub them so set_logger gets "LOGGER"
    # without real file/TB I/O.
    monkeypatch.setattr(tr, "HumanOutputFormat", lambda stream: ("human",))
    monkeypatch.setattr(tr, "CSVOutputFormat", lambda path: ("csv", path))
    monkeypatch.setattr(tr, "TensorBoardOutputFormat", lambda d: ("tb", d))
    monkeypatch.setattr(tr, "Logger", lambda folder, output_formats: "LOGGER")
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: True)
    monkeypatch.setattr(
        tr,
        "repack_to_bc_checkpoint",
        lambda policy, *, extra=None: {"state_dict": {}, "config": {}, "encoding_version": 2},
    )
    monkeypatch.setattr(tr.torch, "save", lambda obj, path: None)
    monkeypatch.setattr(tr, "_verify_repack_exportable", lambda out, cfg: None)

    a = _args(
        tmp_path,
        extra=[
            "--out",  # keep the repack write inside tmp_path (no stray checkpoints/ in cwd)
            str(tmp_path / "out.pt"),
            "--log-dir",
            str(tmp_path / "runs"),
            "--snapshot-dir",
            str(tmp_path / "league"),
            "--snapshot-pool-cap",
            "17",
        ],
    )
    tr._validate(a)
    tr.train(a)

    # pool_cap forwarded to the producer callback (the tracer omits it; train.py must not)
    assert ("SnapshotCallback", 17, "ppo-snapshot") in calls
    # the SnapshotCallback instance reached learn(callback=...)
    assert ("learn", "FakeSnapshotCallback") in calls
    # set_logger fired, and BEFORE learn() (the "must precede learn()" invariant)
    assert ("set_logger", "LOGGER") in calls
    assert calls.index(("set_logger", "LOGGER")) < calls.index(("learn", "FakeSnapshotCallback"))


# --- idempotent resume wiring (PR-5, [D-26] HOLE-C/D) -----------------------------------------


def _stub_train_io(monkeypatch, calls):
    """Stub train()'s I/O boundary (ckpt load, vec-env, repack/save/verify) for the resume tests."""
    fake_cfg = SimpleNamespace(max_areas=32, player_count=7, context_hidden=64)
    monkeypatch.setattr(tr, "load_bc_checkpoint", lambda ckpt: (fake_cfg, {"k": "v"}))
    monkeypatch.setattr(tr, "SubprocVecEnv", lambda thunks, start_method=None: SimpleNamespace())
    monkeypatch.setattr(
        tr, "VecMonitor", lambda venv: SimpleNamespace(close=lambda: calls.append(("close",)))
    )
    monkeypatch.setattr(
        tr,
        "repack_to_bc_checkpoint",
        lambda policy, *, extra=None: {"state_dict": {}, "config": {}, "encoding_version": 2},
    )
    monkeypatch.setattr(tr.torch, "save", lambda obj, path: calls.append(("save",)))
    monkeypatch.setattr(tr, "_verify_repack_exportable", lambda out, cfg: calls.append(("verify",)))
    return fake_cfg


def test_resume_passes_remaining_and_skips_build_model(tmp_path, monkeypatch):
    """A resumed run loads the checkpoint and calls learn(total_timesteps=remaining,
    reset_num_timesteps=False) — the HOLE-D budget cap — and must NOT warm-start via build_model."""
    calls = []
    _stub_train_io(monkeypatch, calls)

    class FakeModel:
        def __init__(self):
            self.policy = object()
            self.num_timesteps = 400  # already trained 400 of the 1000 budget

        def learn(self, **kwargs):
            calls.append(
                ("learn", kwargs.get("total_timesteps"), kwargs.get("reset_num_timesteps"))
            )

    monkeypatch.setattr(tr, "classify_latest_pointer", lambda d: POINTER_VALID)
    monkeypatch.setattr(tr, "load_resume_checkpoint", lambda d, venv, device: FakeModel())

    def _no_build(*a, **k):
        raise AssertionError("build_model must not run on a resume (load brings back the weights)")

    monkeypatch.setattr(tr, "build_model", _no_build)

    a = _args(
        tmp_path,
        extra=[
            "--state-dir",
            str(tmp_path / "state"),
            "--timesteps",
            "1000",
            "--out",
            str(tmp_path / "o.pt"),
        ],
    )
    tr._validate(a)
    tr.train(a)

    # remaining = 1000 - 400 = 600; reset_num_timesteps=False so SB3 stops at the ABSOLUTE 1000.
    assert ("learn", 600, False) in calls
    assert ("save",) in calls and ("verify",) in calls  # still re-exports the repacked artifact


def test_resume_zero_remaining_skips_learn_but_exports(tmp_path, monkeypatch):
    """When the budget is already met, learn() is skipped entirely but the repack/export still runs
    (so a same-budget relaunch is a clean no-op re-export, not an overshoot)."""
    calls = []
    _stub_train_io(monkeypatch, calls)

    class FakeModel:
        def __init__(self):
            self.policy = object()
            self.num_timesteps = 1000

        def learn(self, **kwargs):
            calls.append(("learn",))

    monkeypatch.setattr(tr, "classify_latest_pointer", lambda d: POINTER_VALID)
    monkeypatch.setattr(tr, "load_resume_checkpoint", lambda d, venv, device: FakeModel())
    monkeypatch.setattr(
        tr, "build_model", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no build"))
    )

    a = _args(
        tmp_path,
        extra=[
            "--state-dir",
            str(tmp_path / "state"),
            "--timesteps",
            "1000",
            "--out",
            str(tmp_path / "o.pt"),
        ],
    )
    tr._validate(a)
    tr.train(a)

    assert ("learn",) not in calls  # budget met ⇒ learn skipped
    assert ("save",) in calls and ("verify",) in calls


def test_fresh_run_when_state_dir_empty(tmp_path, monkeypatch):
    """--state-dir with no valid latest.json ⇒ a fresh run (build_model, absolute --timesteps)."""
    calls = []
    _stub_train_io(monkeypatch, calls)

    class FakeModel:
        def __init__(self):
            self.policy = object()
            self.num_timesteps = 0

        def learn(self, **kwargs):
            calls.append(
                ("learn", kwargs.get("total_timesteps"), kwargs.get("reset_num_timesteps"))
            )

    monkeypatch.setattr(tr, "build_model", lambda cfg, ckpt, args, venv=None: (FakeModel(), venv))

    def _no_load(*a, **k):
        raise AssertionError("load_resume_checkpoint must not run for a fresh --state-dir")

    monkeypatch.setattr(tr, "load_resume_checkpoint", _no_load)

    a = _args(
        tmp_path,
        extra=[
            "--state-dir",
            str(tmp_path / "fresh-state"),
            "--timesteps",
            "2048",
            "--out",
            str(tmp_path / "o.pt"),
        ],
    )
    tr._validate(a)  # state_dir is empty (no latest.json) ⇒ classify_latest_pointer reads ABSENT
    tr.train(a)

    assert ("learn", 2048, None) in calls  # absolute budget, default reset (fresh)


def test_freeze_trunk_plus_state_dir_rejected_eagerly(tmp_path):
    """--freeze-trunk + --state-dir is rejected EAGERLY at _validate (not only after a crash): load
    doesn't restore the build-time freeze, so the run could never resume and every checkpoint it
    wrote would be un-resumable. Fail at launch, before any checkpoint is written."""
    a = _args(tmp_path, extra=["--state-dir", str(tmp_path / "state"), "--freeze-trunk"])
    with pytest.raises(SystemExit, match="freeze-trunk"):
        tr._validate(a)


@pytest.mark.parametrize("bad", ["0", "-1"])
def test_validate_rejects_nonpositive_checkpoint_every(tmp_path, bad):
    a = _args(tmp_path, extra=["--state-dir", str(tmp_path / "state"), "--checkpoint-every", bad])
    with pytest.raises(SystemExit, match="checkpoint-every"):
        tr._validate(a)


@pytest.mark.parametrize(
    "reason",
    [POINTER_CORRUPT_JSON, POINTER_VERSION_SKEW, POINTER_ENCODING_SKEW, POINTER_DANGLING_REF],
)
def test_rejected_pointer_halts_with_exit_pointer_rejected(tmp_path, monkeypatch, capsys, reason):
    """A PRESENT-but-rejected latest.json HALTS with EXIT_POINTER_REJECTED (PR-6) — NOT the pre-PR-6
    silent restart from step 0 that would re-burn the whole --timesteps budget under the unattended
    schtasks loop. The HALT fires BEFORE SubprocVecEnv is built, so no env workers are started."""
    calls = []
    _stub_train_io(monkeypatch, calls)

    def _no_build(*a, **k):
        raise AssertionError("build_model must not run on a rejected pointer (train HALTs first)")

    monkeypatch.setattr(tr, "build_model", _no_build)
    monkeypatch.setattr(tr, "classify_latest_pointer", lambda d: reason)

    a = _args(
        tmp_path, extra=["--state-dir", str(tmp_path / "state"), "--out", str(tmp_path / "o.pt")]
    )
    tr._validate(a)
    with pytest.raises(SystemExit) as ei:
        tr.train(a)

    assert ei.value.code == tr.EXIT_POINTER_REJECTED  # exit 3 — the launcher's do-not-retry signal
    err = capsys.readouterr().err
    assert "FATAL" in err
    assert "Refusing to silently restart" in err  # never a silent restart-from-0
    assert ("learn",) not in calls  # halted before any learn()
    assert ("close",) not in calls  # HALT precedes SubprocVecEnv ⇒ no workers to reap


def test_unrecoverable_resume_load_halts_and_reaps_workers(tmp_path, monkeypatch, capsys):
    """When load_resume_checkpoint exhausts every retained pair (ResumeCheckpointError), train()
    HALTS with EXIT_POINTER_REJECTED — but here the env workers were ALREADY started, so the single
    teardown finally must reap them (venv.close) before the SystemExit propagates (no Node leak)."""
    calls = []
    _stub_train_io(monkeypatch, calls)

    def _no_build(*a, **k):
        raise AssertionError("build_model must not run on the resuming path")

    monkeypatch.setattr(tr, "build_model", _no_build)
    monkeypatch.setattr(tr, "classify_latest_pointer", lambda d: POINTER_VALID)  # ⇒ resuming=True

    def _boom(state_dir, venv, device):
        raise tr.ResumeCheckpointError("all retained pairs unreadable")

    monkeypatch.setattr(tr, "load_resume_checkpoint", _boom)

    a = _args(
        tmp_path, extra=["--state-dir", str(tmp_path / "state"), "--out", str(tmp_path / "o.pt")]
    )
    tr._validate(a)
    with pytest.raises(SystemExit) as ei:
        tr.train(a)

    assert ei.value.code == tr.EXIT_POINTER_REJECTED
    assert "FATAL" in capsys.readouterr().err
    assert ("close",) in calls  # workers reaped despite the HALT (the widened teardown guard)
    assert ("learn",) not in calls


def test_both_callbacks_wrapped_in_callbacklist(tmp_path, monkeypatch):
    """With both --state-dir and --snapshot-dir, learn() gets a CallbackList of BOTH callbacks."""
    calls = []
    _stub_train_io(monkeypatch, calls)

    class FakeModel:
        def __init__(self):
            self.policy = object()
            self.num_timesteps = 0

        def learn(self, **kwargs):
            calls.append(("learn", kwargs.get("callback")))

    monkeypatch.setattr(tr, "build_model", lambda cfg, ckpt, args, venv=None: (FakeModel(), venv))

    class FakeSnap:
        def __init__(self, *a, **k):
            pass

    class FakeResume:
        def __init__(self, *a, **k):
            pass

    monkeypatch.setattr(tr, "SnapshotCallback", FakeSnap)
    monkeypatch.setattr(tr, "ResumeCheckpointCallback", FakeResume)

    a = _args(
        tmp_path,
        extra=[
            "--state-dir",
            str(tmp_path / "fresh-state"),
            "--snapshot-dir",
            str(tmp_path / "league"),
            "--out",
            str(tmp_path / "o.pt"),
        ],
    )
    tr._validate(a)
    tr.train(a)

    cb = next(c[1] for c in calls if c[0] == "learn")
    assert isinstance(cb, tr.CallbackList)
    assert {type(x).__name__ for x in cb.callbacks} == {"FakeSnap", "FakeResume"}
