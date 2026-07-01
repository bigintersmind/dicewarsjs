"""Durable per-checkpoint eval producer for the strength-curve harness (Phase 0).

An SB3 :class:`~stable_baselines3.common.callbacks.BaseCallback` that, every ``eval_every``
env steps, repacks the live PPO actor into BC-checkpoint format and exports a **gradeable,
fixtured** ``eval-<step>.weights.js`` (+ its JS↔Python parity ``.fixture.json`` and the
intermediate ``.pt``) into a **non-GC'd** ``eval_dir``, appending a row to ``index.jsonl``.
The out-of-band Node scorer (``scripts/ppo-strength-curve.mjs``, Phase 1) walks that index and
runs the seat-fair gate on each checkpoint, building a strength-vs-steps curve so we can pick
the best checkpoint and see whether training is flattening or regressing.

Why a NEW callback rather than reusing :class:`SnapshotCallback`. They share the repack+export
seam but differ on three axes that matter for a *strength curve*:

* **No GC.** The whole point is a durable record — every 1M-step checkpoint is kept forever
  (a 20M run is ~20 tiny artifacts). ``SnapshotCallback`` FIFO-evicts to ``pool_cap`` because
  its consumers (the PFSP league) only ever sample the newest few.
* **A parity fixture is written** (``fixture_path=…``). The gate's mandatory pre-flight
  cross-checks the exported pure-JS forward against Python reference logits (1e-3 tol) before
  it grades a single game — so a numerically broken export can't fake a win-rate. League
  snapshots skip the fixture ([D-22]); an eval checkpoint needs it to be gradeable later.
* **The ``.pt`` is kept**, not deleted. It is the ship / re-export source: once the curve names
  the best checkpoint, ``export_weights.py`` re-emits it *packed* into ``src/ai/`` for the game.

This is a PRODUCER only — sub-second work in the training loop (a repack + a tiny forward for the
fixture; ``SnapshotCallback`` already proves that is ~tens of ms). The ~7-min arena scoring runs
out-of-band on a CPU box against this durable stream, so it never stalls the GPU rollout.

Publish ordering (so a poller/scorer never reads a torn file or adopts a dangling reference). Each
artifact is written to a ``.tmp`` sibling, ``fsync``'d, then ``os.replace``'d into place — an atomic
rename, so a consumer never sees a half-written file at its final name. The ``.weights.js`` is
renamed **last** and the resume disk-scan keys on ``eval-*.weights.js``, so a crash mid-``_emit``
leaves at most an un-adopted ``.fixture.json``/``.pt`` — never a discoverable weights file missing
its siblings. ``index.jsonl`` is rewritten (same temp→rename dance) only **after** all three renames
return, so it never lists a checkpoint whose weights file isn't on disk.

We ``fsync`` file *data*, not the parent *directory entry* (matching ``SnapshotCallback``): the
rename ordering above holds within a process and across a clean crash, but is not strictly
guaranteed across a *power loss* on a filesystem that may reorder directory updates. Both failure
windows self-correct — the index is rebuilt from disk on the next resume, and a lost/half-visible
checkpoint is at worst a missing curve point or a fixture-less file the scorer's parity pre-flight
rejects (never a mis-graded one). On shodan's ordered-journal FS this ordering holds in practice.

Resume. ``_on_training_start`` reads ``self.model.num_timesteps`` (the resumed env-step count SB3
restores under ``learn(reset_num_timesteps=False)``; the callback's own ``self.num_timesteps`` is
not synced yet at training-start), seeds the cadence cursor to it so a relaunch does not re-emit
steps ``0..resumed``, and rebuilds the tracked index by SCANNING disk. Any eval artifact AHEAD of
the resumed step is stale — the resumed rollout diverges from the pre-crash trajectory, so a
``eval-<future>`` would grade a policy state this run will never actually revisit — so those files
are deleted and dropped from the index. The resumed run re-covers that region at its next
``eval_every`` multiple past the resume point — the cadence grid re-anchors to the resume step, so
a dropped ``eval-<future>`` is not necessarily re-emitted at the same step (harmless: curve points
are keyed on the actual step in the filename/index).
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import torch
from stable_baselines3.common.callbacks import BaseCallback

from dicewars_bc.export_weights import export

from .policy import repack_to_bc_checkpoint

# Zero-padded step width in the ``eval-<step>`` id (matches SnapshotCallback's ``snap-<step:09d>``);
# 9 digits covers every campaign we run (20M steps is 8 digits).
_STEP_WIDTH = 9

# Anchored parse of a published weights filename → its step. Excludes any ``.tmp`` torn-export
# sidecar (which does not end in ``.weights.js``) from the resume disk-scan.
_EVAL_NAME_RE = re.compile(r"eval-(\d+)\.weights\.js$")


class EvalCheckpointCallback(BaseCallback):
    """Publish a durable, gradeable eval checkpoint every ``eval_every`` env steps.

    :param eval_dir: directory to write ``eval-*.weights.js`` + ``.fixture.json`` + ``.pt`` and
        ``index.jsonl`` into. Non-GC'd — every checkpoint is retained.
    :param eval_every: cadence in total env steps (summed across all vec-envs). Must be > 0.
    :param teacher: provenance stamped into each exported module's header + the index row.
    """

    def __init__(
        self,
        eval_dir: str | Path,
        eval_every: int,
        *,
        teacher: str = "ppo-eval",
        verbose: int = 0,
    ) -> None:
        super().__init__(verbose)
        if int(eval_every) <= 0:
            raise ValueError(f"eval_every must be a positive int, got {eval_every!r}")
        self.eval_dir = Path(eval_dir)
        self.eval_every = int(eval_every)
        self.teacher = teacher
        self._last_eval_step = 0
        # Tracked index rows, ascending by step. Rebuilt from disk on resume; never GC'd.
        self._entries: list[dict] = []

    def _on_training_start(self) -> None:
        self.eval_dir.mkdir(parents=True, exist_ok=True)
        # `self.model.num_timesteps` is the resumed env-step count (0 for a fresh run); the
        # callback's own `self.num_timesteps` is not synced at training-start, so read the model's.
        # Seed the cadence cursor to it so the first `_on_step` does not re-emit steps 0..resumed.
        resumed_step = int(self.model.num_timesteps)
        self._last_eval_step = resumed_step
        on_disk = self._discover_on_disk()
        if not on_disk:
            return  # fresh run (or nothing published yet) — nothing to rehydrate or reconcile
        retained = [e for e in on_disk if e["step"] <= resumed_step]
        future = [e for e in on_disk if e["step"] > resumed_step]
        # Delete stale future artifacts BEFORE rewriting the index so it never lists a removed file.
        for entry in future:
            self._delete_artifacts(entry)
        self._entries = retained
        self._write_index_atomic()
        if future:
            print(
                f"[eval] resumed at step {resumed_step}: kept {len(retained)}, "
                f"dropped {len(future)} future checkpoint(s) ahead of the resume point"
            )

    def _discover_on_disk(self) -> list[dict]:
        """Scan ``eval_dir`` for published ``eval-*.weights.js`` → index rows, ascending by step.

        The tracked set is rebuilt from disk on resume (see ``_on_training_start``). ``createdAt``
        is recovered from each weights file's mtime (informational; the step in the filename is
        the key).
        """
        entries: list[dict] = []
        for path in self.eval_dir.glob("eval-*.weights.js"):
            match = _EVAL_NAME_RE.search(path.name)
            if match is None:
                continue  # a stray / .tmp torn-export file — never adopt it
            step = int(match.group(1))
            try:
                created = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            except OSError:
                # Present but unstat-able (a flaky share) — createdAt is informational, so
                # synthesize one and still adopt the file (step from the filename classifies it).
                created = datetime.now(timezone.utc).isoformat()
            entries.append(self._entry(step, created))
        entries.sort(key=lambda e: e["step"])
        return entries

    def _on_step(self) -> bool:
        # `num_timesteps` is SB3's total env steps (summed over vec-envs), advancing by
        # n_steps*n_envs per rollout — so use the `>= cadence` CROSSING idiom (never `== N`, which a
        # rollout that steps past the exact multiple would skip). Emit the first time it crosses.
        if self.num_timesteps - self._last_eval_step >= self.eval_every:
            self._last_eval_step = self.num_timesteps
            self._emit(self.num_timesteps)
        return True

    def _on_training_end(self) -> None:
        # Always grade the FINAL policy (= what train.py repacks to --out and the game ships), even
        # when the run ends between cadence multiples. Guard against a double-emit when the last
        # `_on_step` already emitted at exactly this step (then `num_timesteps == _last_eval_step`).
        final = int(self.model.num_timesteps)
        if final > self._last_eval_step:
            self._last_eval_step = final
            self._emit(final)

    def _emit(self, step: int) -> None:
        self.eval_dir.mkdir(parents=True, exist_ok=True)
        eval_id = f"eval-{int(step):0{_STEP_WIDTH}d}"
        weights_path = self.eval_dir / f"{eval_id}.weights.js"
        fixture_path = self.eval_dir / f"{eval_id}.fixture.json"
        pt_path = self.eval_dir / f"{eval_id}.pt"

        # 1) repack the LIVE actor → BC-format checkpoint dict → temp .pt (export() reads a path).
        repacked = repack_to_bc_checkpoint(
            self.model.policy,
            extra={"teacher": self.teacher, "ppo_step": int(step)},
        )
        tmp_pt = pt_path.with_name(pt_path.name + ".tmp")
        tmp_weights = weights_path.with_name(weights_path.name + ".tmp")
        tmp_fixture = fixture_path.with_name(fixture_path.name + ".tmp")
        try:
            torch.save(repacked, tmp_pt)
            _fsync_path(tmp_pt)
            # packed=False: this run dir has no sibling ./unpackPolicyWeights.js decoder, so the
            # packed format (which raises at export if the decoder is absent) can't be used — the
            # self-contained JSON form loads from any dir. fixture_path set: write the parity
            # fixture the gate's mandatory pre-flight checks the JS forward against (1e-3 tol).
            export(tmp_pt, tmp_weights, fixture_path=tmp_fixture, packed=False)
            _fsync_path(tmp_weights)
            _fsync_path(tmp_fixture)
            # Publish atomically. Rename order matters: the .weights.js is renamed LAST, so its
            # presence on disk implies the .fixture.json and .pt are already durable — the resume
            # disk-scan keys on eval-*.weights.js, so it never adopts a half-published checkpoint.
            os.replace(tmp_fixture, fixture_path)
            os.replace(tmp_pt, pt_path)
            os.replace(tmp_weights, weights_path)
        finally:
            # No-op after a successful replace (the tmps were renamed away); cleans a failed export.
            for tmp in (tmp_pt, tmp_weights, tmp_fixture):
                tmp.unlink(missing_ok=True)

        # 2) append + rewrite the durable index (no GC — every checkpoint is retained).
        self._entries.append(self._entry(int(step), datetime.now(timezone.utc).isoformat()))
        self._entries.sort(key=lambda e: e["step"])
        self._write_index_atomic()
        if self.verbose:
            print(f"[eval] wrote {eval_id} → {weights_path}")

    def _entry(self, step: int, created_at: str) -> dict:
        eval_id = f"eval-{int(step):0{_STEP_WIDTH}d}"
        return {
            "id": eval_id,
            "step": int(step),
            "weights": f"{eval_id}.weights.js",
            "fixture": f"{eval_id}.fixture.json",
            "pt": f"{eval_id}.pt",
            "createdAt": created_at,
            "teacher": self.teacher,
        }

    def _delete_artifacts(self, entry: dict) -> None:
        """Best-effort unlink of a stale future checkpoint's artifacts on resume (see
        ``_on_training_start``). A transient FS error is logged, not raised — dropping a stale file
        is disk hygiene and must not crash a multi-day run."""
        for key in ("weights", "fixture", "pt"):
            try:
                (self.eval_dir / entry[key]).unlink(missing_ok=True)
            except OSError as err:
                print(f"[eval] could not unlink stale {entry[key]} ({err}); leaving on disk")

    def _write_index_atomic(self) -> None:
        """Rewrite ``index.jsonl`` via temp-file + ``os.replace`` (atomic; never torn). One JSON
        object per line, ascending by step — the ledger ``scripts/ppo-strength-curve.mjs`` walks."""
        index_path = self.eval_dir / "index.jsonl"
        tmp_path = index_path.with_name(index_path.name + ".tmp")
        body = "".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in self._entries)
        tmp_path.write_text(body)
        _fsync_path(tmp_path)
        os.replace(tmp_path, index_path)  # atomic rename on POSIX


def _fsync_path(path: Path) -> None:
    """``fsync`` a written file so its bytes are durable before anything references it."""
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
