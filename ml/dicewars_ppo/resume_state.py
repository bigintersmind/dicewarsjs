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
import sys
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .constants import ENCODING_VERSION

# Bump if the on-disk resume layout (latest.json schema / the sidecar set) changes incompatibly, so
# an old pointer is rejected (→ a loud fresh-start) rather than mis-loaded.
RESUME_FORMAT_VERSION = 1
LATEST_NAME = "latest.json"

# Width-agnostic (``\d+``) on purpose: the filenames use ``:09d`` (a MINIMUM width), so at >= 1e9
# env steps the step is 10 digits. A fixed ``\d{9}`` would stop matching there and the GC would
# silently leak those files (resume still works — latest.json carries the name, not these regexes).
_CKPT_RE = re.compile(r"^ckpt-(\d+)\.zip$")
_RNG_RE = re.compile(r"^ckpt-(\d+)\.rng\.pt$")

# Why ``classify_latest_pointer`` rejected (or accepted) ``latest.json`` — a torch-free, sb3-free
# decision the resume caller branches on, so the highest-consequence "do we restart from 0?" logic
# is unit-testable in lean CI (not only behind the sb3-gated ``train.py`` tier). The reasons split
# by the operator's recovery action (see :func:`describe_pointer_rejection`).
POINTER_VALID = "valid"
POINTER_ABSENT = "absent"
POINTER_CORRUPT_JSON = "corrupt-json"
POINTER_VERSION_SKEW = "version-skew"
POINTER_ENCODING_SKEW = "encoding-skew"
POINTER_DANGLING_REF = "dangling-ref"

# The three-way resume decision a driver makes from a POINTER_* reason ([D-26]/PR-6). Kept here in
# the torch-free tier (not inline in the sb3-gated train.py) so the highest-consequence
# "resume / fresh / halt" policy is unit-testable in lean CI — the same reason
# classify_latest_pointer itself lives here. The HALT action is the PR-6 change: a present-but-
# rejected pointer no longer silently restarts from step 0 (unattended, it re-burns the budget).
RESUME_ACTION_RESUME = "resume"
RESUME_ACTION_FRESH = "fresh"
RESUME_ACTION_HALT = "halt"


class ResumeCheckpointError(RuntimeError):
    """Every retained resume checkpoint failed to load — an UNRECOVERABLE resume ([D-26]/PR-6).

    sb3-free (lives here so the torch-only CI tier can name it) but RAISED by ``resume.py`` after
    its corrupt-``.zip`` fallback exhausts the keep-N retained pairs. ``train.py`` catches it, exits
    with ``EXIT_POINTER_REJECTED`` so the PR-6 schtasks auto-restart ALERTS an operator instead of
    crash-looping on bytes that will never heal (the same failure class the rejected-pointer halt
    guards, just discovered at load time rather than pointer-classification time).
    """

