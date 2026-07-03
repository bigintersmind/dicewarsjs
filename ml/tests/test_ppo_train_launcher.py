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


# --- persona launcher (bite F) -------------------------------------------------------------------
# The PERSONA preset + the bite-D reward-flag forwarding. These SOURCE the launcher (guarded main ⇒
# not run) and inspect the resolved config / the assembled `python -m dicewars_ppo.train` argv, that
# the launcher factors into `build_train_argv` precisely so this can be pinned in lean CI without
# spawning python, torch, or a GPU. The contract under test: a persona only sets DEFAULTS (an
# explicit env override always wins), and an UNSET persona is byte-identical to the BEAT-run reward.


def _resolve(tmp_path, env=None, *, build_argv=True, snippet=None):
    """Source the launcher with ``env``, then run an inspection ``snippet``; return ``(rc, out)``.

    ``RUN_ROOT`` is pinned into ``tmp_path`` so the launcher's source-time ``mkdir -p`` can't touch
    the real ``ml/runs`` tree. When ``build_argv`` (the default), ``build_train_argv`` runs first so
    ``snippet`` can read ``TRAIN_ARGV``; the default snippet prints that argv one element per line.
    """
    run_root = tmp_path / "run"
    lines = [
        "set -euo pipefail",
        f'export RUN_ROOT="{run_root}"',
        'export DEVICE="cpu"',
    ]
    lines += [f'export {k}="{v}"' for k, v in (env or {}).items()]
    lines.append(f'source "{LAUNCHER}"')
    if build_argv:
        lines.append("build_train_argv")
    lines.append(snippet or 'printf "%s\\n" "${TRAIN_ARGV[@]}"')
    script = tmp_path / "resolve.sh"
    script.write_text("\n".join(lines) + "\n")
    proc = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, timeout=30, cwd=str(ML_DIR.parent)
    )
    return proc.returncode, proc.stdout + proc.stderr


def _argv_pairs(output: str) -> dict:
    """Fold a printed ``--flag\\nvalue`` argv into a ``{flag: value}`` dict (last wins). Flags that
    take no value map to '' (the next token is another flag or end)."""
    toks = output.split("\n")
    out = {}
    i = 0
    while i < len(toks):
        t = toks[i]
        if t.startswith("--"):
            nxt = toks[i + 1] if i + 1 < len(toks) else ""
            if nxt.startswith("--") or nxt == "":
                out[t] = ""
                i += 1
            else:
                out[t] = nxt
                i += 2
        else:
            i += 1
    return out


def test_no_persona_is_byte_identical_to_the_beat_run(tmp_path):
    # The KEY invariant: an unset PERSONA forwards the SAME training command as the pre-change
    # BEAT/control launcher. Assert the WHOLE production flag set (not just the reward subset) so a
    # future edit to build_train_argv that silently drops/alters a regime flag — e.g. removing
    # `--snapshot-store disk` (reverting to a per-worker memory league), `--snapshot-dir` (PFSP
    # off), or `--start-method forkserver` (the fork-after-threads hazard) — turns this test RED
    # instead of letting a multi-day run train on a different regime under a "byte-identical" check.
    rc, out = _resolve(tmp_path)
    assert rc == 0
    argv = _argv_pairs(out)
    assert set(argv) == {
        "--checkpoint",
        "--out",
        "--timesteps",
        "--n-envs",
        "--start-method",
        "--lr",
        "--ent-coef",
        "--gamma",
        "--reward-mode",
        "--terminal-speed-bonus",
        "--territory-reward-coef",
        "--elim-bounty",
        "--device",
        "--snapshot-dir",
        "--snapshot-every",
        "--snapshot-store",
        "--reserve-baselines",
        "--league-state-dir",
        "--league-dump-every",
        "--state-dir",
        "--checkpoint-every",
        "--eval-dir",
        "--eval-every",
        "--log-dir",
    }  # no prod flag added/dropped; --speed-ref/--shaping-clip/--from-scratch are conditional
    # The [D-19] sparse terminal-win objective the BEAT run trained on — and the UNSHAPED wire
    # (both dense coefs 0, so the env-server gets no --reward-shaping):
    assert argv["--reward-mode"] == "win"
    assert argv["--terminal-speed-bonus"] == "0"
    assert argv["--territory-reward-coef"] == "0"
    assert argv["--elim-bounty"] == "0"
    assert argv["--checkpoint"] == "checkpoints/v2-base/bc_model.pt"  # BC warm start, not a persona
    # The regime-defining values a silent edit could flip under the multi-day run:
    assert argv["--start-method"] == "forkserver"  # CUDA-after-fork / fork-after-threads guard
    assert argv["--snapshot-store"] == "disk"  # cross-worker league, not per-worker memory
    assert argv["--reserve-baselines"] == "3"  # R=3 turtle-equilibrium floor ([D-24])
    assert argv["--snapshot-every"] == "100000"
    assert argv["--checkpoint-every"] == "100000"
    # Durable per-checkpoint eval stream (Phase 0 strength-curve harness): default-on like the
    # snapshot producer, 1M cadence, into $RUN_ROOT/eval. Forwarded on EVERY run (incl. personas).
    assert argv["--eval-every"] == "1000000"
    assert argv["--eval-dir"].endswith("/eval")
    assert argv["--league-dump-every"] == "50"
    # The task-A BEAT production HPs (NOT train.py's own protective defaults):
    assert argv["--lr"] == "2.5e-4"
    assert argv["--ent-coef"] == "0.01"
    assert argv["--gamma"] == "0.999"
    assert argv["--timesteps"] == "20000000"


