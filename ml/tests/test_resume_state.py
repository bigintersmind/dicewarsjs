"""Tests for the sb3-FREE resume core (``dicewars_ppo.resume_state``, PR-5, [D-26]).

Gates on ``torch`` ONLY (the lean CI tier has CPU torch but no ``sb3``), so these RUN IN CI — the
riskiest hinge logic (atomic ``latest.json`` written LAST, pointer rejection, GC keep-N, the RNG
``weights_only`` round-trip) is covered without a GPU/sb3. The ``sb3`` learner glue (``MaskablePPO``
load + callback) is exercised separately, shodan-only, in ``test_resume.py``.

``save_resume_checkpoint`` takes a duck-typed model with ``.save(path)``, so a tiny ``FakeModel``
(no sb3) drives the full save/GC path here.
"""

from __future__ import annotations

import json

import pytest

torch = pytest.importorskip("torch")

import dicewars_ppo.resume_state as rs  # noqa: E402


class FakeModel:
    """A stand-in for the SB3 model: ``.save(path)`` writes a tiny file at the exact path."""

    def save(self, path):
        from pathlib import Path

        Path(str(path)).write_bytes(b"zip-bytes")


def _steps_on_disk(state_dir):
    return sorted(int(p.stem.split("-")[1]) for p in state_dir.glob("ckpt-*.zip"))


# --- RNG sidecar -------------------------------------------------------------------------------


def test_capture_restore_rng_roundtrips():
    torch.manual_seed(123)
    state = rs._capture_rng()
    before = torch.rand(4)
    torch.rand(100)  # advance the stream so we're somewhere else
    rs._restore_rng(state)
    assert torch.equal(torch.rand(4), before)  # restored ⇒ same draw as right after capture


def test_load_rng_sidecar_uses_weights_only_false(tmp_path):
    # The sidecar bundles numpy's MT19937 tuple + python random state, which weights_only=True (the
    # torch>=2.6 default) CANNOT deserialize. load_rng_sidecar must pass weights_only=False, else
    # every resume crashes on a modern torch — this round-trip via that exact path is the guard.
    torch.manual_seed(7)
    rng_path = tmp_path / "x.rng.pt"
    torch.save(rs._capture_rng(), rng_path)
    before = torch.rand(3)
    torch.rand(50)
    rs.load_rng_sidecar(rng_path)  # restores via weights_only=False
    assert torch.equal(torch.rand(3), before)


# --- save + atomic latest.json -----------------------------------------------------------------


def test_save_writes_pair_and_latest_points_at_step(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 50_000)
    assert (tmp_path / "ckpt-000050000.zip").is_file()
    assert (tmp_path / "ckpt-000050000.rng.pt").is_file()
    ptr = rs.read_latest_pointer(tmp_path)
    assert ptr["step"] == 50_000
    assert ptr["ckpt"] == "ckpt-000050000.zip"
    assert ptr["rng"] == "ckpt-000050000.rng.pt"
    assert ptr["version"] == rs.RESUME_FORMAT_VERSION


def test_latest_written_last_failure_before_pointer_leaves_no_latest(tmp_path, monkeypatch):
    # The FIRST checkpoint: if the RNG save fails before latest.json is written, there must be NO
    # torn pointer (a resume would see "no usable point" → fresh, not a dangling reference).
    def boom(obj, path, *a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(rs.torch, "save", boom)
    with pytest.raises(RuntimeError):
        rs.save_resume_checkpoint(FakeModel(), tmp_path, 100)
    assert not rs.latest_pointer_exists(tmp_path)
    assert rs.read_latest_pointer(tmp_path) is None


def test_failed_checkpoint_leaves_prior_latest_intact(tmp_path, monkeypatch):
    # A LATER checkpoint torn mid-write must leave the PREVIOUS durable pointer untouched (bounded
    # loss, not corruption) — the crash hinge.
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 100)  # durable
    real_save = rs.torch.save

    def boom(obj, path, *a, **k):
        if str(path).endswith(".rng.pt"):
            raise RuntimeError("disk full")
        return real_save(obj, path, *a, **k)

    monkeypatch.setattr(rs.torch, "save", boom)
    with pytest.raises(RuntimeError):
        rs.save_resume_checkpoint(FakeModel(), tmp_path, 200)
    assert rs.read_latest_pointer(tmp_path)["step"] == 100  # still the durable one


# --- pointer rejection -------------------------------------------------------------------------


def test_read_latest_pointer_none_when_absent(tmp_path):
    assert rs.read_latest_pointer(tmp_path) is None
    assert rs.latest_pointer_exists(tmp_path) is False


def test_read_latest_pointer_none_on_torn_json(tmp_path):
    (tmp_path / rs.LATEST_NAME).write_text("{ not valid json")
    assert rs.read_latest_pointer(tmp_path) is None
    assert rs.latest_pointer_exists(tmp_path) is True  # present-but-corrupt ⇒ caller warns


def test_read_latest_pointer_none_on_version_skew(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    p = tmp_path / rs.LATEST_NAME
    data = json.loads(p.read_text())
    data["version"] = rs.RESUME_FORMAT_VERSION + 1
    p.write_text(json.dumps(data))
    assert rs.read_latest_pointer(tmp_path) is None
    assert rs.latest_pointer_exists(tmp_path) is True


def test_read_latest_pointer_none_on_encoding_skew(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    p = tmp_path / rs.LATEST_NAME
    data = json.loads(p.read_text())
    data["encodingVersion"] = 999
    p.write_text(json.dumps(data))
    assert rs.read_latest_pointer(tmp_path) is None


def test_read_latest_pointer_none_when_referenced_file_missing(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    (tmp_path / "ckpt-000000010.zip").unlink()
    assert rs.read_latest_pointer(tmp_path) is None  # dangling reference ⇒ not usable


def test_has_resume_checkpoint(tmp_path):
    assert rs.has_resume_checkpoint(tmp_path) is False
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 5)
    assert rs.has_resume_checkpoint(tmp_path) is True


# --- GC ----------------------------------------------------------------------------------------


def test_gc_keeps_newest_keep_and_removes_pairs_together(tmp_path):
    m = FakeModel()
    for step in (100, 200, 300, 400):
        rs.save_resume_checkpoint(m, tmp_path, step, keep=2)
    assert _steps_on_disk(tmp_path) == [300, 400]  # newest 2 survive
    for s in (300, 400):
        assert (tmp_path / f"ckpt-{s:09d}.zip").is_file()
        assert (tmp_path / f"ckpt-{s:09d}.rng.pt").is_file()
    # aged-out pairs removed ENTIRELY (no orphan half)
    assert not (tmp_path / "ckpt-000000100.zip").exists()
    assert not (tmp_path / "ckpt-000000100.rng.pt").exists()
    assert rs.read_latest_pointer(tmp_path)["step"] == 400  # pointer still resolves


def test_gc_never_removes_referenced_even_at_keep_one(tmp_path):
    m = FakeModel()
    rs.save_resume_checkpoint(m, tmp_path, 100, keep=1)
    rs.save_resume_checkpoint(m, tmp_path, 200, keep=1)
    assert _steps_on_disk(tmp_path) == [200]
    assert rs.has_resume_checkpoint(tmp_path)
    assert rs.read_latest_pointer(tmp_path)["step"] == 200
