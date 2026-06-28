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

# Skip the whole module if the PPO `[rl]` stack is absent (e.g. the CI `ml-test` job, which installs
# only `.[onnx,dev]`+gymnasium): snapshot_callback imports SB3's BaseCallback. Runs on shodan, where
# the full stack is installed. Mirrors test_ppo_policy.py.
pytest.importorskip("torch")
pytest.importorskip("stable_baselines3")

import dicewars_ppo.snapshot_callback as snapshot_callback  # noqa: E402
from dicewars_bc.manifest import EXPECTED_ENCODING_VERSION  # noqa: E402
from dicewars_ppo.snapshot_callback import SnapshotCallback  # noqa: E402


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


def _fake_model(num_timesteps=0):
    """Minimal stand-in for the SB3 model. ``_on_training_start`` reads ``num_timesteps`` (the
    resume cursor — 0 for a fresh run, the resumed env-step count otherwise); ``policy`` is what
    ``repack_to_bc_checkpoint`` consumes (faked in these tests). Both must be present, or
    ``_on_training_start``'s unconditional ``int(self.model.num_timesteps)`` raises
    ``AttributeError`` before the empty-dir short-circuit."""
    return SimpleNamespace(policy=SimpleNamespace(), num_timesteps=num_timesteps)


def test_snapshot_every_must_be_positive():
    with pytest.raises(ValueError, match="snapshot_every must be a positive int"):
        SnapshotCallback("/tmp/snaps", 0)


def test_write_manifest_atomic_schema(tmp_path):
    """The manifest matches the Node consumer's schema exactly; no torn temp file is left behind."""
    cb = SnapshotCallback(tmp_path, snapshot_every=10)
    cb.model = _fake_model()
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
    cb._write_manifest_atomic(cb._snapshots)

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["encodingVersion"] == EXPECTED_ENCODING_VERSION == 2
    assert manifest["latestStep"] == 20
    assert [s["id"] for s in manifest["snapshots"]] == ["snap-000000010", "snap-000000020"]
    assert set(manifest["snapshots"][0]) == {"id", "step", "weights", "createdAt"}
    assert not (tmp_path / "manifest.json.tmp").exists()  # temp renamed away, not left torn


def test_publish_exports_weights_and_lists_them(tmp_path, monkeypatch):
    _patch_export(monkeypatch)
    cb = SnapshotCallback(tmp_path, snapshot_every=256, teacher="ppo-snapshot")
    cb.model = _fake_model()  # repack is faked → policy unused
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
    # No leftover temp checkpoint (.pt), torn manifest temp, or torn weights temp (atomic export).
    assert not list(tmp_path.glob("*.pt"))
    assert not list(tmp_path.glob("manifest.json.tmp"))
    assert not list(tmp_path.glob("*.weights.js.tmp"))


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
    cb.model = _fake_model()
    cb._on_training_start()

    cb._publish(100)
    cb._publish(200)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert [s["step"] for s in manifest["snapshots"]] == [100, 200]
    assert manifest["latestStep"] == 200


def test_publish_truncates_manifest_and_gcs_old_files(tmp_path, monkeypatch):
    """Single-writer GC (task E / PR-3): manifest = newest pool_cap; disk = pool_cap + gc_grace."""
    _patch_export(monkeypatch)
    cb = SnapshotCallback(tmp_path, snapshot_every=100, pool_cap=2, gc_grace=1)
    cb.model = _fake_model()
    cb._on_training_start()
    for step in (100, 200, 300, 400, 500):
        cb._publish(step)

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    # Manifest lists only the newest pool_cap (=2).
    assert [s["step"] for s in manifest["snapshots"]] == [400, 500]
    assert manifest["latestStep"] == 500
    # Disk keeps pool_cap + gc_grace (=3): the two manifest files + one grace buffer (step 300).
    on_disk = sorted(p.name for p in tmp_path.glob("snap-*.weights.js"))
    assert on_disk == [
        "snap-000000300.weights.js",
        "snap-000000400.weights.js",
        "snap-000000500.weights.js",
    ]
    # GC never removes a manifest-referenced file.
    for s in manifest["snapshots"]:
        assert (tmp_path / s["weights"]).exists()
    assert not list(tmp_path.glob("*.pt"))
    assert not list(tmp_path.glob("manifest.json.tmp"))


