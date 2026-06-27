# Session Log — ML / Self-Play Bot

Append-only journal. **Add an entry at the end of each working session.** Newest
at the top. This is how context — what we did, what we learned, what didn't work —
survives across days and Claude Code sessions.

Entry template:

```
## YYYY-MM-DD — <short title>
**Phase:** <n>  ·  **Who:** <Ivan / Claude>
**Did:**
- ...
**Learned / decided:**
- ...
**Dead ends / surprises:**
- ...
**Next:**
- ...
```

---

## 2026-06-27 — Task B step B4: PFSP weighting on (the sampler goes live)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:** Turned the PFSP sampler on in `scripts/lib/ppo-league.mjs` `draw()`. B3 only _loaded_ the
snapshot pool; B4 seats it. With a non-empty pool, `draw(seed)` seeds a `mulberry32` stream and fills
the `count` opponent seats with:

- `reserveCount = min(R, count, #distinctReserveBaselines)` aggressive baselines (the resolved
  `--opponents` ids, **distinct, minus `ai_bc`** — the [D-15] turtle-equilibrium defense), sampled
  WITHOUT replacement; then
- `count − reserveCount` snapshots sampled WITH replacement by `w(S) = max(ε, 1 − learnerWinRate(S))^k`
  (`ε=0.05`, `k=2`): lower learner win-rate ⇒ higher weight, cold-start `winRate=0` ⇒ weight 1
  (sampled hardest first), and ε>0 floors every weight at `ε^k > 0` so a fully-mastered snapshot is
  never starved (with a uniform fallback if a pathological k underflows `ε^k` to 0 — see post-review);

then a Fisher-Yates shuffle (same seeded stream) of opponent→seat so neither group binds to fixed
turn-order seats. **Empty pool still returns the byte-identical task-A field** — fixed-field stays the
empty-pool mode of this one pipeline.

- **Knobs as CLI flags.** Env-server `--reserve-baselines`/`--pfsp-epsilon`/`--pfsp-k` → `makeLeague`;
  `train_tracer.py` args + `_validate_args` bounds (ε∈(0,1], k≥0, R≥0, mirroring the Node guards) +
  `EnvServerProcess` argv forwarding. The PFSP knobs ride the `--snapshot-dir`/`snapshot_manifest`
  branch since they only bite a non-empty pool; Node↔Python defaults agree (R=3, ε=0.05, k=2).
- **Tests.** NEW `tests/ml/ppo-league-pfsp.test.js` (17 tests: field shape, reserve rules incl. the
  cap and the empty-reserve `ai_bc`-only case, seeded determinism, win-rate-monotone weighting +
  the higher-k-sharpens check, the ε floor / all-mastered pool, draw→record→winRate loop, new-knob
  validation). NEW `ml/tests/test_env_server_argv.py` (the Python→Node flag bridge — the only
  automated guard on argv forwarding, runs torch-free). Updated the one B3 test that asserted "B4
  hasn't happened yet" to assert snapshots ARE now seated.

**Learned / decided:**

- **Extracted `mulberry32` to its own module** (`scripts/lib/mulberry32.mjs`, re-exported from
  `ppo-probe-core.mjs`) rather than importing it from the probe tool as [D-23]'s file manifest said:
  the league is runtime code and shouldn't pull the throughput-benchmark tool (→ the env runner) into
  its module graph just to borrow an 8-line PRNG. Re-export keeps the existing probe test/imports green.
- **Shuffle opponent→seat** (a [D-23]-unstated addition): without it, reserve baselines would always
  occupy the low array indices and thus the early (first-to-move) board seats — a systematic
  turn-order pattern the learner could overfit. The shuffle is seeded, so determinism holds.
- **Reserve baselines without replacement, capped at the distinct count** (`min(R, count, #reserve)`):
  guarantees R _distinct_ aggressive opponents when enough exist, and degrades gracefully (more PFSP
  seats) when the CSV has fewer than R aggressive bots or is `ai_bc`-only (→ 0 reserved, all PFSP).

**Post-review hardening (5-dimension adversarial workflow → 12 confirmed findings, all minor):**

- **Reserve lookup now guarded.** `resolveBaselineField` only validates the first `count` _cycled_
  positions, so a typo'd opponent id PAST position `count−1` slipped past it and crashed the new
  reserve-pool build with a cryptic `undefined.name`. Added the same clear `Unknown opponent bot id`
  throw + corrected the false "cannot miss" comment.
- **ε^k FP-underflow fallback.** At a pathological `k` (≥~249 for ε=0.05), `ε^k` underflows to 0.0 in
  IEEE-754; with an all-mastered pool that zeroes the roulette total and `sampleByWeight` would
  degenerate to "always the last entry". Added a `total === 0 → uniform` fallback (and scoped the
  "never 0" claims to non-underflowing k).
- **Python validation tightened.** Moved the three PFSP guards OUT of the `--snapshot-dir` branch so
  they validate unconditionally (matching Node's always-on `makeLeague`), and added `math.isfinite`
  for `--pfsp-k` (was accepting inf/nan).
- **Test gaps closed.** Added: a shuffle anti-coupling test (a snapshot reaches the earliest seat and
  a baseline the latest — disabling the shuffle now fails); a default-pin test (default field sequence
  == explicit `{ε:0.05,k:2}`, ≠ other ε); the underflow-fallback test; the reserve-typo guard test;
  and a torch-gated `test_train_tracer_args.py` (parser defaults, `_validate_args` rejections, the
  `_make_env_thunk → server_kwargs` forwarding hop). Final: 1064 JS tests + ruff/lint/build all green.

**Dead ends / surprises:**

- Local `ml` pytest shows 6 pre-existing failures in `test_export_onnx.py` (`zip(strict=True)` needs
  Python 3.10+; this box has 3.9) — unrelated to B4, untouched files. The B4 Python (`train_tracer`
  imports SB3) is validated by `py_compile` + the torch-free argv test, per the B3 precedent.
- Several review agents initially read a stale/phantom `ppo-league.mjs` and "found" that B4 was
  unimplemented; the adversarial verify pass caught and rejected all of those against ground truth.

**Next:**

- **B5** — throughput / decisive-rate re-probe on a snapshot-heavy field (BC-forward snapshot seats
  cost ~0.8 ms/move vs ~0.02–0.4 ms heuristic); re-validate `R` against the real `count`, then lock
  the env-step budget. First live exercise of the sampler runs on shodan here.

## 2026-06-27 — Task B step B3: the snapshot pipeline (Python producer → Node hot-load)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:** Built the full PFSP snapshot pipeline end-to-end (producer + consumer), keeping `draw()`
unchanged — B3 only _loads_ snapshots; B4 samples them, so episode outcomes are still the fixed field.

- **Consumer (Node, fully tested locally).** `scripts/lib/ppo-league.mjs` gained `snapshotManifest` +
  `poolCap` and an async `refresh()`: an mtime-guarded poll of the producer `manifest.json` that
  diffs by stable id, dynamic-`import()`s each new snapshot's `.weights.js` (fresh filename → ESM URL
  cache never serves a stale module), wraps it with `makeBC({ policy })`, FIFO-evicts past `poolCap`,
  and GCs the evicted `.js`. An evicted id stays in `loadedIds` so it is never re-imported from its
  deleted file. `makeBC`/`ENCODING_VERSION` are top-level static imports with no extra load cost (the
  ~2 MB `bcPolicyWeights.js` `makeBC` pulls in is already loaded eagerly via the top-level
  `BUILT_IN_BOTS` import → `ai_bc.js`; the per-snapshot `.weights.js` load stays a dynamic `import()`
  since its filename is runtime-generated — both corrected/simplified post-review). `stats()` now reports real `poolSize` +
  `loadedSnapshots`. Env-server: `--snapshot-manifest`/`--snapshot-pool-cap` flags + `await
league.refresh()` at each episode boundary (a one-`statSync` no-op without a manifest; an
  encoding-version skew throws and stops the run — the frozen-`ENCODING_VERSION` invariant).
- **Producer (Python).** NEW `ml/dicewars_ppo/snapshot_callback.py` — `SnapshotCallback(BaseCallback)`
  publishes every `--snapshot-every` env steps: `repack_to_bc_checkpoint` → temp `.pt` →
  `export(…, fixture_path=None)` (the exact gate-proven path, no per-snapshot fixture) → fsync the
  weights → atomic `manifest.json` via temp + `os.replace`. `train_tracer.py` got
  `--snapshot-dir`/`-every`/`-pool-cap` (absolutized so producer & consumers agree on the path) and
  attaches the callback; `EnvServerProcess.__init__` forwards `snapshot_manifest`/`snapshot_pool_cap`
  into the server argv (`env.py` already splats `server_kwargs`).
- **Tests.** NEW `tests/ml/ppo-league-snapshots.test.js` (11): no-op/empty-pool, incremental
  diff-by-id, mtime short-circuit, FIFO eviction + disk GC, the `loadedIds`-vs-deleted-file guard, and
  the encoding-version fail-loud (manifest-level + per-snapshot). NEW `ml/tests/test_snapshot_callback.py`
  (5): cadence, atomic manifest schema (mirrors the JS consumer), publish orchestration (monkeypatched
  repack/export), append order. `tests/ml/` 89 green; JS lint/prettier clean; Python `py_compile` OK.

**Learned / decided:**

- Clean B3↔B4 seam: **load in B3, sample in B4.** Snapshots enter the pool but `draw()` ignores them,
  so B3 is behavior-preserving and independently testable (pool grows; the drawn field is byte-identical).
- The snapshot manifest is a NEW file distinct from the BC-corpus `manifest.py` — same name, different
  dir + schema (`{encodingVersion, snapshots:[{id,step,weights,createdAt}], latestStep}`).
- **Deviations from [D-23]** (folded into PLAN/D-23): `--snapshot-store` deferred to B6 with
  `SharedDiskStore` (no dead flag now); `--snapshot-pool-cap` added/forwarded (the cap is a consumer
  setting that genuinely needs to reach Node); producer manifest is append-only (tiny entries).

**Dead ends / surprises:**

