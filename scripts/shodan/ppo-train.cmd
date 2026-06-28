@echo off
REM ==================================================================================================
REM  Windows -> WSL bridge for the disconnect-surviving PPO launcher (ml-bot Phase-3 PR-6, [D-26]).
REM
REM  Task Scheduler runs THIS .cmd (see ppo-train-task.xml); it invokes wsl.exe to run the real bash
REM  launcher (scripts/shodan/ppo-train.sh) inside the [rl] venv. Going through Task Scheduler +
REM  wsl.exe is the only pattern that survives an SSH teardown AND a box reboot ([D-26] task-E):
REM  a run started over a bare `ssh` session dies when the session ends.
REM
REM  CONFIGURE (edit these, or set them as machine/user environment variables):
REM    WSL_DISTRO       the WSL distro name (`wsl -l -v` to list).            default: Ubuntu
REM    REPO_WSL_PATH    repo root AS WSL SEES IT (e.g. /home/you/dicewarsjs   default: /home/%USERNAME%/dicewarsjs
REM                     or /mnt/c/Users/you/dicewarsjs).
REM    VENV_ACTIVATE    venv activate script, relative to the repo root.      default: ml/.venv/bin/activate
REM
REM  To override a training knob for this scheduled run (e.g. a bigger budget), prepend it to the
REM  bash command below, e.g.  ... && TIMESTEPS=40000000 bash scripts/shodan/ppo-train.sh
REM  Run the FROM-SCRATCH control run from a shell first (RUNBOOK.md) before scheduling the long run.
REM ==================================================================================================
setlocal
if "%WSL_DISTRO%"==""    set "WSL_DISTRO=Ubuntu"
if "%REPO_WSL_PATH%"=="" set "REPO_WSL_PATH=/home/%USERNAME%/dicewarsjs"
if "%VENV_ACTIVATE%"=="" set "VENV_ACTIVATE=ml/.venv/bin/activate"

REM -l = login shell so a conda/venv init in the user's profile is honored; then activate the [rl]
REM venv explicitly (the launcher's preflight HALTS loudly if torch/sb3 are still missing).
REM `cd ... || exit 1` so a misconfigured REPO_WSL_PATH fails with a clear error instead of running
REM ppo-train.sh from $HOME and dying with an opaque "No such file or directory"; `source` stays
REM non-fatal (2>/dev/null) because the launcher preflight re-checks the venv.
wsl.exe -d %WSL_DISTRO% -- bash -lc "cd '%REPO_WSL_PATH%' || exit 1; source '%VENV_ACTIVATE%' 2>/dev/null; exec bash scripts/shodan/ppo-train.sh"
REM Capture wsl's exit code immediately (no intervening command clobbers ERRORLEVEL). The 3/4
REM do-not-retry mapping below relies on wsl.exe propagating the launcher's exit code to ERRORLEVEL;
REM modern WSL2 (shodan) does. On an ancient WSL that didn't, a coded halt would just be retried by
REM the backstop (harmless: exit 3 re-halts within seconds; exit 4 re-amplifies, bounded by Count).
set "RC=%ERRORLEVEL%"

REM The two CODED halts (3, 4) must not be re-amplified by the task's <RestartOnFailure> backstop (it
REM fires on ANY non-zero exit and can't tell a deliberate halt from a dead .cmd): a relaunch only
REM re-halts+re-alerts (3) or re-runs a no-progress crash-loop (4) for ~Count x MAX_CONSECUTIVE_FAILS
REM attempts. So map 3 and 4 to 0. Everything else propagates to the backstop and IS retried up to
REM <RestartOnFailure Count> times -- intended for transient boot-time failures (CUDA/drive not ready
REM yet), but note this INCLUDES the launcher's own preflight `exit 1` halts (encoding/commit/
REM checkpoint), which therefore re-alert at most Count times rather than once.
REM   3 = EXIT_POINTER_REJECTED  (unrecoverable resume state -- bytes won't heal)
REM   4 = EXIT_CRASH_LOOP        (bounded no-progress crash-loop -- needs an operator, not a relaunch)
if "%RC%"=="3" (
  echo ppo-train.cmd: launcher halted EXIT_POINTER_REJECTED ^(3^) -- intentional, not retrying. See RUNBOOK "Recovery".
  exit /b 0
)
if "%RC%"=="4" (
  echo ppo-train.cmd: launcher halted on a crash-loop ^(4^) -- intentional, not retrying. See RUNBOOK "crash-loop".
  exit /b 0
)
exit /b %RC%
