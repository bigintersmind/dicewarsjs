"""Checkpoint-state core for idempotent resume (Phase 3, task C/E, PR-5, [D-26]) — sb3-FREE.

This is the torch-but-``sb3``-free half of the resume machinery: the RNG sidecar, the atomic
``latest.json`` pointer (the crash hinge), pointer validation, the checkpoint GC, and
``save_resume_checkpoint`` (which takes a duck-typed model with ``.save(path)`` — no ``sb3`` symbol
appears here). The ``sb3`` learner glue (``MaskablePPO.load`` + the ``BaseCallback`` subclass) lives
in the sibling ``resume.py``.

**Why the split** mirrors ``snapshot_manifest.py`` (torch-free) vs ``snapshot_callback.py`` (sb3):
the lean ``ml-test`` CI tier has CPU ``torch`` but NOT ``stable_baselines3`` / ``sb3_contrib``, so
keeping the riskiest logic (atomic ``latest.json`` written LAST, pointer rejection, GC keep-N, the
RNG ``weights_only`` round-trip) out of any ``sb3`` import lets it run in CI
(``test_resume_state.py`` gates on ``torch`` only) instead of shodan-only.

**Crash hinge ([D-26] Q3).** ``save_resume_checkpoint`` writes, in order: (1) the model zip (policy
+ optimizer + ``num_timesteps``) fsync'd durable, (2) the RNG sidecar fsync'd durable, then (3)
``latest.json`` LAST via temp-file + fsync + ``os.replace``. A torn write before step 3 leaves the
PREVIOUS ``latest.json`` (or none) intact, so a resume never references a half-written payload.
Older pairs are GC'd only AFTER ``latest.json`` is durable, and the referenced pair is never deleted
(same ordering discipline as the snapshot GC / HOLE-B).
"""

from __future__ import annotations

import json
import os
import random
import re
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .constants import ENCODING_VERSION

# Bump if the on-disk resume layout (latest.json schema / the sidecar set) changes incompatibly, so
# an old pointer is rejected (→ a loud fresh-start) rather than mis-loaded.
RESUME_FORMAT_VERSION = 1
LATEST_NAME = "latest.json"

# Width-agnostic (``\d+``) on purpose: the filename uses ``:09d`` (a MINIMUM width), so at >= 1e9
# env steps the step is 10 digits. A fixed ``\d{9}`` would stop matching there and the GC would
# silently leak those files (resume still works — latest.json carries the name, not this regex).
_CKPT_RE = re.compile(r"^ckpt-(\d+)\.zip$")


def _fsync_path(path: Path) -> None:
    """``fsync`` a written file so its bytes are durable before anything references it."""
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_dir(path: Path) -> None:
    """Best-effort fsync of a DIRECTORY so a rename/unlink within it survives a power loss.

    ``os.replace`` gives torn-write atomicity but not crash-durability of the directory ENTRY:
    without this, a hard crash could lose the ``latest.json`` rename while a GC unlink of the prior
    pair already reached disk, leaving ``latest.json`` dangling — and the checkpoint pair is the
    ONLY copy of model state. Some platforms (notably macOS) don't support fsync on a directory fd;
    it degrades to a no-op rather than crashing, since this is a hardening, not a correctness
    requirement (Linux / the shodan WSL box get the guarantee).
    """
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass  # directory fsync unsupported here (e.g. macOS) — degrade, don't crash the run
    finally:
        os.close(fd)


# --- RNG sidecar (de-randomize the Python half across a save/load) ----------------------------


def _capture_rng() -> dict[str, Any]:
    """Snapshot the process RNG so a resume continues the SAME stream ([D-26] Q3, bounded-skew).

    Captures torch (CPU), numpy, and python ``random`` state — plus per-device CUDA state when a GPU
    is present (the long run trains on shodan's GPU; CPU-only CI exercises the rest). This is all
    the Python half can de-randomize; the Node env half can't replay trajectories, so the overall
    resume is statistically consistent, not bit-exact.
    """
    state: dict[str, Any] = {
        "torch": torch.get_rng_state(),
        "numpy": np.random.get_state(),
        "python": random.getstate(),
    }
    if torch.cuda.is_available():
        state["cuda"] = torch.cuda.get_rng_state_all()
    return state


