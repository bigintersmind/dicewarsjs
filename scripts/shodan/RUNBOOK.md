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

**When the launcher HALTS on a crash-loop** (`N` consecutive failures with no checkpoint progress):
the run is dying before it can checkpoint. Read the last attempt's traceback (launcher.log / stdout) —
common causes: a wedged Node env-server (`ppo-env-server.mjs`), an OOM, or a GPU/driver fault. Fix the
cause, then re-run; a failure _after_ the step advances resets the counter, so this only trips on a
genuine no-progress loop.

**Stop the unattended run:** `schtasks /end /tn "dicewars-ppo-train"` (and disable the task if you do
not want it to relaunch at next logon/boot).

---

## 7. After the run

1. Gate (§5); if `BEAT`, the exported `src/ai/ppoPolicyWeights.js` is the candidate to merge (it is a
   distinct file from `bcPolicyWeights.js`).
2. Update `docs/ml-bot/RESULTS.md` (win% table + the Lookahead pin) and `LOG.md`.
3. Deferred test-hardening (env-server `main()` persistence integration test, live cross-worker
   `SharedDiskStore`, live forkserver two-half resume smoke) is **PR-7**, not part of this run.
