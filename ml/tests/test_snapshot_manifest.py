"""Pure manifest-helper math (Phase 3, task E / PR-3) — runs in the lean torch-free CI tier.

These cover the resume-rehydration filter and the single-writer GC partition independently of the
SB3 callback that wires them (which needs torch/stable-baselines3 and so runs only on shodan). The
callback integration is covered by ``test_snapshot_callback.py``; the *logic* lives — and is
tested — here, where no GPU stack is needed.
"""

from __future__ import annotations

import pytest

from dicewars_ppo.snapshot_manifest import gc_partition, rehydrate_snapshots


def _snap(step):
    return {"id": f"snap-{step}", "step": step, "weights": f"snap-{step}.weights.js"}


def _snaps(*steps):
    return [_snap(s) for s in steps]


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
