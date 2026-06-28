"""Pure (torch-free) PFSP snapshot-manifest helpers (Phase 3, task E / PR-3).

Split out of :mod:`dicewars_ppo.snapshot_callback` so the resume-rehydration and single-writer GC
*logic* can be unit-tested without importing torch / stable-baselines3 (the callback needs both to
repack the live model; these functions need neither). The callback wires them to the live SB3 model;
the bookkeeping math lives here, where the lean ``ml-test`` tier and a no-GPU dev box can cover it.

A "snapshot entry" is the dict the producer appends to its manifest:
``{"id", "step", "weights", "createdAt"}`` (see ``SnapshotCallback._publish``).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence

# A published weights file is ``snap-<zero-padded-step>.weights.js`` (see ``SnapshotCallback``).
# ANCHORED (``\Z``) so a torn export's ``.weights.js.tmp`` sidecar — or any stray/unrelated file —
# can never pose as a published snapshot and be adopted into the producer's GC/rehydration set. The
# capture group recovers the producer step: the manifest lists only the newest ``pool_cap``, so
# globbing disk by this pattern is what re-tracks the grace zone (and aged-out files) on resume.
_SNAPSHOT_FILE_RE = re.compile(r"snap-(\d+)\.weights\.js\Z")


def snapshot_entry_from_filename(name: str) -> dict | None:
    """Parse a published weights filename into a manifest entry, or ``None`` if it isn't one.

    Returns ``{"id", "step", "weights"}`` (the caller adds the informational ``createdAt`` from the
    file's mtime — kept out of here so this helper stays pure and torch-free). ``None`` for anything
    not matching the anchored ``snap-<step>.weights.js`` pattern: a ``.weights.js.tmp`` torn-export
    sidecar, or a stray/unrelated file. This exclusion is the producer-side half of the atomic-
    export safety net — a ``kill -9`` mid-export leaves a ``.tmp``, never a ``snap-*.weights.js``
    the resume disk-scan would re-adopt. ``id`` is the step zero-padded to 9 digits.
    """
    m = _SNAPSHOT_FILE_RE.match(name)
    if m is None:
        return None
    step = int(m.group(1))
    return {"id": f"snap-{step:09d}", "step": step, "weights": name}


def rehydrate_snapshots(snapshots: Iterable[dict], num_timesteps: int) -> list[dict]:
    """On resume, keep only entries at or before the step we are resuming at.

    A crashed run may have published snapshots at steps the resumed run has not re-reached yet (the
    checkpoint that drove the resume lagged the last snapshot). If we kept those "future" entries,
    re-reaching that step would republish the SAME id — overwriting its ``.weights.js`` and
    double-seating it in a consumer's pool. Dropping ``step > num_timesteps`` makes the producer's
    publish cadence monotonic across the restart. Order-preserving.
    """
    cutoff = int(num_timesteps)
    return [s for s in snapshots if int(s["step"]) <= cutoff]


def gc_partition(
    snapshots: Sequence[dict], pool_cap: int, gc_grace: int
) -> tuple[list[dict], list[dict], list[dict]]:
    """Partition published snapshots (sorted newest-by-step) into the three producer-GC zones.

    Returns ``(manifest_entries, retained, deletable)``:

    - ``manifest_entries`` — the newest ``pool_cap`` entries. This is what the manifest lists, so it
      is exactly what consumers load into their sampleable pool.
    - ``retained`` — the newest ``pool_cap + gc_grace`` entries. These are kept ON DISK. The grace
      zone (``[pool_cap, pool_cap + gc_grace)``) is an on-disk buffer *beyond* the manifest: it lets
      a consumer that read the manifest just before a truncation still find a file it is mid-import
      on. (The consumer's ENOENT tolerance is the real backstop; this just shrinks the race window.)
    - ``deletable`` — every older entry. Its ``.weights.js`` is safe to unlink (single-writer GC).

    Invariants: ``manifest_entries ⊆ retained`` and ``retained ∩ deletable = ∅`` (by step), so the
    producer never unlinks a file the manifest still references.
    """
    if not isinstance(pool_cap, int) or pool_cap <= 0:
        raise ValueError(f"pool_cap must be a positive int, got {pool_cap!r}")
    if not isinstance(gc_grace, int) or gc_grace < 0:
        raise ValueError(f"gc_grace must be a non-negative int, got {gc_grace!r}")

    ordered = sorted(snapshots, key=lambda s: int(s["step"]))
    keep_disk = pool_cap + gc_grace
    manifest_entries = ordered[-pool_cap:]
    retained = ordered[-keep_disk:]
    deletable = ordered[:-keep_disk] if keep_disk < len(ordered) else []
    return manifest_entries, retained, deletable


def plan_resume(
    on_disk: Iterable[dict], resumed_step: int, pool_cap: int, gc_grace: int
) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """Plan the producer's disk + manifest state on resume from what is ACTUALLY on disk.

    Task E / PR-3 hardening: the producer rehydrates from a directory scan of ``snap-*.weights.js``
    (passed in as ``on_disk``), NOT from the truncated manifest. The manifest only lists the newest
    ``pool_cap``, so trusting it would leave the ``gc_grace`` files that live on disk *beyond* the
    manifest untracked — and therefore never GC-eligible — leaking ``gc_grace`` files per resume.

    Returns ``(manifest_entries, retained, deletable, future)``:

    - ``future`` — entries with ``step > resumed_step``. The resumed run will republish these ids at
      the same step, so their stale files must be DELETED (a consumer importing the pre-crash
      weights for an id about to change is the republish-divergence window; the file would also be
      orphaned from this producer's GC). ``future`` is ``on_disk`` minus ``rehydrate_snapshots``.
    - ``manifest_entries`` / ``retained`` / ``deletable`` — ``gc_partition`` of the ``kept`` set
      (``step <= resumed_step``), so the producer re-adopts the grace zone into ``retained`` (keeps
      it GC-eligible), lists the newest ``pool_cap`` in a rewritten manifest, and may delete files
      already aged out beyond ``pool_cap + gc_grace``.

    Pure: the callback does the I/O (glob, ``unlink``, manifest write); the partitioning lives here.
    """
    # Materialize: we iterate ``on_disk`` twice (rehydrate + the future split). A generator would be
    # exhausted by ``rehydrate_snapshots`` and silently make ``future`` empty — reopening the HOLE-C
    # republish-divergence window with no test failure. Listing it first keeps any iterable safe.
    on_disk = list(on_disk)
    kept = rehydrate_snapshots(on_disk, resumed_step)
    cutoff = int(resumed_step)
    future = [s for s in on_disk if int(s["step"]) > cutoff]
    manifest_entries, retained, deletable = gc_partition(kept, pool_cap, gc_grace)
    return manifest_entries, retained, deletable, future