# Module-level so the macOS dir-fsync degrade (in _fsync_dir) warns once per process, not once per
# checkpoint.
_DIR_FSYNC_WARNED = False


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
    requirement (Linux / the shodan WSL box get the guarantee). The degrade is logged ONCE (not on
    every checkpoint) so the reduced-durability mode is visible on the box it's running on rather
    than silent — the whole point of this run is crash-safety.
    """
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        global _DIR_FSYNC_WARNED
        if not _DIR_FSYNC_WARNED:
            print(
                f"WARNING: directory fsync unsupported on this platform ({path}); checkpoint "
                "durability is best-effort (os.replace torn-write atomicity still holds).",
                file=sys.stderr,
            )
            _DIR_FSYNC_WARNED = True
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


def restore_rng_sidecar(rng_path: str | Path) -> bool:
    """Restore the RNG sidecar, degrading to a FRESH RNG stream (loud warn) if it is unreadable.

    Returns ``True`` if the saved stream was restored, ``False`` if it was unreadable and we
    fell back to the live RNG. **This must never abort a resume.** By the time it runs,
    ``MaskablePPO.load`` has ALREADY restored the policy + optimizer + ``num_timesteps`` — the
    expensive, recoverable state. A torn / bit-rotted sidecar (``torch.load`` with
    ``weights_only=False`` can raise ``UnpicklingError`` / ``EOFError`` / ``BadZipFile`` /
    ``RuntimeError`` …) contributes ONLY statistical continuity of the random stream, which the
    resume contract already declares "bounded-skew, not bit-exact" ([D-26] Q3). So losing it is
    exactly the degradation the design permits — raising here would brick a fully-recoverable
    checkpoint, and under the PR-6 schtasks auto-restart that becomes a PERMANENT crash-loop (every
    relaunch reads the same bad byte and dies). Hence: warn loudly, continue with a fresh stream.
    """
    try:
        load_rng_sidecar(rng_path)
        return True
    except Exception as err:  # noqa: BLE001 — corrupt sidecar can raise many torch/pickle types
        print(
            f"WARNING: RNG sidecar {Path(rng_path).name} is unreadable ({err!r}); resuming with a "
            "FRESH RNG stream. The model, optimizer, and num_timesteps were restored — only "
            "random-stream continuity is lost (statistically consistent, bounded-skew per [D-26]).",
            file=sys.stderr,
        )
        return False


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


def _parse_latest(state_dir: str | Path) -> tuple[str, dict[str, Any] | None]:
    """Parse + validate ``latest.json`` ONCE; return ``(reason, data-or-None)``.

    The single source of truth for both :func:`classify_latest_pointer` (reason only) and
    :func:`read_latest_pointer` (data only), so the two can never drift. ``data`` is non-``None``
    only when ``reason == POINTER_VALID``.
    """
    state_dir = Path(state_dir)
    latest = state_dir / LATEST_NAME
    try:
        raw = latest.read_text()
    except (FileNotFoundError, NotADirectoryError):
        return POINTER_ABSENT, None
    try:
        data = json.loads(raw)
    except ValueError:
        return POINTER_CORRUPT_JSON, None
    if not isinstance(data, dict):
        return POINTER_CORRUPT_JSON, None
    if data.get("version") != RESUME_FORMAT_VERSION:
        return POINTER_VERSION_SKEW, None
    # Match the snapshot manifest's encoding gate: a resume must not load a checkpoint from a
    # different observation encoding (it would silently mismatch the live obs).
    if data.get("encodingVersion") != ENCODING_VERSION:
        return POINTER_ENCODING_SKEW, None
    ckpt, rng = data.get("ckpt"), data.get("rng")
    if not ckpt or not (state_dir / ckpt).is_file():
        return POINTER_DANGLING_REF, None
    if not rng or not (state_dir / rng).is_file():
        return POINTER_DANGLING_REF, None
    return POINTER_VALID, data


def classify_latest_pointer(state_dir: str | Path) -> str:
    """Why ``latest.json`` is (un)usable — one of the ``POINTER_*`` reasons (torch-free, CI-tested).

    Lets the resume caller branch the three-way decision (resume / loud-fresh / silent-fresh) AND
    tailor the operator warning to the cause, without an sb3 import — so the highest-consequence
    "should we restart from 0?" logic is unit-testable in lean CI.
    """
    return _parse_latest(state_dir)[0]


def describe_pointer_rejection(reason: str) -> str:
    """Operator-facing explanation for a rejected pointer (caller prefixes ``WARNING: <dir>:``).

    A pure ``reason → message`` map (no I/O), so the resume warning is unit-testable in lean CI. It
    splits by the right recovery action: VERSION / ENCODING skew mean the on-disk ckpt pairs are
    THEMSELVES from an incompatible build (a fresh start is correct, and deleting them is fine),
    whereas CORRUPT_JSON / DANGLING_REF mean only the POINTER broke while the ``ckpt-*.zip`` pairs
    are likely still loadable — so it steers AWAY from deleting them. (The prior wording only told
    the operator to move ``latest.json`` aside, framing recovery around the pointer rather than the
    still-loadable ckpt pairs.)
    """
    recoverable = (
        "the ckpt-*.zip/.rng.pt pairs on disk are likely still loadable — inspect them BEFORE "
        "deleting latest.json (it is the breadcrumb to them)"
    )
    incompatible = "the on-disk checkpoints are from an incompatible build and cannot be resumed"
    return {
        POINTER_CORRUPT_JSON: f"latest.json is corrupt (unreadable JSON); {recoverable}.",
        POINTER_DANGLING_REF: f"latest.json points at a missing checkpoint file; {recoverable}.",
        POINTER_VERSION_SKEW: f"latest.json is from an incompatible resume-format version; "
        f"{incompatible}.",
        POINTER_ENCODING_SKEW: f"latest.json is from a different observation encoding; "
        f"{incompatible}.",
    }.get(reason, f"latest.json is unusable (reason: {reason}).")


def resume_action(reason: str) -> str:
    """Map a ``POINTER_*`` reason to the resume decision ([D-26]/PR-6) — pure, CI-testable.

    ``POINTER_VALID`` → ``RESUME_ACTION_RESUME``; ``POINTER_ABSENT`` (a brand-new ``--state-dir``,
    no prior run) → ``RESUME_ACTION_FRESH``; ANY present-but-rejected reason (corrupt JSON, version
    or encoding skew, dangling ref) → ``RESUME_ACTION_HALT``. The driver turns HALT into a loud exit
    with ``EXIT_POINTER_REJECTED`` so the unattended schtasks auto-restart ALERTS an operator
    instead of silently restarting from step 0 and re-training the full ``--timesteps`` budget — and
    so it does not overwrite the still-recoverable on-disk ``ckpt-*`` pairs the breadcrumb names.
    """
    if reason == POINTER_VALID:
        return RESUME_ACTION_RESUME
    if reason == POINTER_ABSENT:
        return RESUME_ACTION_FRESH
    return RESUME_ACTION_HALT


def read_latest_pointer(state_dir: str | Path) -> dict[str, Any] | None:
    """Return the parsed+validated ``latest.json`` dict, or ``None`` if unusable.

    ``None`` means "no usable resume point": the file is absent, torn (bad JSON), version- or
    encoding-skewed, or references a missing ckpt/rng file. Use :func:`classify_latest_pointer` (or
    :func:`latest_pointer_exists`) to distinguish ABSENT (a fresh run) from PRESENT-but-rejected
    (corrupt — warn loudly, do NOT silently restart from 0).
    """
    reason, data = _parse_latest(state_dir)
    return data if reason == POINTER_VALID else None


def latest_pointer_exists(state_dir: str | Path) -> bool:
    """Does a ``latest.json`` file exist at all (regardless of whether it is valid)?

    Lets the caller tell ABSENT (silent fresh) from PRESENT-but-rejected (loud warning) when
    :func:`read_latest_pointer` returns ``None``.
    """
    return (Path(state_dir) / LATEST_NAME).exists()


def has_resume_checkpoint(state_dir: str | Path) -> bool:
    """True iff ``state_dir`` holds a valid, loadable resume checkpoint."""
    return read_latest_pointer(state_dir) is not None


def resume_candidate_pairs(state_dir: str | Path) -> list[dict[str, Any]]:
    """Ordered checkpoint pairs ``resume.py`` should TRY to load, newest-usable first ([D-26]/PR-6).

    Torch-free (CI-tested) so the corrupt-``.zip`` FALLBACK ORDER — the highest-consequence "which
    checkpoint do we resume from?" decision — is unit-testable without ``sb3``/a GPU, exactly like
    :func:`classify_latest_pointer` is for the resume/fresh decision. ``resume.py`` only adds the
    thin ``MaskablePPO.load`` try/except loop over this list.

    The list is:

    1. The pair ``latest.json`` validates (its explicit ``ckpt``/``rng`` names) — the newest DURABLE
       checkpoint, tried first.
    2. Then the retained OLDER pairs (step STRICTLY LESS THAN the pointer's, whose ``.zip`` is on
       disk), newest-first — what GC ``keep=N`` left behind, so a bit-rotted newest ``.zip``
       degrades to the prior good pair instead of crash-looping the unattended schtasks restart.

    Returns ``[]`` when ``latest.json`` is not ``POINTER_VALID`` (the caller treats that as "no
    resume point"; the resume/fresh/halt split is :func:`classify_latest_pointer`'s job, not this).

    Pairs strictly NEWER than the pointer are deliberately EXCLUDED: a ``.zip`` newer than
    ``latest.json`` is from a checkpoint whose write died before its ``latest.json`` rename (the
    pointer is written LAST), so it is presumed torn and must never be preferred over the validated
    pointer. The ``.rng.pt`` name is carried even if that sidecar is missing/corrupt —
    ``restore_rng_sidecar`` degrades to a fresh stream, so a candidate is "usable" as long as its
    ``.zip`` exists.
    """
    pointer = read_latest_pointer(state_dir)
    if pointer is None:
        return []
    state_dir = Path(state_dir)
    p_step = int(pointer["step"])
    pairs: list[dict[str, Any]] = [
        {"step": p_step, "ckpt": pointer["ckpt"], "rng": pointer["rng"]}
    ]
    for step in reversed(_checkpoint_steps(state_dir)):  # newest-first
        if step >= p_step:
            continue  # the pointer pair (==) is already first; newer (>) is a presumed-torn orphan
        zip_name = f"ckpt-{step:09d}.zip"
        if (state_dir / zip_name).is_file():  # a .zip-less orphan .rng.pt is not loadable
            pairs.append({"step": step, "ckpt": zip_name, "rng": f"ckpt-{step:09d}.rng.pt"})
    return pairs


# --- save / GC ---------------------------------------------------------------------------------


def _checkpoint_steps(state_dir: Path) -> list[int]:
    """Steps with a checkpoint file on disk (ascending), unioned over BOTH the ``.zip`` and the
    ``.rng.pt`` names.

    Unioning both halves means an ORPHANED ``.rng.pt`` — e.g. a prior GC whose ``.zip`` unlink
    succeeded but whose paired ``.rng.pt`` unlink hit a transient ``OSError`` (see
    :func:`_safe_unlink`) — is still enumerated and swept by a later GC pass, so no half-pair leaks
    past one cadence. (A ``.zip``-only orphan self-heals the same way.)
    """
    steps: set[int] = set()
    for p in state_dir.glob("ckpt-*"):
        m = _CKPT_RE.match(p.name) or _RNG_RE.match(p.name)
        if m:
            steps.add(int(m.group(1)))
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
    Unlinks the ``.zip`` and ``.rng.pt`` of each aged-out step together; if a transient
    :func:`_safe_unlink` failure leaves one half behind, ``_checkpoint_steps`` (which unions both
    suffixes) re-enumerates that step on the next pass and sweeps the orphan — no half-pair survives
    past one GC cycle.
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
