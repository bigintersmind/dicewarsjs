"""Tests for the durable per-checkpoint eval producer (Phase 0 — the strength-curve harness).

The callback shares ``SnapshotCallback``'s repack+export seam but differs on the axes that matter
for a strength CURVE: it writes a parity fixture (so each checkpoint is gradeable later), keeps the
``.pt`` (the ship/re-export source), and — the load-bearing difference — NEVER GCs (every 1M-step
checkpoint is retained). These tests monkeypatch ``repack_to_bc_checkpoint`` + ``export`` (the
repack→export path is already proven by the step-7 gate / snapshot tests) and focus on cadence, the
atomic publish, the durable ``index.jsonl`` schema, the no-GC retention contract, and resume
(seed the cursor to the resumed step; drop stale checkpoints AHEAD of it).
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

# Skip if the PPO `[rl]` stack is absent (e.g. the lean CI `ml-test` job): the callback imports
# SB3's BaseCallback. Runs on shodan / the mac-mini CPU box, where torch + sb3 are installed.
# Mirrors test_snapshot_callback.py.
pytest.importorskip("torch")
pytest.importorskip("stable_baselines3")

import dicewars_ppo.eval_checkpoint_callback as eval_checkpoint_callback  # noqa: E402
from dicewars_ppo.eval_checkpoint_callback import EvalCheckpointCallback  # noqa: E402


def _patch_export(monkeypatch):
    """Replace repack+export with fakes: a dict from repack; a stub .js + fixture from export."""

    def fake_repack(policy, *, extra=None):
        return {"fake_state": 1, "extra": dict(extra or {})}

    def fake_export(ckpt_path, out_path, fixture_path=None, *, packed=True):
        from pathlib import Path

        # An eval stream is written to a run dir with no sibling decoder, so it MUST be exported
        # self-contained (packed=False) — a regression to the packed default would emit an
        # `import './unpackPolicyWeights.js'` the scorer can't resolve from the eval dir.
        assert packed is False, "eval export must be unpacked (packed=False)"
        Path(out_path).write_text("export const BC_POLICY = {};\n")
        # An eval checkpoint MUST carry a parity fixture (unlike a league snapshot) — the gate's
        # pre-flight cross-checks the JS forward against it before grading a single game.
        assert fixture_path is not None, "eval export must write a parity fixture"
        Path(fixture_path).write_text('{"config":{},"seed":0,"cases":[]}\n')
        return Path(out_path)

    monkeypatch.setattr(eval_checkpoint_callback, "repack_to_bc_checkpoint", fake_repack)
    monkeypatch.setattr(eval_checkpoint_callback, "export", fake_export)


def _fake_model(num_timesteps=0):
    """Minimal SB3 model stand-in. ``_on_training_start``/``_on_training_end`` read
    ``model.num_timesteps`` (the resume/final cursor); ``policy`` is what
    ``repack_to_bc_checkpoint`` consumes (faked here)."""
    return SimpleNamespace(policy=SimpleNamespace(), num_timesteps=num_timesteps)


def _index_steps(eval_dir):
    lines = (eval_dir / "index.jsonl").read_text().splitlines()
    return [json.loads(line)["step"] for line in lines]


def test_eval_every_must_be_positive(tmp_path):
    with pytest.raises(ValueError, match="eval_every must be a positive int"):
        EvalCheckpointCallback(tmp_path, 0)


def test_emit_writes_weights_fixture_pt_and_indexes(tmp_path, monkeypatch):
    _patch_export(monkeypatch)
    cb = EvalCheckpointCallback(tmp_path, eval_every=1_000_000, teacher="ppo-eval")
    cb.model = _fake_model()
    cb._on_training_start()

    cb._emit(1_000_000)

    eid = "eval-001000000"
    assert (tmp_path / f"{eid}.weights.js").read_text().startswith("export const BC_POLICY")
    assert (tmp_path / f"{eid}.fixture.json").exists()  # gradeable: fixture written
    assert (tmp_path / f"{eid}.pt").exists()  # ship/re-export source: .pt kept

    rows = [json.loads(line) for line in (tmp_path / "index.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0] == {
        "id": eid,
        "step": 1_000_000,
        "weights": f"{eid}.weights.js",
        "fixture": f"{eid}.fixture.json",
        "pt": f"{eid}.pt",
        "createdAt": rows[0]["createdAt"],  # present (exact value not pinned)
        "teacher": "ppo-eval",
    }
    assert rows[0]["createdAt"]  # non-empty ISO stamp
    # Atomic publish: no torn temp artifacts left behind.
    assert not list(tmp_path.glob("*.tmp"))


def test_on_step_emits_on_cadence_only(tmp_path, monkeypatch):
    cb = EvalCheckpointCallback(tmp_path, eval_every=10)
    emitted: list[int] = []
    monkeypatch.setattr(cb, "_emit", lambda step: emitted.append(step))

    # Crossing idiom: emit the first time num_timesteps crosses a cadence multiple, never `== N`.
    for ts, expected in [(5, []), (10, [10]), (15, [10]), (20, [10, 20]), (33, [10, 20, 33])]:
        cb.num_timesteps = ts
        cb._on_step()
        assert emitted == expected


def test_on_training_end_emits_final_once(tmp_path, monkeypatch):
    cb = EvalCheckpointCallback(tmp_path, eval_every=10)
    cb.model = _fake_model()
    cb._on_training_start()
    emitted: list[int] = []
    monkeypatch.setattr(cb, "_emit", lambda step: emitted.append(step))

    cb.num_timesteps = 10
    cb._on_step()  # emits 10; cursor advances to 10
    cb.model = _fake_model(10)
    cb._on_training_end()  # final == last emitted step ⇒ NO double-emit
    assert emitted == [10]

    cb.model = _fake_model(15)
    cb._on_training_end()  # progressed past the last eval ⇒ grade the final policy
    assert emitted == [10, 15]


def test_index_lists_in_step_order(tmp_path, monkeypatch):
    _patch_export(monkeypatch)
    cb = EvalCheckpointCallback(tmp_path, eval_every=1_000_000)
    cb.model = _fake_model()
    cb._on_training_start()

    cb._emit(2_000_000)
    cb._emit(1_000_000)  # out of order → index still ascending by step
    assert _index_steps(tmp_path) == [1_000_000, 2_000_000]


def test_no_gc_retains_all_checkpoints(tmp_path, monkeypatch):
    """The durability contract — the whole reason this is a separate callback from SnapshotCallback:
    every checkpoint is kept so the strength curve is a complete record (a 20M run is ~20 tiny
    artifacts). SnapshotCallback FIFO-evicts to pool_cap; this one never GCs."""
    _patch_export(monkeypatch)
    cb = EvalCheckpointCallback(tmp_path, eval_every=1_000_000)
    cb.model = _fake_model()
    cb._on_training_start()

    steps = [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]
    for step in steps:
        cb._emit(step)

    on_disk = sorted(p.name for p in tmp_path.glob("eval-*.weights.js"))
    assert len(on_disk) == 5  # nothing evicted
    assert _index_steps(tmp_path) == steps
    for step in steps:
        eid = f"eval-{step:09d}"
        assert (tmp_path / f"{eid}.fixture.json").exists()
        assert (tmp_path / f"{eid}.pt").exists()


def test_resume_seeds_cursor_and_drops_future(tmp_path, monkeypatch):
    """Resume: seed the cadence cursor to the resumed step, and drop checkpoints AHEAD of it (they
    grade a pre-crash trajectory the resumed run diverges from). Then the next eval fires one full
    cadence past the resume point — NOT at the dropped step."""
    _patch_export(monkeypatch)
    cb0 = EvalCheckpointCallback(tmp_path, eval_every=1_000_000)
    cb0.model = _fake_model()
    cb0._on_training_start()
    for step in (1_000_000, 2_000_000, 3_000_000):
        cb0._emit(step)

    # A new run resumes at 2.5M: eval-3M is AHEAD of the resume point → dropped from the index AND
    # its artifacts deleted (a scorer must not grade weights the resumed trajectory rolled back).
    cb = EvalCheckpointCallback(tmp_path, eval_every=1_000_000)
    cb.model = _fake_model(2_500_000)
    cb._on_training_start()
    assert [e["step"] for e in cb._entries] == [1_000_000, 2_000_000]
    for suffix in ("weights.js", "fixture.json", "pt"):
        assert not (tmp_path / f"eval-003000000.{suffix}").exists()
    assert _index_steps(tmp_path) == [1_000_000, 2_000_000]

    # Cursor seeded to 2.5M ⇒ the next eval fires at 3.5M (one cadence past resume), emitted once.
    cb.num_timesteps = 3_499_999
    cb._on_step()
    assert _index_steps(tmp_path) == [1_000_000, 2_000_000]  # not yet a full cadence past 2.5M
    cb.num_timesteps = 3_500_000
    cb._on_step()
    assert _index_steps(tmp_path) == [1_000_000, 2_000_000, 3_500_000]


def test_fresh_run_start_is_noop(tmp_path):
    """A fresh run (empty dir, num_timesteps=0) rehydrates nothing and writes no index until the
    first emit — the empty-dir short-circuit in _on_training_start."""
    cb = EvalCheckpointCallback(tmp_path, eval_every=1_000_000)
    cb.model = _fake_model()
    cb._on_training_start()
    assert cb._entries == []
    assert not (tmp_path / "index.jsonl").exists()
