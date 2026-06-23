"""Dataset + batching for the packed BC corpus.

Reads the little-endian blobs described by ``manifest.json`` with ``np.memmap``
(so an 8M-step / tens-of-GB corpus never lands fully in RAM), serves one
*decision step* per item, and collates a batch into the flat/segmented layout
the model consumes.

The on-disk **CSR edge layout** is the crux: each step owns a variable-length
slice of the global edge tensors, ``edges[edge_offsets[i] : edge_offsets[i+1]]``.
We keep edges flat and tag every edge with the batch-local step it belongs to
(``edge_batch``) plus per-batch CSR offsets (``edge_offsets``) — no padding, and
it maps 1:1 onto both the training loss and the single-step ONNX inference graph.

Train/val splitting is done **by game**, not by step: steps from one game are
highly correlated (same board, adjacent turns), so a per-step split would leak.
``meta[:, 0]`` is the game index; we partition games, then gather their steps.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
from torch.utils.data import Dataset

from .manifest import CorpusManifest, load_manifest


def _memmap(m: CorpusManifest, name: str) -> np.memmap:
    return np.memmap(m.file_path(name), dtype=m.dtype(name), mode="r", shape=m.shape(name))


class CorpusDataset(Dataset):
    """One item per teacher decision step.

    ``__getitem__`` returns python/np-backed tensors copied out of the memmaps
    (so DataLoader worker processes never alias the mmap pages across the
    collate boundary):

        nodes      [max_areas, node_features]  float32
        players    [player_count, player_features] float32
        board      [board_features]            float32
        edge_feat  [n_edges, edge_features]     float32
        edge_index [n_edges, 2]  (from_id, to_id) int64
        label      ()  int64  — LOCAL chosen-edge index within this step's slice
        value      [2] (won, placement)         float32
    """

    def __init__(self, corpus_dir, manifest: CorpusManifest | None = None):
        self.manifest = manifest or load_manifest(corpus_dir)
        m = self.manifest

        self.nodes = _memmap(m, "nodes.f32")
        self.players = _memmap(m, "players.f32")
        self.board = _memmap(m, "board.f32")
        self.edges = _memmap(m, "edges.f32")
        self.edge_index = _memmap(m, "edge_index.i32")
        self.edge_offsets = _memmap(m, "edge_offsets.i32")
        self.labels = _memmap(m, "labels.i32")
        self.value = _memmap(m, "value.f32")
        self.meta = _memmap(m, "meta.i32")

    def __len__(self) -> int:
        return self.manifest.steps

    def __getitem__(self, i: int) -> dict[str, torch.Tensor]:
        o0 = int(self.edge_offsets[i])
        o1 = int(self.edge_offsets[i + 1])
        # np.array(..., copy) detaches from the read-only memmap, so the returned
        # tensors are writable and don't alias mmap pages across DataLoader workers.
        return {
            "nodes": torch.from_numpy(np.array(self.nodes[i], dtype=np.float32)),
            "players": torch.from_numpy(np.array(self.players[i], dtype=np.float32)),
            "board": torch.from_numpy(np.array(self.board[i], dtype=np.float32)),
            "edge_feat": torch.from_numpy(np.array(self.edges[o0:o1], dtype=np.float32)),
            "edge_index": torch.from_numpy(np.array(self.edge_index[o0:o1], dtype=np.int64)),
            "label": torch.tensor(int(self.labels[i]), dtype=torch.int64),
            "value": torch.from_numpy(np.array(self.value[i], dtype=np.float32)),
        }

    def game_indices(self) -> np.ndarray:
        """Per-step game index (``meta[:, 0]``), as a plain int64 array."""
        return np.ascontiguousarray(self.meta[:, 0], dtype=np.int64)


@dataclass
class Batch:
    """A collated batch in the flat/segmented layout the model consumes.

    ``edge_batch[e]`` is the batch-local step index (0..B-1) that edge ``e``
    belongs to; ``edge_offsets`` are the per-batch CSR row pointers (length
    B+1, ``edge_offsets[0] == 0``). ``labels`` stay LOCAL (index within each
    step's own edge slice) — the loss recovers the global row as
    ``edge_offsets[b] + labels[b]``.
    """

    nodes: torch.Tensor  # [B, A, Fn]
    players: torch.Tensor  # [B, P, Fp]
    board: torch.Tensor  # [B, Fb]
    edge_feat: torch.Tensor  # [E, Fe]
    edge_from: torch.Tensor  # [E] int64
    edge_to: torch.Tensor  # [E] int64
    edge_batch: torch.Tensor  # [E] int64
    edge_offsets: torch.Tensor  # [B+1] int64
    labels: torch.Tensor  # [B] int64
    value: torch.Tensor  # [B, 2]

    @property
    def batch_size(self) -> int:
        return self.nodes.shape[0]

    def to(self, device) -> "Batch":
        return Batch(
            nodes=self.nodes.to(device),
            players=self.players.to(device),
            board=self.board.to(device),
            edge_feat=self.edge_feat.to(device),
            edge_from=self.edge_from.to(device),
            edge_to=self.edge_to.to(device),
            edge_batch=self.edge_batch.to(device),
            edge_offsets=self.edge_offsets.to(device),
            labels=self.labels.to(device),
            value=self.value.to(device),
        )


def collate(items: list[dict[str, torch.Tensor]]) -> Batch:
    """Stack dense per-step tensors; concatenate ragged edge tensors flat and
    build the segment ids + per-batch CSR offsets."""
    counts = torch.tensor([it["edge_feat"].shape[0] for it in items], dtype=torch.int64)
    edge_offsets = torch.zeros(len(items) + 1, dtype=torch.int64)
    torch.cumsum(counts, dim=0, out=edge_offsets[1:])

    edge_index = torch.cat([it["edge_index"] for it in items], dim=0)

    return Batch(
        nodes=torch.stack([it["nodes"] for it in items]),
        players=torch.stack([it["players"] for it in items]),
        board=torch.stack([it["board"] for it in items]),
        edge_feat=torch.cat([it["edge_feat"] for it in items], dim=0),
        edge_from=edge_index[:, 0].contiguous(),
        edge_to=edge_index[:, 1].contiguous(),
        edge_batch=torch.repeat_interleave(torch.arange(len(items)), counts),
        edge_offsets=edge_offsets,
        labels=torch.stack([it["label"] for it in items]),
        value=torch.stack([it["value"] for it in items]),
    )


def split_by_game(
    dataset: CorpusDataset, val_frac: float, seed: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Partition **games** into train/val, then return the step indices of each.

    Splitting by game (not step) prevents leakage from correlated same-game
    steps. Returns ``(train_step_indices, val_step_indices)``.
    """
    if not 0.0 <= val_frac < 1.0:
        raise ValueError(f"val_frac must be in [0, 1), got {val_frac}")

    game_of_step = dataset.game_indices()
    games = np.unique(game_of_step)
    rng = np.random.default_rng(seed)
    rng.shuffle(games)

    n_val = int(round(len(games) * val_frac))
    val_games = set(games[:n_val].tolist())

    is_val = np.fromiter((g in val_games for g in game_of_step), dtype=bool, count=len(game_of_step))
    all_steps = np.arange(len(game_of_step))
    return all_steps[~is_val], all_steps[is_val]
