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
  `EnvServerProcess`, `cwd = repo root`, `shutil.which("node")`). It must be **Node ≥14 (shodan runs
  v22 via nvm)**: a login/non-interactive shell (`bash -lc`, a scheduled `wsl -e`) resolves the stale
  `/usr/bin/node` **v12**, which SyntaxErrors on the env-server's `??` and crash-loops the run. nvm
  only loads from `.bashrc` (interactive shells), so any launcher that isn't interactive must
  `export PATH="$HOME/.nvm/versions/node/v22*/bin:$PATH"` explicitly (the §4b supervisor does this).
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
4. **Why Task Scheduler and not `nohup` (the durability mechanism):** the run survives because the
   Task Scheduler _service_ owns the `wsl.exe` process for the whole run, which keeps the WSL2 **VM**
   alive. A `nohup`/`&` launch driven over SSH does NOT — when the launching `wsl.exe` returns nothing
   holds the VM open and WSL2 idle-reaps it within ~1–2 min (symptom: boot logs stop mid-startup at
   step 0, no error, `uptime` reset). So a hand-rolled supervisor `.sh` must background the arms then
   `wait` (the `wait` is what anchors the VM for the run's duration).
5. **Registering without the `.xml`:** `schtasks.exe` will **not run from inside WSL** ("cannot execute
   binary file: Exec format error" — interop binfmt isn't registered there); register from the
   PowerShell landing shell. Cleanest is the cmdlets (no `/tr` quoting), pointing at a supervisor:
   ```powershell
   Register-ScheduledTask -TaskName "dicewars-ppo-wave" -Force `
     -Action    (New-ScheduledTaskAction -Execute C:\Windows\System32\wsl.exe -Argument '-d Ubuntu -e /home/<you>/<supervisor>.sh') `
     -Trigger   (New-ScheduledTaskTrigger -AtStartup) `
     -Principal (New-ScheduledTaskPrincipal -UserId 'SHODAN\<you>' -LogonType Interactive) `
     -Settings  (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew)
   Start-ScheduledTask -TaskName "dicewars-ppo-wave"
   ```
   `LogonType Interactive` needs the user logged into the console (verify with
   `(Get-CimInstance Win32_ComputerSystem).UserName`); a running task reads `LastTaskResult=267009`
   (`0x41301` = "currently running", **not** an error).

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
4. **Back up the finished run off-shodan** — the `ml/runs/<run>/` dir (`{ppo.pt, eval/, state, tb}`,
   ~32 MB) is the only copy until you do. shodan→mini, byte-exact through the ASCII-safe base64 path
   (PowerShell-over-SSH mangles raw bytes; base64 survives it):

   ```bash
   # on shodan: tar the run dir to /tmp first, then stream it decoded onto the mini
   ssh shodan "wsl -d Ubuntu bash -lc 'cd ~/dicewarsjs && tar czf /tmp/<run>.tgz ml/runs/<run>'"
   ssh shodan "wsl -d Ubuntu base64 -w0 /tmp/<run>.tgz" | tr -cd 'A-Za-z0-9+/=' \
     | ssh mini "python3 -c 'import sys,base64; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > ~/backup/<run>.tgz"
   ```

   **Verify by per-file _content_ SHA, not the outer-tar SHA.** gzip embeds a timestamp, so re-tarring
   the same bytes yields a different archive hash — and the naive `sha … | cut -d" "` gets its delimiter
   eaten by the nested ssh→wsl→bash quoting (produces empty hashes, a silent false MISMATCH). Instead
   compare the file trees: `find ml/runs/<run> -type f -print0 | xargs -0 sha256sum` on shodan vs. the
   extracted tarball on the mini (`shasum -a 256`), each `sort`ed by path, then `diff`. Timestamp-
   independent, and it catches real corruption (the new `unpackPolicyWeights.js` guard throws on a
   corrupt base64 weight blob, so integrity matters).

5. **Delete the schtasks task** that §4b registered: `ssh shodan 'schtasks /Delete /TN "<name>" /F'` —
   NOT `Unregister-ScheduledTask -Confirm:$false` (the `$false` mangles to a literal `\False` through
   PowerShell-over-SSH and the delete no-ops). Its **AtStartup** trigger otherwise relaunches the
   _finished_ run on the next reboot. Also `rm` the supervisor script the task points at.

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
(PERSONAS §1) — but that assumes env-sim still has CPU headroom at the K-arm footprint; **before
committing N_ENVS for a concurrent wave, run the capacity pre-flight (§8e).** For a same-day batch,
background all three in one WSL session:

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

> **⚠ `ppo-train.cmd`'s `WSLENV` list does NOT forward `EVAL_EVERY`** (nor `EXPECTED_ENCODING_VERSION`).
> The latter is harmless (defaults to 3), but a `.cmd`-based Task Scheduler launch silently reverts
> `EVAL_EVERY` to `1000000` — halving strength-curve resolution and dropping the 0.5M tripwire probe.
> To carry the §8f `EVAL_EVERY=500000` override through Task Scheduler, add `EVAL_EVERY/u` to the
> `WSLENV` line first, `set` it in the wrapper `.cmd`, or bypass `.cmd` with a supervisor `.sh` (§4b.5).

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

### 8d. Batch-2B dense-persona re-pilot wave ([D-30])

The Batch-2 coef sweep failed structurally (BATCH2_REPILOT_FINDINGS.md + its §7 Addendum); the
[D-30] wave replaces the coef axis with a reward-**shape** change, still **flag-only**. Four 1M
arms, warm-started from `ppo-long`, run from the kept persona worktree:

| Arm (RUN_NAME)       | Overrides on top of the `PERSONA` preset                                      | Mechanism                                                       |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ppo-exp-g99-c04`    | `PERSONA=expansionist GAMMA=0.99 TERRITORY_REWARD_COEF=0.04 SHAPING_CLIP=1.0` | γ=0.99 → early-weighted avg-territory objective; stall earns ~0 |
| `ppo-exp-g99-c08`    | same with `TERRITORY_REWARD_COEF=0.08`                                        | upper bracket (bracket LOW — see [D-30] dec. 1)                 |
| `ppo-pred-place-b15` | `PERSONA=predator REWARD_MODE=placement ELIM_BOUNTY=0.15`                     | placement prices death; bounty rewards the kill                 |
| `ppo-pred-place-b25` | same with `ELIM_BOUNTY=0.25`                                                  | upper bracket (0.3+ nears the over-commit exchange rate)        |

**Pre-flight (BLOCKING, in this order):**

1. **Fast-forward the worktree** (`~/dicewarsjs-personas`, kept @ `1c40853`) to current master —
   the wave needs the **#97 eval producer** for fixtured mid-run probes. Safe: the launcher's
   commit pin is per-`RUN_NAME` (`$RUN_ROOT/RUN_COMMIT`), so fresh-named arms pin the new SHA;
   never fast-forward under a _resuming_ run name.
2. `ml/runs/ppo-long/ppo.pt` present (the preset warm-start; preflight HALTs if missing).
3. **Prove the probe path end-to-end** before burning GPU: league snapshots have NO parity
   fixture ([D-22]) and `behavior:profile` hard-exits without one, so probes MUST come from the
   eval stream. Take any existing `eval-*.weights.js` (+ sibling fixture) — or export one
   directly: `cd ml && python -m dicewars_bc.export_weights --ckpt <ckpt.pt> --out x.weights.js
--fixture x.fixture.json --no-packed` (sibling-named fixture; `--no-packed` because a packed
   export outside `src/ai/` fails loud — do NOT use bare `npm run ppo:export`, whose hardcoded
   args overwrite the shipped weights and put the fixture in `tests/fixtures/`) — and run a 1-run
   `behavior:profile` against it. If this doesn't run, the wave's abort machinery doesn't exist;
   fix that first.
4. **Fresh `--state-dir` per arm** (automatic with fresh `RUN_NAME`s): resume restores the OLD γ
   from the SB3 zip, silently ignoring `GAMMA=0.99`.

**Launch (staggered like Batch-2 if the 20M scratch run is still training — ≤3 concurrent
training processes; otherwise all four at once):**

```bash
cd ~/dicewarsjs-personas && source ml/.venv/bin/activate
# Wave A (repeat with the -c08 / -b25 arms as Wave B when these finish, or run all 4 if scratch is done)
PERSONA=expansionist RUN_NAME=ppo-exp-g99-c04 GAMMA=0.99 TERRITORY_REWARD_COEF=0.04 SHAPING_CLIP=1.0 \
  TIMESTEPS=1000000 LR=1e-4 N_ENVS=4 EVAL_EVERY=500000 \
  nohup bash scripts/shodan/ppo-train.sh > ml/runs/ppo-exp-g99-c04.boot.log 2>&1 &
PERSONA=predator RUN_NAME=ppo-pred-place-b15 REWARD_MODE=placement ELIM_BOUNTY=0.15 \
  TIMESTEPS=1000000 LR=1e-4 N_ENVS=4 EVAL_EVERY=500000 \
  nohup bash scripts/shodan/ppo-train.sh > ml/runs/ppo-pred-place-b15.boot.log 2>&1 &
```

(`PERSONA` only sets _defaults_, so every explicit override above wins; `REWARD_MODE=placement` +
`ELIM_BOUNTY` compose — `validate_reward_args` has no exclusivity. For a disconnect-surviving
launch use the §8b Task Scheduler wrappers with these same vars.)

**0.5M tripwire probe (per arm, ~minutes).** When the ~500k eval checkpoint lands (step is
zero-padded to 9 digits — `eval-000500000.weights.js` on a clean run, but a crash-restart
re-anchors the cadence grid, so glob `eval/eval-*.weights.js` or read `eval/index.jsonl` for the
first ≥500k entry), profile it against the control AND the arm's **matched-backbone comparator**
([D-30] dec. 4 — Blitz for E arms, Survivor for P arms). Reference the comparator by its **bare
built-in name** — the persona weights ship in-tree, so `Blitz`/`Survivor` resolve from any
checkout; the `ml/runs/ppo-blitz/` exports live in the MAIN tree and are NOT visible from the
persona worktree's cwd:

```bash
node scripts/behavior-profile.mjs \
  --bots "ExpC04=ml/runs/ppo-exp-g99-c04/eval/eval-000500000.weights.js,Blitz" \
  --control Conqueror --runs 3 --games 10
```

Abort per the [D-30] dec. 3 tiering — **warn at 0.5M on any ONE axis; kill at 0.5M on 2+ axes or
one at 2×; kill at 1M on any axis** (turtle side: ΔavgDiceReserve > +10,
ΔzeroAttackTurnFrac > +0.05, ΔturnsToWin > +20; overextension side: ΔsurvivalTurn < −60 **plus**
a co-signal; absolute floor winPct < 35). Zero-cost proxy between probes: `ep_len_mean` in `tb/`
drifting **±15%**.

**1M full eval + the 3M decision.** Per surviving arm: export (§8c naming, plus `--no-packed` —
run-dir exports have no sibling decoder, and a packed export outside `src/ai/` fails loud), then
`behavior:profile --runs 6 --games 30` (control + matched comparator) and `ppo:gate` 8×80 vs
Lookahead. Ship bars, kill criteria, and the 3M → fresh-seed → `--bar PPO` → `arena:ml` chain are
pre-registered in **[D-30] decisions 5–6** — grade against those, not vibes. Export/ship plumbing
(`ai_<persona>.js`, `builtInBots`) stays unbuilt until a 3M winner clears everything.

### 8e. Pre-flight: 3-arm throughput capacity (BEFORE committing a concurrent wave's N_ENVS)

The single-arm `ppo:throughput-probe` (§`RESULTS`) proves ONE arm's env-sim speed; it does NOT
prove that _K arms at once_ still each hit that speed. A concurrent wave seats K arms × N_ENVS
env-servers simultaneously (one `ppo-env-server.mjs` per env — §4's `N_ENVS = min(nproc-2, 12)`),
so the v3 Wave-1 slate is **3 × 12 = 36 Node servers on shodan's 16 cores** (2.25× oversubscribed),
past the ≤20-env footprint any run has actually proven. §8a's "3 concurrent runs cost ≈ the time of
one" only holds while the CPU still has env-sim headroom under that load — this probe measures
whether it does, so **run it BEFORE locking N_ENVS for any concurrent wave.**

It is **zero-GPU** (stub learner, ~free), so run it **on shodan itself** — contention scales with
core count, so a laptop run only sanity-checks the tool, not the real footprint. It costs ~a minute
of CPU and touches no GPU, so it's safe to run while nothing is training:

```bash
cd <repo> && node scripts/ppo-arm-throughput-probe.mjs   # defaults: 3 arms × 12 envs, realistic league
# knobs: --arms --envs-per-arm --seconds --target-fps --margin --json ; --help via an unknown flag
```

Two timed passes (one arm alone, then all 3 at once) report the per-arm throughput DROP and a
go/no-go on the N_ENVS you're about to commit. The verdict is one-sided: the probe measures the
env-sim CEILING (an upper bound on realized trainer fps — it captures the v3 encoder's ~5–9% cost
natively but not the GPU/wire that sit ON TOP), so **RED (ceiling below the per-arm target even
with zero GPU cost) is conclusive** — reduce N_ENVS or run fewer arms concurrently. GREEN means
env-sim is not the bottleneck at this footprint (GPU/latency then set the realized fps — the §8a
regime); commit N_ENVS. Target defaults to **175 fps/arm** — batch-1's figure, and the wall the
Wave-1 estimate assumes (3 × 3M steps / ~5 h ≈ 167 steps/s per arm). Exit code: 0/GREEN|YELLOW,
2/RED, 1/usage. Re-probe after any change to N_ENVS, the arm count, or the encoder.

### 8f. v3 Wave-1 persona retrain — the verified launch recipe ([D-31], PERSONAS §10.2/§10.7)

Wave 1 is **3 concurrent PPO fine-tunes, 3M steps each**, all warm-started from the completed
encoding-v3 base `ml/runs/ppo-v3-scratch/ppo.pt` (step 20,004,864, `encodingVersion 3`): the
**Conqueror-control** (win, γ0.999 — matched control, never ships), **Blitz-v3** (win, **γ0.99**),
and **Survivor-v3** (**placement**, γ0.999). Source of truth is
[docs/ml-bot/PERSONAS.md](../../docs/ml-bot/PERSONAS.md) §10.2 (the slate) + §10.7 (sequencing).
**§8/§8a is NOT the recipe for this wave** — that is the v2 (bite-F) batch: its `PERSONA` presets
warm-start from the v2 `runs/ppo-long/ppo.pt` under v2 run names (`ppo-conqueror`/`ppo-blitz`/
`ppo-survivor`, ppo-train.sh:57-59), so following it verbatim silently produces the WRONG run.
The launcher supports Wave 1 via env overrides, but its defaults are the 20M BEAT-run production
values — you must override the silent traps below explicitly.

**Pre-flight (BLOCKING, in this order):**

1. **Fast-forward shodan `464a2ee` → master.** The box is pinned at `464a2ee`, which predates the
   §8e 3-arm throughput probe (#116); §8e can't run there until it advances. The fast-forward is
   **verified safe**: `git diff 464a2ee..master` is byte-identical for `ml/dicewars_ppo`, the
   launcher, the obs-frame wire, the env-server, and `src/arena/encodeObservation.js` — the
   training env cannot change under the warm start; only JS eval tooling is added.
2. **Confirm `ml/runs/ppo-v3-scratch/ppo.pt` exists** on this box (the preset warm-start; the v3
   loader HALTs loudly if it's missing — see below).
3. **Run §8e and take `N_ENVS` from its GREEN/RED verdict** — the default 12/arm → 3 × 12 = 36
   servers on 16 cores is 2.25× oversubscribed and unproven. Do NOT launch until §8e greenlights a
   footprint.

**Launch (PERSONA-preset path — every silent-trap knob set explicitly):**

```bash
cd /home/ilay/dicewarsjs && source ml/.venv/bin/activate
# ⚠ set N_ENVS=<§8e result> on each arm before launching (default 12/arm → 36 servers on 16 cores).
for spec in "conqueror ppo-v3-conq-ctl" "blitz ppo-v3-blitz" "survivor ppo-v3-survivor"; do
  set -- $spec
  PERSONA=$1 RUN_NAME=$2 \
    CHECKPOINT=runs/ppo-v3-scratch/ppo.pt EXPECTED_ENCODING_VERSION=3 \
    TIMESTEPS=3000000 LR=1e-4 ENT_COEF=0.01 RESERVE_BASELINES=3 EVAL_EVERY=500000 \
    nohup bash scripts/shodan/ppo-train.sh > ml/runs/$2.boot.log 2>&1 &
done
jobs -l
```

> **⚠ Durability:** this `nohup` loop survives only inside a session that outlives your shell — paste
> it into a **persistent** interactive WSL console, or (preferred) drop it into a supervisor `.sh` that
> ends in `wait` and launch that via a Task Scheduler task (§4b.4–5). Fired-and-forgotten over SSH it
> dies at **step 0** when WSL2 idle-reaps the VM. Verified 2026-07-05: the raw SSH `nohup` launch
> reached "Using cuda device" on all 3 arms, then the VM shut down (`uptime` reset) before any step.

| Knob                        | Value                        | Why override / fail-loud-or-silent                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERSONA`                   | conqueror/blitz/survivor     | Selects the preset that supplies `REWARD_MODE` + `GAMMA` for free (ppo-train.sh:57-59) — do NOT hand-set γ/reward on this path.                                                                                                                                                                                                                                        |
| `RUN_NAME`                  | `ppo-v3-*` (fresh)           | Overrides the preset's v2 default (`ppo-conqueror` etc.). **Fresh name = fresh `--state-dir`** (SB3 resume silently restores old γ). Collision w/ an old v2 dir → **FAIL-LOUD** (below).                                                                                                                                                                               |
| `CHECKPOINT`                | `runs/ppo-v3-scratch/ppo.pt` | Overrides the preset default (v2 `runs/ppo-long/ppo.pt`). Resolved **relative to `ml/`** (`$ML_DIR/$CHECKPOINT`, ppo-train.sh:167) → on disk it's `ml/runs/ppo-v3-scratch/ppo.pt`; don't sanity-check it from the repo root. **FAIL-LOUD**: the v3 loader (`load_bc_checkpoint`/policy.py) rejects a non-v3 checkpoint.                                                |
| `EXPECTED_ENCODING_VERSION` | `3`                          | Asserts the repo's **live JS encoder** (`encodeObservation.js`) is at v3 — a mismatch HALTs with `POINTER_ENCODING_SKEW` (guards a mid-campaign `ENCODING_VERSION` bump), **FAIL-LOUD**. NB: it does NOT inspect the checkpoint — the stale-_checkpoint_ backstop is the `CHECKPOINT` row above. Equals the launcher default, so on a v3 box it's belt-and-suspenders. |
| `TIMESTEPS`                 | `3000000`                    | **SILENT trap** — default `20000000` is a ~6.7× / ~31h-vs-5h GPU overrun. No guard.                                                                                                                                                                                                                                                                                    |
| `LR`                        | `1e-4`                       | **SILENT trap** — default `2.5e-4` (the BEAT LR) over-nudges the warm start. No guard.                                                                                                                                                                                                                                                                                 |
| `EVAL_EVERY`                | `500000`                     | **SILENT trap** — default `1000000` halves strength-curve resolution AND drops the 0.5M tripwire-probe checkpoint the §10.5 panel needs. No guard.                                                                                                                                                                                                                     |
| `ENT_COEF`                  | `0.01`                       | Matched-recipe provenance (PERSONAS §10.2); equals the launcher default, so it's a no-op set explicitly to pin the control on every axis.                                                                                                                                                                                                                              |
| `RESERVE_BASELINES`         | `3`                          | R=3 LOCKED ([D-24]); equals the default — explicit for the same matched-control reason.                                                                                                                                                                                                                                                                                |
| `N_ENVS`                    | **§8e result**               | **SILENT trap** — NOT in the loop above; set per-arm from §8e first. Default 12/arm → 36 servers on 16 cores (2.25× oversubscribed). No guard.                                                                                                                                                                                                                         |

**What each PERSONA preset supplies for free (ppo-train.sh:57-59):** `REWARD_MODE` (`win` for
conqueror/blitz, `placement` for survivor), `GAMMA` (0.999, or **0.99 for blitz** — the one tempo
lever), and a **default `RUN_NAME` we override**. Because γ + reward-mode come correctly from the
preset, they need no overriding on this path — but a no-PERSONA hand-roll would have to set
`GAMMA`/`REWARD_MODE` explicitly. **Why some mistakes are caught and some aren't:** leaving
`CHECKPOINT` at the v2 default fails loud (the v3 loader rejects it) and a `RUN_NAME` collision
with an old v2 dir is caught by the commit-pin drift HALT + the POINTER_ENCODING_SKEW HALT in this
v2→v3 transition — but `TIMESTEPS`/`EVAL_EVERY`/`LR` have **no guard**, so an unset one burns GPU
silently. That asymmetry is exactly why the block sets all three explicitly.

**After the runs:** gate + profile each arm per **§8c** (the persona gate/profile recipe — export to
the `.weights.js`/sibling `.fixture.json` convention, then `ppo:gate` for strength and
`behavior:profile` for style). The §10.4 clock-hack kill-gate (a placement arm forcing an early
decisive death near the now-visible turn cap to bank rank rather than truncate to 0) is now
**instrumented and operational** — `behavior:profile` prints a "Clock-hack tripwire (§10.4)" panel
and `evaluateClockHack()` returns `kill`. Its thresholds are **RATIFIED (2026-07-08): window 50,
nearCapDeathRate 0.05, lateGameAggressionSpike 0.31, truncationRate co-signal 0.18** — calibrated
per the pre-registration from the Conqueror-control's 0.5M/1M eval checkpoints vs the base in the
§10.3 calibration field — see [docs/ml-bot/PERSONAS.md](../../docs/ml-bot/PERSONAS.md) §10.4
(calibration numbers: RESULTS.md 2026-07-08).
