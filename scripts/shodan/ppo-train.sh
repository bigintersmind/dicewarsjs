#!/usr/bin/env bash
#
# Disconnect-surviving PPO launcher for the long BEAT run (ml-bot Phase-3 task C/E, PR-6, [D-26]).
#
# WHAT THIS IS. A thin, idempotent wrapper around `python -m dicewars_ppo.train` that owns the
# PRODUCTION hyperparameters (the task-A BEAT config, deliberately NOT a train.py default — see
# _train_common.resolve_from_scratch / LOG) and turns the PR-5 idempotent checkpoint/resume core
# into an AUTO-RESTARTING multi-day job: on a transient crash it relaunches the SAME command with the
# SAME --timesteps, so HOLE-D's _remaining_timesteps caps the run at the ABSOLUTE budget rather than
# re-burning it per relaunch. It is meant to be driven on shodan (Windows + WSL2 Ubuntu, RTX 4070 Ti)
# under Task Scheduler so it survives SSH teardown AND a box reboot — the only disconnect-surviving
# pattern ([D-26] task-E). See scripts/shodan/ppo-train.cmd + ppo-train-task.xml for the schtasks
# wrapper, and scripts/shodan/RUNBOOK.md for launch / monitor / recovery / the kill gate.
#
# WHY A BOUNDED-RESTART LOOP (not a bare `while true`). The binding throughput constraint is the SB3
# learner loop, not env-sim ([D-24]/B5), so the job is long-lived and WILL hit transient deaths
# (a wedged Node env-server, an OOM blip, a driver hiccup). We relaunch those. But two failure modes
# must NEVER be retried blindly, and train.py signals the first with a distinct exit code:
#   * EXIT_POINTER_REJECTED (3): a present-but-rejected latest.json (corrupt/version/encoding skew,
#     dangling ref) OR a corrupt .zip whose retained fallbacks are also unreadable. Retrying re-reads
#     the same bad bytes forever, and a silent fresh start would re-burn days of GPU. => HALT + ALERT.
#   * A crash-loop with NO forward progress (the run dies before the first checkpoint, every time).
#     We bound CONSECUTIVE no-progress failures; a failure AFTER the checkpoint step advanced resets
#     the counter, so a run that crashes once after days of progress is not killed by a stale count.
#
# USAGE (all knobs are env vars with production defaults; see RUNBOOK.md for the control-run recipe):
#   bash scripts/shodan/ppo-train.sh                       # the long BEAT run (warm-started)
#   FROM_SCRATCH=1 RUN_NAME=ppo-control TIMESTEPS=1000000 \
#       bash scripts/shodan/ppo-train.sh                   # the [D-19] from-scratch control run
#   PERSONA=blitz    TIMESTEPS=3000000 bash scripts/shodan/ppo-train.sh   # a reward-persona run: warm-
#   PERSONA=survivor TIMESTEPS=3000000 bash scripts/shodan/ppo-train.sh   # starts from ppo-long's actor
#   PERSONA=conqueror TIMESTEPS=3000000 bash scripts/shodan/ppo-train.sh  # (control). See RUNBOOK "persona".
#
set -euo pipefail

# --- locate the repo (this file is scripts/shodan/ppo-train.sh => repo root is two levels up) ------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ML_DIR="$REPO_ROOT/ml"
ENCODE_JS="$REPO_ROOT/src/arena/encodeObservation.js"

