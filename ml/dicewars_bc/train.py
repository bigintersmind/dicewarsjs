"""Train the BC policy to clone the teacher from a packed corpus.

    python -m dicewars_bc.train --corpus ../data/selfplay/encoded/corpus-fullfield-300
    python -m dicewars_bc.train --corpus <dir> --epochs 20 --batch-size 512 --device cuda

The default headline metric is **policy accuracy** (top-1 move-match with the
teacher), the imitation-fidelity proxy the Phase-2 gate rests on; the best-val-
accuracy model is checkpointed and ``export_onnx.py`` turns it into the in-browser
model.

**STOP-de-bias retrain (``--select-by stop-cal``).** The vanilla clone over-predicts
STOP (~68% on val vs the teacher's ~45%; ~71% realized in the arena) and turtles.
Move-match accuracy is a *misleading*
proxy there — it rewards the STOP-biased model. So the de-bias retrain (a) down-
weights the STOP class in the loss (``--stop-weight`` / ``--focal-gamma``) and
(b) selects the checkpoint whose **realized argmax STOP rate** lands closest to the
teacher's (``--select-by stop-cal``, target band ``--target-stop-rate``/``--stop-band``)
instead of best move-match — otherwise selection silently re-introduces the bias.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Subset

from .dataset import Batch, CorpusDataset, collate, split_by_game
from .losses import (
    policy_accuracy,
    predicted_stop_rate,
    segmented_cross_entropy,
    teacher_stop_rate,
    value_loss,
)
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
    *,
    stop_weight: float = 1.0,
    focal_gamma: float = 0.0,
) -> dict[str, float]:
    """One pass. ``optimizer=None`` ⇒ eval (no grad, no step).

    The backward objective uses the (optionally) STOP-reweighted / focal CE, but the
    reported ``ce`` is always the PLAIN segmented CE so it stays comparable across
    runs and splits. ``stop``/``tstop`` are the model's argmax STOP rate and the
    teacher's STOP rate — the de-bias calibration diagnostics.
    """
    train = optimizer is not None
    model.train(train)
    reweight = train and (stop_weight != 1.0 or focal_gamma > 0.0)

    totals = {"loss": 0.0, "ce": 0.0, "value": 0.0, "acc": 0.0, "stop": 0.0, "tstop": 0.0}
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
            # Optimize the reweighted objective; report the plain CE for comparability.
            ce_opt = (
                segmented_cross_entropy(
                    edge_logits,
                    batch.edge_offsets,
                    batch.labels,
                    stop_weight=stop_weight,
                    focal_gamma=focal_gamma,
                )
                if reweight
                else ce
            )
            vl = value_loss(value_pred, batch.value)
            loss = ce_opt + value_weight * vl

            if train:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                optimizer.step()

            with torch.no_grad():
                acc = policy_accuracy(edge_logits, batch.edge_offsets, batch.labels)
                stop = predicted_stop_rate(edge_logits, batch.edge_offsets)
                tstop = teacher_stop_rate(batch.edge_offsets, batch.labels)

            bs = batch.batch_size
            totals["loss"] += loss.item() * bs
            totals["ce"] += ce.item() * bs
            totals["value"] += vl.item() * bs
            totals["acc"] += acc.item() * bs
            totals["stop"] += stop.item() * bs
            totals["tstop"] += tstop.item() * bs
            n_steps += bs

    return {k: v / max(n_steps, 1) for k, v in totals.items()}


def _validate_args(args: argparse.Namespace) -> None:
    """Fail fast on nonsensical knob values before any training happens.

    Argparse accepts any float, but several values silently train or select a garbage
    model instead of erroring: a negative ``--stop-weight`` inverts the STOP objective
    (gradient *ascent* on STOP), a negative ``--focal-gamma`` up-weights easy steps, an
    out-of-[0,1] ``--target-stop-rate`` or a negative ``--stop-band`` make every epoch
    score out-of-band (silently disabling calibration), and ``--epochs < 1`` would save
    no checkpoint yet still print a "saved" line. Catch them up front.
    """
    if args.epochs < 1:
        raise ValueError(f"--epochs must be >= 1 (got {args.epochs})")
    if args.stop_weight < 0:
        raise ValueError(
            f"--stop-weight must be >= 0 (got {args.stop_weight}); <1 down-weights STOP, "
            "a negative weight would invert the objective"
        )
    if args.focal_gamma < 0:
        raise ValueError(f"--focal-gamma must be >= 0 (got {args.focal_gamma})")
    if not 0.0 <= args.target_stop_rate <= 1.0:
        raise ValueError(
            f"--target-stop-rate must be in [0, 1] (got {args.target_stop_rate}); 0 = auto"
        )
    if args.stop_band < 0:
        raise ValueError(f"--stop-band must be >= 0 (got {args.stop_band})")


def _selection_score(stop_rate: float, acc: float, target: float, stop_band: float) -> float:
    """Checkpoint score for ``--select-by stop-cal`` (higher is better).

    Two tiers, so calibration dominates accuracy: an in-band epoch
    (``|stop_rate - target| <= stop_band``) scores ``1000 + acc`` and *always* outranks
    any out-of-band epoch (which scores ``-dist`` ≤ 0). The ``1000`` offset is safe
    because ``acc`` and ``dist`` are both rates in ``[0, 1]``, so the tiers can never
    overlap. Among in-band epochs the higher move-match wins; among out-of-band epochs
    the closer STOP rate wins.
    """
    dist = abs(stop_rate - target)
    return (1000.0 + acc) if dist <= stop_band else -dist


def train(args: argparse.Namespace) -> Path:
    _validate_args(args)
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

    split = "val" if has_val else "train"
    stop_cal = args.select_by == "stop-cal"
    if args.stop_weight != 1.0 or args.focal_gamma > 0.0:
        print(f"STOP de-bias: stop_weight={args.stop_weight}  focal_gamma={args.focal_gamma}")
    # The calibration target: a fixed --target-stop-rate, else (0 ⇒ auto) the teacher's
    # own STOP rate measured on the eval split (constant across epochs, captured below).
    target = args.target_stop_rate if args.target_stop_rate > 0 else None

    best_score = None  # higher is better; meaning depends on --select-by
    best = {}  # snapshot of the selected epoch's stats, for the summary line
    for epoch in range(1, args.epochs + 1):
        t0 = time.time()
        tr = _run_epoch(
            model,
            train_loader,
            device,
            args.value_weight,
            optimizer,
            stop_weight=args.stop_weight,
            focal_gamma=args.focal_gamma,
        )
        line = (
            f"epoch {epoch:>3}  train: loss {tr['loss']:.4f}  ce {tr['ce']:.4f}  "
            f"acc {tr['acc']:.4f}  stop {tr['stop']:.3f}(t{tr['tstop']:.3f})"
        )
        eval_stats = tr
        if val_loader is not None:
            va = _run_epoch(model, val_loader, device, args.value_weight, optimizer=None)
            line += (
                f"  |  val: ce {va['ce']:.4f}  acc {va['acc']:.4f}  "
                f"stop {va['stop']:.3f}(t{va['tstop']:.3f})"
            )
            eval_stats = va
        line += f"  ({time.time() - t0:.1f}s)"
        print(line)

        if target is None:  # auto: lock onto the teacher's STOP rate (epoch-invariant)
            target = eval_stats["tstop"]
            if stop_cal and target in (0.0, 1.0):
                # A 0%/100% teacher STOP rate (usually a tiny/pathological split) makes
                # auto calibration meaningless — every epoch is either trivially in-band
                # or hopelessly out. Warn, don't crash: an explicit --target-stop-rate or
                # a wider --val-frac is the fix. (A *raise* here would break the default
                # toy-corpus test, whose 2-step val split is all-STOP → target 1.0.)
                print(
                    f"WARNING: auto --target-stop-rate captured a degenerate "
                    f"{target:.0%} teacher STOP rate on the {split} split — calibration "
                    f"is meaningless. Pass an explicit --target-stop-rate or widen "
                    f"--val-frac."
                )

        if stop_cal:
            in_band = abs(eval_stats["stop"] - target) <= args.stop_band
            score = _selection_score(eval_stats["stop"], eval_stats["acc"], target, args.stop_band)
        else:
            in_band = None  # the calibration band is meaningless for acc selection
            score = eval_stats["acc"]

        if best_score is None or score > best_score:
            best_score = score
            best = {**eval_stats, "epoch": epoch, "score": score, "in_band": in_band}
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "config": config.to_dict(),
                    "encoding_version": manifest.encoding_version,
                    "feature_names": manifest.feature_names,
                    "teacher": manifest.teacher,
                    "epoch": epoch,
                    # Be honest about what "best" was selected on. With no val set the
                    # accuracy figure is TRAIN (overfitting-biased) — `val_accuracy` is
                    # None so downstream tooling can't mistake it for a held-out number.
                    "selection_metric": (
                        ("val_stop_cal" if has_val else "train_stop_cal")
                        if stop_cal
                        else ("val_acc" if has_val else "train_acc")
                    ),
                    "selection_score": best_score,
                    "selection_accuracy": eval_stats["acc"],
                    "val_accuracy": eval_stats["acc"] if has_val else None,
                    # STOP-calibration provenance (the lever + where it landed).
                    "stop_rate": eval_stats["stop"],
                    "target_stop_rate": target,
                    "teacher_stop_rate": eval_stats["tstop"],
                    "stop_weight": args.stop_weight,
                    "focal_gamma": args.focal_gamma,
                    # Did the SELECTED epoch's STOP rate land inside ±stop_band of the
                    # target? None for acc selection (no band). False means the run
                    # shipped the closest checkpoint but never reached calibration.
                    "stop_cal_in_band": in_band,
                },
                ckpt_path,
            )

    if stop_cal:
        if not best.get("in_band", False):
            print(
                f"\nWARNING: no epoch reached the STOP-cal band "
                f"(best |stop - target| = {abs(best['stop'] - target):.3f} > "
                f"band {args.stop_band:.3f}). Saved the CLOSEST checkpoint, but it is "
                f"NOT STOP-calibrated — strengthen --stop-weight/--focal-gamma, widen "
                f"--stop-band, or train longer."
            )
        print(
            f"\nSelected epoch {best.get('epoch')} by STOP-calibration"
            f"{'' if best.get('in_band') else ' (OUT OF BAND)'}: "
            f"{split} stop {best.get('stop', float('nan')):.3f} "
            f"(target {target:.3f}, teacher {best.get('tstop', float('nan')):.3f}), "
            f"{split} acc {best.get('acc', float('nan')):.4f}  →  saved {ckpt_path}"
        )
    else:
        print(
            f"\nBest {split} accuracy: {best.get('acc', float('nan')):.4f}  →  saved {ckpt_path}"
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
    # --- STOP-de-bias retrain knobs (Phase 2) -------------------------------------
    p.add_argument(
        "--stop-weight",
        type=float,
        default=1.0,
        help="Loss weight on teacher-STOP steps (<1 down-weights STOP; 1.0 = plain CE)",
    )
    p.add_argument(
        "--focal-gamma",
        type=float,
        default=0.0,
        help="Focal-loss exponent on the policy CE (0 = off; >0 damps easy/STOP steps)",
    )
    p.add_argument(
        "--select-by",
        choices=["acc", "stop-cal"],
        default="acc",
        help="Checkpoint selection: 'acc' (best move-match) or 'stop-cal' "
        "(STOP rate closest to teacher — required for the de-bias retrain)",
    )
    p.add_argument(
        "--target-stop-rate",
        type=float,
        default=0.0,
        help="Target argmax STOP rate for --select-by stop-cal (0 = auto: the "
        "teacher's measured STOP rate on the eval split)",
    )
    p.add_argument(
        "--stop-band",
        type=float,
        default=0.02,
        help="Half-width of the in-band STOP-rate window around the target (stop-cal)",
    )
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
