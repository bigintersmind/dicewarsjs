"""End-to-end smoke test: the training loop runs and writes a checkpoint."""

import pytest
from _fixtures import default_corpus

torch = pytest.importorskip("torch")

from dicewars_bc.train import _selection_score, build_parser, train  # noqa: E402


def test_train_one_epoch_writes_checkpoint(tmp_path):
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "2",
            "--batch-size", "4",
            "--val-frac", "0.34",
            "--device", "cpu",
            "--node-hidden", "8",
            "--player-hidden", "8",
            "--context-hidden", "16",
            "--edge-hidden", "16",
        ]
    )
    ckpt_path = train(args)
    assert ckpt_path.is_file()

    # weights_only=True doubles as a guard that the checkpoint stays safe-loadable
    # (only tensors + plain containers/scalars) — see export_onnx.py.
    ckpt = torch.load(ckpt_path, weights_only=True)
    assert ckpt["encoding_version"] == 1
    assert ckpt["teacher"] == "Lookahead"
    assert ckpt["config"]["max_areas"] == 6
    assert ckpt["config"]["player_count"] == 2  # carried from the manifest for the ONNX export
    assert "state_dict" in ckpt
    # This run has a val set (--val-frac 0.34), so selection is by val accuracy and
    # val_accuracy is a real held-out number.
    assert ckpt["selection_metric"] == "val_acc"
    assert ckpt["val_accuracy"] is not None
    assert 0.0 <= ckpt["val_accuracy"] <= 1.0
    assert ckpt["selection_accuracy"] == ckpt["val_accuracy"]
    # The de-bias provenance fields are always written — verify they stay sane on the
    # DEFAULT acc path (a regression guard now that they're populated unconditionally).
    assert ckpt["stop_weight"] == pytest.approx(1.0)
    assert ckpt["focal_gamma"] == pytest.approx(0.0)
    assert 0.0 <= ckpt["stop_rate"] <= 1.0
    assert ckpt["stop_cal_in_band"] is None  # no calibration band under acc selection


def test_train_stop_cal_selection_records_calibration(tmp_path):
    """--select-by stop-cal selects on STOP rate (not move-match) and records the
    de-bias provenance: the lever (stop_weight) and where the STOP rate landed."""
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "3",
            "--batch-size", "4",
            "--val-frac", "0.34",
            "--device", "cpu",
            "--select-by", "stop-cal",
            "--stop-weight", "0.5",
            "--node-hidden", "8",
            "--player-hidden", "8",
            "--context-hidden", "16",
            "--edge-hidden", "16",
        ]
    )
    ckpt = torch.load(train(args), weights_only=True)
    assert ckpt["selection_metric"] == "val_stop_cal"
    assert ckpt["stop_weight"] == pytest.approx(0.5)
    assert ckpt["focal_gamma"] == pytest.approx(0.0)
    # auto target ⇒ the teacher's STOP rate on the eval split; both are valid rates.
    assert 0.0 <= ckpt["stop_rate"] <= 1.0
    assert ckpt["target_stop_rate"] == pytest.approx(ckpt["teacher_stop_rate"])
    assert ckpt["val_accuracy"] is not None
    # The in-band flag is recorded and consistent with the saved rate vs the band.
    expected_in_band = abs(ckpt["stop_rate"] - ckpt["target_stop_rate"]) <= 0.02  # default band
    assert ckpt["stop_cal_in_band"] == expected_in_band


def test_train_stop_cal_honors_explicit_target(tmp_path):
    """An explicit --target-stop-rate overrides the auto (teacher) target."""
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "2",
            "--batch-size", "4",
            "--val-frac", "0.34",
            "--device", "cpu",
            "--select-by", "stop-cal",
            "--target-stop-rate", "0.3",
            "--node-hidden", "8",
            "--player-hidden", "8",
            "--context-hidden", "16",
            "--edge-hidden", "16",
        ]
    )
    ckpt = torch.load(train(args), weights_only=True)
    assert ckpt["target_stop_rate"] == pytest.approx(0.3)