# --- reward-persona preset (bite F; docs/ml-bot/PERSONAS.md §8 step 3) -----------------------------
# Each persona is the SAME warm-started run differing ONLY in the reward OBJECTIVE (mode / discount /
# optional speed bonus). Every OTHER hyperparameter (TIMESTEPS/LR/ENT_COEF/N_ENVS/R) is shared, set
# once for the batch, so the Conqueror control is matched on everything but the reward axis
# (PERSONAS §3: vary reward XOR opponent field, never both). A persona only sets DEFAULTS (`:=`), so
# an explicit env override always wins, and an UNSET persona is a pure no-op — byte-identical to the
# BEAT-run launcher. Persona runs warm-start from ppo-long's repacked actor (PERSONAS §8 step 3), not
# the BC net; preflight HALTs loudly if that actor isn't on this box. This block must precede the
# RUN_NAME default below so a persona can name its own run.
PERSONA="${PERSONA:-}"
case "$PERSONA" in
  "") ;;  # no persona → the long BEAT run / control behavior, unchanged (byte-identical)
  conqueror) : "${CHECKPOINT:=runs/ppo-long/ppo.pt}"; : "${REWARD_MODE:=win}";       : "${GAMMA:=0.999}"; : "${RUN_NAME:=ppo-conqueror}" ;;
  blitz)     : "${CHECKPOINT:=runs/ppo-long/ppo.pt}"; : "${REWARD_MODE:=win}";       : "${GAMMA:=0.99}";  : "${RUN_NAME:=ppo-blitz}" ;;
  survivor)  : "${CHECKPOINT:=runs/ppo-long/ppo.pt}"; : "${REWARD_MODE:=placement}"; : "${GAMMA:=0.999}"; : "${RUN_NAME:=ppo-survivor}" ;;
  *) echo "ppo-train: unknown PERSONA='$PERSONA' (expected: conqueror | blitz | survivor)" >&2; exit 1 ;;
esac

# --- run identity + paths -------------------------------------------------------------------------
RUN_NAME="${RUN_NAME:-ppo-long}"
RUN_ROOT="${RUN_ROOT:-$ML_DIR/runs/$RUN_NAME}"
STATE_DIR="${STATE_DIR:-$RUN_ROOT/state}"          # Python resume half (zip + RNG sidecar + latest.json)
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$RUN_ROOT/league}"    # PFSP snapshot pool (weights + manifest.json)
LEAGUE_STATE_DIR="${LEAGUE_STATE_DIR:-$RUN_ROOT/league-state}"  # Node resume half + disk win-rate store
LOG_DIR="${LOG_DIR:-$RUN_ROOT/tb}"                  # TensorBoard event files + per-session progress CSV
OUT="${OUT:-$RUN_ROOT/ppo.pt}"                      # repacked BC-format actor (what ppo:export consumes)
LAUNCH_LOG="$RUN_ROOT/launcher.log"

# --- model + budget + production HPs --------------------------------------------------------------
CHECKPOINT="${CHECKPOINT:-checkpoints/v2-base/bc_model.pt}"  # BC warm start (resolved from $ML_DIR)
TIMESTEPS="${TIMESTEPS:-20000000}"                  # ABSOLUTE env-step budget for the WHOLE campaign
DEVICE="${DEVICE:-cuda}"                             # shodan GPU; "cpu" only for a smoke
LR="${LR:-2.5e-4}"                                  # task-A BEAT config (production HP — NOT a default)
ENT_COEF="${ENT_COEF:-0.01}"                        # task-A BEAT config (production HP)
GAMMA="${GAMMA:-0.999}"                             # a persona may have lowered this above (Blitz)

# --- persona reward objective (bite D flags). Defaults reproduce the [D-19] sparse terminal-win the
# BEAT run trained on, so an unset persona forwards a byte-identical objective. ----------------------
REWARD_MODE="${REWARD_MODE:-win}"                   # 'win' = Conqueror/Blitz; 'placement' = Survivor
TERMINAL_SPEED_BONUS="${TERMINAL_SPEED_BONUS:-0}"   # Blitz's optional secondary lever (0 = off)
SPEED_REF="${SPEED_REF:-}"                          # turn-count ref; train.py REQUIRES it when bonus>0

