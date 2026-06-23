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

    ckpt = torch.load(ckpt_path, weights_only=False)
    assert ckpt["encoding_version"] == 1
    assert ckpt["teacher"] == "Lookahead"
    assert ckpt["config"]["max_areas"] == 6
    assert "state_dict" in ckpt
    assert 0.0 <= ckpt["val_accuracy"] <= 1.0


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
    # With val_frac=0 the saved metric is train accuracy. Random-guess baseline on
    # ~3.9 edges/step is ≈0.26; clearing 0.7 shows the policy head actually learns.
    ckpt = torch.load(ckpt_path, weights_only=False)
    assert ckpt["val_accuracy"] >= 0.7
