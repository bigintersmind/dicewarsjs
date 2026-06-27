"""Periodic self-play snapshot publisher for the PFSP league (Phase 3, task B step B3 — [D-22]/[D-23]).

An SB3 :class:`~stable_baselines3.common.callbacks.BaseCallback` that, every ``snapshot_every`` env
steps, repacks the live PPO actor back into BC-checkpoint format, exports it to a ``.weights.js``
module in ``snapshot_dir``, and atomically republishes ``manifest.json`` listing every snapshot. The
Node env-server's ``league.refresh()`` (``scripts/lib/ppo-league.mjs``) polls that manifest at each
episode boundary and hot-loads the new snapshots as in-process ``ai_bc`` opponents — the PFSP pool the
learner trains against.

This is the **producer half** only: the pool, the seeded sampler, the win-rate book, and the
``poolCap`` FIFO/disk-GC are all Node-resident ([D-22], forced by the bare-i32 learner↔env wire — the
trainer cannot select opponents per-episode over it). The producer just publishes artifacts.

Reuse, not reinvention: ``repack_to_bc_checkpoint`` + ``export`` are the exact step-7 gate path
(PR #61), already proven to produce a module ``makeBC`` accepts — so a snapshot needs **no per-snapshot
parity fixture** ([D-22] decision 6); ``fixture_path=None``.

Atomic publish ordering (so a poller never sees a torn or dangling reference):

1. write the ``.weights.js`` to its final path and ``fsync`` it — durable FIRST;
2. write ``manifest.json`` to a temp file, ``fsync``, then ``os.replace`` it into place — atomic on
   POSIX, and the now-referenced weights file is already on disk.

Frozen invariant: the manifest stamps ``encodingVersion = EXPECTED_ENCODING_VERSION`` (2). The whole
run must hold it — ``makeBC`` hard-throws on skew, so a mid-run bump makes pooled snapshots unloadable
(the Node ``refresh()`` rejects a skewed manifest loudly rather than training on a broken pool).
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


class SnapshotCallback(BaseCallback):
    """Publish a PFSP self-play snapshot every ``snapshot_every`` env steps.

    :param snapshot_dir: directory to write ``snap-*.weights.js`` + ``manifest.json`` into. The Node
        env-server is pointed at ``<snapshot_dir>/manifest.json`` via ``--snapshot-manifest``.
    :param snapshot_every: publish cadence in total env steps (across all vec-envs). Must be > 0.
    :param teacher: provenance stamped into each exported module's header.
    """

    def __init__(
        self,
        snapshot_dir: str | Path,
        snapshot_every: int,
        *,
        teacher: str = "ppo-snapshot",
        verbose: int = 0,
    ) -> None:
        super().__init__(verbose)
        if int(snapshot_every) <= 0:
            raise ValueError(f"snapshot_every must be a positive int, got {snapshot_every!r}")
        self.snapshot_dir = Path(snapshot_dir)
        self.snapshot_every = int(snapshot_every)
        self.teacher = teacher
        self._last_snapshot_step = 0
        self._snapshots: list[dict] = []  # manifest entries, ascending step (append-only)

    def _on_training_start(self) -> None:
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)

    def _on_step(self) -> bool:
        # ``num_timesteps`` is SB3's total-env-steps counter (summed over vec-envs). Publish the first
        # time it crosses a multiple of the cadence; never at step 0 (that snapshot is just the
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
            # 2) export the JS weights module — no parity fixture (makeBC needs only weights, [D-22]).
            export(tmp_pt, weights_path, fixture_path=None)
        finally:
            tmp_pt.unlink(missing_ok=True)

        # Make the weights durable BEFORE the manifest references it (atomic-publish ordering).
        _fsync_path(weights_path)

        # 3) append + atomically republish the manifest (weights already on disk).
        self._snapshots.append(
            {
                "id": snap_id,
                "step": int(step),
                "weights": weights_name,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        )
        self._write_manifest_atomic()
        if self.verbose:
            print(f"[snapshot] published {snap_id} ({len(self._snapshots)} total) → {weights_path}")

    def _write_manifest_atomic(self) -> None:
        """Rewrite ``manifest.json`` via temp-file + ``os.replace`` (atomic; never torn for a poller).

        Schema (a NEW manifest, distinct from the BC-corpus ``manifest.py`` one) — mirrored by the Node
        consumer ``ppo-league.refresh()``::

            {"encodingVersion": 2, "snapshots": [{"id","step","weights","createdAt"}], "latestStep": N}
        """
        manifest = {
            "encodingVersion": EXPECTED_ENCODING_VERSION,
            "snapshots": self._snapshots,
            "latestStep": self._snapshots[-1]["step"] if self._snapshots else 0,
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