# --- parallelism ([D-26] Q4: SubprocVecEnv(forkserver), CUDA inits AFTER the fork) ----------------
# Size to cores but leave headroom for the learner + the per-worker Node env-servers. n_steps*n_envs
# stays divisible by the default batch_size (512 is a multiple of 128) for any n_envs, so the
# train.py divisibility guard never trips on this default.
if [ -z "${N_ENVS:-}" ]; then
  CORES="$(nproc 2>/dev/null || echo 8)"
  if [ "$CORES" -gt 14 ]; then N_ENVS=12; elif [ "$CORES" -gt 3 ]; then N_ENVS=$((CORES - 2)); else N_ENVS=1; fi
fi

# --- PFSP league (B3/B4) + persistence (B6) -------------------------------------------------------
RESERVE_BASELINES="${RESERVE_BASELINES:-3}"         # R=3 LOCKED ([D-24]/B5): turtle-equilibrium floor
SNAPSHOT_EVERY="${SNAPSHOT_EVERY:-100000}"
CHECKPOINT_EVERY="${CHECKPOINT_EVERY:-100000}"      # resume cadence (independent of --snapshot-every)
LEAGUE_DUMP_EVERY="${LEAGUE_DUMP_EVERY:-50}"        # Node league dump cadence in BOOKED episodes

# --- auto-restart policy --------------------------------------------------------------------------
EXIT_POINTER_REJECTED=3                              # MUST match dicewars_ppo._train_common.EXIT_POINTER_REJECTED
                                                     # (a CI canary in test_train_common_args.py pins the pair)
EXIT_CRASH_LOOP=4                                    # this launcher's OWN intentional-halt code for a
                                                     # bounded no-progress crash-loop (distinct from a
                                                     # transient exit so ppo-train.cmd can map it to 0 and
                                                     # stop schtasks <RestartOnFailure> from re-amplifying it)
MAX_CONSECUTIVE_FAILS="${MAX_CONSECUTIVE_FAILS:-5}"  # bound a no-progress crash-loop
BACKOFF_BASE_S="${BACKOFF_BASE_S:-15}"               # backoff = min(BACKOFF_BASE_S * fails, BACKOFF_MAX_S)
BACKOFF_MAX_S="${BACKOFF_MAX_S:-120}"
EXPECTED_ENCODING_VERSION="${EXPECTED_ENCODING_VERSION:-2}"

mkdir -p "$RUN_ROOT"

