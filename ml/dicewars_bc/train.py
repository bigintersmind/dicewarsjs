"""Train the BC policy to clone the teacher from a packed corpus.

    python -m dicewars_bc.train --corpus ../data/selfplay/encoded/corpus-fullfield-300
    python -m dicewars_bc.train --corpus <dir> --epochs 20 --batch-size 512 --device cuda

The headline metric is **policy accuracy** (top-1 move-match with the teacher):
that is the imitation-fidelity proxy that the Phase-2 gate ("clone ai_lookahead
to ~parity") ultimately rests on. We checkpoint the best-val-accuracy model;
``export_onnx.py`` turns that checkpoint into the in-browser model.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Subset

from .dataset import Batch, CorpusDataset, collate, split_by_game
from .losses import policy_accuracy, segmented_cross_entropy, value_loss
from .manifest import load_manifest
from .model import EdgePolicyNet, ModelConfig


def _resolve_device(name: str) -> torch.device:
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(name)


def _run_epoch(
    model: EdgePolicyNet,
    loader: DataLoader,
    device: torch.device,
    value_weight: float,
    optimizer: torch.optim.Optimizer | None,
) -> dict[str, float]:
    """One pass. ``optimizer=None`` ⇒ eval (no grad, no step)."""
    train = optimizer is not None
    model.train(train)

    totals = {"loss": 0.0, "ce": 0.0, "value": 0.0, "acc": 0.0}
    n_steps = 0  # decision steps, for sample-weighted means

    grad_ctx = torch.enable_grad() if train else torch.no_grad()
    with grad_ctx:
        for batch in loader:
            batch: Batch = batch.to(device)
            edge_logits, value_pred = model(
                batch.nodes,
                batch.players,
                batch.board,
                batch.edge_feat,
                batch.edge_from,
                batch.edge_to,
                batch.edge_batch,
            )
            ce = segmented_cross_entropy(edge_logits, batch.edge_offsets, batch.labels)
            vl = value_loss(value_pred, batch.value)
            loss = ce + value_weight * vl

            if train:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                optimizer.step()

            with torch.no_grad():
                acc = policy_accuracy(edge_logits, batch.edge_offsets, batch.labels)

            bs = batch.batch_size
            totals["loss"] += loss.item() * bs
            totals["ce"] += ce.item() * bs
            totals["value"] += vl.item() * bs
            totals["acc"] += acc.item() * bs
            n_steps += bs

    return {k: v / max(n_steps, 1) for k, v in totals.items()}


def train(args: argparse.Namespace) -> Path:
    device = _resolve_device(args.device)
    torch.manual_seed(args.seed)

    manifest = load_manifest(args.corpus)
    print(f"Corpus: {manifest}")
    dataset = CorpusDataset(args.corpus, manifest=manifest)

    train_idx, val_idx = split_by_game(dataset, args.val_frac, seed=args.seed)
    print(f"Steps: {len(dataset)}  →  train {len(train_idx)} / val {len(val_idx)} (by game)")
    if len(train_idx) == 0:
        raise ValueError(
            f"Training split is empty ({len(train_idx)} train / {len(val_idx)} val steps) — "
            f"--val-frac {args.val_frac} is too high for this {manifest.games}-game corpus. "
            f"Lower --val-frac."
        )

    train_loader = DataLoader(
        Subset(dataset, train_idx.tolist()),
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate,
        num_workers=args.num_workers,
        drop_last=False,
    )
    val_loader = (
        DataLoader(
            Subset(dataset, val_idx.tolist()),
            batch_size=args.batch_size,
            shuffle=False,
            collate_fn=collate,
            num_workers=args.num_workers,
        )
        if len(val_idx) > 0
        else None
    )
    has_val = val_loader is not None
    if not has_val:
        print(
            "WARNING: no validation games (--val-frac too small for this corpus) — "
            "selecting the best checkpoint by TRAIN accuracy (overfitting risk)."
        )

    config = ModelConfig.from_manifest(
        manifest,
        node_hidden=args.node_hidden,
        player_hidden=args.player_hidden,
        context_hidden=args.context_hidden,
        edge_hidden=args.edge_hidden,
    )
    model = EdgePolicyNet(config).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"Model: EdgePolicyNet, {n_params:,} params, device={device}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt_path = out_dir / "bc_model.pt"

    best_metric = -1.0  # best val acc (or train acc if no val set)
    for epoch in range(1, args.epochs + 1):
        t0 = time.time()
        tr = _run_epoch(model, train_loader, device, args.value_weight, optimizer)
        line = (
            f"epoch {epoch:>3}  train: loss {tr['loss']:.4f}  ce {tr['ce']:.4f}  "
            f"acc {tr['acc']:.4f}"
        )
        metric = tr["acc"]
        if val_loader is not None:
            va = _run_epoch(model, val_loader, device, args.value_weight, optimizer=None)
            line += f"  |  val: ce {va['ce']:.4f}  acc {va['acc']:.4f}"
            metric = va["acc"]
        line += f"  ({time.time() - t0:.1f}s)"
        print(line)

        if metric > best_metric:
            best_metric = metric
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "config": config.to_dict(),
                    "encoding_version": manifest.encoding_version,
                    "feature_names": manifest.feature_names,
                    "teacher": manifest.teacher,
                    "epoch": epoch,
                    # Be honest about what "best" was selected on: with no val set we
                    # fall back to TRAIN accuracy (overfitting-biased). `val_accuracy`
                    # is None in that case so downstream tooling can't mistake a train
                    # number for a held-out one.
                    "selection_metric": "val_acc" if has_val else "train_acc",
                    "selection_accuracy": best_metric,
                    "val_accuracy": best_metric if has_val else None,
                },
                ckpt_path,
            )

    print(
        f"\nBest {'val' if has_val else 'train'} accuracy: {best_metric:.4f}  →  saved {ckpt_path}"
    )
    return ckpt_path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Behavioral-cloning trainer (DiceWarsJS ml-bot Phase 2)"
    )
    p.add_argument(
        "--corpus", required=True, help="Packed-corpus dir (output of npm run encode-corpus)"
    )
    p.add_argument("--out", default="checkpoints", help="Checkpoint output dir")
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch-size", type=int, default=512)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=0.0)
    p.add_argument("--value-weight", type=float, default=0.5, help="Aux value-loss weight")
    p.add_argument("--val-frac", type=float, default=0.1, help="Fraction of GAMES held out for val")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="auto", help="auto | cpu | cuda")
    p.add_argument("--num-workers", type=int, default=0)
    p.add_argument("--node-hidden", type=int, default=64)
    p.add_argument("--player-hidden", type=int, default=32)
    p.add_argument("--context-hidden", type=int, default=128)
    p.add_argument("--edge-hidden", type=int, default=128)
    return p


def main() -> None:
    train(build_parser().parse_args())


if __name__ == "__main__":
    main()
