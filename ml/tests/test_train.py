"""End-to-end smoke test: the training loop runs and writes a checkpoint."""

import pytest
from _fixtures import default_corpus

torch = pytest.importorskip("torch")

from dicewars_bc.train import build_parser, train  # noqa: E402


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
