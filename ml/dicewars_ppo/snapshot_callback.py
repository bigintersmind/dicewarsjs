"""Periodic self-play snapshot publisher for the PFSP league (Phase 3, task B step B3).

An SB3 :class:`~stable_baselines3.common.callbacks.BaseCallback` that, every
``snapshot_every`` env steps, repacks the live PPO actor back into BC-checkpoint format,
exports it to a ``.weights.js`` module in ``snapshot_dir``, and atomically republishes
``manifest.json`` listing the newest ``pool_cap`` snapshots. The Node env-server's
``league.refresh()`` (``scripts/lib/ppo-league.mjs``) polls that manifest at each episode
boundary and hot-loads the new snapshots as in-process ``ai_bc`` opponents — the PFSP pool
the learner trains on. See [D-22]/[D-23].

This is the **producer half**: it publishes artifacts and — as of task E / PR-3 — is the
**single owner of disk GC**. Under ``SubprocVecEnv`` many Node env-server consumers share one
``snapshot_dir``; if each consumer unlinked its own FIFO-evicted files they would race to
delete each other's (and a lagging consumer would import a path a peer just removed), so
deletion was pulled to this one producer. Consumers now only TRIM their in-memory pool and
tolerate a missing file. The seeded sampler and win-rate book stay Node-resident ([D-22],
forced by the bare-i32 learner-env wire). The producer keeps the newest ``pool_cap`` in the
manifest and ``pool_cap + gc_grace`` on disk (a grace buffer for a consumer mid-import during
a manifest truncation), unlinking older files after the truncated manifest is durable.

Resume (task E / PR-3): ``_on_training_start`` rehydrates the manifest from a prior run (minus
entries published AHEAD of the resumed step), so a relaunched run does not republish ids the
league already pooled nor restart numbering from zero.

Reuse, not reinvention: ``repack_to_bc_checkpoint`` + ``export`` are the exact step-7 gate
path (PR #61), already proven to produce a module ``makeBC`` accepts — so a snapshot needs
**no per-snapshot parity fixture** ([D-22] decision 6); ``fixture_path=None``.

Atomic publish ordering (so a poller never sees a torn or dangling reference):

1. write the ``.weights.js`` to its final path and ``fsync`` it — durable FIRST;
2. write ``manifest.json`` to a temp file, ``fsync``, then ``os.replace`` it into place —
   atomic on POSIX, and the now-referenced weights file is already on disk.

Frozen invariant: the manifest stamps ``encodingVersion = EXPECTED_ENCODING_VERSION`` (2).
The whole run must hold it — ``makeBC`` hard-throws on skew, so a mid-run bump makes pooled
snapshots unloadable (the Node ``refresh()`` rejects a skewed manifest loudly rather than
training on a broken pool).
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import torch
from stable_baselines3.common.callbacks import BaseCallback

from dicewars_bc.export_weights import export
from dicewars_bc.manifest import EXPECTED_ENCODING_VERSION

from .policy import repack_to_bc_checkpoint
from .snapshot_manifest import gc_partition, rehydrate_snapshots


class SnapshotCallback(BaseCallback):
    """Publish a PFSP self-play snapshot every ``snapshot_every`` env steps.

    :param snapshot_dir: directory to write ``snap-*.weights.js`` + ``manifest.json`` into. The Node
        env-server is pointed at ``<snapshot_dir>/manifest.json`` via ``--snapshot-manifest``.
    :param snapshot_every: publish cadence in total env steps (across all vec-envs). Must be > 0.
    :param pool_cap: max snapshots the manifest lists (the consumers' sampleable set). Match the
        env-server league's ``--snapshot-pool-cap``. The manifest is truncated to the newest
        ``pool_cap`` on each publish (task E / PR-3). Must be > 0.
    :param gc_grace: extra snapshots kept ON DISK beyond the manifest (a buffer for a consumer
        mid-import during a manifest truncation). Files older than ``pool_cap + gc_grace`` are
        unlinked here by the single producer. Must be >= 0.
    :param teacher: provenance stamped into each exported module's header.
    """

    def __init__(
        self,
        snapshot_dir: str | Path,
        snapshot_every: int,
        *,
        pool_cap: int = 40,
        gc_grace: int = 10,
        teacher: str = "ppo-snapshot",
        verbose: int = 0,
    ) -> None:
        super().__init__(verbose)
        if int(snapshot_every) <= 0:
            raise ValueError(f"snapshot_every must be a positive int, got {snapshot_every!r}")
        if int(pool_cap) <= 0:
            raise ValueError(f"pool_cap must be a positive int, got {pool_cap!r}")
        if int(gc_grace) < 0:
            raise ValueError(f"gc_grace must be a non-negative int, got {gc_grace!r}")
        self.snapshot_dir = Path(snapshot_dir)
        self.snapshot_every = int(snapshot_every)
        # Single-writer GC (task E / PR-3): the manifest lists the newest `pool_cap` (match the
        # env-server league's --snapshot-pool-cap so consumers see exactly the sampleable set);
        # disk keeps `pool_cap + gc_grace` (a grace buffer for a consumer mid-import during a
        # truncation — its ENOENT tolerance is the real backstop). Older files are unlinked here,
        # by the single producer, so N SubprocVecEnv consumers never race to delete each other's.
        self._pool_cap = int(pool_cap)
        self._gc_grace = int(gc_grace)
        self.teacher = teacher
        self._last_snapshot_step = 0
        # Tracked entries, ascending step; bounded to the newest `pool_cap + gc_grace` after each
        # publish (the on-disk retention set), NOT append-only forever.
        self._snapshots: list[dict] = []

    def _on_training_start(self) -> None:
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        # Resume rehydration (task E / PR-3): adopt a prior run's manifest (minus entries AHEAD of
        # the resumed step) so we neither republish ids the league already pooled nor restart id
        # numbering from zero. Without it, a resumed run re-writes `snap-<step>` ids it already
        # published — duplicate manifest entries + a double-seated pool. `self.model.num_timesteps`
        # is the resumed env-step count (SB3 restores it under `learn(reset_num_timesteps=False)`);
        # the callback's own `self.num_timesteps` is not synced at training-start, so read model's.
        manifest_path = self.snapshot_dir / "manifest.json"
        if not manifest_path.is_file():
            return
        try:
            prior = json.loads(manifest_path.read_text())
        except (OSError, ValueError) as err:
            # A corrupt/half-written manifest must not crash training start — log and start fresh
            # (the league re-polls and rebuilds its pool from the persisted snapshots regardless).
            print(f"[snapshot] ignoring unreadable manifest.json on resume ({err}); starting fresh")
            return
        resumed_step = self.model.num_timesteps
        self._snapshots = rehydrate_snapshots(prior.get("snapshots", []), resumed_step)
        self._last_snapshot_step = resumed_step
        if self._snapshots:
            print(
                f"[snapshot] resumed manifest: kept {len(self._snapshots)} entries "
                f"(step <= {resumed_step})"
            )

    def _on_step(self) -> bool:
        # ``num_timesteps`` is SB3's total env steps (summed over vec-envs). Publish the first
        # time it crosses a cadence multiple; never at step 0 (that snapshot is just the
        # warm-start = the ai_bc baseline, already in the field).
        if self.num_timesteps - self._last_snapshot_step >= self.snapshot_every:
            self._last_snapshot_step = self.num_timesteps
            self._publish(self.num_timesteps)
        return True

    def _publish(self, step: int) -> None:
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)
        snap_id = f"snap-{int(step):09d}"
        weights_name = f"{snap_id}.weights.js"
        weights_path = self.snapshot_dir / weights_name

        # 1) repack the LIVE actor → BC-format checkpoint dict → temp .pt (export() reads a path).
        repacked = repack_to_bc_checkpoint(
            self.model.policy,
            extra={"teacher": self.teacher, "ppo_step": int(step)},
        )
        tmp_fd, tmp_name = tempfile.mkstemp(suffix=".pt", dir=str(self.snapshot_dir))
        os.close(tmp_fd)
        tmp_pt = Path(tmp_name)
        try:
            torch.save(repacked, tmp_pt)
            # 2) export the JS weights module — no parity fixture (makeBC needs weights only).
            export(tmp_pt, weights_path, fixture_path=None)
        finally:
            tmp_pt.unlink(missing_ok=True)

        # Make the weights durable BEFORE the manifest references it (atomic-publish ordering).
        _fsync_path(weights_path)

        # 3) append, then single-writer GC (task E / PR-3): the manifest lists the newest pool_cap;
        # disk keeps the newest pool_cap + gc_grace; older files are deleted. ORDER MATTERS: write
        # the TRUNCATED manifest FIRST (so a crash never leaves the manifest referencing a file we
        # then delete), THEN unlink aged-out files. `gc_partition` keeps the deletable set disjoint
        # from the manifest, so the producer never removes a referenced file.
        self._snapshots.append(
            {
                "id": snap_id,
                "step": int(step),
                "weights": weights_name,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        )
        manifest_entries, retained, deletable = gc_partition(
            self._snapshots, self._pool_cap, self._gc_grace
        )
        self._write_manifest_atomic(manifest_entries)
        for s in deletable:
            (self.snapshot_dir / s["weights"]).unlink(missing_ok=True)
        # Bound the tracked history to what is still on disk so the next gc_partition is over the
        # live set (it would otherwise grow unbounded across a multi-day run).
        self._snapshots = retained
        if self.verbose:
            print(
                f"[snapshot] published {snap_id} ({len(manifest_entries)} in manifest, "
                f"{len(deletable)} GC'd) → {weights_path}"
            )

    def _write_manifest_atomic(self, entries: list[dict]) -> None:
        """Rewrite ``manifest.json`` via temp-file + ``os.replace`` (atomic; never torn).

        ``entries`` is the (already pool_cap-truncated) list the manifest should list. Schema (a NEW
        manifest, distinct from the BC-corpus ``manifest.py`` one), mirrored by the Node consumer
        ``ppo-league.refresh()``::

            {"encodingVersion":2, "snapshots":[{"id","step","weights","createdAt"}], "latestStep":N}
        """
        manifest = {
            "encodingVersion": EXPECTED_ENCODING_VERSION,
            "snapshots": entries,
            "latestStep": entries[-1]["step"] if entries else 0,
        }
        manifest_path = self.snapshot_dir / "manifest.json"
        tmp_path = manifest_path.with_name(manifest_path.name + ".tmp")
        tmp_path.write_text(json.dumps(manifest, indent=2) + "\n")
        _fsync_path(tmp_path)
        os.replace(tmp_path, manifest_path)  # atomic rename on POSIX


def _fsync_path(path: Path) -> None:
    """``fsync`` a written file so its bytes are durable before anything references it."""
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
