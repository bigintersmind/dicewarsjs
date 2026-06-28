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

        def learn(self, **kwargs):
            calls.append(("learn",))

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


def test_make_logger_sink_selection(tmp_path, monkeypatch):
    captured = {}

    def fake_configure(folder, sinks):
        captured["folder"] = folder
        captured["sinks"] = list(sinks)
        return "LOGGER"

    monkeypatch.setattr(tr, "configure", fake_configure)
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: True)

    # no --log-dir → SB3 keeps its stdout default (no configured logger, empty sink list)
    a = _args(tmp_path)
    tr._validate(a)
    assert tr._make_logger(a) == (None, [])

    # --log-dir → stdout + csv + tensorboard; the RETURNED sinks mirror what configure() got, so
    # train()'s status line is built from reality rather than from the --no-tensorboard flag.
    b = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(b)
    logger, sinks = tr._make_logger(b)
    assert logger == "LOGGER"
    assert sinks == ["stdout", "csv", "tensorboard"]
    assert captured["sinks"] == ["stdout", "csv", "tensorboard"]

    # --log-dir + --no-tensorboard → stdout + csv only
    captured.clear()
    c = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs"), "--no-tensorboard"])
    tr._validate(c)
    _, sinks = tr._make_logger(c)
    assert sinks == ["stdout", "csv"]
    assert captured["sinks"] == ["stdout", "csv"]

    # --log-dir but tensorboard missing → degrade to csv only (no raise); the returned sinks reflect
    # the drop, so train() reports "csv" not "csv+tensorboard" (the contradiction this guards).
    captured.clear()
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: False)
    d = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(d)
    _, sinks = tr._make_logger(d)
    assert sinks == ["stdout", "csv"]
    assert captured["sinks"] == ["stdout", "csv"]


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

        def set_logger(self, logger):
            calls.append(("set_logger", logger))

        def learn(self, **kwargs):
            # record the callback's TYPE so we prove the SnapshotCallback instance reached learn()
            calls.append(("learn", type(kwargs.get("callback")).__name__))

    monkeypatch.setattr(tr, "build_model", lambda cfg, ckpt, args, venv=None: (FakeModel(), venv))
    monkeypatch.setattr(tr, "configure", lambda folder, sinks: "LOGGER")
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
