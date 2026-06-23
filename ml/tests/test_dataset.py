"""Dataset memmap reads, CSR slicing, collation, and game-level split."""

import numpy as np
import pytest

from _fixtures import default_corpus

torch = pytest.importorskip("torch")

from dicewars_bc.dataset import CorpusDataset, collate, split_by_game  # noqa: E402


def test_len_and_item_shapes(tmp_path):
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    ds = CorpusDataset(corpus)
    assert len(ds) == 7

    item = ds[0]
    assert item["nodes"].shape == (6, 5)
    assert item["players"].shape == (2, 6)
    assert item["board"].shape == (5,)
    assert item["edge_feat"].shape[1] == 4
    assert item["edge_index"].shape == (item["edge_feat"].shape[0], 2)
    assert item["value"].shape == (2,)
    assert item["label"].dtype == torch.int64
    assert 0 <= int(item["label"]) < item["edge_feat"].shape[0]


def test_csr_slice_matches_global(tmp_path):
    """A step's edge slice equals the raw global CSR slice for that step."""
    corpus = default_corpus(tmp_path / "c")
    ds = CorpusDataset(corpus)
    for i in range(len(ds)):
        o0, o1 = int(ds.edge_offsets[i]), int(ds.edge_offsets[i + 1])
        item = ds[i]
        assert item["edge_feat"].shape[0] == o1 - o0
        np.testing.assert_allclose(item["edge_feat"].numpy(), ds.edges[o0:o1])
        # Last edge of every step is STOP (isStop column == 1).
        assert item["edge_feat"][-1, 3] == 1.0


def test_collate_segments_and_offsets(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    ds = CorpusDataset(corpus)
    items = [ds[i] for i in range(3)]
    batch = collate(items)

    counts = [it["edge_feat"].shape[0] for it in items]
    total = sum(counts)
    assert batch.nodes.shape[0] == 3
    assert batch.edge_feat.shape[0] == total
    assert batch.edge_offsets.tolist() == [0, counts[0], counts[0] + counts[1], total]
    # edge_batch tags each edge with its step.
    expected_batch = sum(([i] * c for i, c in enumerate(counts)), [])
    assert batch.edge_batch.tolist() == expected_batch
    # Labels stay LOCAL (unchanged from the per-item labels).
    assert batch.labels.tolist() == [int(it["label"]) for it in items]


def test_split_by_game_no_leakage(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    ds = CorpusDataset(corpus)
    train_idx, val_idx = split_by_game(ds, val_frac=0.34, seed=1)

    # Disjoint, and together they cover every step.
    assert set(train_idx).isdisjoint(set(val_idx))
    assert sorted([*train_idx, *val_idx]) == list(range(len(ds)))

    games = ds.game_indices()
    train_games = set(games[train_idx].tolist())
    val_games = set(games[val_idx].tolist())
    # No game straddles the split.
    assert train_games.isdisjoint(val_games)
    assert len(val_games) == 1  # round(3 * 0.34) == 1


def test_split_val_frac_zero(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    ds = CorpusDataset(corpus)
    train_idx, val_idx = split_by_game(ds, val_frac=0.0)
    assert len(val_idx) == 0
    assert len(train_idx) == len(ds)
