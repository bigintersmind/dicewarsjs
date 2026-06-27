"""Tests for the PFSP snapshot publisher (Phase 3, task B step B3 — [D-22]/[D-23]).

The callback's NEW logic is the atomic manifest publish + the schema the Node consumer
(``scripts/lib/ppo-league.mjs`` ``refresh()``) reads. The repack→export step it wraps is the
exact step-7 gate path, already proven to produce a ``makeBC``-loadable module — so these tests
monkeypatch ``repack_to_bc_checkpoint`` + ``export`` and focus on the cadence, the atomic
publish, and the manifest schema. A torn or schema-drifted manifest is the failure these guard
against; the JS side's ``ppo-league-snapshots.test.js`` proves the same schema loads.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

import dicewars_ppo.snapshot_callback as snapshot_callback
from dicewars_bc.manifest import EXPECTED_ENCODING_VERSION
from dicewars_ppo.snapshot_callback import SnapshotCallback


def _patch_export(monkeypatch):
    """Replace repack+export with fakes: repack returns a dict; export writes a stub .js."""

    def fake_repack(policy, *, extra=None):
        return {"fake_state": 1, "extra": dict(extra or {})}

    def fake_export(ckpt_path, out_path, fixture_path=None):
        from pathlib import Path

        Path(out_path).write_text("export const BC_POLICY = {};\n")
        return Path(out_path)

    monkeypatch.setattr(snapshot_callback, "repack_to_bc_checkpoint", fake_repack)
    monkeypatch.setattr(snapshot_callback, "export", fake_export)


def test_snapshot_every_must_be_positive():
    with pytest.raises(ValueError, match="snapshot_every must be a positive int"):
        SnapshotCallback("/tmp/snaps", 0)


def test_write_manifest_atomic_schema(tmp_path):
    """The manifest matches the Node consumer's schema exactly; no torn temp file is left behind."""
    cb = SnapshotCallback(tmp_path, snapshot_every=10)
    cb._on_training_start()
    cb._snapshots = [
        {
            "id": "snap-000000010",
            "step": 10,
            "weights": "snap-000000010.weights.js",
            "createdAt": "t0",
        },
        {
            "id": "snap-000000020",
            "step": 20,
            "weights": "snap-000000020.weights.js",
            "createdAt": "t1",
        },
    ]
    cb._write_manifest_atomic()

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["encodingVersion"] == EXPECTED_ENCODING_VERSION == 2
    assert manifest["latestStep"] == 20
    assert [s["id"] for s in manifest["snapshots"]] == ["snap-000000010", "snap-000000020"]
    assert set(manifest["snapshots"][0]) == {"id", "step", "weights", "createdAt"}
    assert not (tmp_path / "manifest.json.tmp").exists()  # temp renamed away, not left torn


def test_publish_exports_weights_and_lists_them(tmp_path, monkeypatch):
    _patch_export(monkeypatch)
    cb = SnapshotCallback(tmp_path, snapshot_every=256, teacher="ppo-snapshot")
    cb.model = SimpleNamespace(policy=SimpleNamespace())  # repack is faked → policy unused
    cb._on_training_start()

    cb._publish(256)

    weights = tmp_path / "snap-000000256.weights.js"
    assert weights.exists() and weights.read_text().startswith("export const BC_POLICY")
    snaps = json.loads((tmp_path / "manifest.json").read_text())["snapshots"]
    assert len(snaps) == 1
    assert snaps[0] == {
        "id": "snap-000000256",
        "step": 256,
        "weights": "snap-000000256.weights.js",
        "createdAt": snaps[0]["createdAt"],  # timestamp present (exact value not pinned)
    }
    assert snaps[0]["createdAt"]  # non-empty ISO stamp
    # No leftover temp checkpoint (.pt) or torn manifest temp.
    assert not list(tmp_path.glob("*.pt"))
    assert not list(tmp_path.glob("manifest.json.tmp"))


def test_on_step_publishes_on_cadence_only(tmp_path, monkeypatch):
    cb = SnapshotCallback(tmp_path, snapshot_every=10)
    published: list[int] = []
    monkeypatch.setattr(cb, "_publish", lambda step: published.append(step))

    for ts, expected in [(5, []), (10, [10]), (15, [10]), (20, [10, 20]), (33, [10, 20, 33])]:
        cb.num_timesteps = ts
        cb._on_step()
        assert published == expected


def test_publish_appends_in_step_order(tmp_path, monkeypatch):
    _patch_export(monkeypatch)
    cb = SnapshotCallback(tmp_path, snapshot_every=100)
    cb.model = SimpleNamespace(policy=SimpleNamespace())
    cb._on_training_start()

    cb._publish(100)
    cb._publish(200)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert [s["step"] for s in manifest["snapshots"]] == [100, 200]
    assert manifest["latestStep"] == 200