def test_persona_blitz_lowers_gamma_and_warm_starts_from_ppo_long(tmp_path):
    rc, out = _resolve(
        tmp_path,
        {"PERSONA": "blitz"},
        build_argv=False,
        snippet='echo "$REWARD_MODE|$GAMMA|$RUN_NAME|$CHECKPOINT"',
    )
    assert rc == 0
    reward, gamma, run_name, checkpoint = out.strip().split("|")
    assert reward == "win"
    assert gamma == "0.99"  # the tempo lever (PERSONAS §5) — distinct from the 0.999 default
    assert run_name == "ppo-blitz"
    assert checkpoint == "runs/ppo-long/ppo.pt"  # specialize the BEAT policy, not the BC net


def test_persona_survivor_uses_placement_reward(tmp_path):
    rc, out = _resolve(tmp_path, {"PERSONA": "survivor"})
    assert rc == 0
    argv = _argv_pairs(out)
    assert argv["--reward-mode"] == "placement"
    assert argv["--gamma"] == "0.999"
    assert argv["--checkpoint"] == "runs/ppo-long/ppo.pt"


def test_persona_conqueror_is_the_matched_control(tmp_path):
    # The control re-runs today's objective (win / 0.999) but still warm-starts from ppo-long and
    # gets its own run name, so its behavioral profile is a matched baseline for the others.
    rc, out = _resolve(
        tmp_path,
        {"PERSONA": "conqueror"},
        build_argv=False,
        snippet='echo "$REWARD_MODE|$GAMMA|$RUN_NAME|$CHECKPOINT"',
    )
    assert rc == 0
    assert out.strip() == "win|0.999|ppo-conqueror|runs/ppo-long/ppo.pt"


def test_persona_expansionist_sets_territory_coef(tmp_path):
    # Bite G dense persona: warm-start + win mode like Conqueror, plus a non-zero territory coef
    # that (via DiceWarsEnv) flips the env-server to --reward-shaping. Elim bounty stays 0.
    rc, out = _resolve(tmp_path, {"PERSONA": "expansionist"})
    assert rc == 0
    argv = _argv_pairs(out)
    assert argv["--territory-reward-coef"] == "0.02"
    assert argv["--elim-bounty"] == "0"
    assert argv["--reward-mode"] == "win"
    assert argv["--checkpoint"] == "runs/ppo-long/ppo.pt"


def test_persona_predator_sets_elim_bounty(tmp_path):
    rc, out = _resolve(tmp_path, {"PERSONA": "predator"})
    assert rc == 0
    argv = _argv_pairs(out)
    assert argv["--elim-bounty"] == "0.1"
    assert argv["--territory-reward-coef"] == "0"
    assert argv["--reward-mode"] == "win"
    assert argv["--checkpoint"] == "runs/ppo-long/ppo.pt"


def test_shaping_clip_forwarded_iff_set(tmp_path):
    # --shaping-clip is gated on SHAPING_CLIP being non-empty (like --speed-ref), so an unset clip
    # stays off (unbounded). Set it explicitly and it rides through.
    rc, out = _resolve(tmp_path, {"PERSONA": "expansionist", "SHAPING_CLIP": "0.5"})
    assert rc == 0
    assert _argv_pairs(out)["--shaping-clip"] == "0.5"