# `|| true`: the deliberate exit codes (EXIT_POINTER_REJECTED / EXIT_CRASH_LOOP) drive the do-not-
# retry contract and must NEVER be pre-empted by a tee failure (a broken stdout pipe on a job whose
# terminal went away, or a full disk) aborting the script early under `set -e` + `pipefail`.
log() { printf '%s [ppo-train] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a "$LAUNCH_LOG" || true; }
alert() { log "ALERT: $*"; }  # a hook point: redirect/extend to email/push if desired (RUNBOOK.md)

# Read the integer "step" out of latest.json without a jq dependency (WSL Ubuntu may not ship it).
latest_step() {
  local f="$STATE_DIR/latest.json"
  [ -f "$f" ] || { echo 0; return; }
  grep -oE '"step"[[:space:]]*:[[:space:]]*[0-9]+' "$f" 2>/dev/null | grep -oE '[0-9]+' | tail -n1 || echo 0
}

# --- preflight: fail FAST and LOUD before committing a multi-day job ------------------------------
preflight() {
  command -v node >/dev/null 2>&1 || { alert "node not on PATH (the env-servers need it)"; exit 1; }
  [ -f "$ENCODE_JS" ] || { alert "missing $ENCODE_JS"; exit 1; }
  local enc
  enc="$(grep -oE 'ENCODING_VERSION[[:space:]]*=[[:space:]]*[0-9]+' "$ENCODE_JS" | grep -oE '[0-9]+' | tail -n1 || echo '?')"
  if [ "$enc" != "$EXPECTED_ENCODING_VERSION" ]; then
    alert "ENCODING_VERSION=$enc but expected $EXPECTED_ENCODING_VERSION — a mid-campaign bump makes"
    alert "pooled snapshots unloadable (POINTER_ENCODING_SKEW). Refusing to launch."
    exit 1
  fi
  [ -f "$ML_DIR/$CHECKPOINT" ] || { alert "BC checkpoint not found: $ML_DIR/$CHECKPOINT"; exit 1; }
  local import_err
  if ! import_err="$(python -c "import torch, sb3_contrib, gymnasium" 2>&1)"; then
    # Surface the actual ImportError, not a generic "venv not active" — a partially-broken install
    # (e.g. torch built against the wrong CUDA libs) needs the real message to diagnose, not a
    # reinstall of a venv that is already present.
    alert "the [rl] venv is not usable (need torch + sb3_contrib + gymnasium): $import_err"
    exit 1
  fi
  # DEVICE defaults to cuda, and SB3's get_device('cuda') SILENTLY falls back to CPU when CUDA is not
  # visible (no exception) — so a cuda run could burn the WHOLE --timesteps budget on CPU (days), the
  # exact waste this launcher exists to prevent, while train.py still logs the REQUESTED device=cuda.
  # Assert availability here and HALT — the docs (RUNBOOK §1/§4b, ppo-train-task.xml) promise this guard.
  if [ "${DEVICE%%:*}" = "cuda" ]; then
    if ! python -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
      alert "DEVICE=cuda but torch.cuda.is_available() is False — refusing to launch: it would train"
      alert "on CPU for days (the budget burn this run guards). Fix CUDA/the [rl] venv (RUNBOOK §1),"
      alert "or set DEVICE=cpu deliberately for a smoke."
      exit 1
    fi
  fi
}

# Pin the commit for the WHOLE run: a `git pull` mid-campaign could change the encoding/env under a
# resuming learner. Record it on first launch; HALT if HEAD drifts on a later (re)start.
check_commit_pinned() {
  local head pin_file="$RUN_ROOT/RUN_COMMIT"
  head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo 'no-git')"
  if [ ! -f "$pin_file" ]; then
    echo "$head" >"$pin_file"
    log "pinned run to commit $head"
  elif [ "$(cat "$pin_file")" != "$head" ]; then
    alert "HEAD ($head) != the pinned run commit ($(cat "$pin_file")) — the code/env changed under a"
    alert "resuming run. Refusing to continue. Check out the pinned commit, or start a fresh RUN_NAME."
    exit 1
  fi
}

# Assemble the `python -m dicewars_ppo.train` argv into the global TRAIN_ARGV array. Factored out of
# run_once so the launcher tests (ml/tests/test_ppo_train_launcher.py) can pin that the persona reward
# flags (bite D) are forwarded WITHOUT spawning python/torch/a GPU. --reward-mode/--terminal-speed-
# bonus are ALWAYS passed (their win/0 defaults are train.py's own, so an unset persona stays the
# [D-19] sparse-win objective); --speed-ref is added only when set (train.py REQUIRES it iff the bonus
# > 0, and rejects a bare flag), and --from-scratch only for the [D-19] control.
build_train_argv() {
  TRAIN_ARGV=(
    --checkpoint "$CHECKPOINT"
    --out "$OUT"
    --timesteps "$TIMESTEPS"
    --n-envs "$N_ENVS"
    --start-method forkserver
    --lr "$LR" --ent-coef "$ENT_COEF" --gamma "$GAMMA"
    --reward-mode "$REWARD_MODE" --terminal-speed-bonus "$TERMINAL_SPEED_BONUS"
    --device "$DEVICE"
    --snapshot-dir "$SNAPSHOT_DIR" --snapshot-every "$SNAPSHOT_EVERY"
    --snapshot-store disk
    --reserve-baselines "$RESERVE_BASELINES"
    --league-state-dir "$LEAGUE_STATE_DIR" --league-dump-every "$LEAGUE_DUMP_EVERY"
    --state-dir "$STATE_DIR" --checkpoint-every "$CHECKPOINT_EVERY"
    --log-dir "$LOG_DIR"
  )
  # `if` (not `[ … ] && …`): a trailing `&&` whose test is FALSE returns non-zero, which under
  # `set -e` would make this function exit 1 and abort the launcher. `if` always returns 0 here.
  if [ -n "$SPEED_REF" ]; then TRAIN_ARGV+=(--speed-ref "$SPEED_REF"); fi
  if [ "${FROM_SCRATCH:-0}" = "1" ]; then TRAIN_ARGV+=(--from-scratch); fi
}

