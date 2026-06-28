"""Behavioral tests for the shodan PPO auto-restart launcher (``scripts/shodan/ppo-train.sh``).

Lean-CI tier: this shells out to ``bash`` and imports NO ``torch``/``sb3`` — so the launcher's
restart-loop DISPATCH is pinned in CI, not only on a live shodan BEAT run. That dispatch is the
*consumer* side of the cross-language ``EXIT_POINTER_REJECTED`` contract (``test_train_common_args``
only checks that the launcher *defines* the same constant; here we prove the launcher *acts* on it),
plus the bounded crash-loop halt and the subtlest line in the file — "a checkpoint-step advance
resets the consecutive-fail counter," i.e. the boundary between killing a genuine crash-loop and
killing a run that has been making progress for days.

The launcher's ``main "$@"`` is guarded by ``[ "${BASH_SOURCE[0]}" = "${0}" ]``, so we SOURCE the
file (defining its functions without auto-running it), stub the heavy/external bits
(``preflight`` / ``check_commit_pinned`` / ``run_once`` / ``latest_step`` / ``sleep``), and drive
``main`` deterministically with no real training, git, GPU, or backoff waits.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ML_DIR = Path(__file__).resolve().parents[1]
LAUNCHER = ML_DIR.parent / "scripts" / "shodan" / "ppo-train.sh"
CMD = ML_DIR.parent / "scripts" / "shodan" / "ppo-train.cmd"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or not LAUNCHER.is_file(),
    reason="needs bash + the shodan launcher",
)


def _exit_code(name: str) -> int:
    """Read an intentional-halt exit code straight from the launcher, so these tests pin the
    DISPATCH behavior without hard-coding a value that could silently drift from the script."""
    m = re.search(rf"^{name}=(\d+)", LAUNCHER.read_text(), re.MULTILINE)
    assert m is not None, f"{name} must be defined in {LAUNCHER}"
    return int(m.group(1))


# Sets the run env + the counters the scenarios use, sources the launcher (guarded main ⇒ not run),
# then overrides the external bits. Sentinel substitution (not str.format) keeps bash's {} braces
# intact. Scenario snippets are appended after this, then a bare `main`.
_PRELUDE = r"""
export RUN_NAME="test"
export RUN_ROOT="__RUN_ROOT__"
export STATE_DIR="$RUN_ROOT/state"
export MAX_CONSECUTIVE_FAILS="__MAX_FAILS__"
export DEVICE="cpu"
ATTEMPTS_FILE="$RUN_ROOT/attempts"
SEQ_FILE="$RUN_ROOT/seq"
mkdir -p "$STATE_DIR"
: > "$ATTEMPTS_FILE"
echo 0 > "$SEQ_FILE"

source "__LAUNCHER__"