def _restore_rng(state: dict[str, Any]) -> None:
    """Inverse of :func:`_capture_rng`. CUDA state is restored only when a GPU is present."""
    torch.set_rng_state(state["torch"])
    np.random.set_state(state["numpy"])
    random.setstate(state["python"])
    cuda = state.get("cuda")
    if cuda is not None and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(cuda)


def load_rng_sidecar(rng_path: str | Path) -> dict[str, Any]:
    """Load + restore an RNG sidecar written by :func:`save_resume_checkpoint`.

    Always loads to CPU — there is intentionally NO device parameter. RNG generator states are CPU
    ByteTensors (``torch.get_rng_state`` and even ``torch.cuda.get_rng_state_all`` return CPU
    tensors), and ``torch.set_rng_state`` / ``torch.cuda.set_rng_state_all`` REQUIRE CPU tensors.
    Mapping the sidecar onto a GPU device (e.g. forwarding the model's ``--device cuda``) makes
    ``torch.set_rng_state`` raise ``TypeError: RNG state must be a torch.ByteTensor`` — which would
    crash EVERY GPU resume (the shodan BEAT run). So the device is deliberately not threaded here.

    ``weights_only=False`` is REQUIRED: the sidecar bundles numpy's ``('MT19937', ndarray, …)``
    tuple + python's ``random`` state, which ``weights_only=True`` (the ``torch>=2.6`` default)
    cannot deserialize — it would crash EVERY resume. The sidecar is a trusted, locally-produced
    file, so this is safe; a deliberate, narrow deviation from the repo's ``weights_only=True``
    convention (which guards UNTRUSTED-shaped checkpoints, e.g. ``policy.load_bc_checkpoint``).
    """
    state = torch.load(rng_path, weights_only=False, map_location="cpu")
    _restore_rng(state)
    return state


# --- atomic latest.json pointer ----------------------------------------------------------------


