"""Migrate a BC-format checkpoint across an APPEND-ONLY encoding bump (v2 → v3).

The [D-31] encoding appends columns to every feature tensor while keeping the old
columns as an exact prefix, and every consumer of a raw feature block in
:class:`~dicewars_bc.model.EdgePolicyNet` takes that block at the TAIL of its
input (node/player rows feed their encoders directly; ``board`` is last in the
context concat; ``edge_feat`` is last in the edge-head concat). So a checkpoint
migrates by widening the INPUT dim of exactly four first-layer weights with
zero columns appended at the tail:

===================  =========================================  ==============
weight               input layout (tail = appended features)     v2 → v3 shape
===================  =========================================  ==============
node_encoder.0       raw node features                          [H, 8] → [H, 13]
player_encoder.0     raw player features                        [H, 6] → [H, 7]
context.0            [node_pool, player_pool, BOARD]            [H, 101] → [H, 103]
edge_head.0          [ctx, from_emb, to_emb, EDGE_FEAT]         [H, 263] → [H, 266]
===================  =========================================  ==============

Zero columns make the migration FUNCTION-PRESERVING: the new features contribute
exactly 0 to every pre-activation, so the migrated net computes the identical
function of the old columns (asserted by a self-check below). Biases and every
other layer are untouched. Uses:

* the architecture source for a ``--from-scratch`` v3 run (``train.py`` still
  loads ``--checkpoint`` for its ``ModelConfig`` even when it re-initializes);
* the [D-31] §4 warm-start FALLBACK arm (start v3 training from the migrated
  v2 policy — a true no-op at t=0).

Usage::

    python -m dicewars_bc.migrate_encoding \
        --ckpt checkpoints/v2-base/bc_model.pt \
        --out  checkpoints/v3-base/bc_model.pt
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch

from .model import EdgePolicyNet, ModelConfig

# The four wire-width fields of ModelConfig, keyed to the first-layer weight each
# feeds. Kept explicit (not derived from constants) so the mapping documents the
# concat layouts the tail-append relies on.
_WIDTH_FIELDS = ("node_features", "player_features", "board_features", "edge_features")
_TARGET = {
    "node_features": 13,
    "player_features": 7,
    "board_features": 7,
    "edge_features": 10,
}
_SOURCE_VERSION = 2
_TARGET_VERSION = 3

# first-layer weight key → the config field whose delta widens it.
_WIDEN = {
    "node_encoder.0.weight": "node_features",
    "player_encoder.0.weight": "player_features",
    "context.0.weight": "board_features",
    "edge_head.0.weight": "edge_features",
}


def migrate_checkpoint(ckpt: dict) -> dict:
    """Return a v3 copy of a v2 BC-format checkpoint (state_dict widened, config
    and ``encoding_version`` restamped). Pure — the input dict is not mutated.

    :raises ValueError: if the checkpoint is not v2-stamped or a width field
        does not match the v2 wire.
    """
    ev = ckpt.get("encoding_version")
    if ev != _SOURCE_VERSION:
        raise ValueError(
            f"migrate_encoding: checkpoint encoding_version={ev!r}, expected {_SOURCE_VERSION} — "
            "this migration only widens v2 → v3."
        )
    cfg = dict(ckpt["config"])
    v2_widths = {"node_features": 8, "player_features": 6, "board_features": 5, "edge_features": 7}
    for field in _WIDTH_FIELDS:
        if cfg.get(field) != v2_widths[field]:
            raise ValueError(
                f"migrate_encoding: config.{field}={cfg.get(field)!r} is not the v2 wire width "
                f"{v2_widths[field]} — refusing to guess a column mapping."
            )

    state = {k: v.clone() for k, v in ckpt["state_dict"].items()}
    for key, field in _WIDEN.items():
        w = state[key]
        delta = _TARGET[field] - cfg[field]
        # Appended features sit at the TAIL of this weight's input, so the new
        # columns go at the end; zero-init = the migrated net ignores them.
        state[key] = torch.cat([w, torch.zeros(w.shape[0], delta, dtype=w.dtype)], dim=1)

    new_cfg = {**cfg, **_TARGET}
    out = {
        **ckpt,
        "state_dict": state,
        "config": new_cfg,
        "encoding_version": _TARGET_VERSION,
        "migrated_from_encoding": _SOURCE_VERSION,
    }
    _assert_function_preserved(ckpt, out)
    return out


def _assert_function_preserved(old_ckpt: dict, new_ckpt: dict) -> None:
    """Self-check: the migrated net on tail-padded inputs must equal the source
    net on the original inputs. Zero weights multiply arbitrary pad values to
    exact zeros, but a wider GEMM may accumulate the surviving products in a
    different order, so compare with a tight tolerance rather than bit-equality.
    Cheap (one tiny forward pair)."""
    old_cfg = ModelConfig(**old_ckpt["config"])
    new_cfg = ModelConfig(**new_ckpt["config"])
    old_net = EdgePolicyNet(old_cfg)
    old_net.load_state_dict(old_ckpt["state_dict"])
    new_net = EdgePolicyNet(new_cfg)
    new_net.load_state_dict(new_ckpt["state_dict"])
    old_net.eval()
    new_net.eval()

    g = torch.Generator().manual_seed(0)
    a, p, e = old_cfg.max_areas, old_cfg.player_count, 5
    nodes = torch.rand(1, a, old_cfg.node_features, generator=g)
    nodes[:, :, EdgePolicyNet.PRESENT_COL] = (nodes[:, :, EdgePolicyNet.PRESENT_COL] > 0.3).float()
    players = torch.rand(1, p, old_cfg.player_features, generator=g)
    board = torch.rand(1, old_cfg.board_features, generator=g)
    edge_feat = torch.rand(e, old_cfg.edge_features, generator=g)
    edge_from = torch.randint(0, a, (e,), generator=g)
    edge_to = torch.randint(0, a, (e,), generator=g)
    edge_batch = torch.zeros(e, dtype=torch.int64)

    def pad(t: torch.Tensor, width: int) -> torch.Tensor:
        extra = torch.full((*t.shape[:-1], width - t.shape[-1]), 0.7, dtype=t.dtype)
        return torch.cat([t, extra], dim=-1)

    with torch.no_grad():
        old_logits, old_value = old_net(
            nodes, players, board, edge_feat, edge_from, edge_to, edge_batch
        )
        new_logits, new_value = new_net(
            pad(nodes, new_cfg.node_features),
            pad(players, new_cfg.player_features),
            pad(board, new_cfg.board_features),
            pad(edge_feat, new_cfg.edge_features),
            edge_from,
            edge_to,
            edge_batch,
        )
    ok = torch.allclose(old_logits, new_logits, atol=1e-6, rtol=0) and torch.allclose(
        old_value, new_value, atol=1e-6, rtol=0
    )
    if not ok:
        raise AssertionError(
            "migrate_encoding: migrated net is NOT function-preserving — a concat layout "
            "assumption is wrong (appended features must sit at each input's tail)."
        )


def main(argv: list[str] | None = None) -> Path:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ckpt", required=True, help="source v2 BC-format checkpoint (.pt)")
    ap.add_argument("--out", required=True, help="destination v3 checkpoint (.pt)")
    args = ap.parse_args(argv)

    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    migrated = migrate_checkpoint(ckpt)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(migrated, out)
    print(
        f"migrated {args.ckpt} (v{_SOURCE_VERSION}) -> {out} (v{_TARGET_VERSION}); "
        "function-preservation self-check passed"
    )
    return out


if __name__ == "__main__":
    main()
