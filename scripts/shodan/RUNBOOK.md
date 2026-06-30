# shodan PPO long-run runbook (ml-bot Phase-3 task C/E, PR-6)

The operator guide for the **long BEAT run** — the disconnect-surviving, auto-restarting PPO training
job that PR-6 wraps around the PR-4 driver (`train.py`) and the PR-5 idempotent checkpoint/resume
core. It runs on **shodan** (Windows + WSL2 Ubuntu, RTX 4070 Ti). Read this end-to-end once before
launching: the long run burns days of GPU, so the pre-flight gates below exist to make sure that time
is not wasted.

Files in this directory:

| File                 | What it is                                                                             |
| -------------------- | -------------------------------------------------------------------------------------- |
| `ppo-train.sh`       | the bash launcher: production HPs + both resume halves + the bounded auto-restart loop |
| `ppo-train.cmd`      | Windows → WSL bridge (`wsl.exe -- bash … ppo-train.sh`) that Task Scheduler invokes    |
| `ppo-train-task.xml` | importable Task Scheduler definition (survives SSH teardown + reboot)                  |
| `RUNBOOK.md`         | this file                                                                              |

---

## 0. The contract you are operating under

- **Resume is statistically-consistent, bounded-skew — NOT bit-exact** ([D-26] Q3). The Python half
  (policy + optimizer + `num_timesteps` + RNG sidecar) and the Node league half
  (`league-state-<seedBase>.json`) resume **independently** (no two-phase commit), and the Node env
  workers cannot replay trajectories. A resumed run continuing on a slightly different random stream
  is **expected**, not a bug.
- **The budget is absolute** ([D-26] HOLE-D). The launcher always relaunches with the **same**
  `--timesteps`; `_remaining_timesteps` + `learn(reset_num_timesteps=False)` cap the campaign at that
  absolute total no matter how many times it restarts. Do **not** "top up" `TIMESTEPS` on a restart
  expecting more training — raise it deliberately and understand it changes the absolute target.
- **Two states are never silently retried** (PR-6 safety guard). `train.py` exits
  **`EXIT_POINTER_REJECTED` (3)** on an unrecoverable resume state, and the launcher treats that as
  **halt + alert**, never relaunch. See §6.
- **Pin the commit + encoding for the whole campaign.** The launcher records `git rev-parse HEAD` in
  `RUN_COMMIT` on first launch and **halts** if HEAD later drifts; it also refuses to launch unless
  `ENCODING_VERSION == 2`. A mid-run `git pull` that bumps the encoding makes pooled snapshots
  unloadable (`POINTER_ENCODING_SKEW`). Finish the campaign on one commit.

---

## 1. Prerequisites (one-time, on shodan)

```bash
# in WSL, at the repo root
cd ~/dicewarsjs            # or wherever you cloned it
cd ml && python -m venv .venv && source .venv/bin/activate
pip install -e .[rl]       # gymnasium + stable-baselines3 + sb3-contrib + pettingzoo + tensorboard
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"   # expect True
```

- `pip install -e .[rl]` **re-resolves torch from PyPI** and may replace your CUDA build — see
  `ml/README.md` for the `constraints.txt` pin if `torch.cuda.is_available()` flips to `False`.
- `node` must be on PATH inside WSL (the trainer spawns one Node `ppo-env-server.mjs` per env via
  `EnvServerProcess`, `cwd = repo root`, `shutil.which("node")`).
- The BC warm-start checkpoint (`ml/checkpoints/v2-base/bc_model.pt`, the deployed `ai_bc`) must be
  present. It is a trained artifact, not committed — copy it to shodan if missing.

---

## 2. Gate BEFORE the long run — the PR-5 shodan validation checklist (BLOCKING)

The sb3-coupled resume **execution** path is shodan-only (the lean CI tier has no sb3). It must pass
on this box **before** you trust the auto-restart with a multi-day job. Run the rl tiers + the
[D-26] checklist:

```bash
cd ml && source .venv/bin/activate
python -m pytest tests/test_resume.py tests/test_train_args.py tests/test_train_common_args.py \
                 tests/test_snapshot_callback.py tests/test_train_tracer_args.py -q
```