def test_selection_score_in_band_beats_out_of_band():
    """Calibration is the dominant tier: any in-band epoch outranks any out-of-band one,
    even one with far higher move-match accuracy. (This is the PR's whole thesis — acc
    must NOT be able to re-introduce the STOP bias once an epoch is calibrated.)"""
    target, band = 0.45, 0.02
    in_band_low_acc = _selection_score(stop_rate=0.45, acc=0.10, target=target, stop_band=band)
    out_band_high_acc = _selection_score(stop_rate=0.70, acc=0.99, target=target, stop_band=band)
    assert in_band_low_acc > out_band_high_acc


def test_selection_score_among_in_band_prefers_accuracy():
    """Within the band, the tie-break is move-match accuracy."""
    target, band = 0.45, 0.05
    higher_acc = _selection_score(stop_rate=0.44, acc=0.60, target=target, stop_band=band)
    lower_acc = _selection_score(stop_rate=0.47, acc=0.50, target=target, stop_band=band)
    assert higher_acc > lower_acc


def test_selection_score_out_of_band_prefers_closest_stop_rate():
    """Out of band, accuracy is irrelevant — the closer STOP rate wins."""
    target, band = 0.45, 0.02
    closer = _selection_score(stop_rate=0.55, acc=0.10, target=target, stop_band=band)
    farther = _selection_score(stop_rate=0.65, acc=0.99, target=target, stop_band=band)
    assert closer > farther


def test_selection_score_band_edge_counts_as_in_band():
    """An epoch sitting EXACTLY on the band edge is in-band (the code's `<=`). Guards
    against a future `<=`→`<` regression at the boundary. (target=0 keeps the distance
    exactly representable — `target + band` drifts just past the edge in float.)"""
    band = 0.02
    edge = _selection_score(stop_rate=band, acc=0.0, target=0.0, stop_band=band)
    assert edge >= 1000.0  # in-band tier, not the -dist tier


@pytest.mark.parametrize(
    "flag, value",
    [
        ("--epochs", "0"),
        ("--stop-weight", "-0.5"),
        ("--focal-gamma", "-1.0"),
        ("--target-stop-rate", "1.5"),
        ("--stop-band", "-0.02"),
    ],
)
def test_train_rejects_invalid_args(tmp_path, flag, value):
    """Nonsensical knob values fail fast with a ValueError instead of silently training
    or selecting a garbage model. Validation runs before the corpus loads, so the
    (nonexistent) --corpus path is never touched."""
    args = build_parser().parse_args(
        ["--corpus", str(tmp_path / "nonexistent"), "--out", str(tmp_path / "o"), flag, value]
    )
    with pytest.raises(ValueError, match=flag):
        train(args)


def test_train_focal_gamma_affects_training(tmp_path):
    """--focal-gamma must actually flow into the training OBJECTIVE, not just be
    recorded. Two runs identical except for --focal-gamma (same --seed ⇒ same init and
    same data order) must produce different trained weights — if focal were silently
    dropped from the loop, the checkpoints would be byte-identical. (Asserting only the
    persisted ``focal_gamma`` scalar would pass even with focal disabled in _run_epoch.)
    """
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    common = [
        "--corpus", str(corpus), "--batch-size", "4", "--val-frac", "0.34",
        "--device", "cpu", "--epochs", "3", "--seed", "0",
        "--node-hidden", "8", "--player-hidden", "8",
        "--context-hidden", "16", "--edge-hidden", "16",
    ]
    plain = torch.load(
        train(build_parser().parse_args([*common, "--out", str(tmp_path / "plain")])),
        weights_only=True,
    )
    focal = torch.load(
        train(build_parser().parse_args(
            [*common, "--out", str(tmp_path / "focal"), "--focal-gamma", "2.0"]
        )),
        weights_only=True,
    )
    assert plain["focal_gamma"] == pytest.approx(0.0)
    assert focal["focal_gamma"] == pytest.approx(2.0)
    a, b = plain["state_dict"], focal["state_dict"]
    assert any(not torch.equal(a[k], b[k]) for k in a), (
        "focal_gamma did not change the trained weights — it is not threaded into the loss"
    )