def test_on_training_start_rehydrates_and_deletes_future_files(tmp_path, monkeypatch):
    """Resume rehydration (task E / PR-3, disk-scan): rebuild the tracked set from the snapshot dir
    minus entries ahead of the resumed step, DELETE those future files (they get republished), so
    re-reaching a step republishes its id exactly once (no duplicate, no stale weights)."""
    _patch_export(monkeypatch)
    # A prior run published snapshots at 100, 200, 300.
    cb0 = SnapshotCallback(tmp_path, snapshot_every=100)
    cb0.model = _fake_model()
    cb0._on_training_start()
    for step in (100, 200, 300):
        cb0._publish(step)

    # A new run resumes at step 250: snap-300 is AHEAD of the resume point and must be dropped AND
    # its stale file deleted (a consumer must not import pre-crash weights for a soon-changed id).
    cb = SnapshotCallback(tmp_path, snapshot_every=100)
    cb.model = _fake_model(250)
    cb._on_training_start()
    assert [s["step"] for s in cb._snapshots] == [100, 200]  # future snap-300 dropped from tracking
    assert not (
        tmp_path / "snap-000000300.weights.js"
    ).exists()  # ...and its file deleted on resume
    # The rewritten manifest no longer lists the future entry (closes the republish window).
    resumed_manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert [s["step"] for s in resumed_manifest["snapshots"]] == [100, 200]

    cb._publish(300)  # re-reached → republished exactly once, no duplicate id
    steps = [s["step"] for s in json.loads((tmp_path / "manifest.json").read_text())["snapshots"]]
    assert steps == [100, 200, 300]
    assert steps.count(300) == 1


def test_resume_readopts_grace_zone_so_it_is_gc_eligible(tmp_path, monkeypatch):
    """Disk leak fix (task E / PR-3): the manifest lists only pool_cap, but disk holds pool_cap +
    gc_grace. A resume must re-track the grace-zone files (by scanning disk, not reading the
    truncated manifest) so a later publish can still GC them — else they leak per resume."""
    _patch_export(monkeypatch)
    # Prior run, pool_cap=2 gc_grace=1: after 100..500, disk = [300,400,500], manifest = [400,500].
    cb0 = SnapshotCallback(tmp_path, snapshot_every=100, pool_cap=2, gc_grace=1)
    cb0.model = _fake_model()
    cb0._on_training_start()
    for step in (100, 200, 300, 400, 500):
        cb0._publish(step)
    assert sorted(p.name for p in tmp_path.glob("snap-*.weights.js")) == [
        "snap-000000300.weights.js",  # grace-zone file (NOT in the manifest)
        "snap-000000400.weights.js",
        "snap-000000500.weights.js",
    ]

    # Resume past all of them, then publish two more. If snap-300 (the grace-zone file) were not
    # re-tracked on resume, it could never enter `deletable` and would leak forever.
    cb = SnapshotCallback(tmp_path, snapshot_every=100, pool_cap=2, gc_grace=1)
    cb.model = _fake_model(500)
    cb._on_training_start()
    assert [s["step"] for s in cb._snapshots] == [300, 400, 500]  # grace zone re-adopted, tracked
    cb._publish(600)  # disk budget now exceeded → snap-300 must be GC'd, not leaked
    cb._publish(700)
    on_disk = sorted(p.name for p in tmp_path.glob("snap-*.weights.js"))
    assert "snap-000000300.weights.js" not in on_disk  # the formerly-leaked grace file is now GC'd
    assert on_disk == [
        "snap-000000500.weights.js",  # pool_cap + gc_grace = 3 newest survive
        "snap-000000600.weights.js",
        "snap-000000700.weights.js",
    ]


def test_publish_does_not_crash_when_gc_unlink_fails(tmp_path, monkeypatch):
    """Robustness (task E / PR-3): a non-FileNotFound FS error while deleting an AGED-OUT file is
    pure disk hygiene and must NOT crash a multi-day run (manifest + weights already durable)."""
    _patch_export(monkeypatch)
    cb = SnapshotCallback(tmp_path, snapshot_every=100, pool_cap=1, gc_grace=0)
    cb.model = _fake_model()
    cb._on_training_start()
    cb._publish(100)

    # Make the next GC unlink raise a non-FileNotFound OSError (e.g. EIO / read-only remount).
    real_unlink = snapshot_callback.Path.unlink

    def flaky_unlink(self, *args, **kwargs):
        if self.name == "snap-000000100.weights.js":
            raise OSError("simulated EIO on aged-out file")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(snapshot_callback.Path, "unlink", flaky_unlink)
    cb._publish(200)  # snap-100 ages out; its unlink raises — must be swallowed, not propagated

    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert [s["step"] for s in manifest["snapshots"]] == [
        200
    ]  # publish completed despite the error
    assert (tmp_path / "snap-000000100.weights.js").exists()  # left on disk for the next GC pass