Confirm (these are the [D-26] holes the long run depends on; the tests above pin each):

- [ ] `MaskablePPO.load` round-trips with **no `custom_objects`** and restores `num_timesteps`
      (PATH A / HOLE-C) — `test_load_resume_restores_num_timesteps_and_policy`.
- [ ] `--device cuda` resume restores the RNG sidecar **to CPU without crashing**
      (`test_load_resume_on_cuda_restores_rng_without_crash`, runs only with a GPU).
- [ ] `_setup_learn` caps at the **absolute** `--timesteps` under `reset_num_timesteps=False`
      (HOLE-D) — `test_resume_setup_learn_caps_at_absolute_budget`.
- [ ] **Corrupt-`.zip` fallback** rolls back to the retained prior pair, and **all-corrupt** raises
      `ResumeCheckpointError` (→ the halt path) — the two new PR-6 tests in `test_resume.py`.
- [ ] A **live forkserver two-half resume**: start a short run with `--state-dir` + `--league-state-dir`,
      kill it mid-flight, relaunch the SAME command, and confirm it resumes (see §4 smoke).

> If any of these fail on shodan, **stop** and fix before launching — this path has never run off the
> GPU box. (Locally, only the torch-free `test_resume_state.py` tier runs; it covers the candidate
> ordering + the resume/fresh/halt policy, not the live `MaskablePPO.load`.)

Also confirm the **turtle floor** before committing: the field must stay decisive. A quick
multi-seed check that global `decisiveRate >= 0.60` (no degenerate stall equilibrium) — see
`npm run ppo:league-probe` / `arena:sweep` decisiveRate output.

---

## 3. The from-scratch control run (sequenced BEFORE the long run) — [D-19] / [D-26] Q6

The task-A +33.4 BEAT was partly **fixed-field exploitation** (4 of 7 gate opponents, including all 3
strong, were training opponents — [D-23]). The control run proves a gate win is **real PPO learning**,
not that artifact: train from a fresh init (no BC warm start) for a short budget and confirm it learns
_something_ above chance.

```bash
FROM_SCRATCH=1 RUN_NAME=ppo-control TIMESTEPS=1000000 DEVICE=cuda \
    bash scripts/shodan/ppo-train.sh
```

`--from-scratch` is mutually exclusive with `--freeze-trunk` and relaxes `--lr`/`--ent-coef` only when
those are omitted; the launcher passes explicit production HPs, so set `LR`/`ENT_COEF` for the control
explicitly if you want the from-scratch exploration defaults instead. Gate it (see §5) and sanity-check
the curve in TensorBoard before spending days on the long run.

---

## 4. Launch the long run

### 4a. Interactive (good for the first launch + the live-resume smoke)

```bash
cd ~/dicewarsjs
source ml/.venv/bin/activate
bash scripts/shodan/ppo-train.sh            # RUN_NAME=ppo-long, TIMESTEPS=20000000 by default
```

**Live two-half resume smoke** (do this once): let it write at least one checkpoint
(`ml/runs/ppo-long/state/latest.json` appears and its `step` advances), `Ctrl-C`, then re-run the exact
same command. It should log `resumed from … at num_timesteps=<N>` and continue — not restart at 0.

Common overrides (env vars; defaults in `ppo-train.sh` header):

| Var                                   | Default            | Meaning                                         |
| ------------------------------------- | ------------------ | ----------------------------------------------- |
| `TIMESTEPS`                           | `20000000`         | absolute env-step budget for the whole campaign |
| `N_ENVS`                              | `min(nproc-2, 12)` | parallel `SubprocVecEnv(forkserver)` workers    |
| `LR` / `ENT_COEF`                     | `2.5e-4` / `0.01`  | task-A BEAT production HPs                      |
| `CHECKPOINT_EVERY` / `SNAPSHOT_EVERY` | `100000`           | resume cadence / PFSP snapshot cadence (steps)  |
| `RESERVE_BASELINES`                   | `3`                | R, **locked** at 3 ([D-24]/B5)                  |
| `DEVICE`                              | `cuda`             | use `cpu` only for a smoke                      |
| `MAX_CONSECUTIVE_FAILS`               | `5`                | no-progress crash-loop bound                    |