def _write_latest_atomic(state_dir: Path, step: int, ckpt_name: str, rng_name: str) -> None:
    """Write ``latest.json`` LAST via temp-file + fsync + ``os.replace`` (atomic; never torn)."""
    payload = {
        "version": RESUME_FORMAT_VERSION,
        "encodingVersion": ENCODING_VERSION,
        "step": int(step),
        "ckpt": ckpt_name,
        "rng": rng_name,
    }
    latest = state_dir / LATEST_NAME
    tmp = latest.with_name(latest.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    _fsync_path(tmp)
    os.replace(tmp, latest)  # atomic rename on POSIX
    # Make the rename durable BEFORE save_resume_checkpoint's GC unlinks the prior pair — else a
    # power-loss crash could drop the latest.json rename yet keep the GC unlink → dangling pointer.
    _fsync_dir(state_dir)


def read_latest_pointer(state_dir: str | Path) -> dict[str, Any] | None:
    """Return the parsed+validated ``latest.json`` dict, or ``None`` if unusable.

    ``None`` means "no usable resume point": the file is absent, torn (bad JSON), version- or
    encoding-skewed, or references a missing ckpt/rng file. The caller distinguishes ABSENT (a legit
    fresh run) from PRESENT-but-rejected (corrupt — warn loudly, do NOT silently restart from 0) via
    :func:`latest_pointer_exists`.
    """
    state_dir = Path(state_dir)
    latest = state_dir / LATEST_NAME
    try:
        raw = latest.read_text()
    except (FileNotFoundError, NotADirectoryError):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("version") != RESUME_FORMAT_VERSION:
        return None
    # Match the snapshot manifest's encoding gate: a resume must not load a checkpoint from a
    # different observation encoding (it would silently mismatch the live obs).
    if data.get("encodingVersion") != ENCODING_VERSION:
        return None
    ckpt, rng = data.get("ckpt"), data.get("rng")
    if not ckpt or not (state_dir / ckpt).is_file():
        return None
    if not rng or not (state_dir / rng).is_file():
        return None
    return data


def latest_pointer_exists(state_dir: str | Path) -> bool:
    """Does a ``latest.json`` file exist at all (regardless of whether it is valid)?

    Lets the caller tell ABSENT (silent fresh) from PRESENT-but-rejected (loud warning) when
    :func:`read_latest_pointer` returns ``None``.
    """
    return (Path(state_dir) / LATEST_NAME).exists()


def has_resume_checkpoint(state_dir: str | Path) -> bool:
    """True iff ``state_dir`` holds a valid, loadable resume checkpoint."""
    return read_latest_pointer(state_dir) is not None


# --- save / GC ---------------------------------------------------------------------------------


def _checkpoint_steps(state_dir: Path) -> list[int]:
    """Steps of the ``ckpt-*.zip`` files on disk (ascending), parsed from the filenames."""
    steps = []
    for p in state_dir.glob("ckpt-*.zip"):
        m = _CKPT_RE.match(p.name)
        if m:
            steps.append(int(m.group(1)))
    return sorted(steps)


def _safe_unlink(path: Path) -> None:
    """Best-effort unlink of an aged-out checkpoint file — never crash a multi-day run on disk I/O.

    Deleting an unreferenced file is pure hygiene; a transient FS error leaves it on disk and a
    later run's GC reclaims it. ``missing_ok`` makes it idempotent for the single writer.
    """
    try:
        path.unlink(missing_ok=True)
    except OSError as err:
        print(f"[resume] GC: could not unlink {path.name} ({err}); leaving on disk")


def _gc_old_checkpoints(state_dir: Path, *, keep: int, keep_step: int) -> None:
    """Delete checkpoint pairs (``.zip`` + ``.rng.pt``) older than the newest ``keep``.

    Called only AFTER ``latest.json`` is durable, so the referenced (newest) pair is always within
    ``keep`` (``keep >= 1``); ``keep_step`` is also force-retained as a belt-and-suspenders guard so
    the GC can never remove the pair ``latest.json`` currently names (the HOLE-B ordering hazard).
    Removes the ``.zip`` and ``.rng.pt`` together so a half-pair is never left behind.
    """
    steps = _checkpoint_steps(state_dir)
    survivors = set(steps[-keep:]) | {int(keep_step)}
    for s in steps:
        if s in survivors:
            continue
        _safe_unlink(state_dir / f"ckpt-{s:09d}.zip")
        _safe_unlink(state_dir / f"ckpt-{s:09d}.rng.pt")


def save_resume_checkpoint(model: Any, state_dir: str | Path, step: int, *, keep: int = 2) -> None:
    """Atomically checkpoint the learner for resume; ``latest.json`` written LAST ([D-26] Q3).

    :param model: the (Maskable)PPO model — needs ``.save(path)`` (SB3 persists policy + optimizer +
        ``num_timesteps``). Duck-typed so this module stays ``sb3``-free.
    :param state_dir: directory the checkpoint pair + ``latest.json`` live in.
    :param step: ``num_timesteps`` at this checkpoint (names the files: ``ckpt-<step>.zip``).
    :param keep: newest checkpoint pairs kept on disk (``>= 1``; default 2 = current + one back).
    """
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    step = int(step)
    tag = f"ckpt-{step:09d}"
    zip_path = state_dir / f"{tag}.zip"
    rng_path = state_dir / f"{tag}.rng.pt"

    # 1) model zip (policy + optimizer + num_timesteps), durable FIRST. (SB3 .save would append
    #    .zip; we pass it explicitly so _fsync_path opens the exact file.)
    model.save(zip_path)
    _fsync_path(zip_path)
    # 2) RNG sidecar, durable SECOND (torch.save: numpy/python RNG state is not JSON-able).
    torch.save(_capture_rng(), rng_path)
    _fsync_path(rng_path)
    # 3) latest.json LAST — only now does a resume see this checkpoint. A crash before here leaves
    #    the prior latest.json intact (bounded loss, not a torn pointer).
    _write_latest_atomic(state_dir, step, zip_path.name, rng_path.name)
    # 4) GC older pairs (the newest `keep`, plus this step, always survive — never delete the pair
    #    latest.json now references).
    _gc_old_checkpoints(state_dir, keep=max(int(keep), 1), keep_step=step)
