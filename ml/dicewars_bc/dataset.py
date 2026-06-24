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

from dataclasses import dataclass, fields

import numpy as np
import torch
from torch.utils.data import Dataset

from .manifest import CorpusManifest, load_manifest


def _memmap(m: CorpusManifest, name: str) -> np.memmap:
    return np.memmap(m.file_path(name), dtype=m.dtype(name), mode="r", shape=m.shape(name))


def _all_finite(arr, chunk: int = 1 << 24) -> bool:
    """True iff every element is finite (no NaN/inf), checked in fixed-size chunks.

    A flat ``np.isfinite(arr).all()`` would materialize a bool array the size of the
    whole blob — defeating the point of memmapping a tens-of-GB corpus. Chunking keeps
    peak memory flat (~16M elems/chunk) and short-circuits on the first bad chunk."""
    flat = np.asarray(arr).reshape(-1)
    for i in range(0, flat.size, chunk):
        if not np.isfinite(flat[i : i + chunk]).all():
            return False
    return True


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

        self._validate_integrity()

    def _validate_integrity(self) -> None:
        """One-time corpus sanity checks at load. The CSR/label checks read only the
        small per-step i32 arrays; the edge_index range check and the float-finiteness
        check each make a single O(N) pass over the larger blobs (negligible next to a
        multi-hour training run). Turns a contract break (a dropped STOP edge, an
        out-of-range label, an out-of-range territory id, a non-finite float feature,
        a truncated/non-CSR offset array) into a loud error at the seam, rather than an
        ``-inf``/``nan`` loss or a silent neighbor-row read deep in training (the
        segmented loss assumes every step has >=1 edge and a per-slice-local label; the
        model gathers node embeddings by ``edge_batch * max_areas + id``)."""
        offsets = np.asarray(self.edge_offsets, dtype=np.int64)
        labels = np.asarray(self.labels, dtype=np.int64)
        total_edges = self.edges.shape[0]

        if offsets[0] != 0:
            raise ValueError(f"edge_offsets[0] must be 0, got {offsets[0]}.")
        if offsets[-1] != total_edges:
            raise ValueError(
                f"edge_offsets[-1]={offsets[-1]} != edges row count {total_edges} — "
                f"truncated/corrupt corpus."
            )
        counts = np.diff(offsets)
        if counts.size and counts.min() < 1:
            bad = int(np.argmin(counts))
            raise ValueError(
                f"step {bad} has {int(counts[bad])} edges — every step must have >=1 (the trailing "
                f"STOP edge). A dropped STOP would silently mis-index the segmented loss."
            )
        out_of_range = (labels < 0) | (labels >= counts)
        if out_of_range.any():
            bad = int(np.argmax(out_of_range))
            raise ValueError(
                f"label {int(labels[bad])} at step {bad} is out of range [0, {int(counts[bad])}) "
                f"for its edge slice — labels must be LOCAL chosen-edge indices."
            )

        # edge_index ids must address a real node row [0, max_areas). The model
        # gathers from/to node embeddings by `edge_batch * max_areas + id`, so an
        # out-of-range id would silently index a neighbouring step's node block
        # instead of erroring (an id past the very last block would instead trip
        # torch's own index bounds-check — caught, but far from this seam). The JS
        # encoder guarantees in-range ids; this catches a corrupt/hand-built corpus.
        # STOP edges use sentinel id 0, which is in range.
        max_areas = self.manifest.max_areas
        ei_min = int(self.edge_index.min())
        ei_max = int(self.edge_index.max())
        if ei_min < 0 or ei_max >= max_areas:
            raise ValueError(
                f"edge_index id out of range [0, {max_areas}): min={ei_min}, max={ei_max}. "
                f"Ids must address a territory node row (STOP uses sentinel 0)."
            )

        # Float feature blobs must be finite. A NaN/inf would sail through the integer
        # checks above and surface as a silent `nan` loss deep in training (the same
        # fail-at-the-seam rationale, for the f32 inputs). Chunked so a tens-of-GB blob
        # never lands fully in RAM (see _all_finite).
        for blob_name, arr in (
            ("nodes", self.nodes),
            ("players", self.players),
            ("board", self.board),
            ("edges", self.edges),
            ("value", self.value),
        ):
            if not _all_finite(arr):
                raise ValueError(
                    f"{blob_name}.f32 contains NaN/inf — corrupt corpus; "
                    f"float features must be finite."
                )

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

    def to(self, device) -> Batch:
        # Every field is a tensor; move them generically so adding a field can't
        # silently leave it on the wrong device (the hand-written version had to be
        # kept in sync by hand).
        return Batch(**{f.name: getattr(self, f.name).to(device) for f in fields(self)})


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
    if val_frac > 0:
        # Never empty the training set: keep at least one game in train even when
        # rounding (or a tiny corpus) would otherwise route every game to val. An
        # empty train split silently trains on nothing — see the guard in train().
        n_val = min(n_val, len(games) - 1)
    val_games = set(games[:n_val].tolist())

    is_val = np.fromiter(
        (g in val_games for g in game_of_step), dtype=bool, count=len(game_of_step)
    )
    all_steps = np.arange(len(game_of_step))
    return all_steps[~is_val], all_steps[is_val]