- **No local Python env** (no torch/sb3 on this Mac), so the producer is validated by `py_compile` +
  its monkeypatched pytest, which must run on **shodan / CI** — not locally. The `repack→export` step
  it wraps is already gate-proven (PR #61), so the untested-locally surface is only the new
  orchestration (atomic manifest + cadence), which the pytest covers.

**Next:**

- **B4** — turn PFSP weighting on in `draw()`: sample the pool by `w(S)=max(ε,1−winRate(S))^k`, reserve
  R=3 aggressive baselines, seeded `mulberry32(seedBase+ep)`, empty-pool fallback. **First step the
  league must run on shodan with Python** (the producer publishing into a live consumer pool) — the B3
  Python side gets its first real exercise there.

---

## 2026-06-27 — Task B step B2: per-seat `seatBeat[]` + the id-keyed win-rate book

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Reviewed the post-review hardening that landed on the merged PRs.** PR #63 (weights + docs) and
  PR #64 (B1) are both merged. #64 carried two Ivan-authored hardening commits on top of my B1:
  `1fda04c` (validate `count`/`learnerSeat` at `makeLeague`; fold the stable `id` into the resolved
  field → single source of truth; correct dangling `[D-23]`→`[D-22]` citations) and `10f2aaa`
  (`Object.freeze` the empty-pool field + entries; external name golden; comment accuracy). All sound;
  the `id`-on-field change directly feeds B2's `recordResult` keying.
- **Implemented B2 — the [D-22] "real work item" (pairwise win-rate attribution).**
  - `scripts/lib/ppo-env.mjs`: added a per-board-seat `seatBeat[]` vector to **both** outcome shapers.
    `summarizeOutcome` derives it from the final placement order (`seatBeatFromPlacements`);
    `eliminationOutcome` synthesizes it at the learner's death from alive / prior-elim / same-turn
    co-elim, threading a `coElimSeats` **Set** out of `guardedOnTurn` (replacing the old scalar
    `coElimAbove` count, which is now derived from the set) — so the ~2× early-termination throughput
    is preserved with no full `placements` build.
  - `scripts/lib/ppo-league.mjs`: added the id-keyed win-rate book (`Map<id,{wins,games}>`).
    `recordResult` now credits `book[id].wins += seatBeat[seat]` per drawn opponent (excluding
    `maxTurns` truncations); new `winRate(id)` returns `wins/games`, **0 on cold-start** (→ max PFSP
    weight, [D-23]); `stats()` gains `bookSize`. A cycled baseline seated twice yields two independent
    records — verified.
  - `scripts/ppo-env-server.mjs`: moved `league.recordResult(drawn, result)` **above** the wire
    zero-decision gate so a zero-decision episode (a real decisive loss) **is** booked — Ivan's call on
    [D-23] open-Q2 (the wire-skip is a frame concern; the Node-side league is orthogonal).
- **Tests.** Threaded a `seatBeat` oracle (independent reimpl) into the existing full-vs-early fixtures
  in `ppo-env.test.js` — both shapers validated against the engine's placement order across a plain
  mid-game elimination, the three co-elimination tie-break seeds, a runner-up, a learner win, and the
  zero-decision seed — **zero extra match runs**. Added 7 win-rate-book tests to `ppo-league.test.js`
  (pairwise crediting, cycled-baseline double-record, interior-learner board-seat indexing, accrual,
  truncation exclusion, cold-start, no-seatBeat defensive). `tests/ml/` 78 green; lint clean.

**Learned / decided:**

- `placements` is a **best-first ordered list of seat ids** (rank = `indexOf`), so "learner beat seat
  s" = `rank[learnerSeat] < rank[s]` — strict, no ties. The early path reproduces this exactly via the
  `runMatch` ascending-seat-id / `calculatePlacements`-reversal tie-break, which the existing
  co-elimination fixtures already pin — they doubled as the B2 attribution oracle.
- Booking zero-decision episodes keeps the win-rate honest about fast-crushing fields (what PFSP wants)
  without touching the wire contract — the two concerns are cleanly separable.

**Next:**

- **B3** — the snapshot pipeline (Python SB3 `SnapshotCallback` → `repack` → `export(…,
fixture_path=None)` → atomic manifest → Node `refresh()` hot-load via `makeBC`, fresh filename). B0's
  deferred `snapshot-manifest`/`-store` CLI flags + the `ENCODING_VERSION=2` freeze doc land here too.

---

## 2026-06-27 — Task A PASSED: fixed-field 1M PPO BEATS the gate (Δ +33.4)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Launched the fixed-field 1M diagnostic ([D-22] task A) durably via a Windows Scheduled Task**
  (`schtasks /create /tn ppoff /tr "wsl bash …/ppo-fixedfield-task.sh" …; schtasks /run /tn ppoff`)
  — the only WSL-teardown-immune launch. Prior tmux/setsid attempts died inside the 15–25 min
  distro-teardown window; the scheduled task cleared it and ran ~4 h to **`TRAIN_EXIT=0` (489 iters
  / 1.001M steps, flat memory)**. The desync fix (PR #62) was present in the running code (verified
  by `decisionsThisEpisode` grep).
- **Exported on shodan** (`export_weights --ckpt checkpoints/ppo-fixedfield-1M.pt`), pulled
  `ppoPolicyWeights.js` + `ppoForwardCases.json` to the Mac over the base64 ssh channel,
  **sha256-verified byte-identical** (`1a754eef…`).
- **`npm run ppo:gate` (3040 seat-fair games, parity 1.2e-5): PPO 45.2 ± 2.0% vs Lookahead
  11.8 ± 0.7%, paired Δ +33.4 ± 2.4 [31.0, 35.8] → ✅ BEAT** (STOP 48.7%, atk-win 65.6%).
- Moved the weights to a clean PR branch `feat/ml-ppo-fixedfield-1M-weights` off origin/master (NOT
  entangled with the PR #62 infra fix). Updated RESULTS / PLAN / DECISIONS + the ml-bot memory.

**Learned / decided:**

- **The D-7 headline BEAT gate is met — first time.** A ~37-pt swing off the −3.7 BC-anchor
  baseline; PPO unambiguously learned past the BC clone on a like-for-like basis (same pipeline /
  gate, tracer −3.6 → 1M +33.4). Task A's binary question ("does PPO move past the BC ceiling at
  all?") is answered emphatically-yes.
- **Caveat that shapes task B:** trained against `DEFAULT_OPPONENTS`
  (lookahead/strategist/expectimax/bc/defensive) — 4 of the 7 gate opponents (incl. all 3 strong)
  were training opponents → partly fixed-field _exploitation_; it also beats the 3 held-out bots
  (example/default/adaptive) → partial generalization. Not yet "robustly general."
- **Per [D-22]'s material-gain branch → green-light task B (PFSP league).** Started scoping it.

**Dead ends / surprises:**

- schtasks issued from the PowerShell `ssh shodan` lands in creates a **Task-Scheduler-owned**
  job that's session-independent — so the launch needn't happen physically on shodan; it survives
  the very teardown that killed the SSH-detached runs. (Re-confirms the [[infra_shodan_gpu_pc]]
  gotcha — but proven this time end-to-end across a 4 h run.)
- No `ep_rew_mean` in the SB3 log (no Monitor wrapper) — the gate Δ is the learning signal;
  `explained_variance` (~0.68–0.88) corroborated a healthy value head.

**Next:**

- Open the weights PR; land the task-B scope (DECISIONS D-23 / expanded PLAN bullet) once the
  scoping workflow returns.
- Implement task B (PFSP league): `scripts/lib/ppo-league.mjs` + SB3 snapshot callback + win-rate
  attribution, with fixed-field as the empty-pool degenerate mode (shared pipeline with task A).

---

## 2026-06-25 — Phase-3 step 7 CLOSED: first real PPO-tracer gate number (on shodan)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Ran the real export + gate on shodan** (the torch box; the scaffold below was Mac-only). The
  step-6 `checkpoints/ppo-tracer.pt` **was never persisted** (only the code merged as PR #60), so I
  re-ran the tracer to regenerate it: `python -m dicewars_ppo.train_tracer --checkpoint
checkpoints/v2-base/bc_model.pt --timesteps 2048 --out checkpoints/ppo-tracer.pt` — train→repack→
  `_verify_repack_exportable` all green (12 PPO updates, reloads into a bare `EdgePolicyNet`).
- **Exported** `python -m dicewars_bc.export_weights --ckpt checkpoints/ppo-tracer.pt --out
../src/ai/ppoPolicyWeights.js --fixture ../tests/fixtures/bc/ppoForwardCases.json` → JS weights
  (`teacher=ppo-tracer`, **102,787 params**, 2.1 MB) + 6-case parity fixture. Pulled both into the
  repo over the ssh→WSL channel, **sha256-verified byte-identical** to the shodan originals.
- **Parity is live + green:** `tests/ai/ppoForward.test.js` (previously `skipIf(!present)`) now runs
  — the pure-JS `bcForward` reproduces the PyTorch reference logits at **3.0e-5** (< 1e-3 tol).
- **First real gate** (`npm run ppo:gate`, seat-fair, 20 runs × 19 seeds × 8 seat rotations =
  **3040 games**, 267.7s):
  - PPO **11.5 ± 1.3%** vs Lookahead **15.1 ± 1.1%** · paired **Δ −3.6 ± 1.7 pp [−5.3, −1.9]** →
    ❌ **BEHIND** (CI strictly below 0).
  - PPO STOP **55.2%**, attack-win **81.4%**.

**Learned / decided:**

- **The tracer behaves exactly as predicted** — a loop-closer, not a strength run (2048 steps,
  ~12 updates, low-LR warm-start from v2-base BC). It lands ≈ the BC anchor and BEHIND the bar.
  The repack→export→register→gate chain is now proven against a **real trained PPO policy**, not a
  BC stand-in. A real **BEAT** is the Phase-3 scaling goal, not this step.
- **Win% is field-relative — read the paired Δ, not the absolute.** Lookahead is 15.1% here vs the
  ~23% in the capacity-probe field because this gate field is the full built-in roster (8-way FFA,
  chance baseline 12.5%, with Strategist + Expectimax also strong). Both bots are measured in the
  **same** field every game and counterbalanced across all 8 seats, so the **paired Δ** is the valid
  signal; the absolute win% is not comparable across different fields.
- **shodan env note:** the env-server (`ppo-env-server.mjs`) needs **Node v22** (nvm:
  `~/.nvm/versions/node/v22.23.1`); the default `/usr/bin/node` is v12 and fails the ESM import.
  `EnvServerProcess` resolves `node` via `shutil.which`, so PATH must front the v22 bin.

**Dead ends / surprises:**

- The step-6 PPO checkpoint artifact wasn't on disk (only the code shipped) — had to regenerate it
  before exporting. Cheap (a tracer is tiny), but worth noting: the gate artifact is reproducible
  from `v2-base/bc_model.pt` in one command, it is not a kept file.

**Next:**

- Artifacts (`src/ai/ppoPolicyWeights.js` + `tests/fixtures/bc/ppoForwardCases.json`) are
  **untracked-local**; permanent `builtInBots.js` registration stays **Phase-4 / BEAT-gated**. Commit
  the step-7 scaffold + these artifacts only if we want the parity test to run in CI on this net.
- Phase-3 **scaling** (PFSP league, from-scratch control, reward shaping) toward an actual BEAT;
  re-run `ppo:gate` at each checkpoint and append the number here.

---

## 2026-06-25 — Phase-3 step 7: headline-gate scaffold (repack→export→register→gate)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Mapped step 7 against the code first** and found the heavy lifting already exists: the
  Python repack (`repack_to_bc_checkpoint` in `policy.py`, driven by `train_tracer.py`'s
  `_verify_repack_exportable`) and `dicewars_bc/export_weights.py` consume a repacked PPO
  actor **unchanged** (it's a bare `EdgePolicyNet` ckpt; the `ppo_*`/`teacher` provenance keys
  are ignored, `selection_metric=None`), and `makeBC({ policy })` in `src/ai/ai_bc.js` already
  takes an alternate exported policy (built for the capacity probe). So step 7 is **JS-side
  glue + the gate harness**, not new Python.
- **Scaffolded the gate path (all green on this Mac, no GPU):**
  - `scripts/lib/load-bc-policy.mjs` — the shared "trust an exported policy" step: dynamic-import
    - **mandatory JS↔Py parity pre-flight** (per-logit tolerance + exact argmax match) against the
      `--fixture`. Lifted from the capacity probe, which now reuses it (DRY).
  - `scripts/lib/stats.mjs` — the `T95`/`meanCi` block, extracted from the three copies in
    `arena-sweep.mjs` / `_probe-capacity-arena.mjs` / the new gate (migrated all three).
  - `scripts/lib/ppo-gate-core.mjs` + `scripts/ppo-gate.mjs` (`npm run ppo:gate`) — register the
    candidate via `makeBC({ policy })`, run a **seat-fair 8-bot FFA sweep** (built-ins minus the
    BC clone, + the candidate), report candidate & `Lookahead` win% with 95% CIs **plus the
    paired per-run Δwin%** and a **BEAT / TIE / BEHIND** verdict. Gate = **BEAT only** (paired Δ
    CI strictly above 0); judged on **win%, not ELO**.
  - `npm run ppo:export` — the canonical `export_weights.py` invocation (→ `src/ai/ppoPolicyWeights.js`
    - `tests/fixtures/bc/ppoForwardCases.json`).
  - Tests: `tests/scripts/{loadBcPolicy,ppoGateCore}.test.js` (23 cases) + `tests/ai/ppoForward.test.js`
    (PPO parity, skips until the export artifacts exist) + `ml/tests/test_export_weights.py`
    (torch-only repack-format export coverage, BC CI tier).
- **Validated the whole machinery against the BC anchor** (`ppo-gate.mjs --weights
src/ai/bcPolicyWeights.js --fixture …/forwardCases.json`): seat-fair BCanchor **14.2 ± 4.2%** vs
  Lookahead **22.9 ± 4.8%** (paired Δ −8.8, CI below 0 → **BEHIND**), parity **2.4e-5**, STOP **49%**,
  attack-win **83%** — the bar's measured strength matches the documented seat-fair Lookahead
  (RESULTS D-7 ≈24%), so repack→export→register→gate is proven end-to-end. The missing-weights path
  prints the exact 3-command reproduce recipe and exits non-zero.
- **Ran a 5-dimension adversarial review workflow** (parity contract / statistical gate & seat
  fairness / build-import safety / Python repack fidelity / pin & docs), 23 agents, each finding
  independently verified. **It caught a real CRITICAL bug and I fixed it:** the first cut reused
  `runArena`, which maps `bots[i] → seat i` and never rotates, so the candidate (seat 7) and the bar
  (seat 5) sat in fixed seats every game and `MapGenerator` hands out territory by seat — confounding
  the paired delta. **Fix:** the gate now counterbalances exactly like `scripts/_baseline.mjs`
  (`rotatedField` over all N seat rotations per seed, via `runMatch` directly). The proof it mattered:
  pre-fix fixed-seat Lookahead measured **18.3%**; seat-fair it measures **22.9%**, in line with the
  documented seat-fair ~24%. Also folded in confirmed defensive fixes: `export_weights.py` now asserts
  `encoding_version == EXPECTED_ENCODING_VERSION` and loads `weights_only=True` (consistent + safe);
  `checkParity` now guards fixture↔weights feature-width agreement; and the gate documents its
  conservative one-sided α≈0.025 verdict + low-power caveat. Refuted (correctly): a "PLAN says add to
  builtInBots" misread and a seed-overlap claim (stride is safe).

**Learned / decided:**

- **Bar pin:** in-repo `ai_lookahead` differs from `596f781` only in **comments** (verified
  `git diff 596f781 HEAD -- src/ai/ai_lookahead.js` — a strict-`>` doc wording fix, constants
  byte-identical), so it is the behavioral `@596f781` bar, exactly as RESULTS.md already treats it.
- **Registration scope:** the gate registers the candidate **dynamically** via `makeBC({policy})`;
  a **permanent** `builtInBots.js` entry (which plain `arena:sweep` reads) is deferred to **Phase 4**,
  gated on the bot clearing BEAT. A static import of the not-yet-existing `ppoPolicyWeights.js` would
  break the build/suite, and a tracer-strength net does not belong in the shipped field — the dynamic
  harness is the green, honest path. This is a deliberate deviation from the PLAN's literal "add to
  builtInBots".
- The _tracer_ policy is a loop-closer, not a strength run: it should land ≈ the BC clone
  (TIE/BEHIND). A real **BEAT** is the Phase-3 scaling goal.

**Dead ends / surprises:**

- None blocking. Mild surprise: step 7 needed **zero** new Python — the step-5/6 repack design
  already produced an `export_weights`-compatible checkpoint, so the only outstanding artifact is
  the exported `ppoPolicyWeights.js` itself (a torch box / shodan).

**Next:**

- On shodan: `npm run ppo:export` from the step-6 `checkpoints/ppo-tracer.pt`, copy
  `src/ai/ppoPolicyWeights.js` + `tests/fixtures/bc/ppoForwardCases.json` into the repo, then
  `npm run ppo:gate` for the first real (tracer-strength) gate number — closes the step-7 loop.
- Then the Phase-3 **scaling** tasks (PFSP league, from-scratch control, reward shaping) toward an
  actual BEAT; re-run `ppo:gate` at each checkpoint.

---

## 2026-06-25 — PR #60 review follow-up: two truncated-wire regression gaps closed

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Ran a second, pre-merge review pass on PR #60 (the step-6 PR) with four specialist agents
  (general code / test-coverage / silent-failure / comments), distinct from the step-6 adversarial
  4-dimension review. It **cleared the wire change as correct** — JS↔Py byte offsets match
  field-for-field (`truncated` i32 at offset 40, `placement` f32 shifted to 44, 48-byte header),
  truncation semantics sound, and the placement-at-cap path verified safe (`calculatePlacements`
  runs unconditionally and ranks survivors when there is no winner, so `placement ∈ [0,1]` always
  holds at a cap — `step()`'s placement guard can't spuriously raise).
- Closed **two defense-in-depth gaps** the pass surfaced, both in the exact mechanism the wire fix
  protects (the PPO value-bootstrap decision), committed `e407387`:
  1. `env.py step()` validated `won`/`placement`/`truncated` each in-range but **not** the
     `won`↔`truncated` cross-invariant — the contradictory pair `(won=1, truncated=1)` passed every
     per-field guard and would bootstrap a win's value target (`terminated=False`), poisoning the
     critic. Added a fail-loud guard + a hermetic rejection test that drives the **real** `step()`
     body (swap/removal makes `step()` return a tuple instead of raising, so the test is coupled to
     the guard, not a tautology).
  2. **No byte-level obs-frame round-trip exercised `truncated=1`.** Set `truncated=1` in the
     `ppo-action-parity` terminal round-trip + asserted it survives serialize→parse.

**Learned / decided:**

- **`0` serializes identically as i32 or f32**, so the all-`truncated=0` test corpus would let a
  dtype/offset regression on the new offset-40 slot pass **every** test and only fail at runtime on
  shodan (a real cap arriving as `1065353216`). A single non-zero round-trip value is the cheap,
  load-bearing guard against that whole class.
- Neither gap is a **live** bug today — the JS side keeps the flags mutually exclusive — but both
  guard the **league/PFSP code that will set `truncated` next** (the most likely place a future
  `summarizeOutcome`-shaped path violates the invariant silently).

**Dead ends / surprises:**

- None. Verified locally in a throwaway `gymnasium` venv (the `[rl]` stack is shodan-only, but the
  new guard is pure-Python so the hermetic test is authoritative regardless of gymnasium version):
  `test_ppo_env_unit.py` + `test_ppo_wire.py` **20 passed**, `ruff` clean; `ppo-action-parity`
  **12 passed**, eslint + prettier clean. The pinned-env `[rl]` confirmation still runs on shodan as
  with prior steps.
- **Deferred (lower-risk, → PFSP work):** assert `truncated`/`won` presence at the env-server wire
  boundary (currently `result.truncated ? 1 : 0` silently coerces a missing field to 0); add
  `batch_size>0` / `learner_seat<player_count` guards to `train_tracer._validate_args`; a one-line
  `summarizeOutcome` JSDoc caveat (the "cap only" invariant strictly holds only on the
  `terminateOnElimination:true` path the server always uses).

**Next:**

- Unchanged by this review — **step 7** (repack → export → register → `arena:sweep` gate vs
  `ai_lookahead`) and the Phase-3 scaling tasks (PFSP league, `SubprocVecEnv`, from-scratch control).

---

## 2026-06-25 — Phase-3 tracer step 6: tiny warm-started PPO run + truncated/terminated wire fix

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Closed the tracer slice (step 6): the self-play PPO loop runs end-to-end.** New
  `ml/dicewars_ppo/train_tracer.py` warm-starts the `MaskableEdgePolicy` (EdgePolicyNet trunk +
  fresh scalar critic) from the v2-BC checkpoint, runs sb3-contrib `MaskablePPO` over `DiceWarsEnv`
  vs a fixed, seed-pure, heterogeneous JS-baseline field (`ai_lookahead,ai_strategist,ai_expectimax,
ai_bc,ai_defensive`, cycled to fill 6 opponent seats) with a **sparse terminal-win reward** (+1
  win / 0 else, [D-19] decision 3), a handful of updates, then **repacks** the trained actor to BC
  checkpoint format and verifies it reloads into a bare `EdgePolicyNet` (the step-7 export target).
- **Folded in the deferred `truncated`-vs-`terminated` wire fix.** Added a `truncated` i32 field to
  the obs-frame header (frame 44→48 bytes). A `maxTurns` stalemate CAP is now a Gym **truncation**
  (`terminated=False, truncated=True` → SB3 bootstraps `V(s)`); a win or the learner's elimination
  is a genuine terminal (`terminated=True`). This disambiguates the cap from a `winner=-1` mid-game
  elimination, which carried the same `winner/won` but is NOT a truncation. Computed in
  `runSelfPlayEpisode` (`summarizeOutcome`: `finalState.phase !== GAME_OVER`; `eliminationOutcome`:
  always `false`), carried through the env-server terminal frame, parsed in `wire.py`, surfaced by
  `DiceWarsEnv.step()`.
- Regenerated the byte-exact golden fixture (`obs_frame_v2.{bin,json}`, 280→284 bytes); JS↔Py wire
  parity stays green both ways. Added a hermetic `step()` test driving the real terminated/truncated
  mapping (review-confirmed gap — a swap would silently break SB3 bootstrapping yet pass everything).

**Learned / decided:**

- **MaskablePPO constructs and trains with the custom `MaskableEdgePolicy` cleanly** — the first
  real exercise of the full SB3 learner path (step 5 only tested `build_policy` standalone). The
  absent `mlp_extractor` / `set_training_mode` is a non-issue in practice.
- The `truncated` flag had to be a **dedicated header field** — `winner=-1 + won=0` is genuinely
  ambiguous between a stalemate-cap survivor and a mid-game elimination, so no existing field could
  carry it. SB3's gym→VecEnv shim turns `truncated=True` into `TimeLimit.truncated` and bootstraps,
  so correct value targets fall out for free once the wire carries the bit.
- `--freeze-trunk` is a clean safety floor: the repacked actor is **byte-identical** (22 tensors) to
  the warm-start, and `policy_gradient_loss ≈ 1.6e-8` confirms the frozen actor emits no gradient.

**Dead ends / surprises:**

- None. Validated on shodan (branch `ml-bot/phase3-ppo-tracer-run`, HEAD `67c8381`): ruff clean; 13
  env-unit + wire/policy tests + 1 live env smoke pass; the default tracer run completes 4 updates
  with the critic learning (explained_variance → 0.74, value_loss 0.005→0.0024); repack reloads into
  a bare `EdgePolicyNet`; `--freeze-trunk` preserves the actor byte-for-byte. JS suite (obs-frame +
  ppo-env, 44 tests incl. a new truncation test) green locally. An adversarial 4-dimension review
  (wire-parity / truncation-semantics / train-script / test-coverage) cleared 3 dimensions and
  surfaced exactly the one test gap, now closed.

**Next:**

- **Step 7** — repack → `export_weights.py` → regenerated JS↔Py fixture → register via
  `makeBC({policy})` → `arena:sweep` win% vs `ai_lookahead@596f781` (95% CIs). The repack path is
  already proven from a real trained policy, so step 7 is wiring + the headline gate.
- **Scaling** — PFSP league, more envs (SubprocVecEnv — DummyVecEnv serializes the blocking sockets),
  the from-scratch control, annealed shaping only if terminal-only is too slow.

---

## 2026-06-25 — Phase-3 tracer step 5: EdgePolicyNet-trunk PPO policy + warm-start/repack

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Reviewed merged #58 (step 4) — the review-pass hardening is sound (bounded `recv_frame`,
  reap-safe server teardown, `weakref.finalize` GC backstop, hermetic env/socket unit tier in CI).
- Built the custom SB3 policy in `ml/dicewars_ppo/policy.py` (`MaskableEdgePolicy`): the v2-BC
  `EdgePolicyNet` trunk + per-edge head as the PPO actor, a **fresh scalar critic** off `ctx`.
  Bypasses SB3's `features_extractor→action_net` pipeline (the ragged per-edge head doesn't fit it)
  by overriding `forward`/`evaluate_actions`/`predict_values`/`get_distribution` to gather
  padded-`MAX_EDGES` edge logits straight from the obs `Dict` into a `MaskableCategorical`.
- `warm_start_from_bc` / `load_bc_checkpoint` load trunk + `edge_head` from the v2-BC checkpoint
  (assert `encoding_version == 2` + v2 feature widths); critic stays fresh.
- **Closed the [D-19] gate-breaking repack gap up front:** `repack_to_bc_checkpoint` pulls the
  actor back into BC checkpoint format (bare `EdgePolicyNet` `state_dict` + config), proven by a
  round-trip parity test. So the step-7 "graded bot == trained policy" risk is already de-risked.
- Extracted the edge-head gather into `EdgePolicyNet.edge_logits_from_context` so the BC
  forward/ONNX export and the PPO actor share one source of truth (Ivan chose the extraction over
  copy-with-comment). Behavior-preserving: BC `test_model` + `test_export_onnx` green, ONNX trace
  byte-unchanged.
- Located the warm-start source: `~/dicewarsjs/ml/checkpoints/v2-base/bc_model.pt` on shodan
  (`enc=2`, 102,787 params, `val_stop_cal=0.7264…` — matches `bcPolicyWeights.js` byte-for-byte =
  the deployed `ai_bc`). The other `checkpoints/{probe/*,smoke}` `.pt`s are stale encoding-v1.

**Learned / decided:**

- The PPO actor being a _real_ `EdgePolicyNet` instance (same submodule names) is what makes the
  repack a near-identity — keep it that way through scaling.
- The BC `value_head` rides along through warm-start/PPO/repack untouched (PPO never puts it in a
  loss → grad stays `None` → weights survive), so the JS↔Py parity fixture still runs at export.

**Dead ends / surprises:**

- None. Validated on shodan (branch `ml-bot/phase3-ppo-policy`): ruff clean, 12 BC-parity + 8 new
  policy tests pass, and the **real `v2-base` checkpoint** warm-starts, repacks byte-identically,
  and drove the live env-server through a 76-decision episode picking only legal actions.

**Next:**

- Step 6 — tiny tracer PPO run (1–2 envs, 1 learner + fixed JS baselines, terminal-win reward,
  warm-started, a handful of updates) with low initial LR / optional brief trunk freeze ([D-19]
  decision 1). Fold in the `truncated`-vs-`terminated` wire flag for `maxTurns` stalemates while
  there (deferred from step 4) so value bootstrapping is correct.

---

## 2026-06-25 — Phase-3 tracer step 4: Python `[rl]` env scaffold (`dicewars_ppo`)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Scaffolded the Python learner side of Phase 3 as a new in-repo package
  `ml/dicewars_ppo/` (sibling of `dicewars_bc`) — the first piece of tracer steps 4–7,
  built against the PR #57 env-server:
  - `constants.py` — the wire/encoding contract mirrored from JS: v2 feature widths
    (node 8 / player 6 / board 5 / edge 7), `ENCODING_VERSION = 2` guard, `MAX_EDGES = 64`
    ([D-20]), and the `OBS_FRAME_MAGIC` / 44-byte header layout from `obs-frame.mjs`.
  - `wire.py` — a Python port of `scripts/lib/obs-frame.mjs`: `parse_frame`,
    `serialize_frame` (mirror, for tests), and the length-prefixed socket framing
    (`recv_frame` / `send_action`).
  - `env_server.py` — `EnvServerProcess`: launch + supervise a `ppo-env-server.mjs`
    subprocess, parse its `LISTENING` line, drain stdout so the pipe can't stall, reap cleanly.
  - `env.py` — `DiceWarsEnv(gymnasium.Env)`: `Discrete(MAX_EDGES)` + `action_masks()`, a
    `Dict` obs of the v2 tensors padded to `MAX_EDGES`, sparse terminal-win reward ([D-19]
    decision 3), and the continuous back-to-back-episode read model matched to the server.
- Added the `[rl]` optional-dependency group (gymnasium, stable-baselines3, sb3-contrib,
  pettingzoo) and registered the package in `ml/pyproject.toml`.
- Tests: `test_ppo_wire.py` (6, hermetic, numpy-only) parses a committed golden frame
  (`tests/fixtures/obs_frame_v2.bin`, generated by `gen_obs_frame_fixture.mjs` through the
  real JS serializer) and round-trips it byte-for-byte; `test_ppo_env.py` is the end-to-end
  smoke (launch a real server, STOP-only episodes) that skips where gymnasium/node are absent.

**Learned / decided:**

- **The env is single-agent, not PettingZoo AEC** — a refinement of [D-19]'s wording, not a
  deviation from its design. The env-server already runs all 7 opponent seats in-process in
  Node and exposes only the learner seat, so the Python-facing interface is a plain
  `gymnasium.Env` with `action_masks()` — exactly what MaskablePPO consumes, no multi-agent
  wrapper. Holds for the whole phase: PFSP snapshots also run in-process ([D-19]), so there is
  never more than one external seat. (`pettingzoo` kept in `[rl]` for its reference utilities.)
- **Cross-language wire parity proven two ways before any training:** the byte-exact
  golden-fixture test, and a live 2-episode / 132-decision run against the real Node server
  (stalemate terminals, valid placements). The byte path most likely to hide a subtle bug
  (endianness, framing, the back-to-back-episode model) is green.

**Dead ends / surprises:**

- Local `python3` is 3.9.6 while the project targets ≥3.10, so the pre-existing
  `test_export_onnx.py` fails locally on `zip(strict=True)` — environmental, not a regression
  (untouched file; passes on shodan/CI 3.10+). The new code uses `from __future__ import
annotations`, so the no-gym modules still import cleanly under 3.9.

**Next:**

- Step 5: custom SB3 `ActorCriticPolicy` (EdgePolicyNet trunk extractor + padded `MAX_EDGES`
  `MaskableCategorical` + fresh scalar critic), warm-started from the v2-BC checkpoint
  (assert `encoding_version == 2`). Then step 6 (tiny PPO run) and step 7
  (repack → export → register → gate) — the [D-19] gate-breaking SB3→EdgePolicyNet repack
  adapter needs its own parity assertion.
- On shodan: `pip install -e .[rl]`, run `pytest tests/test_ppo_env.py` (the real end-to-end
  smoke) and re-confirm the throughput probe before locking the env-step budget.

---

## 2026-06-25 — Phase-3 env-server review hardening (PR #57 fixes) → [D-21]

**Phase:** 3 · **Who:** Claude

**Did:**

- Reviewed the tracer slice (PR #57) with specialized agents + an adversarial verification workflow, then
  fixed every finding. No engine/shipped-bot edits — all in `scripts/` + `tests/ml/`. Full suite 965 green;
  CI green on `be126bc`.
- **Disconnect (was: zombie loop).** The learner runs as a bot fn and `runBotDirect` swallows _every_ bot-fn
  throw, so the `EnvClosed` from `chooseAction` was eaten → the `if (err instanceof EnvClosed) break` was dead
  code; with `--episodes=0` a vanished client spun full matches forever. Fix: record the loss and re-raise on
  the next turn boundary via a `failIfLost` **onTurn** guard (the one seam the engine's try/catch can't
  swallow); the worker now **always** posts `closed` on socket loss.
- **Watchdog (issue A — the unattended-training gate).** The main-side `Atomics.wait` had no timeout, so a
  hard worker death (OOM/segfault — no JS throw, `failSafe` never runs) or a connected-but-silent learner
  parked it forever. Added `--decision-timeout-ms` (default 120 s; 0 = off) → bounded loud abort (exit 1).
- **Loud desync (issue B).** `decodeAction`'s out-of-range throw was _also_ dead (swallowed → silent
  turn-forfeit → a stream of valid-looking, corrupt low-reward episodes). `chooseAction` now validates the
  index and fails **fatal** (exit 1) with a `MAX_EDGES`/masking hint, instead of poisoning training data.
- **Placement parity (corrects D-20's "exact").** `rank = #alive` was off by one on a same-turn
  co-elimination: `runMatch` orders simultaneous deaths by ascending seat id and `calculatePlacements`
  reverses that, so a co-eliminee with a HIGHER id than the learner finishes ABOVE it but isn't in `#alive`.
  `eliminationOutcome` now uses `rank = aliveCount + (higher-id same-turn co-eliminees)`.
- **Robustness/teardown.** `writeFramed` inside the `handleObs` try; worker `failSafe` (uncaught/unhandled →
  wake main `ST_CLOSED`, now consumed by the parent); episode loop in `try/finally` that always reaps the
  worker; `readExactly` re-entrancy guard; rejected 2nd connection gets a no-op error handler (no spurious
  shutdown); CLI rejects unknown/non-finite flags; bind/worker failures exit 1.
- **Tests (+22 → 965).** `tests/ml/obs-frame.test.js` (codec shape/size/type guards, `numEdges=0`);
  co-elimination placement across seats 0/1/3 + a runner-up exact-parity case; the onTurn abort-seam
  mechanism; `uniquifyNames`, `makeLearnerBot` validation, `mergeShards`, `decodeAction` STOP guard. New
  `scripts/ppo-env-disconnect-smoke.mjs` (`npm run ppo:disconnect-smoke`): a 3-scenario lost-learner smoke —
  disconnect → exit 0, watchdog → exit 1, desync → exit 1.

**Learned / decided ([D-21]):**

- **The control-plane constraint.** Because the learner is an ordinary bot fn, `runBotDirect` converts any
  throw into a silent turn-forfeit. So _every_ env↔learner control signal — disconnect, timeout, desync — must
  surface via the `onTurn` seam (which `runMatch` does NOT wrap in try/catch), never by throwing from
  `chooseAction`. This is the load-bearing fact behind all four robustness fixes and the protocol the Python
  client (steps 4–7) must respect: reply within the deadline, never send an out-of-range index; a clean
  disconnect ⇒ exit 0, a timeout/desync ⇒ exit 1.
- The adversarial workflow (4 verifiers + a completeness critic) confirmed the disconnect and placement fixes
  sound and surfaced A & B — both deadlock/silent-corruption holes the green suite couldn't catch — which were
  then fixed. The placement fix was reconfirmed by a 1,560-game oracle sweep, 0 mismatches.

**Dead ends / surprises:**

- `decodeAction`'s loud out-of-range throw and `chooseAction`'s `EnvClosed` look like working error paths but
  are BOTH dead on the live path — the same `runBotDirect` swallow. That loud-by-design / silent-in-practice
  asymmetry is exactly why a desync poisoned data with no signal. Resolved by routing both through the onTurn
  channel + a boundary index check in `chooseAction`.

**Next:**

- Unchanged: tracer steps 4–7 (Python `[rl]` on shodan). The watchdog (issue A) was the prerequisite the
  verification critic gated long unattended runs on — now in place.

---

## 2026-06-25 — Phase-3 env-server early termination (the [D-20] step-1 follow-up)

**Phase:** 3 · **Who:** Claude

**Did:**

- Added `terminateOnElimination` to `runSelfPlayEpisode` (`scripts/lib/ppo-env.mjs`, default off → the
  full-game integration oracle stays byte-identical). When on, an internal `onTurn` guard unwinds
  `runMatch` at the learner's elimination and `eliminationOutcome` synthesizes the terminal there
  (`won=0`, `winner = state.winner` — null/-1 while the game is undecided, or the real winner if the
  eliminating turn also ended the game; `placements`/`botStats` null; new `eliminated:true` flag).
- Placement at death is **exact**, not approximate: a player's finishing rank is locked the moment it
  dies (every still-alive seat outlives it), so `rank = #alive` reproduces `calculatePlacements`'
  game-over value with no tail. Factored `scaledPlacementFromRank(rank, playerCount)` so both paths
  share the mapping.
- `ppo-env-server.mjs` sets the flag (terminal frame now emitted at elimination, not game-over).
- Refactored `runProbeShard` (`ppo-probe-core.mjs`) onto the same flag — dropped its bespoke
  `EPISODE_TERMINAL` sentinel-throw; behavior identical (the probe already stopped at elimination).
- Tests: 3 new cases in `tests/ml/ppo-env.test.js` — (a) eliminated learner → early terminal, stops
  strictly sooner; (b) stops on the **exact** elimination turn AND `placement` equals the engine's
  `calculatePlacements` value on a fixed seed; (c) a winning learner (seed 11) → flag is a byte-for-byte
  no-op vs the full game. 12/12 green; parity (11) + probe-helper (8) green; env-smoke re-run PASS.

**Learned / decided:**

- The "winner=-1 + placement>0" terminal frames in the smoke are **stalemate survivors** (passive STOP
  learner still alive at maxTurns), not eliminations — correctly routed through the normal game-over
  summary, not `eliminationOutcome`. Verified seed 100 = stalemate (`eliminated:false`, placement 0.667,
  turnCount 500). No bug; the placement model reconciles with the engine on every smoke seed.

**Dead ends / surprises:**

- First no-op test asserted `won===1` vs 6 **passive** opponents — they turtle (defensive dice pile up)
  and the learner stalemates, so `won===0`. Switched to 6 ai_bc + seed 11 (a genuine learner win) to
  exercise the survive-to-game-over no-op with an actual `won===1`.

**Next:**

- Steps 4–7 (Python `[rl]` on shodan): PettingZoo AEC env (action space = `MAX_EDGES` 64) → warm-started
  SB3 policy + SB3→EdgePolicyNet repack adapter → tiny PPO run → repack/export/register → `arena:sweep`
  vs `ai_lookahead@596f781` (D-7 BEAT gate). Re-confirm throughput on shodan before locking the budget.

---

## 2026-06-25 — Phase-3 tracer step 3: throughput probe → GREEN; MAX_EDGES = 64 ([D-20])

**Phase:** 3 · **Who:** Claude

**Did:**

- Built `scripts/ppo-throughput-probe.mjs` (+ `scripts/lib/ppo-probe-core.mjs`, `ppo-probe-worker.mjs`,
  `npm run ppo:throughput-probe`) and `tests/ml/ppo-throughput-probe.test.js` (8 pure-helper tests).
  Reuses the env core (`runSelfPlayEpisode` + `onObservation`), `benchmark-bot`'s timing wrapper, and
  `selfplay-core`'s field/seat resolution + worker-pool pattern. Full suite 940 green.
- Ran it (Mac, 8-core), worst-case `7xLookahead` + realistic `Lookahead,Strategist,Expectimax,4xBC`,
  300 ep single-thread + 800 ep @4 workers.

**Learned / decided ([D-20]):**

- **GO — throughput is NOT the blocker.** Realistic league **644 steps/s single-thread, 1,933 @4
  workers** → **~28M / ~84M env-steps in a 12h unit** — ~40–80× the ≳1–2M fail-fast bar. The
  in-process-opponent cost [D-19] worried about is comfortably affordable. (Re-confirm on shodan, but
  the margin makes the GO robust.)
- **MAX_EDGES = 64.** Per-decision `numEdges` p100 ≈ 26 (p99 15, mean ~5), zero overflow over ~100k
  decisions — D-19's ~64–128 was conservative; 64 = ~2.5× margin, far under sb3-contrib #247's ~1400.
- **A real single-learner PPO episode ends at the learner's elimination, not game-over.** Modeled via
  `runMatch`'s `onTurn` (added an `onTurn` passthrough to `runSelfPlayEpisode` — backward-compatible,
  oracle still byte-identical).

**Dead ends / surprises:**

- First probe run played to game-over → realistic looked _slower_ than worst-case (94 vs 429 steps/s):
  an artifact of simulating the opponent-only tail after the learner died (which generates 0 learner
  steps). Stopping at learner elimination fixed it (94 → 372 → 644 with more episodes) and is the
  correct PPO model. **Surfaced a step-1 env-server follow-up:** it currently plays to game-over and
  emits the terminal frame only then — adopting early termination is a ~2× free throughput win.
- Per-move cost: the BC-snapshot stand-in (~0.8 ms forward pass) is the priciest opponent, above
  Lookahead (~0.3–0.4 ms); Expectimax is cheap here (~0.16 ms), far from the solo-bot "too slow" marker.

**Next:**

- Tracer steps 4–7 (Python side, on shodan): `[rl]` deps + minimal PettingZoo AEC env (action space =
  `MAX_EDGES` 64) → custom warm-started SB3 policy + the SB3→EdgePolicyNet repack adapter (D-19 finding
  c) → tiny PPO run → repack→export→register→`arena:sweep` vs `ai_lookahead@596f781`.
- Optional cheap win first: make the step-1 env-server terminate episodes at learner elimination ([D-20]).

---

## 2026-06-25 — Phase-3 tracer steps 1–2 built + green: Node env-server + action-encoding parity

**Phase:** 3 · **Who:** Claude

**Did:**

- Re-grounded the exact contracts via a focused surface-map workflow (5 readers → byte-level synthesis
  brief), then verified the two UNCERTAIN flags directly in source (`encodeGlobals` reads the same
  `BotState` fields `createBotState` emits ⇒ no train/live drift; the STOP-only path `N===1` is valid).
- Built the **env-server** (tracer step 1): `scripts/lib/obs-frame.mjs` (self-describing binary wire
  codec), `scripts/lib/ppo-env.mjs` (`decodeAction` + `runSelfPlayEpisode` reusing `runMatch` verbatim
  via an injected synchronous learner bot-fn shim), `scripts/lib/ppo-socket-worker.mjs` (socket-owning
  worker thread), `scripts/ppo-env-server.mjs` (main thread parks on `Atomics.wait`). `npm run`:
  `ppo:env-server`, `ppo:env-smoke`.
- Built the **parity gate** (tracer step 2): `tests/ml/ppo-action-parity.test.js` (11) +
  `tests/ml/ppo-env.test.js` (9). **All 20 green.** Transport proven end-to-end by
  `scripts/ppo-env-smoke.mjs` (forked server + STOP-only client, 3 episodes, 164 obs frames).

**Learned / decided:**

- **Lowest-risk seam = reuse `runMatch`, don't edit `runBotTurn`.** `runBotDirect` calls bot fns
  synchronously, so the learner is just a bot fn that encodes-emits-and-blocks. Zero engine edits;
  opponents run through the same `runBotTurn` as any arena match.
- **The sync blocking read (brief risk #1) is real but containable:** isolate it in a worker thread
  that owns the socket; the main thread blocks on `Atomics.wait` over a `SharedArrayBuffer`. The pure
  env core takes an injected synchronous `chooseAction`, so it's fully unit-testable with a stub — no
  socket needed for the gate.
- **No mask blob on the wire.** The inference encoder emits only legal edges ⇒ the mask is implicit
  all-ones (matches `ai_bc`'s no-mask argmax). Pad-to-MAX + mask is an agent-side (Python) rollout
  concern, not the wire's.
- **The two highest-severity correctness traps are now pinned by tests:** the encoder's `moves[]`
  ordering coincides with `getValidMoves` element-by-element, and `decodeAction(enc, argmax(logits))`
  reproduces `ai_bc` exactly (bridge-decode == shipped-bot decode). The integration oracle confirms a
  learner reproducing `ai_bc` yields a final state byte-identical to a pure `runMatch` at three seats.

**Dead ends / surprises:**

- A JS in-process socket smoke test **deadlocks** — the server's main thread is blocked in
  `Atomics.wait`, so the client must be a separate OS process. The smoke check forks the server.
- ai_bc 4-player games can **stalemate** (turtling); a stalemate terminal (winner=−1, won=0, valid
  placement) is legitimate, not a bug. Reward stays well-defined.

**Next:**

- Tracer **step 3 — throughput probe**: a no-op learner against the **real `ai_lookahead` league**,
  measure learner-steps/sec (1 vs N envs). This is the existential early signal (reachability is
  UNPROVEN per [D-19]) and sizes the env-step budget / kill threshold (decision 4).
- Then steps 4–7 (Python `[rl]` deps + AEC env → warm-started SB3 policy → tiny PPO run →
  repack→export→`arena:sweep`).

---

## 2026-06-25 — Phase-3 PPO kicked off: architecture finalized (D-19), 4 decisions made, first tracer slice defined

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Squash-merged PR #56 (encoding-v2 / ceiling probe) to master; branched `ml-bot/phase3-ppo`.
- Ran a **scope-grounding surface-map + adversarial verification** of the Phase-3 PPO design (5
  parallel readers over JS rollout assets / Python BC trainer / JS↔Python bridge / SB3+PettingZoo
  ecosystem / shodan ops → synthesis → 3 skeptics → finalized doc), the way [D-12] grounded Phase 1.
  Verified the load-bearing code claims by hand before recording them (`export_weights.py:140`
  `getattr` on a bare `EdgePolicyNet`; `builtInBots.js:36` static-array registration; `ai_bc.js:67`
  `makeBC({policy})`; `encodeObservation.js:471` `encodeObservationForInference`, `ENCODING_VERSION 2`).
- Recorded **[D-19]** (full architecture + the 4 decisions + the 3 verification findings); flipped
  PLAN Phase 3 to 🟨 in progress with the corrected 7-step tracer-slice task list + scaling tasks;
  updated the README dashboard + status block.

**Learned / decided:**

- **Architecture:** PettingZoo AEC, one learner seat external + 7 seats in-process; a **persistent
  Node env-server over a local binary socket** (NOT per-step JSON — [D-3] trap); policy **reuses the
  `EdgePolicyNet` trunk + per-edge head** + a fresh scalar critic; the **observation IS the v2
  encoding** ([D-18]).
- **Four decisions (Ivan):** (1) warm-start from v2-BC + a short from-scratch control; (2) **full
  8-FFA vs a heterogeneous PFSP league from step one** — deviates from the PLAN's 3–4p-symmetric
  task, grounded in [D-15] (symmetric mirrors turtle → ~0% decisive → no gradient); (3) **sparse
  terminal-win reward first**, annealed potential-based shaping only if too slow (placement = the ELO
  trap); (4) **fixed env-step budget + kill threshold**, sized after the throughput probe.

**Dead ends / surprises:**

- **The synthesis's throughput math was wrong (caught by a skeptic).** It claimed the JS↔Python
  _wire_ (~13 µs/step vs ~50–200 µs JSON) was the bottleneck; it omitted that every STOP runs all 7
  in-process heuristic opponents (`ai_lookahead`/strategist/expectimax, ~4 g/s/core). Real cost is
  **~1.7–5 ms/learner-step (~100–400× the quoted figure)** — the wire is ~2–10% of a step, so binary
  framing is a cheap nicety and the [D-3] plateau-by-slowness risk **relocates from the wire into
  opponent simulation** (no bridge format fixes it). **Reachability is UNPROVEN until a throughput
  probe runs against the real lookahead league.**
- **`EdgePolicyNet`'s variable-length edge head doesn't fit MaskablePPO** (fixed `Discrete(N)` + bool
  mask) → **pad-to-validated-`MAX_EDGES` (~64–128, well under sb3-contrib #247) + mask the tail.**
- **Gate-breaking gap:** `export_weights.py` `getattr`s a bare `EdgePolicyNet`, so it **fails on a raw
  SB3 policy object** → a new **SB3→EdgePolicyNet repack step (with its own parity assertion + a
  regenerated JS↔Py fixture)** is required, else the graded bot ≠ the trained policy.

**Next:**

- **Build the first tracer slice, steps 1–3 (decision-independent, highest-de-risk):** the Node
  env-server (`scripts/ppo-env-server.mjs`, `runBotTurn` inverted to a socket) → the **cross-bridge
  action-encoding parity test** (sampled index → encoder `moves[]` → correct `{from,to}|null`) →
  the **throughput probe** against the real lookahead league (sizes the budget). Then Python `[rl]`
  deps + AEC env, the custom warm-started policy, the tiny PPO run, and repack→export→`arena:sweep`.

## 2026-06-25 — Phase-3 Step 2: encoding-v2 → FEATURE-LIMITED confirmed; BC win% 6.7%→12.5%, deployed; fork to PPO

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Built **encoding-v2** (`ENCODING_VERSION 1→2`): engineered local-neighbourhood features only
  (Ivan's call — no raw adjacency blob). Node 5→8 (`enemyNbrDiceMaxNorm`, `enemyNbrFrac`,
  `degreeNorm`), edge 4→7 (`tgtRetakeThreatNorm`, `srcVacateThreatNorm`, `tgtEnemyNbrFrac`).
  Lockstep bump across `encodeObservation.js`, `manifest.py`, `ai_bc.js` guard, export fixtures,
  and JS/Python tests. Broke a transition deadlock (`encode-corpus → cli-utils → ai_bc` guard
  threw mid-transition) by extracting `scripts/lib/cli-args.mjs`.
- Re-encoded the **same** 100k corpus on `shodan` (8,591,769 steps / 59.4M edges, counts
  identical to v1) and retrained the **same** 102k MLP with the **same** recipe (the only
  variable is the encoding; v1 twin = the [D-17] capacity-probe `c0_base`).
- Exported v2 weights → `src/ai/bcPolicyWeights.js` (+ regenerated parity fixture), arena-
  confirmed via `arena:bc-stopbias` (15×130, bias 0–3, same 8-bot field as the baseline). Full
  suite green (909/909). ADR: [D-18].

**Learned / decided:**

- **FEATURE-LIMITED, decisively.** Val move-match **0.5675 → 0.7328** (+16.5 pt) AND — the
  decisive part — the gate followed: peak arena win% **6.7 ± 0.8 → 12.5 ± 1.4** (CIs disjoint).
  Contrast the capacity sweep, where +0.58 pt proxy left win% flat. The per-edge MLP was
  feature-starved, not factorization-saturated.
- Native gap to Lookahead (~17%) ~halved (13 pt → ~4.6 pt). BC is still below the gate (parity-
  not-beat, [D-15]); the residual is the **imitation ceiling** → **fork to PPO** (D-18). The v2
  observation is the durable artifact: ships as deployed BC _and_ feeds the PPO input.

**Dead ends / surprises:**

- **v2 needs NO STOP bias.** Peak at `stopBias 0` (native arena STOP 53% vs v1's ~71% turtle);
  positive bias now only suppresses STOP and _hurts_. The richer features fixed the turtle
  natively — deploy at default, no tuning.
- Training warned "no epoch hit the STOP-cal band" (val STOP 0.418 < target 0.448) — a non-issue:
  val-STOP ≠ arena-STOP (known confound), and bias 0 already lands STOP at 53% in self-play.
- Caught a stale v1 assertion in `tests/scripts/encode-corpus.test.js` (`encodingVersion` 1→2)
  that the lockstep bump had missed; full suite green after the fix.

**Next:**

- **Phase 3 → PPO.** Stand up the PPO loop on `shodan` with the v2 observation as the policy
  input (warm-start from the v2 BC weights is the open design question). Target: cross the
  imitation ceiling and clear the [D-7] gate (statistically significant win% edge over Lookahead).

## 2026-06-25 — Phase-3 ceiling probe, Step 1: capacity is NOT the bottleneck (10× params → flat-to-declining win%)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Ran the cheap capacity localization probe (Ivan's chosen path after #55) to find _where_ the
  ~13 pt gap to Lookahead lives before committing to a GNN/PPO fork. Zero-code sweep on
  `shodan` (CUDA): `EdgePolicyNet` at 3 widths (102k / 403k / 1.0M params), same 100k corpus,
  same recipe (`--epochs 6 --stop-weight 0.5 --select-by stop-cal`).
- Hardened the proxy result on the **real metric**: added a backward-compatible `policy` param
  to `makeBC()` (`src/ai/ai_bc.js`) so candidate checkpoints can be arena-evaluated without
  overwriting the shipped weights; built `scripts/_probe-capacity-arena.mjs` (parity pre-flight
  - config×bias grid, peak-win% comparison). Exported all 3 checkpoints + fixtures off `shodan`.
- 23,400-game confirm (4 configs × bias {0,1,2} × 15×130, paired seeds). Full tables in
  RESULTS.md (Phase 3 section). ADR: [D-17].

**Learned / decided:**

- **NOT capacity-limited.** Val move-match flat across 10× params (56.75 → 57.33%); peak arena
  win% flat-to-declining (6.7 → 6.6 → 5.1%, the 1M net slightly _worse_). Both metrics agree.
  The gap is **encoding and/or factorization**, not model size.
- **Decided (D-17): proceed to encoding-v2** — add board adjacency + richer features
  (`ENCODING_VERSION 1→2`), re-encode, retrain the same MLP. Splits feature-limited vs
  factorization-saturated, AND the enriched observation is reusable as the PPO input (not
  throwaway). BC's own ceiling is parity, so this retrain is **diagnostic**; the payoff is the
  reusable encoding + a sharper PPO design.

**Dead ends / surprises:**

- The "connection dropped mid-sweep" from the prior session was a false alarm on the
  _monitoring_ — the sweep itself finished cleanly (3 checkpoints, RC=0). Recovered them.
- **val-STOP ≠ arena-STOP, and the gap is epoch-dependent.** `stop-cal` matched val STOP, but
  the 6-epoch probe nets turtle harder in self-play (arena STOP ~55%) than the deployed 2-epoch
  model (~49%). So I compared each width at its _peak_ win% over a bias grid (matched operating
  point), not at bias 0 — else capacity would be confounded with STOP-calibration. (This
  fragility of BC's STOP behavior under its own distribution is itself a point for PPO, which
  trains on-distribution.)
- **Persistence reality, re-confirmed:** a `setsid`-detached WSL job is killed within seconds of
  SSH disconnect — it's WSL process-tree teardown on session exit, **not** a network artifact
  (happens even on the stable wired LAN). Tailscale was down this session; reached `shodan` via
  its direct GFiber LAN IP (`192.168.1.181`). The capacity confirm needed no durable job (export
  on shodan = seconds; arena = local). **Step 2's re-encode WILL** → schtasks-or-kept-alive TBD.

**Next:**

- Encoding-v2: investigate the current encoder/corpus/model pipeline, design the adjacency blob
  - feature set, do the `ENCODING_VERSION 1→2` lockstep (`encodeObservation.js` /
    `manifest.py EXPECTED_ENCODING_VERSION` / `ai_bc.js` guard), re-encode the 100k corpus on
    shodan (durable job), retrain (6ep stop-cal), export, arena-confirm win% vs Lookahead w/ CIs.

---

## 2026-06-24 — STOP-de-bias retrain: weighted-CE + stop-cal selection → calibrated (win 3.6→6.4%, still not parity)

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- **Implemented the two machine-independent retrain levers** (branch `ml-bot/bc-focal-retrain`):
  `segmented_cross_entropy` gained `stop_weight` (down-weights teacher-STOP steps,
  `label == count-1`; weight-normalized mean) + `focal_gamma`; defaults reproduce plain CE
  exactly. `train.py` gained `--stop-weight`/`--focal-gamma` (training objective only — reported
  `ce` stays plain) and **`--select-by stop-cal`**, which checkpoints the epoch whose realized
  argmax STOP rate is closest to the teacher's (auto target = teacher val STOP) instead of best
  move-match. New `predicted_stop_rate`/`teacher_stop_rate` helpers + per-epoch STOP logging. 15
  new Py tests; full ml suite 22/22 on the mini (incl. ONNX parity).
- **Ran the retrain as a `stop_weight` scan on the Mac mini** (`shodan` offline): {1.0, 0.5,
  0.25, 0.125}, 2 epochs each, stop-cal, full 100k corpus. ~27 min/epoch, memory-bound but
  stable at `nw=4`. `w=0.5` → val STOP 0.436 (teacher 0.448) at val acc 0.556 — the pick.
- **Exported `w=0.5` → `src/ai/bcPolicyWeights.js` + regenerated the parity fixture; 16/16 JS
  parity tests green.** Validated in-arena (`arena:bc-stopbias`, bias −1…2, 20×150, seedbase 0).

**Learned / decided:**

- **The de-bias worked, baked into the weights.** Native (`stopBias 0`) realized arena STOP
  **70.8% → 48.6%** (teacher ~45%); native win **3.6% → 6.4%** (disjoint CIs [3.0,4.2]→[5.5,7.3]).
  The de-biased native model beats the OLD model's _tuned_ peak (5.9% @ bias 1); the inverted-U
  shifted left to center on bias 0–0.5. **Shipping native `stopBias 0`** (`ai_bc = makeBC()`) —
  teacher-faithful, no inference crutch. (val→arena STOP shift ≈ +5 pp: 0.436 → 0.486.)
- **stop-cal selection earned its keep:** the `w=1.0` control's STOP rate _grew_ with training
  (ep1 0.541 → ep2 0.603), so move-match selection would have shipped the worse-calibrated epoch;
  stop-cal took ep1. Confirms the "MUST switch checkpoint selection off move-match" warning.
- **Still NOT parity — exactly as the inference sweep predicted.** Best BC ~6.8% vs Lookahead
  ~20% (~⅓). Residual ~13 pt = the per-edge-MLP encoding/arch ceiling ([D-Encoding]), not STOP
  calibration. **STOP-de-bias is now CLOSED; parity lives in Phase-3 (GNN / PPO).** Pure BC's
  role stands as the PPO warm-start — now a _calibrated_ one.

**Dead ends / surprises:**

- **The STOP bias compounds with training epochs.** The `w=1.0` control hit val STOP 0.541 at
  ep1 → 0.603 at ep2; the original 20-epoch run reached ~68%. So the over-prediction grows the
  longer you train on plain CE — an extra reason move-match selection (which keeps the most-
  trained epoch) is dangerous, and why "few epochs + stop-cal" is the right recipe.
- The regenerated mini corpus (Default/Example/Adaptive use `Math.random`) is not byte-identical
  to shodan's, but teacher (Lookahead) val STOP came out ~0.448 — consistent with the ~45% the
  whole de-bias targets.

**Next:**

- Open the PR for `ml-bot/bc-focal-retrain` (losses/train + de-biased weights/fixture + docs).
- **Phase 3:** GNN and/or PPO warm-started from this calibrated clone — where the ~13 pt parity
  gap actually lives. Pure-BC STOP-de-bias is done.

---

## 2026-06-24 — STOP-de-bias Step 0: fixed an invalid parity row + ran the inference STOP-bias sweep → GREEN-LIGHT

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- **Found + fixed a critical latent bug from PR #50.** BC was registered in
  `src/arena/builtInBots.js` as `adaptModernBot(ai_bc)` — but `adaptModernBot` produces a
  `(GameState)→move` wrapper for the in-game `runAI` loop, while every `BUILT_IN_BOTS`
  consumer (CLI scripts, **ArenaScreen, TournamentScreen**) calls bots via
  `runMatch → runBotDirect` with a **`BotState`**. So BC **threw on every arena turn (0
  attacks, all errors) and never ran its policy.** The merged "BC 0.0% win / rank-3 ELO 1275"
  parity row in RESULTS measured a do-nothing seat that force-ends every turn, **not the
  clone.** No test exercised BC through its registered arena fn, so it slipped through #50.
  **Fix:** register BC **raw** (`fn: ai_bc`), drop the unused `adaptModernBot` import.
- **Built the STOP-de-bias Step 0 tooling.** `makeBC({ stopBias, onDecision })` in
  `src/ai/ai_bc.js` (subtracts a constant from the trailing STOP logit before argmax — an
  additive logit penalty, **not** a softmax temperature, which is argmax-invariant);
  `ai_bc = makeBC()` so there's one code path. New `scripts/bc-stopbias-sweep.mjs` +
  `npm run arena:bc-stopbias`. Tests: an arena-registration regression (BC plays via its
  built-in fn, 0 errors / >0 attacks — pins the bug fixed above) + `makeBC` hook tests. All
  235 arena + 15 BC tests green; lint clean.
- **Ran the full sweep** (6 biases × 20 runs × 150 games = 18,000 games, ~22 min single-core).
  Numbers in RESULTS ("BC STOP-bias inference sweep" section); also flagged the now-invalid
  parity row there with a correction banner.

**Learned / decided:**

- **GREEN-LIGHT the de-bias retrain — calibration hypothesis confirmed with tight CIs.**
  Win% is a clean inverted-U **peaking exactly where STOP% hits the teacher's rate**:
  `stopBias 1` → STOP 46.7% (teacher ~45%) → **win 5.9 ± 0.8**, statistically clear of the
  3.6 ± 0.6 control (no CI overlap). Past the peak it goes suicidal as predicted (STOP keeps
  dropping, attack-win% collapses 85→78, placement/ELO degrade). **Retrain target: STOP ~45%.**
- **ELO is a trap for this bot — judge on win%.** ELO _decreases_ monotonically with bias
  (1260→1105) even as win% _peaks_ at bias 1, because ELO rewards survival/placement and the
  passive clone turtles to middling placement without winning. This is precisely the illusion
  that made the broken-registration "rank-3 ELO 1275" row look like a near-miss.
- **Inference biasing alone does NOT reach parity** (best BC 5.9% vs Lookahead 21.2%, ~¼).
  The retrain is still worth it (cheap, loss-only, bakes calibration in honestly, right PPO
  warm-start) but the residual ~15-pt gap is the encoding/architecture ceiling (GNN/PPO),
  not STOP calibration.
- **First valid arena read of the real policy:** `stopBias 0` (the true control) is **3.6%
  win / STOP 70.8%**, not 0% — the clone does win occasionally; it just turtles. STOP 70.8%
  matches the ~68% Python validation number, cross-confirming the encoder/forward path.

**Dead ends / surprises:**

- The 4×40 smoke read oversold bias-1 (~10%); the real 20×150 number is 5.9%. STOP rates
  matched closely (calibration is stable) — win lift was small-sample noise. Lesson reinforced:
  tight CIs before trusting a win% delta.
- The teacher's own win% _rises_ with BC's bias (17.9→23.2) — a suicidal BC feeds territory to
  the survivors (Lookahead chief among them), a seat-interaction effect, not BC strength.

**Next:**

- The bugfix likely deserves its own small PR — it fixes BC in the live Arena/Tournament
  **screens** too, independent of the ml-bot retrain work.
- **The retrain itself (on `shodan`):** weighted/focal segmented CE in `ml/dicewars_bc/losses.py`
  (teacher-STOP = `label == counts-1`), reuse the fixed 100k corpus, re-export unchanged ([D-16]).
  **`train.py` MUST switch checkpoint selection off val move-match** (rewards the STOP bias) onto
  STOP-rate calibration (~45%) or an arena-win probe. Then re-run `arena:bc-stopbias` at bias 0 to
  confirm the retrained clone sits near the teacher STOP rate without the inference hack.

---

## 2026-06-23 — Phase-2 parity run: 100k corpus + MLP clone → passive (STOP-biased), no win parity

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- **Wired the in-browser BC bot (PR #50).** Pure-JS **synchronous** forward pass
  (`src/ai/bcForward.js`) instead of ONNX Runtime Web — the bot contract is sync
  everywhere in the arena (`botRunner`, `runAI`, self-play workers) while ORT's
  `session.run` is async; for this tiny per-edge MLP a hand-written forward is
  trivially fast and keeps the contract. Label-free `encodeObservationForInference`
  reuses the training encoders and reconstructs `getValidMoves` from a `BotState`. A
  JS↔Python parity test asserts the forward reproduces PyTorch logits (≤2e-3,
  identical argmax). `ml/dicewars_bc/export_weights.py` dumps a checkpoint → a JS
  weights module + the parity fixture.
- **Ran the full parity pipeline on `shodan` (RTX 4070 Ti, WSL).** Generated the
  **100k-game full-7-bot corpus** (8,591,769 teacher steps, 59.4M edges, 8.2 GB
  packed), encoded it, and trained the MLP on CUDA (15 epochs, ~67 s/epoch).
- **Hardening + Python CI** landed separately (PR #49: `weights_only`, dynamo-export
  robustness, `edge_index` range check, ruff pin, `.github/workflows/ml-ci.yml`).

**Learned / decided:**

- **The MLP clone does NOT reach win-rate parity — the headline Phase-2 result.**
  `arena:sweep` (20×150, seat-fair): **BC 0.0% win / ELO 1275** vs **Lookahead 18.8%
  / 1303**. Best val move-match was **57.6%**, but the errors are systematically
  _STOP-when-it-should-attack_ (the net predicts STOP ~68% vs ~45% true). Net effect:
  BC plays passively → survives for middling placement (so ELO looks rank-3) but
  **never conquers a board to win**. **Move-match accuracy is a misleading proxy** — a
  STOP-biased 57% clone is competitively dead.
- Per [D-Encoding], the simplest MLP plateaus: the **objective/encoding, not RL, is
  the gap** — fix before any Phase-3 PPO.

**Dead ends / surprises:**

- `shodan`'s WSL tears down detached jobs ~25 s after SSH disconnect (no systemd);
  tmux, `setsid`, and a Windows-side `Start-Process` keepalive all failed. **Windows
  Scheduled Tasks (`schtasks`) survive** — the working pattern for long jobs (encode,
  train). Corpus gen ran foreground-sharded (4×25k, ~314 s each, under the 600 s call cap).
- DataLoader `--num-workers 0` starved the GPU (epoch > 5 min); `--num-workers 12` → ~67 s/epoch.

**Next (decision pending with Ivan):**

- **De-bias the STOP class** (class-weighted / focal CE, or down-weight STOP) — the
  cheapest high-value lever to turn the passive clone into an active player; retrain on
  the same corpus (still on `shodan`). If that plateaus → escalate to a **1–2 layer GNN**.
- Bundle: production weights are 2.1 MB as JSON-in-JS; a base64 Float32 binary ≈ 410 KB.

---

## 2026-06-23 — BC trainer scaffolded (Python `ml/`) — trains on real tensors, exports ONNX

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- **Decided where the Python lives ([D-16]):** in-repo at `ml/` (vs a separate repo
  or local-only on the GPU box) — Ivan picked it so the **encoding contract**
  (`manifest.json` / `ENCODING_VERSION` / feature-column order in
  `encodeObservation.js`) and the trainer that reads it stay co-versioned in one
  commit. `ml/` excluded from the JS toolchain (`.prettierignore`; ESLint `--ext`
  already skips `.py`); artifacts gitignored.
- **Scaffolded `ml/dicewars_bc/`** — a runnable PyTorch BC trainer reading the packed
  tensors: `manifest.py` (loads + validates the contract, asserts
  `EXPECTED_ENCODING_VERSION`), `dataset.py` (memmap-backed `Dataset`, CSR-aware
  `collate`, **game-level** train/val split — no same-game leakage), `model.py`
  (`EdgePolicyNet`: per-node + per-player encoders, **seat-symmetric** mean-pool over
  seats, context MLP, per-edge head + aux value head — the masked per-edge MLP
  [D-Encoding] starts with), `losses.py` (**segmented** CE/accuracy over the CSR edge
  slices), `train.py`, `export_onnx.py`. Plus `pyproject.toml`, `requirements.txt`,
  `README.md`, and a **hermetic pytest suite** (builds a tiny synthetic corpus
  — no real data needed; torch/onnxruntime tests skip if absent).
- **Verified end-to-end on the real 300-game sample corpus** (24,254 Lookahead-seat
  steps): val move-match climbed **33% → 47% in 8 untuned CPU epochs** (random
  baseline ≈14% over ~6.9 edges/step). ONNX export → **ORT parity max |Δlogits| ≈
  5e-7**, dynamic-edge inference confirmed, sidecar contract written. Full suite green;
  repo `prettier --check` still clean.

**Learned / decided:**

- **The ONNX inference contract is logits-only, single-step ([D-16]).** Inputs
  `nodes/players/board` + flat edges (`edge_feat/from/to/batch`); output
  `edge_logits [E]` (+ `value`). `edges`/`batch` dynamic; at inference B=1,
  `edge_batch` all-zeros. Every edge is legal → the bot just `argmax`es (`→{from,to}`
  or STOP→`null`). **The segmented softmax stays Python-side (loss only)** so the
  export is portable — no `scatter` in the graph, no masking needed in JS.
- **Seat-symmetry is enforced by mean-pooling player embeddings** (permutation-
  invariant); `isMe`/`isMine` carry owner identity relationally. A unit test asserts
  permuting seat rows leaves the output unchanged.
- Python 3.9 is the only local interpreter; the code targets 3.10+ but uses
  `from __future__ import annotations` throughout so it runs on 3.9 for local dev too.

**Dead ends / surprises:**

- A hand-computed expected value in one loss test had a sign slip; the cross-check
  against `torch.cross_entropy` caught it — implementation was right.
- **Adversarial verification pass (5-dimension multi-agent review) caught a real
  high-severity export bug:** `export_onnx.py` hardcoded the player/seat axis to 7 and
  only marked the batch axis dynamic, so the exported graph **froze the seat count at
  7** while the sidecar advertised it as dynamic — a model trained on a non-7p corpus
  would have rejected its own inference shape. Fixed: `player_count` now flows
  `manifest → ModelConfig → checkpoint → export example`, and the seat axis is marked
  dynamic (the net mean-pools over seats, so it was already seat-agnostic). Also added a
  **B=2 parity check** (the B=1 case never exercised the cross-step `edge_batch*A`
  gather), one-time **corpus integrity validation** at load (catches a dropped STOP /
  out-of-range label loudly instead of an `-inf` loss), and dropped a dead loss param.
  Re-verified on the real corpus: B=1 + B=2 ORT parity green, graph accepts 2/3/5/8
  seats. (Benign producer-side finding deferred: `encode-corpus.mjs` `counts.games` can
  over-count games with a teacher seat but zero emitted steps — the loader uses
  `np.unique(meta)`, so no leakage; a follow-up nit.)

**Next:**

- **The parity run, on the GPU box.** Generate the 100k–1M-game corpus ([D-13],
  full 7-bot field per [D-15]) → `encode-corpus` → train on `shodan` (CUDA) with
  tuning → export ONNX.
- **The in-browser bot slice:** add `onnxruntime-web`, extract a **label-free
  encoder** from `encodeStep` (it needs a `chosenMove` today), wrap as a
  `(BotState)→{from,to}|null` bot, and evaluate on `arena:sweep` vs `ai_lookahead`
  (the Phase-2 gate). Escalate the net to a 1–2 layer GNN only if the MLP can't reach
  parity.

---

## 2026-06-23 — Tensor-expansion pass landed: lean corpus → packed BC tensors

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- Built the **observation encoder** (`src/arena/encodeObservation.js`) — a pure
  `encodeStep(step, ctx)` that turns one re-derived fat step into the D-Encoding tensors:
  node graph `[maxAreas][present, dice/8, isMine, isEnemy, isBorder]`, per-seat globals
  `[playerCount][isMe, eliminated, territoriesFrac, diceFrac, connectedFrac, stockNorm]`,
  board scalars `[myDiceShare, activeFrac, phase one-hot]`, a masked edge head over
  `getValidMoves` + STOP (`winProb, atk/8, def/8, isStop`), the BC label (chosen-edge
  index), and an aux value head (`won`, normalized `placement`). Owner is encoded
  **relationally** (no seat one-hot). Feature-column orders exported as constants
  (single source of truth for the manifest + tests).
- Built the **CLI** (`scripts/encode-corpus.mjs`, `npm run encode-corpus`) — streams a lean
  corpus, re-derives via `trajectoryFromReplay`, filters to the teacher seat(s) (`--teacher`,
  default `Lookahead`; `#n` suffix stripped), and writes a **NumPy-loadable packed artifact**:
  dense `nodes`/`players`/`board`, CSR edges (`edges`/`edge_index`/`edge_offsets`), plus
  `labels`/`value`/`meta`, all described by `manifest.json` (dtypes, shapes, feature names).
- Ran it on `corpus-fullfield-300.jsonl`: **300 games → 24,254 Lookahead-seat steps**, 6.9
  edges/step avg, 24.8 MB across 9 blobs in 1.8s. Output gitignored under
  `data/selfplay/encoded/`.

**Learned / decided:**

- **The encoding invariant holds end-to-end.** A test re-runs `getValidMoves(state)`
  independently at _every_ decision of a real game and asserts the encoder's non-STOP edges
  are exactly that set (+ one trailing STOP, all-ones mask). The label always points at the
  applied move. 18 encoder unit tests + 3 CLI e2e tests; full suite **885 green**.
- **The packed binary round-trips.** A read-back-as-Python check (and a committed CLI test)
  confirm every blob's byte size matches its manifest shape and the first step reconstructs
  bit-for-bit from disk. CSR offsets are monotonic and terminate at `totalEdges`.
- **Two version stamps, deliberately separate:** `OBSERVATION_SCHEMA_VERSION` (on-disk lean
  record) vs `ENCODING_VERSION` (expanded tensor layout) — the tensor layout can evolve
  without reshuffling the corpus.
- Edge ragged-set handled with CSR (concat + row offsets), so no per-step edge padding waste;
  nodes/globals stay dense fixed-width (+ present-mask) for trivial `reshape` in Python.

**Dead ends / surprises:**

- None functional. One TDZ bug (a `const` lookup table referenced above its declaration in
  the end-of-run size summary) — fixed by summing over the manifest's own file list.
- Node-tensor size is the cost driver (32×5 floats/step → ~5 GB at 8M steps). Fine for now;
  noted Int8/quantization as the obvious shrink if the full corpus gets unwieldy.

**Next:**

- **Behavioral cloning** on the packed tensors (Python, per D-3): masked per-edge MLP over
  node+global+edge features → cross-entropy on the legal set; aux value head on `placement`.
  Escalate to a 1–2 layer GNN only if the MLP can't clone (gate = clone reaches Lookahead
  parity). Then export to ONNX (D-4) and wire as an in-browser bot. Open: **where the Python
  training code lives** (sibling dir vs separate repo) — decide at BC kickoff.

## 2026-06-23 — Corpus field validated: the full 7-bot arena field ([D-15], RESULTS)

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- Committed the duplicate-seat feature (`5dcdd51`), then **validated the corpus field**
  with a decisive-rate screen (7 candidate fields, 80 games each) + a label-density pass
  (300-game shards, fat steps re-derived via `trajectoryFromReplay`, tallying Lookahead-seat
  steps).
- **Chose the full 7-bot arena field** (`Look,Strat,Expect,Def,Default,Example,Adaptive`),
  imitating Lookahead's seat. Numbers in RESULTS + recorded in [D-15].

**Learned / decided:**

- **Decisive rate is driven by field diversity, not Lookahead count.** Full field **85%**;
  seed-pure `2×Look,2×Strat,2×Expect,Def` 65%; `3×Look` 51%; `4×Look,3 random` 39%;
  `4×Look` 18%. Piling on patient Lookahead seats (even with `Math.random` bots) stays
  turtle-prone — only genuine diversity (incl. the weak/aggressive arena bots) breaks it.
- **The full field also gives the best _labels_, not just the most decisive games:** 80.8
  Lookahead steps/game, **55% attacks** (balanced). The seed-pure 2× field has more steps
  (156/game, 2 seats) but they're **40% attacks** — disproportionately turtling STOPs from
  its lower decisive rate. Balanced labels + exact eval-distribution match settled it.
- **Cost accepted:** the 3 `Math.random` bots make games non-reproducible from seed
  (cross-machine dedup lost), fine under disjoint seed ranges (D-13); recorded moves stay
  valid. Seed-pure 2× is the reproducible fallback. Stalemates (~15%) kept (valid labels;
  `placements` is a full ranking even when `winner` is null → aux value head still trains).
- Volume: ~8M `(obs,move)` teacher pairs per 100k games; 63 g/s on one 8-core box →
  100k ≈ 26 min, < 1 hr across the fleet.

**Next:**

- **Tensor-expansion pass** over the lean corpus (reuse `trajectoryFromReplay`), emitting
  masked node/global/edge tensors + the Lookahead-seat label per D-Encoding; assert the
  action mask matches `getValidMoves`. Then BC train → ONNX → in-browser bot.

## 2026-06-23 — Duplicate-seat support built; pure Lookahead mirror is a turtle equilibrium ([D-15])

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- Built **duplicate-seat support** in `scripts/selfplay.mjs` (the [D-Encoding] corpus
  option (a)): a `<count>x<Bot>` field multiplier (`expandFieldTokens`) + `#n`
  seat-display-name uniquification (`assignSeatNames` / `resolveSeats`) in
  `scripts/lib/selfplay-core.mjs`, so one policy can fill many seats despite matchRunner's
  unique-name guard and name-keyed ELO. Worker re-resolves from the expanded base list and
  derives identical `#n` names. Help/usage updated.
- Tests: a new `duplicate-seat support` block (multiplier, uniquifier, resolver, a direct
  `generateShard` mirror asserting `metadata.bots = ['Lookahead#1'..'#3']`, and a CLI
  worker-pool e2e). `tests/scripts/selfplay.test.js` **55 passing**.

**Learned / decided:**

- **A pure Lookahead mirror is a turtle equilibrium → it is NOT the corpus recipe
  ([D-15]).** `7×Lookahead` stalemates ~97% at maxTurns 500 and **0% at maxTurns 2000**
  (just turtles longer — mean ~2046 actions). `6×Lookahead,Strategist` and
  `5×Lookahead,Strategist,Expectimax` only reach ~12% decisive. Lookahead is patient
  (`BASE_THRESHOLD` 2.2); in a symmetric N-way standoff nobody gets dominant enough to
  trigger PRESS, so all hold. Pure-mirror data is almost all turtling STOPs with no winner
  — it would teach the clone to turtle.
- **Pivot the corpus to a heterogeneous decisive field, imitating Lookahead's seat**
  (option b/c). Heterogeneity (weak/aggressive opponents, incl. the canonical arena's
  `Math.random` bots) is what breaks the symmetry and lets games resolve. The
  duplicate-seat feature stays as harness infrastructure (controlled / low-player mirrors),
  just not as the corpus generator.

**Dead ends / surprises:**

- Expected Lookahead's PRESS posture to break the mirror standoff that all-Strategist hits;
  it doesn't — the patient BASE bar dominates a balanced symmetric field. Confirmed it's an
  equilibrium, not a turn-cap artifact, by re-running at 4× the cap (still 0% decisive).

**Next:**

- Pick + validate the decisive heterogeneous corpus field (start from the canonical 7-bot
  arena field; measure decisive rate and Lookahead-seat label density), then the
  tensor-expansion pass + BC.

## 2026-06-23 — Phase 2 kickoff: D-Encoding finalized + tracer teacher shard

**Phase:** 2 · **Who:** Ivan + Claude

**Did:**

- Branched **`ml-bot/imitation-baseline`** off master for Phase 2.
- **Finalized D-Encoding (Proposed → Accepted)** after grounding it against the code:
  graph over the fixed territory-id node space (≤31 real nodes, pad to `maxAreas=32`,
  present-mask; topology static per game, only owner/dice change); per-node features
  (`dice/8`, `is_mine`/`is_enemy`/`is_border`, owner encoded **relationally** not as a seat
  one-hot); per-player globals incl. **my dice-share / activePlayers / gamePhase** (so a
  feed-forward net can reproduce the teacher's posture-adaptive policy); a **masked edge
  head + explicit STOP** (not a flat 31×31 head) with `winProb = WIN_TABLE[atk][def]` as the
  engineered edge feature; BC label = teacher's `chosenMove` filtered to its seat; terminal
  reward already recorded, optional aux value head recommended for the Phase-3 warm-start.
- **Verified information-completeness**: read `ai_lookahead.js` — it reads only
  owner/dice/adjacency, per-player territories/dice/largestGroup/stock(+cohesion), and
  per-edge win-prob. All present in `BotState` or computable from `getValidMoves` (which
  returns from/to/attackerDice/defenderDice), so the gate ("can't clone ⇒ encoding is
  wrong") is well-posed.
- **Generated a tracer shard**: `npm run selfplay --seed-count 2000 --seed-start 1`
  (committed harness, default 4-bot seed-pure decisive field) → 2000 games, **100% clean**,
  19.1 MB, `data/selfplay/tracer-lookahead-seed-1-2000.jsonl` (gitignored, regenerable).
- **Validated the shard** (scratch script via the committed modules): all 2000 deserialize
  through `deserializeTrajectory`'s boundary checks; round-trip 5/5
  (`fatSteps.length === actions.length`); STOP always the last `legalMoves` entry
  (2199/2199 sample steps); teacher (Lookahead, seat 2) labels extractable as
  attacks+STOPs; the win-prob edge feature spot-checks correct (4v2 dice → 0.939).

**Learned / decided:**

- **Bar pin `596f781` is still valid.** `ai_lookahead.js`'s only change since then
  (`2ee4070`, PR #39) is a **comment-only** edit — behavior is byte-identical, so the
  teacher I'm cloning == the pinned bar. No re-baseline needed.
- **Two real corpus decisions surfaced (recorded in D-Encoding sub-decision):** (1) the
  committed harness requires **distinct** bot names and only **4 seed-pure built-ins**
  exist, so an `N×Lookahead` pure-self-play field isn't expressible today; (2) the eval is
  **7-player FFA** but the default field is **4-player** (bots = seats). Recommendation for
  the corpus: **add duplicate-seat support** (seat-suffixed names) → label-dense, on-policy,
  reproducible `N×Lookahead` 7p self-play. The tracer's 4p mixed-field data is fine for
  pipeline/encoding development, NOT the training corpus.
- **STOP-heavy teacher labels**: in the sample, Lookahead STOPs ≫ attacks (patient
  `BASE_THRESHOLD`). The clone must learn when to hold; flag class imbalance for the BC
  training step (class weighting / per-class accuracy), and re-check the ratio on 7p data
  where Lookahead is more aggressive.

**Next:**

- **Corpus field decision** (recommend: duplicate-seat support in `selfplay.mjs`), then
  generate the real teacher corpus at 7p.
- **Encoding implementation**: a `src/arena/` (or `training/`) tensor-expansion pass over
  the lean dataset reusing `trajectoryFromReplay`, emitting masked node/global/edge tensors
  plus the teacher-seat label; assert the action mask lines up with `getValidMoves`.
- Then the BC train → ONNX → ORT-Web bot → Node-vs-browser action-parity test (tracer
  scale first), before scaling data + net for the `arena:sweep` gate.

## 2026-06-23 — Phase-1 task 3: per-move allocation trims → Phase 1 DONE

**Phase:** 1 · **Who:** Ivan + Claude

**Did:**

- Landed the two per-move allocation trims ([D-12]'s "real perf lever") in
  `src/engine/StateManager.js`, branch `ml-bot/perf-permove-trims`:
  1. **No double-clone of `areas` per `END_TURN`.** `applyEndTurn` used to
     `cloneAreas(state.areas)` and hand that to `distributeReinforcements`, which
     deep-clones the board _again_ internally — two full clones per end-turn. Now it
     passes `state.areas` through; `distributeReinforcements` is pure and already clones.
  2. **`findLargestConnectedGroup` gated to dirty players.** `recalcPlayerStats` ran the
     union-find pass for all 7 players every action; a player's largest group changes
     only when their owned-territory set does, so it now recomputes only
     `[attacker, former-owner]` on a capture and **nobody** on a failed attack / end-turn.
     A new `dirtyLargestGroup` param (null = recompute all, for the initial build); the
     cheap O(areas) territory/dice/eliminated scan stays universal; territoryCount===0 ⇒
     largestGroup 0 without a pass.
- Added a 5-seed per-action invariant fuzz test (`StateManager.test.js`) that, after
  **every action**, asserts the maintained `territoryCount`/`diceCount`/`largestGroup`/
  `eliminated` equal a from-scratch recompute — across captures, failed attacks,
  eliminations and end-turns. Gates: **850 tests green**, lint + build clean.
- **Scratch (uncommitted) extra verification, recorded here for traceability:** ran an
  out-of-tree differential fuzz of the dirty-set recalc against a reimplementation of the
  _old_ always-full-recompute algorithm — zero divergences. Like the engine-only
  microbench, this is a scratch check, not a committed artifact; the committed safety net
  is the 5-seed per-action fuzz test above plus 850-green. (A later multi-agent adversarial
  review re-confirmed zero divergence over ~880k actions across 205 seeds × 5 move-policies.)
- Measured before/after (BEFORE captured on the unmodified branch; AFTER on the trims;
  engine-only isolation via `git stash`). Recorded in `RESULTS.md`. Flipped task 3 + task
  5 checkboxes, the Phase-1 heading, gate, and the README dashboard/status.

**Learned / decided:**

- **The engine win is ≈1.9× (≈215 → ≈414 games/s pure-engine), but the self-play field
  only shows +3–5%** — that decisive field's wall-clock is dominated by the bots' own
  depth-2 search, not `applyAction`. The honest framing: the committed-harness number is
  the gate deliverable; the engine-only isolation is what the **bot-free learner
  engine→tensor rollout path** (Phase 2/3) actually gets, and that's the ≈1.9×.
- **Byte-identical games before/after** (same action-count distribution, same 230,918
  actions over the 600-game bench) is the real correctness signal — the trims are pure
  speed, zero behavior change. The fuzz test pins the per-action invariant directly.
- **Bot-side `join`-matrix fast-path deferred** (the optional task-3 sub-item). It was
  never isolated as a bottleneck, the field is search-dominated, and the learner never
  touches the legacy-view chain ([D-13]) — so it stays a measured-and-only-if future
  micro-opt, not a gate blocker.

**Dead ends / surprises:**

- First cut of the fuzz test asserted the game always reaches `gameOver`; seed 100 turtle-
  stalemated under the mixed move-picker (6000 actions, no winner) — the **invariant still
  held every action**, only my termination expectation was wrong. Switched to aggressive
  attacking + asserting path coverage (captures + losses + eliminations all > 0) instead of
  full resolution.

**Next:**

- **Phase 2 — imitation baseline.** Generate ~100k–1M `ai_lookahead` self-play games with
  the committed harness (shardable by seed range across machines), pick the graph encoding
  ([D-Encoding]), behavioral-clone a small masked policy/value net, export to ONNX, run
  in-browser, and gate it at ~parity with Lookahead on `arena:sweep`.

## 2026-06-22 — Phase-1 task 5: parallel self-play harness scaffolded

**Phase:** 1 · **Who:** Ivan + Claude

**Did:**

- Built the committed parallel self-play harness (D-12) on branch
  `ml-bot/selfplay-harness`. Three files + a test + `npm run selfplay`:
  - `scripts/lib/selfplay-core.mjs` — worker-agnostic core. `generateShard` runs a
    seed block through `runMatch` in training mode (`recordHistory:false` +
    `recordTrajectory:true`), streams each **clean** lean trajectory via an injected
    `write` callback, and keeps only tiny per-game summaries — the heavy
    `MatchResult`/`finalState`/`trajectory` drop out of scope each iteration (the
    RAM-safety crux at 100k–1M games). `forcedEndReason` is the D-14 quarantine
    predicate (drop any game where a bot's `errors`/`invalidMoves`/`maxMovesHit > 0`).
    `aggregateStats` is the single-threaded, path-dependent ELO post-pass replayed over
    summaries sorted by seed (scheduler-independent). `makeFileWriter` is a
    backpressure-free batched `fs.writeSync` JSONL sink.
  - `scripts/lib/selfplay-worker.mjs` — `worker_threads` entry; receives bot **names**,
    not closures (D-12), resolves them itself, streams its shard to its own part-file.
  - `scripts/selfplay.mjs` — CLI. Seed-range sharding
    (`--seed-start`/`--seed-count`/`--out`), worker pool (default ~50% cores) or an
    inline single-core baseline (`--workers 1`), `--no-write` throughput-only mode,
    contiguous seed blocks concatenated in seed order. Defaults to the seed-pure
    heterogeneous decisive field (Strategist/Expectimax/Lookahead/Defensive); warns on
    `Math.random` bots (break the same-seed→same-game sharding guarantee). Prints
    throughput, clean-rate + per-signal quarantine breakdown, action-count distribution,
    and ELO.
  - `tests/scripts/selfplay.test.js` — 18 tests (all green): round-trip per clean game,
    determinism modulo timestamp, the D-14 quarantine for all three signals (throw →
    `errors`; repeated invalid → `invalidMoves`; cap → `maxMovesHit`), the abort-on-failure
    guard, order-independent ELO aggregation, writer flush boundary, and a worker-pool
    **e2e** that asserts seed-ordered, round-trippable JSONL with no orphaned part-files.
- Ran an adversarial multi-agent review of the scaffold (17 agents; 12 findings → 7
  confirmed, 5 refuted) and fixed all 7: hardened the worker-pool error path (terminate
  stragglers + clean up `.partN` files in a `finally`; `concatParts` destroys its stream
  on error and no longer owns deletion), made `writer.close()` idempotent and
  `finally`-guarded in the worker and inline paths (no fd leak on a `generateShard` throw),
  and added a `runMatchFn` test seam so the `maxMovesHit` and abort paths (not triggerable
  with real games) are deterministically tested. Full suite **821 passing**, lint clean,
  build green.

**Learned / decided:**

- Used `fs.writeSync` (batched), not a `WriteStream`: `generateShard` is a tight sync
  loop that never yields, so a stream's `'drain'` backpressure can't run mid-shard and
  its buffer could grow unbounded on a fast/cheap field. Blocking writes from a worker
  sidestep that and keep the core synchronous + unit-testable.
- The lean record carries a wall-clock `metadata.timestamp`, so the determinism test
  compares games with the timestamp stripped — game _content_ (seed/actions/outcome) is
  deterministic; the stamp isn't. Harmless for the merge story (no collisions).
- Smoke numbers (tiny N, overhead-dominated): ~10 g/s 1-worker vs ~22 g/s 3-worker on
  the decisive seed-pure field. Real scaling numbers belong in `RESULTS.md` once task 3's
  trims land — deferred per the gate.

**Next:**

- Task 3 (per-move allocation trims), then record before/after + single-core-vs-N-worker
  throughput and the action-count distribution in `RESULTS.md` to close the Phase-1 gate.

## 2026-06-22 — PR #42 review hardening (boundary + forced-end signal)

**Phase:** 1 · **Who:** Ivan + Claude

**Did:**

- Acted on the multi-agent PR-#42 review. Three changes, all green (arena suite
  213 passing; `trajectoryExport` 28 → 36 tests):
  1. **Forced-end signal made first-class (D-14).** Exported `MAX_MOVES_PER_TURN`
     (single source of truth) and added a `maxMovesHit` per-bot counter to
     `MatchResult.botStats`, incremented when a turn exhausts the move cap. Replaces
     the earlier "derive from turn length === cap" plan, which was ambiguous (recorded
     run is `cap` ATTACKs **+** trailing STOP, and a legit 100-attack voluntary turn
     looks identical). Task-5 now quarantines on `errors`/`invalidMoves`/`maxMovesHit > 0`
     uniformly.
  2. **Deserialize boundary hardening.** `deserializeTrajectory` now validates the
     terminal reward label (`metadata.winner` null-or-in-range; `metadata.placements`
     a full permutation) and the config fields that feed `createGame` (`playerCount`
     ≥ 2; positive map/dice dims), not just `seed`. A poisoned label/config now fails
     loudly at parse instead of detonating opaquely downstream.
  3. **Tests.** Added a stalemate/null-winner case (winner null + valid placements
     permutation, round-trips through validation) and an explicit "GAME_OVER ⇒ no
     trailing STOP" assertion (was only covered implicitly by the seed-12345
     coincidence), plus six deserialize-rejection tests.

**Learned / decided:**

- The reward label is what makes a record a _trajectory_ and not a plain replay, so
  it belongs in boundary validation — the `toRecord` finalize-guard only covers the
  write path; the read path needed the same protection.
- A per-game integer counter beats per-turn length reconstruction for detecting
  cap-forced ends: unambiguous, and consumers never have to re-segment the flat
  action list.

**Next:**

- Task 5: `scripts/selfplay.mjs` + worker pool + JSONL streaming, consuming the
  `botStats` forced-end counters as the quarantine filter.

---

## 2026-06-22 — PR 2 built: trajectory export (`src/arena/trajectoryExport.js`, task 4)

**Phase:** 1 · **Who:** Ivan + Claude

**Did:**

- Scoped task 4 with a verified surface-map (fan-out readers over `matchRunner`,
  `replayFormat`, `StateManager`, bot adapters, `GameRunner`/`arenaRunner`) before
  writing code, then built it TDD as 4 slices, all green:
  1. **`replayFormat.js` refactor** — extracted `createReplayFromActions(actions,
config, metadata)` (the two existing builders re-point at it) and hoisted
     `REPLAY_VERSION` (was a hardcoded `1` in 3 spots).
  2. **`src/arena/trajectoryExport.js`** — `OBSERVATION_SCHEMA_VERSION`, a `STOP`
     sentinel (`{type:'END_TURN'}`), `createTrajectoryRecorder()`, the lean→fat
     re-derivation (`trajectoryFromReplay`/`trajectoryStepFromReplay`), and
     JSONL-oriented `serialize`/`deserializeTrajectory` with version gates.
  3. **Hook plumbing** — `runMatch`/`runBotTurn` thread an `onStep`/`recordTrajectory`
     option; ATTACK steps reuse the `botState`+`validMoves` already computed at the
     decision point (zero extra engine calls on the hot path), STOP step recomputes;
     all gated behind `if (onStep)`. `arenaRunner` forwards both options.
  4. **Integration test + sample** — `tests/arena/trajectoryExport.test.js` (19
     tests) incl. the headline round-trip; `tests/fixtures/trajectories/sample.jsonl`
     (3 games, seeds 1/2/3).
- Full suite **783 passing**, lint clean, `npm run build` green.

**Learned / decided:**

- **Crux:** under `recordHistory:false`, `createReplay` builds its action list from
  `finalState.history` → **empty**, so the plain replay silently breaks in training
  mode. That's the whole reason the `onStep` hook exists: it records the lean action
  list **out-of-band from `state.history`**.
- **Lean canonical, fat derived** (confirmed with Ivan; aligns [D-13]). On-disk = lean
  (seed + actions + terminal label); fat steps re-derived via
  `createBotState(replayToState(replay,i))` — which is also the Phase-2 tensor-expansion
  pass. The headline test asserts `rederived === live` step-for-step under
  `recordHistory:false`, proving lean is a lossless compression of fat.
- **Invariant: one fat step per _applied_ action** (`fatSteps ≡ lean action list`).
  Rejected/invalid moves and bot errors are skipped (never reach `applyAction`); the
  turn-ending STOP is the `END_TURN` step. This keeps live capture and re-derivation in
  lockstep.
- `nextTurn` already skips eliminated players, so `runMatch`'s eliminated-skip
  `END_TURN` (applied outside `runBotTurn`) is **defensive dead code** → the action list
  is exactly the bot decisions and replays faithfully. The full-state round-trip test
  guards against this assumption silently breaking.
- A trajectory/replay is **self-contained** (seed + recorded actions, re-applied by the
  engine — bots are _not_ called on replay), so the committed `sample.jsonl` is stable
  across bot tuning; it only depends on engine determinism.
- BotState is deeply frozen + freshly built per move → stored by reference, no clone.
  The `replayToState` round-trip is robust to the `recordHistory` mismatch (it rebuilds
  with history on, but `createBotState` drops history, so observations compare equal).

**Dead ends / surprises:**

- Planned to hoist `getValidMoves` to the loop top per the surface-map; turned out
  unnecessary — the ATTACK step reuses the `validMoves` already computed at `:91`, so
  no hot-path change.

**Next:**

- **Task 3** (per-move allocation trims — first-class [D-12]) and **task 5** (committed
  parallel self-play harness `scripts/selfplay.mjs` + `npm run selfplay`, streaming
  trajectories to JSONL, shardable by seed range — reuses this module's lean record).
  Then the Phase-1 gate (scaling + before/after numbers) → Phase 2.

---

## 2026-06-22 — PR 1 landed: training-mode `recordHistory` flag + determinism harness (tasks 1–2)

**Phase:** 1 · **Who:** Ivan + Claude

**Did:**

- Implemented **PR 1** as a tracer-bullet vertical slice: flag → thread through
  `createGame`/`runMatch`/`runArena` → `tests/engine/determinism.test.js` green.
- `StateManager.appendHistory()` skips the per-move history append when
  `config.recordHistory === false`; both reducers route through it. Defaults
  history **ON**, so the browser `GameController` + replay/tournament persistence
  are untouched (verified against the call sites in review).
- `createGame` adds `recordHistory` to the config allowlist and **throws in
  training mode** (`recordHistory:false`) when the seed is missing/`null`/`NaN` —
  the production UI keeps its `Math.random` seed fallback (history on → never gated).
- Persisted `dicePerArea` in `createReplay`/`createReplayFromState` so non-default
  dice games round-trip losslessly.
- New determinism test (16 cases, node env, **seed-pure bots only** —
  Strategist/Lookahead/Expectimax/Defensive): same seed → identical game; different
  seeds diverge; `history.length === 0` under `recordHistory:false` with identical
  play; explicit-seed gate (incl. null/NaN); replay round-trip with **and without**
  `dicePerArea`.

**Learned / decided:**

- Ran a 20-agent adversarial review of the diff before declaring done; verdict
  **ship-ready, no blockers**. It validated the "production paths unaffected" claim
  against the actual callers (arena/tournament always pass integer seeds).
- Real gap the review surfaced and we fixed: the seed gate tested `=== undefined`
  while the fallback used `??`, so `seed:null`/`seed:NaN` silently slipped past into
  a random seed — defeating training-mode reproducibility. Fixed to
  `== null || Number.isNaN`, with tests.

**Dead ends / surprises:**

- The `dicePerArea` round-trip's deeper rngState/board assertions are never reached
  on the _true_ bug path (reconstruction throws mid-replay when the recorded dice-5
  actions hit a wrongly-owned territory on a default-3 map). Added an explicit
  negative case that pins the consequence rather than leaning on those lines.

**Gates:** determinism 16/16; full `npm test` **763/763** (54 files); ESLint clean;
`npm run build` ok.

**Next:**

- **PR 2** — trajectory export (`src/arena/trajectoryExport.js`, task 4).
- **PR 3** — committed parallel self-play harness (`scripts/selfplay.mjs`) +
  per-move alloc trims + before/after throughput numbers (tasks 5, 3).

---

## 2026-06-22 — Phase 1 kicked off: verified surface-map + scope correction ([D-12])

**Phase:** 1 · **Who:** Ivan + Claude

**Did:**

- Branched **`ml-bot/selfplay-harness`** off clean `master` (`e3b8928`) for Phase 1.
- Ran a fan-out **map + adversarial verification** of the entire Phase-1 surface area
  (6 subsystem readers + 5 skeptics over engine/arena/scripts/docs) _before_ writing
  any code — to ground the scope in verified facts, not assumptions.
- Rewrote the PLAN Phase-1 section and recorded the rationale in **[D-12]**.

**Learned / decided:**

- **History append is _not_ the perf lever** — ~1–2% of per-move cost; `cloneAreas` +
  `clonePlayers` + 7× `findLargestConnectedGroup` (~19× larger) dominates. History fix
  kept for memory/asymptotic safety, but **per-move alloc trims (task 3) promoted to
  first-class** (Ivan's call) — the real lever and a Phase-2 data-gen risk.
- **Parallel self-play is greenfield** — no worker/process code exists; the "266 g/s on
  4 procs" number was a deleted, uncommitted probe. Building a **committed
  `scripts/selfplay.mjs`** (Ivan's call) that Phase 2 reuses for its 100k–1M games.
- **`recordHistory` must default ON (history recorded)** — the browser `GameController`
  and replay persistence read `state.history`; only the training harness opts out via
  `recordHistory:false`, and the arena hot loop doesn't read history (safe to skip there).
- **Round-trip already works** (`replayGame`, `GameRunner.test.js:205`); enabling
  precondition is just explicit-seed capture + persisting `dicePerArea` in the replay
  config.
- **Gate reframed** from "≥100 g/s/core" to "near-linear scaling confirmed + per-field
  numbers recorded" — `ai_lookahead` self-play is ~4 g/s and parallelism-bound, not
  micro-opt-bound.
- **Compute is multi-machine ([D-13]):** data-gen shards by seed range across the
  available CPU machines (engine determinism + independent games → clean JSONL merge);
  PPO trains on a CUDA GPU workstation, full loop co-located to keep the bridge local.
  `selfplay.mjs` designed shardable from day one — a few machines' worth of cores make 1M
  lookahead-teacher games a few-hours job. (Machine specifics kept in local notes, not
  the repo.)
- **Bot-side overhead found:** all built-in bots run via `adaptLegacyBot` →
  `createLegacyViewFromBotState`, which rebuilds an O(areas²) `join` matrix _per move_;
  strategist/lookahead/expectimax read the legacy view, not `BotState` (the README's
  "modern" label is loose). A modern fast-path is a **measured** task-3 candidate for the
  hot heuristic bots (re-validate parity after) — not a blanket port; the learner reads
  engine→tensor directly.

**Dead ends / surprises:**

- The PLAN's "near-linear scaling already measured" leaned on a probe that no longer
  exists in the tree — the parallel result is unproven from committed code.
- Identical-Strategist self-play is degenerate: 0 attacks, stalemates to `maxTurns`
  every game → worst-case throughput + zero learning signal. The harness must use a
  decisive/heterogeneous field and report completion rate.

**Next:**

- **PR 1** — `feat(engine)`: training-mode `recordHistory` flag + end-to-end seeds +
  `tests/engine/determinism.test.js` (tasks 1–2). Then **PR 2** trajectory export
  (task 4), **PR 3** committed parallel harness + per-move trims + throughput numbers
  (tasks 5, 3).

---

## 2026-06-22 — Eval-rework spike kicked off (Phase 0.5, Track A)

**Phase:** 0.5 · **Who:** Ivan + Claude

**Did:**

- Squash-merged the press-mechanism PR (#39, parity with Lookahead) to `master`
  (`2ee4070`); branched `ml-bot/expectimax-eval-rework` off it so any new sweep
  measures against the shipped parity baseline.
- Opened **Phase 0.5** (PLAN): a _bounded_ eval-rework spike — the last cheap Track-A
  swing at the open Phase-0 gate (a significant **outright-win%** edge over
  Lookahead; placement/ELO already at parity). Approved basket: `mergePotential`,
  `fieldRivalIncome`, `trappedDice` (+ `supportedBorder` only if those show life).
  **Capped at 4 sweep swings.**
- Added the three features to `evaluateBoard` as `DEFAULT_PARAMS` weights defaulting
  to **0**, so `makeExpectimax()` reproduces the D-9 bot byte-for-byte (27/27 tests
  green, lint clean) until a sweep turns one on. Reuses the whole
  `makeExpectimax` / `_tune.mjs` / `_baseline.mjs` infra — no engine changes.
- Launched **Swing 1**: single-term magnitude screen (`_tune.mjs --games 1000`,
  seed 1) over each term at 3 magnitudes.

**Learned / decided:**

- **Spike killed at 2/4 swings — basket is a dud ([D-11]).** Swing 1 (1000 games,
  seed 1): `mergePotential` and `trappedDice` neutral-when-tiny, harmful-when-grown;
  `fieldRivalIncome 0.2` the lone (noisy) positive. Swing 2 (3000 games, seed 2): the
  0.2 bump **didn't replicate** — no config beats the D-9 baseline at higher power on
  fresh maps. Same parity ceiling as D-8/D-9; the eval sits at a local optimum and
  bolt-on terms perturb rather than break it.
- **Reverted the three dud params** (don't ship inert, known-negative weights); the
  finding lives in RESULTS + [D-11]. Stopped early on purpose — the 4-swing cap was a
  ceiling, not a quota.

**Dead ends / surprises:**

- Plumbing check (140 games): `trappedDice: 0.5` already over-penalizes (cand win%
  collapses), so the useful range is well below that — screened smaller magnitudes.
- The Swing-1 `fieldRivalIncome 0.2` positive was a seed-1 fluke (didn't survive a
  fresh seed at 3× the games) — a reminder that single-seed screens overfit.

**Next:**

- **Pivot to Track B — Phase 1 (self-play harness hardening):** disable the O(n²)
  history append for training, force end-to-end seeds + a determinism test, add
  trajectory export, confirm parallel self-play. Its own PR off clean master.

---

## 2026-06-22 — PR #39 review follow-up: interior posture-bar documented ([D-10])

**Phase:** 0 · **Who:** Ivan + Claude

**Did:**

- Applied the low-risk findings from the multi-agent PR #39 review (script guards,
  comment accuracy, a strict-boundary press test) — committed `3728997`.
- Resolved the one deferred design finding: the posture `threshold` is threaded into
  every recursive `search` node, so it gates interior-node valuation, not just the
  root commit. Decided **(b) keep + document accurately** over (a) decouple+re-tune.
  Rewrote the `postureThreshold` / `search` doc comments to frame it as
  **policy-consistent valuation** (value interior nodes under the bot's own
  threshold-gated policy) with the **frozen-root-posture caveat**; recorded the call
  and a deferred decoupling A/B in [D-10]. Also fixed a lingering "U-shaped" →
  "inverted-U (∩)" label in the [D-9] record.

**Learned / decided:**

- The interior gating is **defensible, not a bug**: at `searchDepth: 2` it is one
  interior layer, and the frozen-root-posture approximation rarely changes a board's
  posture bucket one ply out. It is genuinely closer to evaluating positions under
  the behavior policy than under a neutral greedy max.
- The cleaner separation (neutral interior bar + posture only at the root, as
  `ai_lookahead` does) is the lever to revisit **only if `searchDepth` grows** — the
  approximation worsens with depth. Deferred as a tracked A/B, not run now (marginal
  expected effect at depth 2; out of scope for a review follow-up).

**Dead ends / surprises:**

- None — the finding turned out to be a documentation/intent-clarity issue, not a
  behavioral defect.

**Next:**

- Unchanged from [D-9]: Track B (learned policy) or an eval rework to cross from
  win% parity to a decisive edge over Lookahead. The [D-10] A/B is a small,
  depth-gated side quest, not on the critical path.

---

## 2026-06-22 — Press-mechanism (D-9): Expectimax reaches parity with Lookahead

**Phase:** 0 · **Who:** Ivan + Claude

**Did:**

- Built the structural **press-mechanism** [D-8] named into `ai_expectimax`:
  (1) a **posture-adaptive attack threshold** (`postureThreshold` — PRESS/WEAK/BASE
  U-shape, replacing the single fixed `attackThreshold`, which became a nullable
  fixed-bar override); (2) a **strengthened elimination term** (`activeRival`); and
  (3) a **low-odds risk floor** (`lowOddsFloor`/`lowOddsPenalty`) — a third
  ingredient beyond the two D-8 named, mirroring Lookahead's `LOW_ODDS_PENALTY`.
- Tuned via a parallel arena-sweep **workflow** (coarse 36-config grid → auto-refine,
  90 configs) + focused two-seed low-odds/depth sweeps; verified finalists on a
  **holdout seed** and at the full seat-fair gate. **Landed** `{ baseThreshold 1.2,
pressThreshold -2.5, activeRival 2, lowOddsFloor 0.78, lowOddsPenalty 5,
searchDepth 2 }` as the new shipped default.
- Generalized the retained gate harnesses: `_tune.mjs` now reports the paired edge
  **vs Lookahead** (+ `beatsLook`); `_baseline.mjs` gained `--vs <bot>` (default
  Lookahead), `--cand '<json>'` (gate a config without landing), and `--seedbase`
  (disjoint-seed confirmation). Rewrote the unit suite's policy tests into 7
  tuning-independent posture/risk-floor mechanic tests (23 pass).

**Learned / decided:**

- **Result = parity, not a win.** Across 3 disjoint-seed × 5600-game seat-fair runs
  (16,800 games): Expectimax **ties Lookahead on win%** (22–23% vs 22.5–23.9%,
  overlapping CIs; Look a hair ahead on raw wins), **significantly out-places it**
  (pooled paired 51.2%, z=3.09, **p≈0.002**), is **ELO co-leader**, and **ties the
  1v1 duel** (49.5%, which the pre-press default _lost_ at 45.3%, p=0.007). Beats
  Strategist decisively. Rank 6/7 → **joint-strongest**.
- **The headline gate (significant win% edge over Lookahead) is NOT met — it's a
  tie.** Phase 0's gate stays open on win%. Landed anyway: it is a strict, large
  improvement over the previous shipped Expectimax (which lost to Lookahead). See
  [D-9].
- **depth-2 is essential** (depth-1 win% collapses to ~10%); `activeRival` wants to
  be **low** (1–2) — over-chasing eliminations hurts; the **low-odds floor was the
  key third lever** (posture+elimination alone left a ~4–5 pt gap it mostly closed).

**Dead ends / surprises:**

- **Seed-1 overfitting bit twice:** the coarse workflow's seed-1 winner appeared to
  edge Lookahead but trailed by 3–6 pts on a holdout seed. Lesson reinforced:
  always confirm tuned configs on disjoint seeds (now easy via `--seedbase`).
- The "strong elimination punches through the floor" hypothesis was **wrong** —
  `activeRival` 4–6 _hurt_ win% vs `activeRival` 2.
- Found+fixed a bug in the new `--cand` path: `_baseline.mjs`'s 2-player section was
  still reading the shipped bot, not the override (A and B gave identical 1v1
  numbers, the tell).

**Next:**

- The "places better, win% ties" ceiling that capped Expectimax-vs-Strategist (D-8)
  now caps Expectimax-vs-Lookahead one tier up. A decisive win% edge over Lookahead
  likely needs a better board **evaluation** or deeper **search**, not more posture
  tuning → **Track B (learned policy)** is the open frontier, or a separate eval
  rework. Decide before sinking more effort into Track A.

---

## 2026-06-21 — Gate re-baselined to `Lookahead` (D-7 accepted)

**Phase:** 0 · **Who:** Ivan + Claude

**Did:**

- Per Ivan's call, **accepted [D-7]**: the evaluation gate's opponent of record is
  now **`ai_lookahead`** (pinned `596f781`), not `ai_strategist`. Propagated through
  the docs: README ("the bar" + Goal + dashboard gates), PLAN (top gate callout +
  Phase 0/2/3 gates + imitation target), DECISIONS (D-7 → Accepted, D-5 amended),
  RESULTS (convention note + a vs-Lookahead headline row). `ai_strategist`
  (`f5fedb2`) kept as a **secondary reference**, not the deciding bar.

**Learned / decided:**

- Against the new (correct) bar, the just-landed tuned Expectimax **does not pass**:
  it trails Lookahead on win% (~15% vs ~25%), though it's ~co-leader by ELO. The
  Phase 0 **headline gate (beat Lookahead) is now OPEN** — the tuned bot is a strong
  #2, not the field leader. (This is a more honest framing than "beats Strategist.")
- Phase 2's imitation target also switches to Lookahead (clone the strongest
  heuristic — both de-risks the pipeline and yields a stronger starting policy).

**Next:**

- To actually pass the gate: add the structural **press-mechanism** (posture-adaptive
  threshold + elimination term) to a search bot and try to beat Lookahead, and/or
  carry the finding into Track B's learned policy ([D-8], now measured vs the right
  bar). Historical RESULTS/LOG rows dated ≤ this entry were measured vs Strategist —
  accurate history, read in that light.

---

## 2026-06-21 — Phase 0, step 3: tuned & landed Expectimax → rank-1–2 by ELO (win% still a tie)

**Phase:** 0 · **Who:** Ivan + Claude

**Did:**

- Refactored `ai_expectimax` to a `makeExpectimax(params)` factory (same code path,
  injectable params; default export byte-identical — verified by reproducing the
  baseline 2p head-to-head 990/1009/1 exactly).
- Ran a parallel arena-sweep tuning search (coarse `attackThreshold × threat` grid →
  refine + weight perturbations → verify finalists on **holdout** seeds + a clean
  4000-game cross-seed re-check).
- **Landed `{ attackThreshold: 0.3, threat: 2.0 }`** as the new shipped default and
  recorded the official before/after in `RESULTS.md`; added [D-8](./DECISIONS.md).
- Fixed the one unit test the new weights invalidated (the vulnerability-orientation
  test — the tuned bot now correctly declines a marginal exposing 2v1) by pinning
  it to an explicit low `attackThreshold` via `makeExpectimax`, decoupling the
  mechanic test from the (now actively-tuned) production weights.

**Learned / decided:**

- Two levers do all the work: **patience** (`attackThreshold` 0.05 → 0.3) and
  **exposure-aversion** (`threat` 0.45 → 2.0). `searchDepth`/`topK`/other weights
  barely moved the needle.
- Result: Expectimax went from rank **6/7 → rank 1–2 by ELO** (seat-fair ELO 1349,
  highest in the field; canonical 1305 vs Strat 1229, non-overlapping CIs) and
  out-places Strategist head-to-head **62.4%** (z = 18.6, p ≈ 0). **But win% is a
  tie** (sign flips with seed sample: Ex 13.5–15.7% vs Strat 14.0–15.3%), and it's
  still well below `Lookahead` (~25%) on win%.
- **The win% ceiling is structural, not a tuning gap** — a single fixed
  `attackThreshold` can't both stay patient (avoid FFA over-extension) and press to
  close out won games. That's [D-8]; the next lever is a **posture-adaptive
  threshold + press/elimination term** (the `Lookahead` mechanism), not more
  weight-tuning.
- Gate = **partially met** (ELO/placement ✅, win% tie) per Ivan's call → ship the
  improvement, don't overclaim a win.

**Dead ends / surprises:**

- Predicted the depth-2 combo test would break under the higher `threat`; it didn't
  — the vulnerability-orientation test broke instead (the tuned bot rightly judges a
  marginal exposing capture not worth it).
- Pleasant surprise: the seat-fair sweep is _more_ favorable than the fixed-seat
  canonical (Ex win% 15.7 > Strat 14.0 vs canonical 13.8 < 14.5) — the win%
  difference is small enough that seed/seat noise flips its sign, reinforcing "tie."
- One tuning-verify subagent returned corrupted (normalized) numbers for one config;
  caught it (lookWin 0, fractional win%) and re-verified that config directly.

**Next:**

- Decide whether to pursue the **structural press-mechanism** (posture-adaptive
  threshold + elimination bonus) to chase a true win% win over Strategist and close
  the gap to `Lookahead` — and whether that belongs in `ai_expectimax` or informs
  Track B's learned policy. Also weigh **D-7** (re-baseline the gate to `Lookahead`,
  the actual field leader, rather than `Strategist`).
- Tooling: retained `scripts/_baseline.mjs` (the D-5 seat-fair + paired gate
  harness) and `scripts/_tune.mjs` (per-config evaluator) as reusable ml-bot
  helpers; removed the one-off `_probe`/`_diag`/`_tune-workflow` scaffolding. The
  canonical gate command remains `npm run arena:sweep`. (Promoting `_baseline.mjs`
  to a committed, tested `arena-gate` script is a clean future nicety.)

---

## 2026-06-21 — Phase 0 baseline run: Expectimax (default weights) loses the FFA to Strategist

**Phase:** 0 · **Who:** Ivan + Claude

**Did:**

- Ran the Phase 0 baseline three ways, all vs Strategist pinned at `f5fedb2`
  (working-tree Strategist == `f5fedb2`, verified by empty `git diff`):
  1. Canonical `npm run arena:sweep -- --runs 30 --games 200` (6000-game, 7-bot FFA).
  2. Seat-counterbalanced sweep (5600 games, all 7 cyclic seat rotations) — honors
     D-5 by removing residual seat-count bias.
  3. Paired per-game placement test + a 2-player deterministic head-to-head.
- Recorded the headline row + full run detail in `RESULTS.md`.

**Learned / decided:**

- **Current Expectimax does NOT beat Strategist — it loses decisively** (7.1 ± 0.8%
  vs 17.5%, rank 6/7; paired z = −19.7, p ≈ 0). Seat-fairness barely moved the
  numbers, so the verdict is robust.
- **But the eval isn't broken:** 1v1 it's a statistical tie with Strategist
  (49.5%, p = 0.67). It only collapses in the 7-player crowd → classic
  **over-extension in an FFA** (worst avg placement of all bots; lowest attack
  win-rate of the strong bots). Likely levers, all existing scalar params:
  `ATTACK_THRESHOLD = 0.05` (no patience), `THREAT_WEIGHT = 0.45` (under-weights
  exposure), no low-odds floor.
- **Search is clearly viable here** — `Lookahead` (also a search bot, depth-1 with a
  posture-adaptive threshold, high border-threat weight, low-odds penalty) **tops
  the field at ~32%**. So the Phase 0 "does search beat Strategist?" question is
  already answered _yes_ by a sibling; the open question narrows to "can
  `ai_expectimax` be tuned into the strongest bot." (See DECISIONS D-7.)
- Throughput: full 7-bot field ~21 games/s single core; depth-2 Expectimax is
  comfortably in-browser-playable.

**Dead ends / surprises:**

- Surprise: a brand-new depth-2 expectimax landed _below_ the dumb bots while a
  depth-1 sibling (Lookahead) dominates — confirming that **eval weights + a
  crowd-aware attack threshold matter far more than search depth** in this game.
- The naive "over-extension = too many attacks" reading is confounded: Expectimax
  makes _fewer_ total attacks than Strategist (38 vs 58) but only because it dies
  earlier. The unconfounded signal is its lower per-attack win-rate (78.5%) and
  worst placement — it picks worse fights and exposes itself.

**Next:**

- Phase 0, step 3: refactor `ai_expectimax` to a `makeExpectimax(weights)` factory
  (same code path, injectable params) and run a tuning search prioritizing
  `ATTACK_THRESHOLD` and `THREAT_WEIGHT`. **Land a tuned version only if it beats
  Strategist with a statistically significant edge** (seat-fair sweep + paired
  test). If weight-tuning alone can't clear the bar, record that honestly and
  weigh the Track B pivot.

---

## 2026-06-21 — Feasibility analysis + plan created

**Phase:** pre-0 · **Who:** Ivan + Claude

**Did:**

- Ran a multi-agent feasibility analysis: 3 agents read the codebase (bot
  contract, headless throughput, MDP shape) and 2 researched the RL landscape +
  prior art, then a synthesis pass.
- Created this `docs/ml-bot/` folder: `README.md`, `PLAN.md`, `DECISIONS.md`,
  `LOG.md`, `RESULTS.md`.

**Learned / decided:**

- Verdict: **large-but-doable**, not too big. Engine is a great RL environment.
- The bar is **beating `ai_strategist`** — a strong exact-odds baseline. Prior art
  says from-scratch self-play RL often _loses_ to good heuristics until
  bootstrapped, so we go **search-first, learning-second**.
- Measured throughput: ~150 games/s/core pure engine; ~77 g/s with Strategist;
  near-linear across cores. Inference, not the engine, will be the bottleneck.
- Key code facts captured in `README.md` (getValidMoves mask, WIN_TABLE odds,
  seeded determinism, O(n²) history append to disable for training).
- Decisions D-1…D-5 + D-Encoding recorded in `DECISIONS.md`.

**Dead ends / surprises:**

- AlphaZero/MuZero turnkey templates don't fit (stochastic + 8-player FFA);
  model-free PPO is the right family. (D-2)

**Next:**

- Phase 0: scaffold the depth-1 chance-node expectimax bot (`ai_expectimax`)
  reusing `ai_strategist`'s eval + `WIN_TABLE`, register it, and run the first
  `arena:sweep` vs `ai_strategist`. Record the baseline + first result in
  `RESULTS.md`.
- **Baseline dependency (now cleared):** PR #35 (`fix/strategist-endgame-turtle`)
  changed `ai_strategist`; it **merged to master the same day as `f5fedb2`**. Pin
  that SHA in `RESULTS.md` when running the baseline sweep. Building/validating the
  expectimax bot itself was never blocked.