# Stubs defined AFTER source ⇒ they override the script's own definitions. No real git/GPU/waits.
preflight() { :; }
check_commit_pinned() { :; }
sleep() { :; }
"""


class _Result:
    def __init__(self, rc: int, attempts: int, output: str) -> None:
        self.rc = rc
        self.attempts = attempts
        self.output = output  # stdout + stderr merged (alerts are tee'd to both)


def _drive_main(tmp_path: Path, scenario: str, *, max_fails: int = 5) -> _Result:
    run_root = tmp_path / "run"
    harness = (
        _PRELUDE.replace("__RUN_ROOT__", str(run_root))
        .replace("__MAX_FAILS__", str(max_fails))
        .replace("__LAUNCHER__", str(LAUNCHER))
        + scenario
        + "\nmain\n"
    )
    script = tmp_path / "harness.sh"
    script.write_text(harness)
    proc = subprocess.run(
        ["bash", str(script)],
        capture_output=True,
        text=True,
        timeout=30,  # a runaway loop (e.g. a broken reset) fails loudly instead of hanging CI
        cwd=str(ML_DIR.parent),
    )
    attempts_file = run_root / "attempts"
    attempts = len(attempts_file.read_text().split()) if attempts_file.exists() else 0
    return _Result(proc.returncode, attempts, proc.stdout + proc.stderr)


def test_clean_exit_runs_once_and_returns_zero(tmp_path):
    r = _drive_main(tmp_path, 'run_once() { echo a >> "$ATTEMPTS_FILE"; return 0; }')
    assert r.rc == 0
    assert r.attempts == 1  # a clean run is never relaunched


def test_pointer_rejected_halts_immediately_without_retry(tmp_path):
    # The heart of PR-6: exit EXIT_POINTER_REJECTED ⇒ the launcher HALTS, never bounded-retries.
    # run_once returns the launcher's OWN constant, so the test tracks the script's value.
    code = _exit_code("EXIT_POINTER_REJECTED")
    r = _drive_main(
        tmp_path,
        'run_once() { echo a >> "$ATTEMPTS_FILE"; return "$EXIT_POINTER_REJECTED"; }',
    )
    assert r.rc == code  # propagated verbatim as the do-not-retry signal
    assert r.attempts == 1  # halted on the first attempt — not retried
    assert "not retrying" in r.output.lower()


def test_no_progress_crash_loop_halts_at_bound(tmp_path):
    # A persistently-failing run that never checkpoints (latest_step stays 0 — no latest.json) is
    # bounded: exactly MAX_CONSECUTIVE_FAILS attempts, then a distinct EXIT_CRASH_LOOP halt.
    code = _exit_code("EXIT_CRASH_LOOP")
    r = _drive_main(
        tmp_path,
        'run_once() { echo a >> "$ATTEMPTS_FILE"; return 1; }',
        max_fails=3,
    )
    assert r.rc == code
    assert r.attempts == 3
    assert "crash-loop" in r.output.lower()


def test_checkpoint_progress_resets_the_fail_counter(tmp_path):
    # latest_step climbs 0,0,100,100,… — the step advance observed at the top of attempt 3 resets
    # `fails`, so with MAX=3 the bound is hit at attempt 5, NOT attempt 3. If the reset logic
    # regressed (counter never reset), this would halt at attempt 3 and `attempts == 5` would fail.
    code = _exit_code("EXIT_CRASH_LOOP")
    scenario = (
        'latest_step() { local n; n="$(cat "$SEQ_FILE")"; n=$((n + 1)); echo "$n" > "$SEQ_FILE"; '
        'if [ "$n" -le 2 ]; then echo 0; else echo 100; fi; }\n'
        'run_once() { echo a >> "$ATTEMPTS_FILE"; return 1; }'
    )
    r = _drive_main(tmp_path, scenario, max_fails=3)
    assert r.rc == code
    assert r.attempts == 5  # 5, not 3 — the progress at attempt 3 reset the counter


@pytest.mark.skipif(not CMD.is_file(), reason="needs ppo-train.cmd")
def test_cmd_maps_both_halt_codes_to_no_retry():
    """ppo-train.cmd must map BOTH coded halts to `exit /b 0` so Task Scheduler <RestartOnFailure>
    never re-amplifies a deliberate halt. EXIT_POINTER_REJECTED (3) is transitively pinned by the
    test_train_common_args.py canary, but EXIT_CRASH_LOOP (4) and the .cmd's `if "%RC%"=="N"`
    literals had NO cross-file pin: a bump of EXIT_CRASH_LOOP in ppo-train.sh would silently desync
    the .cmd branch and re-amplify crash-loops. The launcher tests can't run cmd.exe, so pin the
    coupling statically here (lean tier, no torch)."""
    cmd_text = CMD.read_text()
    for name in ("EXIT_POINTER_REJECTED", "EXIT_CRASH_LOOP"):
        code = _exit_code(name)  # read from ppo-train.sh
        assert re.search(rf'if\s+"%RC%"=="{code}"\s*\(', cmd_text), (
            f'ppo-train.cmd must map RC=={code} ({name}) to no-retry: `if "%RC%"=="{code}" (`'
        )
    # the catch-all still propagates everything else to the backstop
    assert "exit /b %RC%" in cmd_text


def test_transient_failure_then_success_exits_zero(tmp_path):
    # The bounded-RETRY path (distinct from the do-not-retry exit-3 path): a transient exit-1
    # failure is relaunched, and a subsequent clean exit ends the loop at 0.
    scenario = (
        'run_once() { echo a >> "$ATTEMPTS_FILE"; '
        'local n; n="$(cat "$SEQ_FILE")"; n=$((n + 1)); echo "$n" > "$SEQ_FILE"; '
        '[ "$n" -ge 2 ] && return 0 || return 1; }'
    )
    r = _drive_main(tmp_path, scenario, max_fails=5)
    assert r.rc == 0
    assert r.attempts == 2  # failed once, relaunched, then succeeded
