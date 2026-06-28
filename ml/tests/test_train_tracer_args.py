"""train_tracer PFSP arg plumbing: re-export wiring + parser defaults, _validate_args, forwarding.

Torch/SB3-gated (``train_tracer`` imports them at module scope), so this runs on shodan and skips in
the lean ``ml-test`` CI job — same pattern as test_snapshot_callback.py / test_ppo_policy.py. The
parser/validate/thunk surface itself now lives in the torch-free ``_train_common`` (and is covered
lean in test_train_common_args.py); this file's remaining job is to prove the TRACER still exposes
that surface byte-identically after the extraction:
  - the re-export wiring (``tt._make_env_thunk is tc._make_env_thunk`` etc.);
  - the argparse defaults that ACTUALLY govern production runs, which must agree with the Node
    makeLeague defaults, are unchanged through the tracer's thin build_parser wrapper;
  - the unconditional PFSP range guards in _validate_args (mirroring the always-on Node guards); and
  - the args -> server_kwargs hop inside _make_env_thunk (patched in _train_common, where it lives).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

pytest.importorskip("torch")
pytest.importorskip("sb3_contrib")

import dicewars_ppo._train_common as tc  # noqa: E402
import dicewars_ppo.train_tracer as tt  # noqa: E402


def test_tracer_reexports_shared_core():
    # The env-thunk + validation moved to the torch-free _train_common; the tracer re-imports them
    # so its body (and these tests) keep the same names. build_parser is a thin wrapper that stamps
    # the tracer's __doc__, so it is NOT identity-equal — assert its surface matches instead.
    assert tt._make_env_thunk is tc._make_env_thunk
    assert tt._validate_args is tc._validate_args


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


def test_tracer_parser_golden_defaults():
    # The shared _train_common.build_parser body now governs BOTH drivers, so pin the tracer's FULL
    # default surface: an edit made for train.py's benefit inside the shared parser can't silently
    # drift the tracer ([D-26] Q1 byte-identical). --out is the load-bearing one — the tracer keeps
    # ppo-tracer.pt vs train.py's overridden ppo.pt, so a bare run can't clobber the other's
    # checkpoint. (Parse [] directly: parse-time defaults only, no validation, so no real file.)
    a = tt.build_parser().parse_args([])
    assert (a.checkpoint, a.out) == ("checkpoints/v2-base/bc_model.pt", "checkpoints/ppo-tracer.pt")
    assert (a.learner_seat, a.n_envs, a.timesteps, a.n_steps) == (0, 1, 2048, 512)
    assert (a.batch_size, a.n_epochs, a.lr, a.gamma) == (128, 4, 1e-4, 0.999)
    assert (a.gae_lambda, a.ent_coef, a.vf_coef) == (0.95, 0.0, 0.5)
    assert (a.max_turns, a.seed, a.seed_base, a.device) == (500, 0, 1, "cpu")
    assert a.freeze_trunk is False
    assert (a.snapshot_dir, a.snapshot_every, a.snapshot_pool_cap) == (None, 50_000, 40)
    # B6 league-persistence flags (PR-5) live in the SHARED parser now, so pin them OFF here too:
    # the tracer must never carry them set, or its byte-identical Node argv would drift.
    assert (a.snapshot_store, a.league_state_dir, a.league_dump_every) == (None, None, None)
    assert a.opponents == tc.DEFAULT_OPPONENTS
    # the tracer threads its OWN __doc__ as the --help description (help-text wiring is preserved)
    assert tt.build_parser().description == tt.__doc__


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

    # The thunk resolves DiceWarsEnv in _train_common's namespace now (that's where it lives), so
    # patch THERE — patching tt.DiceWarsEnv would miss it (and the name no longer exists on tt).
    monkeypatch.setattr(tc, "DiceWarsEnv", FakeEnv)
    a = _args(tmp_path, reserve_baselines=4, pfsp_epsilon=0.2, pfsp_k=1.5)
    cfg = SimpleNamespace(max_areas=32, player_count=7)
    tt._make_env_thunk(cfg, a, 0)()  # invoke the zero-arg env factory (== tc._make_env_thunk)

    server_kwargs = captured["server_kwargs"]
    assert server_kwargs["reserve_baselines"] == 4
    assert server_kwargs["pfsp_epsilon"] == 0.2
    assert server_kwargs["pfsp_k"] == 1.5
