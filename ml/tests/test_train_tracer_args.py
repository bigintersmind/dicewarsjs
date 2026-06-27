"""train_tracer PFSP arg plumbing: parser defaults, _validate_args bounds, server_kwargs forwarding.

Torch/SB3-gated (``train_tracer`` imports them at module scope), so this runs on shodan and skips in
the lean ``ml-test`` CI job — same pattern as test_snapshot_callback.py / test_ppo_policy.py. It
covers the layers the torch-free test_env_server_argv.py cannot reach:
  - the argparse defaults that ACTUALLY govern production runs (a separate copy from the
    EnvServerProcess constructor defaults), which must agree with the Node makeLeague defaults;
  - the unconditional PFSP range guards in _validate_args (mirroring the always-on Node guards); and
  - the args -> server_kwargs hop inside _make_env_thunk (a typo there would pass the argv test but
    silently mis-tune a multi-env run).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

pytest.importorskip("torch")
pytest.importorskip("sb3_contrib")

import dicewars_ppo.train_tracer as tt  # noqa: E402


def _args(tmp_path, **overrides):
    """Parse a minimal valid argv (real checkpoint file) with optional knob overrides."""
    ckpt = tmp_path / "ckpt.pt"
    ckpt.write_bytes(b"x")
    argv = ["--checkpoint", str(ckpt)]
    for key, val in overrides.items():
        argv += [f"--{key.replace('_', '-')}", str(val)]
    return tt.build_parser().parse_args(argv)


def test_parser_pfsp_defaults_match_makeleague(tmp_path):
    # These argparse defaults govern production; drift here silently retunes runs and diverges from
    # the Node makeLeague defaults (scripts/lib/ppo-league.mjs).
    a = _args(tmp_path)
    assert a.reserve_baselines == 3
    assert a.pfsp_epsilon == 0.05
    assert a.pfsp_k == 2.0


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
        tt._validate_args(a)


def test_validate_args_validates_pfsp_even_without_snapshot_dir(tmp_path):
    # No --snapshot-dir (fixed-field mode): the PFSP guards still run (unconditional, like Node), so
    # a bad value is rejected rather than silently swallowed; valid values pass cleanly.
    bad = _args(tmp_path, pfsp_epsilon=5)
    with pytest.raises(SystemExit, match="pfsp-epsilon"):
        tt._validate_args(bad)
    tt._validate_args(_args(tmp_path, reserve_baselines=2, pfsp_epsilon=0.1, pfsp_k=3))  # no raise


def test_make_env_thunk_forwards_pfsp_into_server_kwargs(tmp_path, monkeypatch):
    captured = {}

    class FakeEnv:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(tt, "DiceWarsEnv", FakeEnv)
    a = _args(tmp_path, reserve_baselines=4, pfsp_epsilon=0.2, pfsp_k=1.5)
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tt._make_env_thunk(cfg, a, 0)()  # invoke the zero-arg env factory

    server_kwargs = captured["server_kwargs"]
    assert server_kwargs["reserve_baselines"] == 4
    assert server_kwargs["pfsp_epsilon"] == 0.2
    assert server_kwargs["pfsp_k"] == 1.5