run_once() {
  build_train_argv
  ( cd "$ML_DIR" && python -m dicewars_ppo.train "${TRAIN_ARGV[@]}" )
}

main() {
  preflight
  log "run=$RUN_NAME root=$RUN_ROOT persona=${PERSONA:-none} reward_mode=$REWARD_MODE gamma=$GAMMA \
speed_bonus=$TERMINAL_SPEED_BONUS speed_ref=${SPEED_REF:-none} checkpoint=$CHECKPOINT \
timesteps=$TIMESTEPS n_envs=$N_ENVS device=$DEVICE lr=$LR ent_coef=$ENT_COEF \
R=$RESERVE_BASELINES from_scratch=${FROM_SCRATCH:-0}"

  local fails=0 prev_step=-1 attempt=0
  while true; do
    check_commit_pinned
    local step
    step="$(latest_step)"
    if [ "$step" -gt "$prev_step" ]; then
      [ "$fails" -gt 0 ] && log "progress since last attempt (step $prev_step -> $step); resetting fail counter"
      fails=0
    fi
    prev_step="$step"

    attempt=$((attempt + 1))
    log "attempt #$attempt (resume step=$step, consecutive_fails=$fails)"

    local rc=0
    run_once && rc=0 || rc=$?

    if [ "$rc" -eq 0 ]; then
      log "training completed cleanly (exit 0). Repacked actor → $OUT"
      log "NEXT: export + gate — see scripts/shodan/RUNBOOK.md ('Gate the result')."
      exit 0
    fi

    if [ "$rc" -eq "$EXIT_POINTER_REJECTED" ]; then
      alert "train.py exited $EXIT_POINTER_REJECTED (UNRECOVERABLE resume state). NOT retrying — the"
      alert "bytes will not heal. Inspect $STATE_DIR per the FATAL message above and RUNBOOK.md"
      alert "('Recovery'). Halting."
      exit "$EXIT_POINTER_REJECTED"
    fi

    fails=$((fails + 1))
    if [ "$fails" -ge "$MAX_CONSECUTIVE_FAILS" ]; then
      alert "$fails consecutive failures with no checkpoint progress (last exit $rc) — this is a"
      alert "crash-loop, not a transient death. Halting (exit $EXIT_CRASH_LOOP) so an operator can"
      alert "investigate (RUNBOOK.md '§6 crash-loop')."
      exit "$EXIT_CRASH_LOOP"
    fi

    local backoff=$((BACKOFF_BASE_S * fails))
    [ "$backoff" -gt "$BACKOFF_MAX_S" ] && backoff="$BACKOFF_MAX_S"
    log "transient exit $rc; relaunching SAME command in ${backoff}s (HOLE-D caps the absolute budget)"
    sleep "$backoff"
  done
}

# Run main() only when this file is EXECUTED, not when it is SOURCED. The real entrypoints
# (direct `bash scripts/shodan/ppo-train.sh`, and ppo-train.cmd's `exec bash … ppo-train.sh`) are
# executed, so the guard is true and main runs exactly as before. The launcher tests
# (ml/tests/test_ppo_train_launcher.py) SOURCE this file to stub preflight/run_once/latest_step/sleep
# and drive main()'s restart loop deterministically — without the guard, sourcing would auto-run it.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
