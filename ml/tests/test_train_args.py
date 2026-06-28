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

    extra = ["--start-method", "spawn"] + (["--from-scratch"] if from_scratch else [])
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

    # no --log-dir → SB3 keeps its stdout default (no configured logger)
    a = _args(tmp_path)
    tr._validate(a)
    assert tr._make_logger(a) is None

    # --log-dir → stdout + csv + tensorboard
    b = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(b)
    assert tr._make_logger(b) == "LOGGER"
    assert captured["sinks"] == ["stdout", "csv", "tensorboard"]

    # --log-dir + --no-tensorboard → stdout + csv only
    captured.clear()
    c = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs"), "--no-tensorboard"])
    tr._validate(c)
    tr._make_logger(c)
    assert captured["sinks"] == ["stdout", "csv"]

    # --log-dir but tensorboard missing → degrade to csv only (no raise)
    captured.clear()
    monkeypatch.setattr(tr, "_tensorboard_available", lambda: False)
    d = _args(tmp_path, extra=["--log-dir", str(tmp_path / "runs")])
    tr._validate(d)
    tr._make_logger(d)
    assert captured["sinks"] == ["stdout", "csv"]
