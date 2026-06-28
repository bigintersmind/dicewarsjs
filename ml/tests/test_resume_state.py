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


def test_load_rng_sidecar_always_maps_to_cpu(tmp_path, monkeypatch):
    # GPU-resume blocker regression, CPU-observable: the sidecar must load to CPU regardless of the
    # model's device. RNG generator states are CPU ByteTensors and torch.(cuda.)set_rng_state reject
    # a GPU-mapped tensor — forwarding the model's --device cuda into map_location crashed EVERY GPU
    # resume. The CUDA smoke test in test_resume.py never runs in CI / on the Mac; this pins the
    # exact invariant (load goes to CPU) without a GPU, so a map_location=device regression fails
    # HERE instead of only on a live shodan BEAT run.
    torch.save(rs._capture_rng(), tmp_path / "x.rng.pt")
    seen = {}
    real_load = rs.torch.load

    def spy(path, *a, **k):
        # map_location is torch.load's 2nd positional; capture either form so the assertion is
        # form-agnostic (kwarg today, but a positional refactor must still be pinned to CPU).
        seen["map_location"] = k.get("map_location", a[0] if a else None)
        return real_load(path, *a, **k)

    monkeypatch.setattr(rs.torch, "load", spy)
    rs.load_rng_sidecar(tmp_path / "x.rng.pt")
    assert seen["map_location"] == "cpu"  # never a CUDA device


def test_restore_rng_sidecar_restores_good_stream(tmp_path):
    torch.manual_seed(11)
    rng_path = tmp_path / "g.rng.pt"
    torch.save(rs._capture_rng(), rng_path)
    before = torch.rand(3)
    torch.rand(40)
    assert rs.restore_rng_sidecar(rng_path) is True  # restored
    assert torch.equal(torch.rand(3), before)


def test_restore_rng_sidecar_degrades_on_corrupt(tmp_path, capsys):
    # A torn/bit-rotted sidecar must NOT abort: restore_rng_sidecar returns False + warns, so a
    # resume whose model/optimizer/num_timesteps are already loaded continues with a fresh stream
    # rather than crash-looping under the PR-6 auto-restart.
    bad = tmp_path / "bad.rng.pt"
    bad.write_bytes(b"not a torch checkpoint")
    assert rs.restore_rng_sidecar(bad) is False  # degraded, did not raise
    assert "FRESH RNG stream" in capsys.readouterr().err


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


def test_read_latest_pointer_none_on_non_dict_json(tmp_path):
    # Valid JSON that isn't an object (e.g. a list) is still unusable — the isinstance(dict) gate.
    (tmp_path / rs.LATEST_NAME).write_text("[1, 2, 3]")
    assert rs.read_latest_pointer(tmp_path) is None
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_CORRUPT_JSON


# --- classify_latest_pointer (the CI-testable resume decision) ---------------------------------


def test_classify_absent_and_valid(tmp_path):
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_ABSENT
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_VALID


def test_classify_corrupt_json(tmp_path):
    (tmp_path / rs.LATEST_NAME).write_text("{ not valid json")
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_CORRUPT_JSON


def test_classify_version_skew(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    p = tmp_path / rs.LATEST_NAME
    data = json.loads(p.read_text())
    data["version"] = rs.RESUME_FORMAT_VERSION + 1
    p.write_text(json.dumps(data))
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_VERSION_SKEW


def test_classify_encoding_skew(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    p = tmp_path / rs.LATEST_NAME
    data = json.loads(p.read_text())
    data["encodingVersion"] = 999
    p.write_text(json.dumps(data))
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_ENCODING_SKEW


def test_classify_dangling_ref(tmp_path):
    rs.save_resume_checkpoint(FakeModel(), tmp_path, 10)
    (tmp_path / "ckpt-000000010.zip").unlink()
    assert rs.classify_latest_pointer(tmp_path) == rs.POINTER_DANGLING_REF


def test_describe_pointer_rejection_splits_by_recovery_action():
    # Pointer-only breakage ⇒ steer AWAY from deleting; build skew ⇒ incompatible.
    for recoverable in (rs.POINTER_CORRUPT_JSON, rs.POINTER_DANGLING_REF):
        assert "BEFORE deleting latest.json" in rs.describe_pointer_rejection(recoverable)
    for incompatible in (rs.POINTER_VERSION_SKEW, rs.POINTER_ENCODING_SKEW):
        assert "incompatible build" in rs.describe_pointer_rejection(incompatible)


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


def test_gc_sweeps_orphaned_rng_without_zip(tmp_path):
    # Simulate a prior half-failed GC (a transient _safe_unlink error left a lone .rng.pt at an old
    # step). Because _checkpoint_steps unions .zip AND .rng.pt names, the next GC re-enumerates that
    # step and sweeps the orphan — no half-pair leaks past one cadence.
    m = FakeModel()
    rs.save_resume_checkpoint(m, tmp_path, 100, keep=2)
    rs.save_resume_checkpoint(m, tmp_path, 200, keep=2)
    (tmp_path / "ckpt-000000050.rng.pt").write_bytes(b"orphan")  # a .zip-less sidecar from step 50
    rs.save_resume_checkpoint(m, tmp_path, 300, keep=2)  # survivors = newest 2 ⇒ {200, 300}
    assert not (tmp_path / "ckpt-000000050.rng.pt").exists()  # orphan swept
    assert _steps_on_disk(tmp_path) == [200, 300]


def test_gc_handles_10_digit_steps_above_1e9(tmp_path):
    # The :09d filename is a MINIMUM width, so >= 1e9 steps are 10 digits. _CKPT_RE/_RNG_RE use \d+
    # (not \d{9}); a fixed width would silently leak these pairs over a multi-day BEAT run.
    m = FakeModel()
    rs.save_resume_checkpoint(m, tmp_path, 1_500_000_000, keep=1)
    rs.save_resume_checkpoint(m, tmp_path, 1_600_000_000, keep=1)
    assert _steps_on_disk(tmp_path) == [1_600_000_000]  # old 10-digit pair GC'd
    assert rs.read_latest_pointer(tmp_path)["step"] == 1_600_000_000
    assert not (tmp_path / "ckpt-1500000000.rng.pt").exists()  # both halves of the old pair gone