def test_explicit_env_overrides_persona_preset(tmp_path):
    # PERSONA sets DEFAULTS only (`:=`), so an explicit override always wins — needed to sweep e.g.
    # Blitz's gamma floor without forking the launcher.
    rc, out = _resolve(tmp_path, {"PERSONA": "blitz", "GAMMA": "0.97", "RUN_NAME": "blitz-v2"})
    assert rc == 0
    argv = _argv_pairs(out)
    assert argv["--gamma"] == "0.97"


def test_unknown_persona_exits_nonzero(tmp_path):
    rc, out = _resolve(tmp_path, {"PERSONA": "wrecker"}, build_argv=False, snippet="echo unreached")
    assert rc != 0
    assert "unknown persona" in out.lower()
    assert "unreached" not in out


def test_speed_ref_forwarded_iff_speed_ref_set(tmp_path):
    # The launcher gates `--speed-ref` on `[ -n "$SPEED_REF" ]` — i.e. on SPEED_REF being non-empty,
    # NOT on the bonus. Pin both that coupling and the footgun: SPEED_REF set with the bonus still 0
    # STILL forwards `--speed-ref` (train.py then rejects bonus==0 + a ref, fail-loud — RUNBOOK §8).
    # The absent-when-unset direction is covered by the byte-identical test's whole-flag-set assert
    # (no --speed-ref there).
    rc, out = _resolve(tmp_path, {"PERSONA": "blitz", "SPEED_REF": "120"})  # bonus left at 0
    assert rc == 0
    argv = _argv_pairs(out)
    assert argv["--terminal-speed-bonus"] == "0"  # bonus untouched...
    assert argv["--speed-ref"] == "120"  # ...yet --speed-ref forwarded purely because SPEED_REF set

    rc, out = _resolve(
        tmp_path, {"PERSONA": "blitz", "TERMINAL_SPEED_BONUS": "0.5", "SPEED_REF": "120"}
    )
    assert rc == 0
    argv = _argv_pairs(out)
    assert argv["--terminal-speed-bonus"] == "0.5"
    assert argv["--speed-ref"] == "120"


def test_from_scratch_still_appends_flag_after_refactor(tmp_path):
    # The control run uses FROM_SCRATCH=1; pin that build_train_argv preserved it through the
    # run_once → build_train_argv refactor.
    rc, out = _resolve(tmp_path, {"FROM_SCRATCH": "1"})
    assert rc == 0
    assert "--from-scratch" in _argv_pairs(out)


def test_preflight_rejects_ambiguous_from_scratch(tmp_path):
    # FROM_SCRATCH is honored only as the literal '1', so any other non-empty value (e.g. 'true')
    # used to SILENTLY select the warm-started mode. preflight must refuse to guess. The guard is
    # the first preflight check, so this stays hermetic (no node/torch/checkpoint needed).
    rc, out = _resolve(tmp_path, {"FROM_SCRATCH": "true"}, build_argv=False, snippet="preflight")
    assert rc != 0
    assert "refusing to guess" in out.lower()


@pytest.mark.skipif(not CMD.is_file(), reason="needs ppo-train.cmd")
def test_cmd_forwards_persona_into_wsl():
    """The Windows→WSL bridge must export PERSONA AND every per-run knob into WSL via WSLENV so a
    per-persona scheduled task can set them as Windows env vars without editing it. Assert each
    `*/u` token (not just PERSONA): dropping e.g. REWARD_MODE/u or SPEED_REF/u would silently strand
    the matching `:=`-override path (test_explicit_env_overrides_persona_preset) at the Windows→WSL
    boundary with nothing to catch it."""
    cmd_text = CMD.read_text()
    assert "WSLENV" in cmd_text
    # Every launcher env var a scheduled task may set per-persona (RUNBOOK "persona" batch knobs).
    for var in (
        "PERSONA",
        "CHECKPOINT",
        "TIMESTEPS",
        "LR",
        "ENT_COEF",
        "GAMMA",
        "RUN_NAME",
        "REWARD_MODE",
        "TERMINAL_SPEED_BONUS",
        "SPEED_REF",
        "TERRITORY_REWARD_COEF",
        "ELIM_BOUNTY",
        "SHAPING_CLIP",
        "N_ENVS",
        "RESERVE_BASELINES",
    ):
        assert re.search(rf"{var}/u", cmd_text), f"ppo-train.cmd must forward {var} via WSLENV"
