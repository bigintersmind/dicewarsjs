"""Manifest load/validation — pure numpy, no torch."""

import json

import pytest
from _fixtures import default_corpus

from dicewars_bc.manifest import EXPECTED_ENCODING_VERSION, load_manifest


def test_loads_valid_corpus(tmp_path):
    corpus = default_corpus(tmp_path / "c", max_areas=6, player_count=2)
    m = load_manifest(corpus)
    assert m.encoding_version == EXPECTED_ENCODING_VERSION
    assert m.max_areas == 6
    assert m.player_count == 2
    assert m.node_features == 13  # v3: owner attributes + income consequences
    assert m.player_features == 7  # v3: +turnsUntilActsNorm
    assert m.board_features == 7  # v3: +myStockNorm, +turnClockNorm
    assert m.edge_features == 10  # v3: +elimination/income deltas
    assert m.steps == 7
    assert m.shape("edge_offsets.i32") == (m.steps + 1,)


def test_missing_manifest(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_manifest(tmp_path / "nope")


def test_version_mismatch_raises(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    mpath = corpus / "manifest.json"
    raw = json.loads(mpath.read_text())
    raw["encodingVersion"] = 999
    mpath.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="version mismatch"):
        load_manifest(corpus)


def test_missing_blob_raises(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    (corpus / "nodes.f32").unlink()
    with pytest.raises(FileNotFoundError, match="nodes.f32"):
        load_manifest(corpus)


def test_inconsistent_shape_raises(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    mpath = corpus / "manifest.json"
    raw = json.loads(mpath.read_text())
    raw["files"]["edge_offsets.i32"]["shape"] = [raw["counts"]["steps"]]  # should be steps+1
    mpath.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="contradicts"):
        load_manifest(corpus)


def test_bad_dtype_raises(tmp_path):
    corpus = default_corpus(tmp_path / "c")
    mpath = corpus / "manifest.json"
    raw = json.loads(mpath.read_text())
    raw["files"]["nodes.f32"]["dtype"] = "<f8"
    mpath.write_text(json.dumps(raw))
    with pytest.raises(ValueError, match="dtype"):
        load_manifest(corpus)
