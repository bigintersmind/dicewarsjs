"""Pure manifest-helper math (Phase 3, task E / PR-3) — runs in the lean torch-free CI tier.

These cover the resume-rehydration filter and the single-writer GC partition independently of the
SB3 callback that wires them (which needs torch/stable-baselines3 and so runs only on shodan). The
callback integration is covered by ``test_snapshot_callback.py``; the *logic* lives — and is
tested — here, where no GPU stack is needed.
"""

from __future__ import annotations

import pytest

from dicewars_ppo.snapshot_manifest import (
    gc_partition,
    plan_resume,
    rehydrate_snapshots,
    snapshot_entry_from_filename,
)


def _snap(step):
    return {"id": f"snap-{step}", "step": step, "weights": f"snap-{step}.weights.js"}


def _snaps(*steps):
    return [_snap(s) for s in steps]


# --- snapshot_entry_from_filename -------------------------------------------------------------


def test_entry_from_filename_parses_and_keeps_padded_id():
    assert snapshot_entry_from_filename("snap-000000256.weights.js") == {
        "id": "snap-000000256",
        "step": 256,
        "weights": "snap-000000256.weights.js",
    }


def test_entry_from_filename_zero_pads_a_short_step():
    # The producer always zero-pads the id to 9 digits; a shorter on-disk step still yields the
    # padded id (so a resume rescan keys on the same id the original publish used).
    assert snapshot_entry_from_filename("snap-5.weights.js") == {
        "id": "snap-000000005",
        "step": 5,
        "weights": "snap-5.weights.js",
    }


@pytest.mark.parametrize(
    "name",
    [
        "snap-000000256.weights.js.tmp",  # torn-export sidecar — THE atomic-export safety net
        "snap-.weights.js",  # no step digits
        "snap-abc.weights.js",  # non-numeric step
        "manifest.json",  # the manifest itself
        "snap-100.weights.js.bak",  # trailing junk (anchored \Z rejects it)
        "prefix-snap-100.weights.js",  # not anchored at the start (match() anchors start)
        "snap-100.weights.mjs",  # wrong extension
        "snap-100.js",  # missing the .weights segment
    ],
)
def test_entry_from_filename_rejects_non_snapshots(name):
    # A non-conforming filename must never be adopted into the producer's GC/rehydration set —
    # this is what stops a torn .tmp export from being re-globbed as a real snapshot on resume.
    assert snapshot_entry_from_filename(name) is None


# --- rehydrate_snapshots ----------------------------------------------------------------------


def test_rehydrate_keeps_entries_at_or_before_resumed_step():
    snaps = _snaps(100, 200, 300)
    assert [s["step"] for s in rehydrate_snapshots(snaps, 250)] == [100, 200]


def test_rehydrate_keeps_an_entry_exactly_at_the_resumed_step():
    # `<=` boundary: a snapshot published exactly at the resumed step is kept (re-reaching it is the
    # same step, not a future republish).
    assert [s["step"] for s in rehydrate_snapshots(_snaps(100, 200), 200)] == [100, 200]


def test_rehydrate_drops_all_when_resuming_before_the_first_snapshot():
    assert rehydrate_snapshots(_snaps(100, 200), 50) == []


def test_rehydrate_is_order_preserving_and_nonmutating():
    snaps = _snaps(100, 200, 300)
    out = rehydrate_snapshots(snaps, 999)
    assert [s["step"] for s in out] == [100, 200, 300]
    assert len(snaps) == 3  # input untouched


# --- gc_partition -----------------------------------------------------------------------------


def test_gc_partition_manifest_is_newest_pool_cap():
    manifest, retained, deletable = gc_partition(
        _snaps(100, 200, 300, 400, 500), pool_cap=2, gc_grace=1
    )
    assert [s["step"] for s in manifest] == [400, 500]  # newest pool_cap
    assert [s["step"] for s in retained] == [300, 400, 500]  # newest pool_cap + gc_grace
    assert [s["step"] for s in deletable] == [100, 200]  # the rest


def test_gc_partition_invariants_hold():
    manifest, retained, deletable = gc_partition(_snaps(1, 2, 3, 4, 5, 6), pool_cap=3, gc_grace=2)
    msteps = {s["step"] for s in manifest}
    rsteps = {s["step"] for s in retained}
    dsteps = {s["step"] for s in deletable}
    assert msteps <= rsteps  # manifest is a subset of what's retained on disk
    assert rsteps.isdisjoint(dsteps)  # never delete a retained (or manifest) file
    assert rsteps | dsteps == {1, 2, 3, 4, 5, 6}  # every entry is either retained or deletable


