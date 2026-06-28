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
wsl.exe -d %WSL_DISTRO% -- bash -lc "cd '%REPO_WSL_PATH%' && source '%VENV_ACTIVATE%' 2>/dev/null; exec bash scripts/shodan/ppo-train.sh"
exit /b %ERRORLEVEL%
