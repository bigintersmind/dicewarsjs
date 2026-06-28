"""SB3 learner glue for idempotent resume (Phase 3, task C/E, PR-5, [D-26]).

This is the ``sb3``-coupled half of the resume machinery — ``MaskablePPO.load`` and the
``BaseCallback`` subclass that drives periodic checkpoints. The ``sb3``-free core (RNG sidecar,
atomic ``latest.json``, GC, ``save_resume_checkpoint``, pointer validation) lives in the sibling
``resume_state.py`` so it can be CI-tested without ``sb3`` (mirroring ``snapshot_callback.py`` ↔
``snapshot_manifest.py``). Imported ONLY by ``train.py`` (already torch-ful), never by the
env-thunk's module — so the [D-26] Q4 torch-free invariant for ``_train_common`` /
``SubprocVecEnv`` workers holds.

This is the **Python half** of the two-half resume ([D-26] Q3): it owns the policy + optimizer +
``num_timesteps`` + process RNG. The other half is the Node league's per-worker
``league-state-<seedBase>.json`` (whose filename is built in ``scripts/ppo-env-server.mjs``'s
``resolveLeaguePersistence``; serialized via ``scripts/lib/ppo-league-store.mjs``); the two resume
INDEPENDENTLY (no two-phase commit), so resume is "statistically consistent, bounded-skew," NOT
bit-exact.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback

from .resume_state import (
    LATEST_NAME,
    POINTER_ABSENT,
    POINTER_CORRUPT_JSON,
    POINTER_DANGLING_REF,
    POINTER_ENCODING_SKEW,
    POINTER_VALID,
    POINTER_VERSION_SKEW,
    RESUME_ACTION_FRESH,
    RESUME_ACTION_HALT,
    RESUME_ACTION_RESUME,
    RESUME_FORMAT_VERSION,
    ResumeCheckpointError,
    classify_latest_pointer,
    describe_pointer_rejection,
    has_resume_checkpoint,
    latest_pointer_exists,
    read_latest_pointer,
    restore_rng_sidecar,
    resume_action,
    resume_candidate_pairs,
    save_resume_checkpoint,
)

# Re-export the pointer helpers train.py uses, so it imports its whole resume surface from one place
# even though the implementation lives in the sb3-free sibling.
__all__ = [
    "LATEST_NAME",
    "POINTER_ABSENT",
    "POINTER_CORRUPT_JSON",
    "POINTER_DANGLING_REF",
    "POINTER_ENCODING_SKEW",
    "POINTER_VALID",
    "POINTER_VERSION_SKEW",
    "RESUME_ACTION_FRESH",
    "RESUME_ACTION_HALT",
    "RESUME_ACTION_RESUME",
    "RESUME_FORMAT_VERSION",
    "ResumeCheckpointCallback",
    "ResumeCheckpointError",
    "classify_latest_pointer",
    "describe_pointer_rejection",
    "has_resume_checkpoint",
    "latest_pointer_exists",
    "load_resume_checkpoint",
    "read_latest_pointer",
    "restore_rng_sidecar",
    "resume_action",
    "resume_candidate_pairs",
    "save_resume_checkpoint",
]


def load_resume_checkpoint(state_dir: str | Path, venv: Any, device: str) -> MaskablePPO:
    """Load the learner from the newest LOADABLE checkpoint (PATH A — restores num_timesteps).

    Uses ``MaskablePPO.load(env=venv)`` so policy + optimizer + ``num_timesteps`` are restored in
    ONE call BEFORE ``learn`` and BEFORE ``SnapshotCallback._on_training_start`` reads it (so the
    snapshot producer rehydrates against the RESUMED step, not 0 — HOLE-C). Building a fresh model +
    ``set_parameters`` instead would leave ``num_timesteps`` at 0 and the snapshot producer would
    classify the entire on-disk pool as "future" and delete it — so the resume MUST go through
    ``load``. Then the RNG sidecar is restored — but a corrupt sidecar DEGRADES to a fresh stream
    (``restore_rng_sidecar``) rather than aborting: the recoverable state is already loaded.

    **Corrupt-``.zip`` fallback (PR-6).** ``classify_latest_pointer`` validates the pointer JSON and
    that the referenced files EXIST, but not that the ``.zip`` bytes are intact — a bit-rotted or
    half-flushed newest ``.zip`` at a VALID pointer makes ``MaskablePPO.load`` raise, which under
    the unattended schtasks auto-restart would be a PERMANENT crash-loop (every relaunch reads the
    same bad bytes and dies). So we try the pointer's pair first, then fall back to the retained
    ``keep=N`` OLDER pairs (newest-first, from :func:`resume_candidate_pairs`), rolling back one
    checkpoint cadence at most. Only when EVERY retained pair fails do we raise
    :class:`ResumeCheckpointError` — ``train.py`` turns that into the halt-and-alert exit code,
    rather than retrying bytes that will not heal. We deliberately do NOT rewrite ``latest.json`` on
    fallback: it is the crash hinge and the next checkpoint moves the pointer forward anyway; a
    repeat crash before then simply re-runs this cheap fallback.
    """
    state_dir = Path(state_dir)
    candidates = resume_candidate_pairs(state_dir)
    if not candidates:
        raise FileNotFoundError(f"no valid resume checkpoint in {state_dir}")
    last_err: Exception | None = None
    for i, cand in enumerate(candidates):
        zip_path = state_dir / cand["ckpt"]
        try:
            model = MaskablePPO.load(zip_path, env=venv, device=device)
        except Exception as err:  # noqa: BLE001 — a torn .zip raises BadZipFile/EOFError/RuntimeError
            last_err = err
            more = "trying the retained prior pair" if i + 1 < len(candidates) else "no older pair"
            print(
                f"WARNING: resume checkpoint {cand['ckpt']} failed to load ({err!r}); {more}.",
                file=sys.stderr,
            )
            continue
        if i > 0:
            # Fell back past the newest pair: surface the rollback loudly — up to one
            # --checkpoint-every window of progress (and num_timesteps) is replayed.
            print(
                f"WARNING: resumed from RETAINED prior checkpoint {cand['ckpt']} "
                f"(step={cand['step']}) after {i} newer pair(s) failed to load — rolled back up to "
                "one checkpoint cadence.",
                file=sys.stderr,
            )
        # The MODEL load honors `device`, but the RNG sidecar must NOT — RNG states are CPU
        # ByteTensors and set_rng_state rejects a GPU-mapped tensor (would crash every --device
        # cuda resume). A torn/bit-rotted sidecar degrades to a fresh RNG stream (loud warn), not
        # bricking the resume whose model/optimizer/num_timesteps are already restored above.
        restore_rng_sidecar(state_dir / cand["rng"])
        return model
    raise ResumeCheckpointError(
        f"all {len(candidates)} retained resume checkpoint(s) in {state_dir} failed to load; last "
        f"error: {last_err!r}. This is usually corrupt bytes, but the SAME error across EVERY "
        "retained pair more often means an ENVIRONMENT mismatch (a torch/sb3 version change since "
        "the checkpoints were written, or a bad --device) than per-file corruption — verify those "
        "FIRST. Inspect the ckpt-*.zip pairs before deleting latest.json (it is the breadcrumb to "
        "them)."
    )


class ResumeCheckpointCallback(BaseCallback):
    """Periodically checkpoint the learner for crash-safe resume (every ``checkpoint_every`` steps).

    Mirrors :class:`SnapshotCallback`'s cadence + resume-cursor discipline: ``_on_training_start``
    seeds the cursor to the RESUMED step (so the first post-resume checkpoint waits a full cadence
    instead of firing immediately), ``_on_step`` fires on each cadence crossing, and
    ``_on_training_end`` writes a final checkpoint so a clean finish is always resumable at the true
    end step (a subsequent same-budget relaunch then resumes, computes ``remaining == 0``, and just
    re-exports).
    """

    def __init__(
        self,
        state_dir: str | Path,
        checkpoint_every: int,
        *,
        keep: int = 2,
        verbose: int = 0,
    ) -> None:
        super().__init__(verbose)
        if int(checkpoint_every) <= 0:
            raise ValueError(f"checkpoint_every must be a positive int, got {checkpoint_every!r}")
        self.state_dir = Path(state_dir)
        self.checkpoint_every = int(checkpoint_every)
        self._keep = int(keep)
        self._last = 0

    def _on_training_start(self) -> None:
        # self.model.num_timesteps is the resumed env-step count (SB3 restores it under
        # learn(reset_num_timesteps=False)); the callback's own num_timesteps is not synced at
        # training-start, so read the model's — same reason as SnapshotCallback._on_training_start.
        self._last = int(self.model.num_timesteps)

    def _on_step(self) -> bool:
        if self.num_timesteps - self._last >= self.checkpoint_every:
            self._last = self.num_timesteps
            save_resume_checkpoint(self.model, self.state_dir, self.num_timesteps, keep=self._keep)
        return True

    def _on_training_end(self) -> None:
        # Final checkpoint at the true end step (skip if a cadence save already landed there) so a
        # clean finish is resumable even if the process dies between learn() and the repack/export.
        if self.num_timesteps != self._last:
            save_resume_checkpoint(self.model, self.state_dir, self.num_timesteps, keep=self._keep)
            self._last = self.num_timesteps