def test_gc_partition_nothing_deletable_below_disk_budget():
    manifest, retained, deletable = gc_partition(_snaps(100, 200), pool_cap=40, gc_grace=10)
    assert [s["step"] for s in manifest] == [100, 200]
    assert [s["step"] for s in retained] == [100, 200]
    assert deletable == []


def test_gc_partition_sorts_unordered_input_by_step():
    manifest, _retained, deletable = gc_partition(_snaps(300, 100, 200), pool_cap=1, gc_grace=0)
    assert [s["step"] for s in manifest] == [300]  # newest by step regardless of input order
    assert {s["step"] for s in deletable} == {100, 200}


def test_gc_partition_zero_grace_deletes_everything_below_pool_cap():
    _manifest, retained, deletable = gc_partition(_snaps(1, 2, 3), pool_cap=1, gc_grace=0)
    assert [s["step"] for s in retained] == [3]
    assert [s["step"] for s in deletable] == [1, 2]


@pytest.mark.parametrize("pool_cap", [0, -1])
def test_gc_partition_rejects_nonpositive_pool_cap(pool_cap):
    with pytest.raises(ValueError, match="pool_cap"):
        gc_partition(_snaps(1), pool_cap=pool_cap, gc_grace=0)


def test_gc_partition_rejects_negative_grace():
    with pytest.raises(ValueError, match="gc_grace"):
        gc_partition(_snaps(1), pool_cap=1, gc_grace=-1)


# --- plan_resume ------------------------------------------------------------------------------


def test_plan_resume_readopts_grace_zone_so_it_stays_gc_eligible():
    # The leak fix: disk holds pool_cap + gc_grace, the manifest lists only pool_cap. Resuming from
    # the FULL on-disk set (not the truncated manifest) must re-track the grace zone in `retained`,
    # else those files are never GC-eligible again. Here pool_cap=2, gc_grace=1, resume past all.
    manifest, retained, deletable, future = plan_resume(
        _snaps(300, 400, 500), resumed_step=999, pool_cap=2, gc_grace=1
    )
    assert [s["step"] for s in manifest] == [400, 500]  # manifest = newest pool_cap
    assert [s["step"] for s in retained] == [
        300,
        400,
        500,
    ]  # grace-zone 300 re-adopted, GC-eligible
    assert deletable == []
    assert future == []


def test_plan_resume_marks_future_entries_for_deletion():
    # A pre-crash snapshot AHEAD of the resumed step is republished by the resumed run → its stale
    # file must be deleted (the republish-divergence window). It is NOT in the manifest/retained.
    manifest, retained, deletable, future = plan_resume(
        _snaps(100, 200, 300), resumed_step=250, pool_cap=40, gc_grace=10
    )
    assert [s["step"] for s in future] == [300]
    assert [s["step"] for s in manifest] == [100, 200]
    assert [s["step"] for s in retained] == [100, 200]
    assert deletable == []  # below the disk budget, nothing aged out


def test_plan_resume_partitions_grace_and_future_together():
    # Both zones at once: resume at 350 over disk 100..600 with pool_cap=2, gc_grace=1.
    manifest, retained, deletable, future = plan_resume(
        _snaps(100, 200, 300, 400, 500, 600), resumed_step=350, pool_cap=2, gc_grace=1
    )
    assert [s["step"] for s in future] == [400, 500, 600]  # ahead of 350 → delete + republish
    assert [s["step"] for s in manifest] == [200, 300]  # kept = [100,200,300]; newest pool_cap
    assert [s["step"] for s in retained] == [100, 200, 300]  # newest pool_cap + gc_grace
    assert [s["step"] for s in deletable] == []  # only 3 kept, exactly the disk budget


def test_plan_resume_materializes_a_generator_input():
    # plan_resume iterates on_disk TWICE (rehydrate, then the future split). Without the
    # internal `list(on_disk)`, a generator would be exhausted after the first pass and `future`
    # would silently come back empty — reopening the HOLE-C republish window with no other signal.
    # Passing an iterator locks the materialization in.
    _manifest, _retained, _deletable, future = plan_resume(
        iter(_snaps(100, 200, 300, 400, 500, 600)), resumed_step=350, pool_cap=2, gc_grace=1
    )
    assert [s["step"] for s in future] == [400, 500, 600]


def test_plan_resume_unordered_input_and_empty():
    manifest, retained, deletable, future = plan_resume(
        _snaps(300, 100, 200), resumed_step=999, pool_cap=1, gc_grace=0
    )
    assert [s["step"] for s in manifest] == [300]  # newest by step regardless of input order
    assert {s["step"] for s in deletable} == {100, 200}
    assert future == []
    # Empty disk (fresh run) → all-empty plan, no error.
    assert plan_resume([], resumed_step=0, pool_cap=40, gc_grace=10) == ([], [], [], [])