### 4b. Unattended via Task Scheduler (survives SSH teardown + reboot)

1. Edit `ppo-train-task.xml`: set `<UserId>` (twice) to your account and the `<Command>` /
   `<WorkingDirectory>` to the Windows path of this `scripts\shodan` dir. Edit `ppo-train.cmd`'s
   `REPO_WSL_PATH` / `VENV_ACTIVATE` (or set them as env vars).
2. Import + start:
   ```bat
   schtasks /create /tn "dicewars-ppo-train" /xml scripts\shodan\ppo-train-task.xml
   schtasks /run    /tn "dicewars-ppo-train"
   ```
3. **GPU caveat:** WSL2 CUDA generally needs the user session. The template uses an
   `InteractiveToken` principal + a logon trigger — pair with auto-login to survive reboot. If you
   switch to "run whether logged on or not", verify `torch.cuda.is_available()` is `True` under that
   context first (the launcher preflight halts loudly otherwise).

---

## 5. Gate the result — the [D-24] / [D-7] kill gate

After a budget unit (or at the end), export the repacked actor and gate it on **win%** (never ELO)
vs `ai_lookahead@596f781`:

```bash
# export the long-run actor (the npm ppo:export script points at the TRACER ckpt; override --ckpt)
cd ml && source .venv/bin/activate
python -m dicewars_bc.export_weights \
    --ckpt runs/ppo-long/ppo.pt \
    --out ../src/ai/ppoPolicyWeights.js \
    --fixture ../tests/fixtures/bc/ppoForwardCases.json
# Output is the compact packed base64-f32 module (default since #51): it imports the sibling
# ./unpackPolicyWeights.js, so it MUST land in src/ai/. (The gate below loads it the same way.)
cd .. && npm run ppo:gate            # 20 runs x 150 games, PPO vs Lookahead@596f781, paired Δ + 95% CI
```

- **PASS = `BEAT`**: a statistically significant win% edge — the paired per-run win% **Δ 95% CI lower
  bound is > 0**. `TIE`/`BEHIND` do not pass.
- **Kill gate ([D-24]):** if, after a budget unit, the 95% CI lower bound is **not** > 0 → declare
  **plateau** and fall back to the best of Track A / Phase 2 (`ai_bc`). A small true edge needs more
  `--runs` to clear the CI: `npm run ppo:gate -- --runs 40 --games 200`.
- Sanity baseline: `npm run ppo:gate -- --weights src/ai/bcPolicyWeights.js --fixture tests/fixtures/bc/forwardCases.json --name BCanchor`
  validates the harness against the known BC anchor (≈ TIE/BEHIND).

Record the result (PPO win% / Lookahead win% / Δ / CI / the run commit + Lookahead pin) in
`docs/ml-bot/RESULTS.md`.

---

## 6. Monitoring & recovery

**Monitor:**

