"""Dataset memmap reads, CSR slicing, collation, and game-level split."""

from dataclasses import fields

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
    assert item["nodes"].shape == (6, 8)  # v2: 8 node features
    assert item["players"].shape == (2, 6)
    assert item["board"].shape == (5,)
    assert item["edge_feat"].shape[1] == 7  # v2: 7 edge features
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


def test_integrity_rejects_out_of_range_label(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    labels = np.fromfile(corpus / "labels.i32", dtype="<i4")
    labels[0] = 999  # far outside step 0's edge slice
    labels.tofile(corpus / "labels.i32")
    with pytest.raises(ValueError, match="out of range"):
        CorpusDataset(corpus)


def test_integrity_rejects_empty_segment(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    offsets = np.fromfile(corpus / "edge_offsets.i32", dtype="<i4")
    offsets[1] = offsets[0]  # step 0 now owns zero edges (no STOP)
    offsets.tofile(corpus / "edge_offsets.i32")
    with pytest.raises(ValueError, match=">=1"):
        CorpusDataset(corpus)


def test_integrity_rejects_out_of_range_edge_index(tmp_path):
    corpus = default_corpus(tmp_path / "c")  # max_areas == 6
    ei = np.fromfile(corpus / "edge_index.i32", dtype="<i4")
    ei[0] = 999  # a territory id far past max_areas
    ei.tofile(corpus / "edge_index.i32")
    with pytest.raises(ValueError, match="out of range"):
        CorpusDataset(corpus)


def test_integrity_rejects_negative_edge_index(tmp_path):
    # The lower half of the `ei_min < 0 or ei_max >= max_areas` guard: a negative id
    # would index backwards into the previous step's node block (edge_batch * A + id),
    # a silent mis-gather rather than an error — so it must be rejected at the seam.
    corpus = default_corpus(tmp_path / "c")  # max_areas == 6
    ei = np.fromfile(corpus / "edge_index.i32", dtype="<i4")
    ei[0] = -1
    ei.tofile(corpus / "edge_index.i32")
    with pytest.raises(ValueError, match="out of range"):
        CorpusDataset(corpus)


def test_integrity_rejects_edge_index_equal_to_max_areas(tmp_path):
    # Off-by-one boundary: the range is half-open [0, max_areas), so id == max_areas
    # is the first INVALID value and must raise. Pins the `>=` (vs `>`) in the guard.
    corpus = default_corpus(tmp_path / "c")  # max_areas == 6
    ei = np.fromfile(corpus / "edge_index.i32", dtype="<i4")
    ei[0] = 6  # == max_areas
    ei.tofile(corpus / "edge_index.i32")
    with pytest.raises(ValueError, match="out of range"):
        CorpusDataset(corpus)


def test_integrity_accepts_max_in_range_edge_index(tmp_path):
    # Positive boundary: max_areas - 1 is the highest valid node row and must NOT be
    # rejected — guards against an over-eager check that would flag the top of range.
    corpus = default_corpus(tmp_path / "c")  # max_areas == 6
    ei = np.fromfile(corpus / "edge_index.i32", dtype="<i4")
    ei[0] = 5  # max_areas - 1
    ei.tofile(corpus / "edge_index.i32")
    ds = CorpusDataset(corpus)  # must construct without raising
    assert len(ds) == 7


def test_integrity_rejects_nan_in_float_blob(tmp_path):
    # A NaN in any f32 feature blob is corruption that would otherwise surface as a
    # silent `nan` loss deep in training — reject it at load, like the integer checks.
    corpus = default_corpus(tmp_path / "c")
    nodes = np.fromfile(corpus / "nodes.f32", dtype="<f4")
    nodes[0] = np.nan
    nodes.tofile(corpus / "nodes.f32")
    with pytest.raises(ValueError, match="NaN/inf"):
        CorpusDataset(corpus)


def test_batch_to_moves_every_field(tmp_path):
    # Batch.to() rebuilds generically over dataclass fields; the result must be a Batch
    # whose every field is a tensor on the target device. A non-tensor field added later
    # would raise here — the regression the generic rewrite is meant to guard against.
    corpus = default_corpus(tmp_path / "c")
    ds = CorpusDataset(corpus)
    batch = collate([ds[i] for i in range(len(ds))]).to("cpu")
    for f in fields(batch):
        t = getattr(batch, f.name)
        assert isinstance(t, torch.Tensor)
        assert t.device.type == "cpu"


def test_split_val_frac_zero(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    ds = CorpusDataset(corpus)
    train_idx, val_idx = split_by_game(ds, val_frac=0.0)
    assert len(val_idx) == 0
    assert len(train_idx) == len(ds)


def test_split_by_game_keeps_train_nonempty(tmp_path):
    """A val_frac that would round every game into val must still leave >=1 game
    (and thus >=1 step) in train — an empty train split is a silent no-op run."""
    corpus = default_corpus(tmp_path / "c")  # 3 games
    ds = CorpusDataset(corpus)
    train_idx, val_idx = split_by_game(ds, val_frac=0.99, seed=0)
    assert len(train_idx) > 0  # the clamp keeps >=1 game in train
    games = ds.game_indices()
    assert len(set(games[train_idx].tolist())) == 1  # exactly one game stays in train
    assert len(set(games[val_idx].tolist())) == 2
    assert set(train_idx).isdisjoint(set(val_idx))