def test_train_stop_cal_out_of_band_warns_and_records_false(tmp_path, capsys):
    """When no epoch reaches the band, the run still ships the closest checkpoint but
    flags it (stop_cal_in_band=False) and prints a loud WARNING. Forced deterministically
    with a zero band + a target the realized STOP rate cannot equal exactly."""
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "2",
            "--batch-size", "4",
            "--val-frac", "0.34",
            "--device", "cpu",
            "--select-by", "stop-cal",
            "--target-stop-rate", "0.137",
            "--stop-band", "0.0",
            "--node-hidden", "8",
            "--player-hidden", "8",
            "--context-hidden", "16",
            "--edge-hidden", "16",
        ]
    )
    ckpt = torch.load(train(args), weights_only=True)
    assert ckpt["stop_cal_in_band"] is False
    assert "WARNING" in capsys.readouterr().out


def test_train_stop_cal_in_band_records_true(tmp_path):
    """The calibration-met path records stop_cal_in_band=True. A wide band around a
    near-zero target guarantees the realized STOP rate lands inside it, so the flag
    takes its True value somewhere in the suite — the out-of-band and acc-path tests
    only ever yield False/None, which would let a hardcoded-False regression slip by."""
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "2",
            "--batch-size", "4",
            "--val-frac", "0.34",
            "--device", "cpu",
            "--select-by", "stop-cal",
            "--target-stop-rate", "0.01",
            "--stop-band", "0.5",
            "--node-hidden", "8",
            "--player-hidden", "8",
            "--context-hidden", "16",
            "--edge-hidden", "16",
        ]
    )
    ckpt = torch.load(train(args), weights_only=True)
    assert ckpt["stop_cal_in_band"] is True


def test_train_stop_cal_degenerate_auto_target_warns(tmp_path, capsys):
    """An auto --target-stop-rate captured as 0%/100% (a degenerate split) is meaningless
    to calibrate against — the run warns rather than silently calibrating to a bogus
    target. The default toy corpus's 2-step val split is all-STOP (teacher rate = 1.0),
    so this exercises the guard without a crafted corpus."""
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "1",
            "--batch-size", "4",
            "--val-frac", "0.34",
            "--device", "cpu",
            "--select-by", "stop-cal",  # auto target (no --target-stop-rate)
            "--node-hidden", "8",
            "--player-hidden", "8",
            "--context-hidden", "16",
            "--edge-hidden", "16",
        ]
    )
    ckpt = torch.load(train(args), weights_only=True)
    assert ckpt["target_stop_rate"] in (0.0, 1.0)  # degenerate auto target
    assert "degenerate" in capsys.readouterr().out.lower()


def test_train_overfits_tiny_corpus(tmp_path):
    """A high-capacity net should drive train accuracy up on a handful of steps —
    a sanity check that gradients actually flow through the policy head."""
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    out = tmp_path / "ckpt"
    args = build_parser().parse_args(
        [
            "--corpus", str(corpus),
            "--out", str(out),
            "--epochs", "200",
            "--batch-size", "7",
            "--val-frac", "0.0",  # train on everything; we're checking it can fit
            "--device", "cpu",
            "--lr", "0.01",
        ]
    )
    ckpt_path = train(args)
    # With val_frac=0 there is no val set, so the saved metric is TRAIN accuracy —
    # recorded honestly as such (selection_metric="train_acc", val_accuracy=None).
    # Random-guess baseline on ~3.9 edges/step is ≈0.26; clearing 0.7 shows the
    # policy head actually learns.
    ckpt = torch.load(ckpt_path, weights_only=True)
    assert ckpt["selection_metric"] == "train_acc"
    assert ckpt["val_accuracy"] is None
    assert ckpt["selection_accuracy"] >= 0.7