- `ml/runs/<name>/launcher.log` — every attempt, exit code, restart, and ALERT (also on stdout).
- `ml/runs/<name>/tb/` — TensorBoard event files (one continuous run, merged by `num_timesteps`) +
  per-session `progress-<resumed_step>.csv` (a resume never truncates an earlier session's CSV).
- `ml/runs/<name>/state/latest.json` — the crash hinge; its `step` is the resume point.
- `nvidia-smi` in WSL — the learner should keep the GPU busy (it is the binding rate, [D-24]).

**When the launcher HALTS (`EXIT_POINTER_REJECTED` / exit 3 — "UNRECOVERABLE resume state"):**

`train.py` prints a cause-specific, **non-destructive** message via `describe_pointer_rejection`.
The recovery action depends on the cause:

- `corrupt-json` / `dangling-ref`: the **pointer** broke but the `ckpt-*.zip`/`.rng.pt` pairs on disk
  are likely still loadable. **Inspect them BEFORE deleting `latest.json`** (it is the breadcrumb to
  them). The corrupt-`.zip` fallback means a torn _newest_ zip auto-rolls back to the retained prior
  pair; a halt here means the pointer itself (or every retained pair) is unusable.
- `version-skew` / `encoding-skew`: the on-disk checkpoints are from an **incompatible build** — a
  fresh start is correct. This should not happen mid-campaign because the commit + encoding are
  pinned; if it does, something changed under the run (check `RUN_COMMIT`).

To **deliberately** restart a campaign, point `--state-dir`/`RUN_NAME` at a **fresh** directory rather
than leaving a rejected pointer in place — the launcher's halt is exactly there to stop a silent
restart-from-0 from re-burning days of GPU.

**When the launcher HALTS on a crash-loop** (`N` consecutive failures with no checkpoint progress,
launcher exit `EXIT_CRASH_LOOP` / `4`): the run is dying before it can checkpoint. Read the last
attempt's traceback (launcher.log / stdout) — common causes: a wedged Node env-server
(`ppo-env-server.mjs`), an OOM, or a GPU/driver fault. Fix the cause, then re-run; a failure _after_
the step advances resets the counter, so this only trips on a genuine no-progress loop. Under Task
Scheduler this is **not** auto-relaunched: `ppo-train.cmd` maps both intentional halt codes (`3` and
`4`) to `0`, so `<RestartOnFailure>` does not re-amplify the crash-loop — the task stops and waits for
you (re-run it with `schtasks /run` after fixing the cause).

**Stop the unattended run:** `schtasks /end /tn "dicewars-ppo-train"` (and disable the task if you do
not want it to relaunch at next logon/boot).

---

## 7. After the run

1. Gate (§5); if `BEAT`, the exported `src/ai/ppoPolicyWeights.js` is the candidate to merge (it is a
   distinct file from `bcPolicyWeights.js`).
2. Update `docs/ml-bot/RESULTS.md` (win% table + the Lookahead pin) and `LOG.md`.
3. Deferred test-hardening (env-server `main()` persistence integration test, live cross-worker
   `SharedDiskStore`, live forkserver two-half resume smoke) is **PR-7**, not part of this run.

---

## 8. Reward-persona batch (bite F) — the concurrent persona runs

The headline BEAT run is done. This launches the **reward-persona roster**
([docs/ml-bot/PERSONAS.md](../../docs/ml-bot/PERSONAS.md)): several PPO bots that share the BEAT
policy as their starting point but specialize toward distinct play-styles via the reward objective.
**Prerequisite:** `ml/runs/ppo-long/ppo.pt` (the BEAT actor) must exist on this box — each persona
warm-starts from it (PERSONAS §8 step 3). Preflight HALTs if it is missing.

The launcher's `PERSONA` knob is the whole mechanism: it sets the reward objective + a default
`RUN_NAME` + warm-starts from `runs/ppo-long/ppo.pt`. **Everything else (TIMESTEPS / LR / N_ENVS / R)
is shared — set it once for the batch** so the Conqueror control is matched on every axis but the
reward (PERSONAS §3: vary reward XOR field, never both). The three flag-only personas:

| `PERSONA`   | Reward objective                         | Run name        |
| ----------- | ---------------------------------------- | --------------- |
| `conqueror` | `win`, γ=0.999 — **the matched control** | `ppo-conqueror` |
| `blitz`     | `win`, **γ=0.99** (tempo lever, §5)      | `ppo-blitz`     |
| `survivor`  | **`placement`**, γ=0.999                 | `ppo-survivor`  |

These are **specialization** runs from an already-strong policy, so the budget is far smaller than the
20M from-scratch/BC run — start at **`TIMESTEPS=3000000`** (≈ a few hours each; calibrate from the
first run's TensorBoard). Consider a **lower `LR`** than the BEAT `2.5e-4` so the reward shaping nudges
rather than wrecks the warm start. (Expansionist/Predator need the per-frame territory/elim wire scalar
— "bite G" — and are not in this batch.)

### 8a. Launch concurrently (the simple path — one WSL session)

The box is idle and the runs are latency-bound, so 3 concurrent runs cost ≈ the time of one
(PERSONAS §1). For a same-day batch, background all three in one WSL session:

```bash
cd <repo> && source ml/.venv/bin/activate
for P in conqueror blitz survivor; do
  PERSONA=$P TIMESTEPS=3000000 LR=1e-4 nohup bash scripts/shodan/ppo-train.sh \
      > ml/runs/ppo-$P.boot.log 2>&1 &
done
jobs -l   # 3 PIDs; each persona has its OWN runs/<name>/ tree (state/league/tb) — no collision
```

Each run is fully isolated: dirs are keyed on `RUN_NAME`, and every Node env-server binds an
**OS-assigned ephemeral port** (`--port=0`), so nothing is shared but the read-only BEAT actor and the
GPU. Monitor each at `ml/runs/<name>/launcher.log` + `ml/runs/<name>/tb/` (§6).

### 8b. Launch via Task Scheduler (reboot-surviving — for longer runs)

`ppo-train.cmd` forwards `PERSONA` (+ the per-run knobs) into WSL via `WSLENV`, so each var only has to
be present in the **Windows process environment** when the task runs. But Task Scheduler's `<Exec>`
action has no env-var field and `ppo-train.cmd` takes no arguments, and a single _global_ Windows
`PERSONA` var can't differentiate three concurrent persona tasks — so set it **per task** one of two
ways (clone `ppo-train-task.xml` per persona, each with a distinct `<URI>`/name):

- **Wrapper command (no extra file):** point the task action at
  `cmd.exe /c "set PERSONA=blitz&& set TIMESTEPS=3000000&& set LR=1e-4&& scripts\shodan\ppo-train.cmd"`
  (the `set`s populate the process env that `WSLENV` then forwards).
- **Per-persona .cmd copy:** copy `ppo-train.cmd` → `ppo-train-blitz.cmd` with `set PERSONA=blitz` (and
  any per-run knobs) near the top, and point that persona's task at the copy.

The auto-restart / HALT semantics (§6) apply per persona, independently.

### 8c. Gate + profile each persona

Each persona gets **two** measurements — strength **and** style:

```bash
# Export each persona's actor to the `.weights.js` / sibling `.fixture.json` convention. This naming
# is LOAD-BEARING for step 2: behavior:profile has NO --fixture flag — it derives the parity fixture
# from the weights path via siblingFixturePath (`*.weights.js` → `*.fixture.json`, same dir). Run from
# ml/ (cd ml && source .venv/bin/activate); repeat for ppo-conqueror (the control) and ppo-survivor.
python -m dicewars_bc.export_weights --ckpt runs/ppo-blitz/ppo.pt \
    --out runs/ppo-blitz/blitz.weights.js --fixture runs/ppo-blitz/blitz.fixture.json

# 1. Strength (does it still beat Lookahead, or how much win% did the persona cost?) — §5 gate.
#    ppo:gate DOES take an explicit --fixture (unlike behavior:profile):
cd .. && npm run ppo:gate -- --weights ml/runs/ppo-blitz/blitz.weights.js \
    --fixture ml/runs/ppo-blitz/blitz.fixture.json --name Blitz

# 2. Style (did a DISTINCT personality emerge?) — the behavioral-eval harness gates the persona's
#    pre-registered signature. The bot's display NAME must match the PERSONA_SIGNATURES key (Blitz);
#    the fixture is found as the weights file's `.fixture.json` sibling automatically.
npm run behavior:profile -- --bots Blitz=ml/runs/ppo-blitz/blitz.weights.js \
    --control Conqueror=ml/runs/ppo-conqueror/conqueror.weights.js \
    --mde aggression:1.5,turnsToWin:8   # calibrate the MDEs from the pilot; see EVAL_HARNESS.md
```

Personas are **not** gated on beating Lookahead — a Blitz that trades win% for tempo is the
deliverable (PERSONAS §9). Record each persona's win% **and** behavioral signature in
`docs/ml-bot/RESULTS.md`. Ship the fun ones as in-game bots (a weights file + a thin `ai_<persona>.js`
alias + an `aiConfig`/`builtInBots` entry — the `ai_ppo` wiring from PR #74 generalizes).
