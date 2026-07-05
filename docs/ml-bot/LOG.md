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

## 2026-07-05 (evening) — [D-29] strength-curve scorer Phase 1 BUILT + mini acceptance PASSED (Wave-0 item 1, the hard Wave-1 precondition)

**Phase:** Wave-0 eval builds (PERSONAS §10.7 item 1) · **Who:** Claude (PR review + merge Ivan-gated)

**Did:**

- Extracted **`runGateSweep`** from `ppo-gate.mjs` into `ppo-gate-core.mjs` ([D-29] decision 6):
  identical seed formula / rotation order / tallies / abort semantics, pinned by
  `tests/scripts/ppoGateSweep.test.js` against a stub match runner; generalized to per-run
  win%/placement/attack tallies for arbitrary **in-field** names; throws instead of
  `process.exit`; made async (yields between runs) so SIGINT/timers stay live through
  minutes-long sweeps. `ppo-gate.mjs` is now a thin CLI over it — output unchanged.
- Built **`npm run ppo:curve`** (`scripts/ppo-strength-curve.mjs` + `strength-curve-core.mjs`):
  resume-safe index walking, `CP-<step>` candidate vs Lookahead + `PPO` tallied from the same
  games, per-run arrays persisted per row, `--watch`/`--rsync-from` transport, `--every-n`/
  `--max-points` (logged, never silent), `--test-retest`, `strength.meta.json` provenance with
  hard-mismatch abort, and `analyzeCurve` (k=2 run-paired regression vs the running best's lower
  CI bound + loud alert + `tb/` join pointer; k=3 plateau; gaps break windows; divergence flag;
  mandatory confirmation-protocol printout). One-sided α=0.05 t-table added to `stats.mjs`.
- **Tier-1 hermetic acceptance** (`strengthCurveE2E.test.js`): synthetic index over real exports
  of known strength (PPO early / BC anchor twice later / corrupted fixture) with real games —
  the regression detector fires on the descending pair; corrupted fixture → `parity-failed` row.
  First budget (8×18) left ~1 t-unit of margin and flaked; re-powered to 10×27 (expected t ≈ −5).
- **Multi-agent review** (determinism + AI-contract + spec-fidelity, findings adversarially
  verified): 15 raw → 7 confirmed, all fixed (per-row `gitSha` + sha256 on failed rows;
  not-yet-synced expected steps now break k-windows; encoding-abort `reason` discriminator —
  width mismatch ≠ version mismatch; `seedBase` NaN guard in sweep + gate CLI — a `--seedbase`
  typo used to silently grade N replays of the seed-0 map; `--test-retest --watch` rejected).
  The determinism lens **formally verified zero methodology drift** in the extraction. 8 refuted.
- **Mini acceptance PASSED (the pre-registered Wave-1 precondition):** on the mini
  (branch `wave0-strength-curve` @ `d3a5892`, master deps refreshed), graded `eval-001000008`
  (the v3 run's 1M checkpoint) end-to-end at the default budget from the backed-up eval stream —
  **Δ vs Lookahead +27.6 ± 2.2 [25.4, 29.8] BEAT · Δ vs PPO +0.6 TIE · 3060 games ·
  parity 1.2e-6 · 552.1 s**. Outputs (`strength.jsonl` with per-run arrays + per-row provenance,
  `.csv`, `.meta.json`) live in `mini:~/dicewarsjs/ml/runs/ppo-v3-scratch/eval/`.

**Learned / decided:**

- **Mini timing calibration** (the doc's open Q4 item): ~**552 s/checkpoint** at default budget
  vs shodan's 267.7–440.5 s → a full 21-point v3 curve ≈ **3.2 h serially on the mini**.
- The v3 net at **1M steps already TIEs the full 20M v2 `ppo-long`** (+0.6 ΔPPO) while BEATing
  Lookahead +27.6 — consistent with the 2M/6M/12M "bar saturates by 2M" sketch, now with a
  default-budget measurement behind it.
- A long synchronous sweep starves Node's event loop (SIGINT, timers, vitest's worker RPC) —
  hence async `runGateSweep`. Surfaced as a flaky-looking vitest "onTaskUpdate timeout".
- The games-heavy E2E is **skipped on CI** (`describe.skipIf(CI)`): the 2-vCPU runner under
  coverage blew the 600 s hook timeout at the powered budget, and a weaker budget flakes. It
  runs in every local `npm test`; the detection rules stay CI-covered via the stub-match suites.
- Local (MacBook) smoke of the same checkpoint at 4×36: +28.5 ± 7.5, test-retest spread 4.16 pp —
  the noise-floor flag works and tiny budgets are honest about their CIs.

**Next:**

- PR `wave0-strength-curve` — Ivan reviews/merges (stopping point per Ivan: one PR per Wave-0
  item, not one big batch).
- Grade the remaining 20 v3 checkpoints on the mini (~3.2 h, `--max-points 0` resumes where the
  acceptance left off) — the first real within-trajectory curve; its test-retest gives negative
  control (2) of PERSONAS §10.5.
- Wave-0 remainder, each its own PR: Holm in `behavior-core.mjs` (item 2), profile-pairing
  script (item 3), #97 probe pre-flight + negative controls (item 5), 3-arm throughput probe
  (item 6, Ivan-gated shodan).

---

## 2026-07-05 (later) — v3 net SHIPPED as Conqueror ([D-31] §5): packed export → `conquerorPolicyWeights.js`, PPO baseline untouched

**Phase:** rollout ([D-31] §5) · **Who:** Claude (Ivan-approved; merge Ivan-gated)

**Did:**

- Ivan closed out the run ops first: schtasks `dicewars-ppo-v3-scratch` deleted; `{ppo.pt, eval/,
RUN_COMMIT, launcher.log}` backed up to the mini (`~/dicewarsjs/ml/runs/ppo-v3-scratch/`,
  sha256-verified) — the first off-shodan copy of the strongest net + the Wave-1 warm-start source.
- Exported `ml/runs/ppo-v3-scratch/ppo.pt` on shodan (repo clean at the run's pinned `464a2ee`) →
  packed `src/ai/conquerorPolicyWeights.js` (103,779 params) + `tests/fixtures/bc/
conquerorForwardCases.json`; pulled both (sha256 match), left shodan's checkout clean.
- **Provenance check:** all 103,779 floats of the shipped packed export are **bit-identical** to
  `eval-020004864.weights.js` — the exact artifact every §4 bar was gated on (maxAbsDiff 0).
- Rewired `ai_conqueror.js` off the `ppoPolicyWeights.js` alias onto its own file; `ai_ppo` keeps
  the frozen v2 `ppo-long` weights as the `ppo:gate` bar. New `npm run conqueror:export` pinned to
  the v3 checkpoint. New `conquerorForward.test.js` (JS↔Python parity, asserts `encodingVersion 3`).
- Test contract inverted deliberately: the old "Conqueror IS ppo-long — identical to `ai_ppo`
  move-for-move" test became (a) a positive pin to `conquerorPolicyWeights.js` move-for-move and
  (b) a **divergence** assertion vs `ai_ppo` (a regression to the shared import must now fail).
- Stale "Conqueror = ppo-long" prose swept: `builtInBots.js`, `aiConfig.js` (Conqueror is now the
  strongest net overall, not Survivor), root `CLAUDE.md`, PERSONAS pilot blockquote, README status.
- Two review agents (determinism + AI-contract) on the diff converged on one functional catch:
  `ml-roundrobin.mjs`'s "PPO ≡ Conqueror same-weights" calibration probe — its premise dies with
  this ship (the Δ is now a real ~+6 pp strength signal), so an adequately-powered `arena:ml`
  would deterministically print a false "harness defect" WARN. **Probe removed** (no same-weights
  pair exists anymore); four sibling scripts' stale "duplicate policy" comments swept.

**Learned / decided:**

- End-to-end strength smoke on the shipped artifact itself (default `ppo:gate`, candidate =
  `conquerorPolicyWeights.js`): **BEAT vs Lookahead +32.0 ± 1.6 pp [30.4, 33.7]** (37.9% vs 5.9%,
  3060 games) — consistent with the eval-checkpoint's +33.9 [32.2, 35.5] (bit-identical weights;
  the drift is unseeded-field noise). The packed module plays at the gated strength; the §4
  verdicts remain the record. Log: shodan `ml/runs/_eval_logs/v3-scratch.20M.ship-smoke.log`.

**Next:**

- PR merge (Ivan-gated), then Wave-0 remainder ([D-29] scorer first) → Wave-1 warm-starts.

## 2026-07-05 — `ppo-v3-scratch` COMPLETE → ALL [D-31] §4 bars PASS: primary (encoding A/B) +6.1 h2h over `ppo-scratch-long`, ship +5.5 h2h over Survivor — the v3 net is the new strongest; ships as Conqueror

**Phase:** 3 → rollout ([D-31] §5) · **Who:** Claude (Ivan away; results check requested)

**Did:**

- Completion check on shodan: the run finished **clean 2026-07-04 20:53 CDT** — exit 0, attempt
  #1, **zero restarts**, 20,004,864 steps in ~31.6 h (~175 fps), actor repacked to `ppo.pt`, full
  per-1M fixtured eval stream through the terminal checkpoint.
- Built PERSONAS §10.7 **Wave-0 item 4** (the head-to-head bar loader): `ppo:gate --bar
Name=weights.js` (+ `--bar-fixture`) parity-checks a bar export and seats it as an extra field
  seat; `buildGateField` gained the optional `barFn` seat + collision guards. 3 new unit tests
  (suite 1373 green, lint/format clean).
- Ran the full [D-31] §4 bar set **locally on the Mac** (zero shodan load), candidate =
  `eval-020004864.*`: floor vs Lookahead **BEAT +33.9 ± 1.6 [32.2, 35.5]**; **PRIMARY vs
  `ppo-scratch-long` BEAT** (initial +7.0 [5.0, 9.1]; fresh-seed §10.2 confirmation at
  `--seedbase 20 --runs 40` = **+6.1 ± 2.2 [3.9, 8.4]** — the reported number); **SHIP vs
  Survivor BEAT** (initial +3.5 [1.2, 5.8]; fresh-seed **+5.5 ± 1.7 [3.8, 7.2]**).
- Filled the strength curve's tail (16M **+30.7**, 19M **+32.3** vs Lookahead) — with 2M/6M/12M
  from yesterday the dip bottoms at ~12M and the tail **rises monotonically to the final
  checkpoint** (+33.9): the candidate is the curve's peak, no winner's-curse rescue needed.
- Archived all seven gate logs to shodan `ml/runs/_eval_logs/` (`v3-scratch.20M.*`,
  `v3-scratch.{16M,19M}.curve.log`). Full tables in `RESULTS.md`.

**Learned / decided:**

- **The encoding was the binding constraint, as [D-31] hypothesized:** same recipe, same budget,
  only the observation changed → +6.1 pp head-to-head over the v2 scratch control. The
  warm-start-fallback arm ([D-31] §3) is moot — never fires.
- **Ship-bar consequence ([D-31] §5):** the v3 net replaces **Conqueror's** weights (packed
  export into `src/ai/`, [D-27] pattern; hidden `ai_ppo` keeps `ppo-long` as the gate baseline;
  the 9-seat gate field keeps its v2 `PPO` seat — era comparability, no row boundary). PERSONAS
  §10.1's conditionality resolves to the full-slate path: every retrain warm-starts from
  `ml/runs/ppo-v3-scratch/ppo.pt`.
- 10-seat h2h fields (bar = extra seat) depress absolute win% — only the paired Δ is judged;
  don't cross-compare those win% columns with 9-seat rows.
- The ship-bar initial (+3.5) vs fresh-seed (+5.5) spread is a reminder the §10.2 fresh-seed
  confirmation isn't ceremony — seed-block luck at 20 runs is ±2 pp.

**Next:**

- **Ship plumbing** ([D-31] §5 / PERSONAS §10.7): packed export of the v3 actor into `src/ai/`
  as Conqueror's weights + export-parity check + PR (Ivan-gated merge, per the auto-mode
  classifier).
- **Wave 0 remainder before Wave 1** (§10.7): [D-29] scorer Phase 1 (hard precondition — one real
  checkpoint scored end-to-end on the mini), Holm in `behavior-core.mjs`, profile-pairing script,
  probe-path pre-flight, A/A + test-retest negative controls, 3-arm throughput probe. Item 4 (the
  weights-loader) is DONE as of this session. Wave-1 launches stay Ivan-gated (`schtasks`).

---

## 2026-07-04 — v3 persona slate designed + pre-registered (PERSONAS.md §10); Predator closure scoped "under the current wire"

**Phase:** post-3 (persona re-batch planning) · **Who:** Ivan + Claude

**Did:**

- Designed the v3 persona wave ahead of `ppo-v3-scratch` finishing, via a 12-agent workflow: six
  extractors over docs/ml-bot/ + the `ml/dicewars_ppo` trainer knobs, three independent slate
  designs (player-experience / training-feasibility / evaluation-rigor lenses), each adversarially
  red-teamed. The three designs **converged on the same core slate**; red-team defects folded in.
- Wrote the full pre-registration draft to **PERSONAS.md §10** — the durable record (slate,
  parameters, signatures, bars, kill-gates, Wave-0 build list, sequencing). Future sessions should
  pick up from there, not re-derive.

**Learned / decided:**

- **Slate:** Conqueror ships the v3 base weights as-is (the −7.6 lesson); Blitz-v3 (win/γ0.99,
  no speed bonus in the primary arm) and Survivor-v3 (placement/γ0.999) retrain at 3M; **Predator
  revives** (placement backbone + low bounty {0.15, 0.25}, 2×1M pilots → 3M winner) riding v3's
  per-edge `eliminatesDefender`; one internal Conqueror-control arm (never ships). **Expansionist
  stays parked** (reward-shape defect — no observation column fixes the [D-30] §7 stock residual);
  a "Berserker" γ0.97 entry-rung wildcard was considered and deferred.
- **Predator finality scoped (Ivan):** a failure closes Predator **"under the current wire"** —
  it falsifies the [D-31] representability hypothesis, not the persona under a fixed
  credit-assignment wire. Rationale: the red-team caught that kill-credit **dilution onto
  turn-boundary frames** is a second live root cause the encoder doesn't touch, so "dead under any
  encoding" would overclaim.
- Key red-team catches now pre-registered: the **clock-hack basin points the other way** for
  placement arms (suicide-before-cap, not stalling — new truncation-rate/late-aggression
  tripwire); the **vulture/scavenging hack** on a newly-legible kill signal (scavenge co-read as a
  ship-blocking sanity check); strength bars must anchor to the **v3 base**, not the v2 `PPO` seat
  (CI-lower-bound > −8 pp vs own warm-start); signatures need **dual controls** (trained control
  arm AND raw base); kills bar restored to ≥15% of the realized comparator (the +0.25 number was
  [D-30]'s interim bar, not the MDE).
- Fine-tune-vs-scratch stance: fine-tune the batch; the one registered scratch trigger is the
  [D-27] follow-up (if Survivor-v3 beats the base again → 20M placement scratch as a v4 question).
- Plumbing gaps found (now Wave-0 items): `arena:ml --bots` takes built-in names only and
  `buildGateField` throws on non-field bar names → head-to-head bars need a `Name=weights.js`
  loader; terminal `turn_number` is logged nowhere (Blitz `--speed-ref` calibration needs a hook,
  and it's in engine-turn units, not the clock column's player-turns); Wave-1 N_ENVS needs a
  3-arm throughput probe first.

**Dead ends / surprises:**

- All three independent designs proposed essentially the same slate — the v2 record (batch-1,
  batch-2/2B, [D-30]) constrains the design space that tightly. The main disagreements were
  eval-side (melee vs profile-pairing for distinctiveness; bar anchoring), all resolved toward the
  rigor lens.

**Next:**

- **Wave 0 (zero GPU, can start now):** [D-29] scorer Phase 1 (hard Wave-1 precondition), Holm in
  `behavior-core.mjs`, the profile-pairing separation script, the weights-loader for head-to-head
  bars, probe-path pre-flight, A/A + test-retest negative controls, throughput probe.
- When `ppo-v3-scratch` finishes (~tonight): run the [D-31] §4 bars (primary vs
  `ppo-scratch-long`, ship vs Survivor); on primary pass, Wave 1 launches per §10.7.

---

## 2026-07-04 — `ppo-v3-scratch` mid-run check: healthy at 12.2M/20M; belated tripwire at 12M = BEAT vs Lookahead (Δ +26.0 pp)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Live health check on shodan: 12.2M/20M steps (61%), still **attempt #1 — zero restarts** in ~19.5h
  since the 2026-07-03 relaunch. Config verified on the running state: `from_scratch=1`,
  `encodingVersion: 3`, `RUN_COMMIT=464a2ee`, checkpoints landing on cadence. Throughput steady at
  174 fps (194 at launch, settled as the league pool filled with net snapshots) → ETA ~9 PM CDT
  2026-07-04. PPO internals sane: explained_variance 0.87–0.90, entropy −0.80 to −0.96 (no
  collapse), approx_kl 0.01–0.02.
- Found the [D-31] §4 **0.5M/1M tripwires were never run** — the run sailed past both marks with no
  eval logged since Jun 30. Ran a belated tripwire instead, at full gate strength, **locally on the
  Mac** (zero cost to the training box): pulled the eval producer's `eval-012000096.weights.js` +
  fixture (the per-1M export, #97 producer) and ran `npm run ppo:gate` on them (20×153, 3060 games,
  parity 6.1e-5).
- **Verdict: ✅ BEAT.** V3at12M win% **34.1 ± 1.6** vs Lookahead **8.1 ± 1.1**; paired Δ
  **+26.0 ± 1.9 pp** [24.1, 27.9]. STOP% 38.5, attack-win% 68.6. Gate log archived to
  `ml/runs/_eval_logs/v3-scratch.12M.tripwire.log` on shodan.

**Learned / decided:**

- The v3 net at 12M is already at ~parity with the shipped v2 `ppo-long`'s FINAL edge over
  Lookahead (+27.7 pp at 20M) with 8M steps still to train — the fixed encoder is at minimum not
  hurting, and the "shows learning, no collapse" tripwire intent is cleared emphatically. (The real
  encoding A/B is still the [D-31] §4 primary bar: head-to-head vs `ppo-scratch-long` at 20M.)
- League `ep_rew_mean` plateauing ~0.15–0.25 says nothing about absolute strength — the PFSP pool
  is a rolling window of the learner's own recent snapshots (7.3M–12.2M at check time), so flat
  reward vs the pool is the expected signature of steady improvement, not stagnation.
- The per-1M eval exports make missed tripwires recoverable after the fact, and a local Mac gate
  run (~7 min) is a free way to probe a live run without touching shodan's CPU.

**Next:**

- Let the run finish (~tonight). Then the [D-31] §4 bars, in order: **primary** — beat the v2
  scratch control `ppo-scratch-long` head-to-head (seat-fair, 95% CI excluding 0); **ship** — also
  beat Survivor head-to-head. Primary pass + ship fail → keep as training base, no reship; primary
  fail → warm-start fallback once ([D-31] §3), then the track closes.
- Optional while waiting: gate a couple of earlier eval exports (2M/6M) to sketch the [D-29]
  strength curve for free from the same producer artifacts.

**Curve-sketch postscript (same day):** gated `eval-002000016` and `eval-006000048` the same way
(local Mac, 3060 games each; logs archived `_eval_logs/v3-scratch.{2M,6M}.curve.log`). Curve vs
Lookahead: **2M Δ +32.4 ± 1.9** [30.5, 34.3] (37.5% vs 5.1) → **6M +27.2 ± 2.2** [25.0, 29.4]
(34.8 vs 7.6) → **12M +26.0 ± 1.9** (34.1 vs 8.1). Readings: (1) the Lookahead bar **saturates by
2M** — it cannot resolve improvement past that point, reinforcing that only the [D-31] §4 primary
bar (vs `ppo-scratch-long`) is a real 20M readout; (2) the mild 2M→6M **decline** (CIs disjoint)
is the classic PFSP signature — early policy max-exploits the weak heuristic-adjacent field, then
the objective shifts toward beating its own ever-stronger snapshots (STOP% 44.8→37.6/38.5 shows it
trading patience for pressure); do NOT read the dip as regression. (3) Cross-campaign caveat: these
are 9-seat fields (personas excluded, PPO seated); the v2 `ppo-scratch-long` +36.3 was an 8-seat
field at `c0d1441` — Δs across field sizes aren't directly comparable, so the +26 vs +36.3 spread
says nothing yet; the head-to-head decides.

---

## 2026-07-03 — Five-agent review of the v3 harness PRs → clock defect found; `turnClockNorm` redefinition + JS hardening PR; `ppo-v3-scratch` killed + relaunched on the fixed encoder

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Ran a five-agent adversarial review over the merged v3 harness PRs (#101–#105). Headline find:
  the [D-31] board clock was **broken as spec'd** — `turnNumberNorm` divided the engine's round
  counter (`turnNumber`, +1 per full-roster wrap) by `DEFAULT_MAX_TURNS = 500`, which caps
  per-PLAYER-TURN `turnCount`. Wrong unit by a factor of ~playerCount: the clock read ~0.13–0.5 at
  real truncation and never saturated where the cap fires.
- Convened a design panel on the fix; decision recorded as the 2026-07-03 amendment inside [D-31]:
  new engine `GameState.turnsTaken` counter (completed player-turns — the cap's unit), copied onto
  `BotState`, encoded as `min(turnsTaken / DEFAULT_MAX_TURNS, 1)`, and **renamed** `turnClockNorm`
  (same column position) so the name-keyed fingerprint test + Python mirrors force conscious
  downstream updates. In-place v3 redefinition (no v4): no v3-trained weights exist.
- Landed the fix in this PR alongside the review's JS hardening items: `bcForward` non-finite
  output gate (kills the silent NaN→argmax-0 zombie-bot mode), `assertPolicyEncodingCompatible`
  strengthened (rejects non-finite declared widths; re-derives the ACTUAL first-layer input widths
  from the weight rows so a lying config can't pass), `computeTurnsUntilActs` + `groupIncome`
  misuse guards, `DEFAULT_MAX_TURNS` propagated to the five scripts that hardcoded 500, and ml-ci
  now triggers on `encodeObservation.js`/`obs-frame.mjs` (the JS side of the wire contract).
- A concurrent sibling PR carries the Python-side hygiene from the same review (train.py / tracer /
  snapshot / migration files — kept file-disjoint from this one).

**Learned / decided:**

- Unit mismatches between counters are invisible to every shape/fingerprint tripwire — the
  fingerprint is name-keyed, so a semantics change MUST rename the column to trip it. That is now
  the precedent ([D-31] amendment).
- The obs_frame_v3 binary goldens are width-only (no names on the wire): regenerating after the
  rename produced byte-identical fixtures, as expected.

**Ops (same day, after the merges):**

- PRs merged Ivan-reviewed: #106 → `11fc455`, #107 → `fd3a869`. (Self-merge and remote `schtasks`
  are auto-mode-classifier-blocked by design — Ivan ran the merges and both `schtasks` commands;
  everything in between was automated.)
- `ppo-v3-scratch` stopped at ~6.6M/20M (`schtasks /end`; WSL processes verified dead), run dir
  archived → `ml/runs/ppo-v3-scratch-stale-attempt2-brokenclock-20260703` (attempt-1 naming
  convention), shodan checkout pulled to `464a2ee`, task re-run. Relaunch verified healthy
  end-to-end: attempt #1 from step 0 (no accidental resume — the state dir went with the archive),
  `--from-scratch` on the live argv, `RUN_COMMIT` = `464a2ee`, the launch log prints the RESOLVED
  `from_scratch=1` (#106's helper doing its job), 12 env-servers + GPU active, first 100k
  checkpoint landed stamped `encodingVersion: 3` (`ckpt-000100008.zip`, ~190 fps holding).

**Next:**

- Tripwires at 0.5M/1M vs Lookahead; primary bar vs the v2 scratch control (`ppo-scratch-long`,
  +36.3); ship bar vs Survivor ([D-31] §4). Bars unchanged by the clock fix.

---

## 2026-07-02 — Observability audit → encoding v3 ([D-31]): owner identity / income / turn order / clock, append-only with v2 slice-compat

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Full audit of what the nets can see vs what a player sees. Found four REPRESENTATIONAL gaps
  (untrainable — the information never reaches the net): owner identity (binary isMine/isEnemy +
  mean-pooled player rows → can't link territories to players, can't see eliminations), income
  economics (largestGroup scalar only — no group membership, bridges, or capture deltas), turn
  order (mean-pool destroys seat order; BotState never carried it), the clock (turnNumber never
  encoded). Retro-explains Batch-2B's 0/4 style bars — Predator was unrepresentable.
- Spec'd + decided [D-31] (5 parts: append-only superset w/ slice-compat, "Standard" feature set,
  scratch-20M training w/ warm-start fallback, layered pre-registered bars,
  ship-flagship-defer-personas). PR #101 landed the inert primitives (`groupIncome.js`
  fuzz-checked vs `findLargestConnectedGroup`, `BotPlayer.turnsUntilActs`, shared
  `DEFAULT_MAX_TURNS`).
- Landed the contract flip: encoder v3 (nodes 8→13, players 6→7, board 5→7, edges 7→10),
  `ENCODING_VERSION = 3`, `SUPPORTED_ENCODING_VERSIONS = [2, 3]` + `assertPolicyEncodingCompatible`
  (guards relaxed at ai_bc/makeBC, league refresh/restore, probe-core), Python mirror in the same
  commit (constants/manifest/policy wording), goldens + wire fixtures regenerated (v3 filenames),
  slice-down proof test (v2 weights bit-identical on padded v3 tensors).

**Learned / decided:**

- The slice-down adapter costs ZERO code in the forward: `linear()` iterates the weight's input
  dim and every concat keeps the variable-width tensor last — v2 nets structurally ignore appended
  columns. The append-only rule is what buys this (and a function-preserving zero-init warm start).
- Income features are node properties gathered onto edges: cutValue/myGain depend only on `to`,
  computed once per node in the shared context — the edge = gathered-node-value identity holds by
  construction.
- test_train's stop-cal in-band test was implicitly coupled to encoding widths (tiny net + random
  fixture corpus); made it deterministic (target 0.5 ± band 0.5 covers [0,1]).

**Dead ends / surprises:**

- Pre-existing, unrelated: `ml/tests/test_export_onnx.py` fails on this Mac's Python 3.9
  (`zip(strict=True)` is 3.10+) — fails identically on master; fine on shodan.

**Ops (same day, after the merge):**

- Throughput probe: worst-case 1,072→1,053 steps/s (noise), realistic 577→521-551 (~5-9% —
  the 4×BC seats now compute groupIncome per move) → GREEN, huge margin (12h ≈ 15-24M steps).
- Launch needed two unblocks, both landed: `dicewars_bc.migrate_encoding` (#103/#104 —
  `--from-scratch` still loads `--checkpoint` for the ARCHITECTURE and v2 ckpts are now
  rejected; zero-widen the four first-layer inputs, function-preserving, self-checked; also
  the [D-31] §4 warm-start-fallback tool) and the launcher's `EXPECTED_ENCODING_VERSION`
  default 2→3. `checkpoints/v3-base/bc_model.pt` created on shodan (self-check passed on the
  real ckpt; the first attempt exposed an fp32 accumulation-order tolerance bug, fixed #104).
- **Launch attempt died to the documented [D-26] bare-ssh trap**: nohup inside WSL does NOT
  survive the ssh session — Windows idles the WSL VM out ~1min after the last session closes
  (attempt #1 EOFError, attempt #2 killed mid-startup, launcher gone with the VM). The
  RUNBOOK §4b Task-Scheduler bridge is the designed fix; registering a scheduled task on the
  box is deliberately left to Ivan (one-time `schtasks /create` + `/run`, see the session
  handoff). Found + fixed while there: the committed bridge didn't forward `FROM_SCRATCH`
  through WSLENV (a scheduled from-scratch campaign was impossible), and note login shells on
  shodan resolve `/usr/bin/node` v12 (nvm lives in interactive rc) — any bridge/wrapper must
  pin the nvm node on PATH.
- Cosmetic: train.py's banner prints a hardcoded "encoding_version==2" string (the guard
  itself is version-correct) — fix opportunistically.

**Next:**

- Ivan: register + start the `dicewars-ppo-train` scheduled task (RUNBOOK §4b) for
  `ppo-v3-scratch` (FROM_SCRATCH=1, 20M, CHECKPOINT=checkpoints/v3-base/bc_model.pt).
- Then tripwires at 0.5M/1M; primary bar vs the v2 scratch control, ship bar vs Survivor
  ([D-31] §4).

## 2026-07-02 — Batch-2B 1M verdict: all four arms BEAT, no style bar cleared → Expansionist PARKED, Predator DROPPED ([D-30] dec. 6 executed)

**Phase:** persona-roster (Batch 2B, wave close-out) · **Who:** Ivan + Claude

**Did:**

- Both waves finished clean overnight (Wave A 21:52, Wave B 02:02 CDT; all four arms `exit 0`,
  attempt #1, zero restarts). Ran the 1M full eval per RUNBOOK §8d off each arm's **fixtured
  final eval-stream checkpoint** (`eval-001001472.*` — no manual export needed): 4×
  `behavior:profile` 6×30 (control + matched comparator) + 4× `ppo:gate` 8×80, all 8 jobs in
  parallel on the idle box (~12 min wall). Full numbers: RESULTS.md → "dense-reward personas
  Batch-2B"; raw logs `ml/runs/_b2c_eval/` on shodan.

**Learned / decided:**

- **Strength: 4/4 BEAT** (c04 +7.7 / c08 +21.3 / b15 +17.3 / b25 +18.2). The [D-30] basin fixes
  worked — no turtle (γ0.99 arms), no bounty-suicide (placement arms). Diagnosis confirmed.
- **Style: 0/4 cleared the pre-registered bar.** Exp: avgTerritory Δ−0.68 (c04, wrong way!) / ns
  (c08), never beyond Blitz — the γ-transformed coef buys tempo, not territory (c08 = a healthy
  Blitz-lite; c04 = strictly worse than Blitz). Pred: kills Δ+0.07/+0.04 ns — bounty has now
  failed at {0.1, 0.15, 0.25, 0.4, 0.7} across two backbones, while bounty-0 Survivor out-kills
  every bounty arm (1.86–1.92). The bounty is a dead lever on this wire.
- **[D-30] dec. 6 executed as pre-committed: Expansionist PARKED, Predator DROPPED.** Roster =
  the shipped three (+ hidden PPO/BC), a complete product. No 3M, no ship plumbing built.
- Surprise worth keeping: PredB15's avgTerritory (+1.83) beat the _Expansionist_ bar — placement
  backbone > territory coef as a hold-territory lever. Any map-painter revival starts there. Also:
  the dec. 5 early-game-territory readout doesn't exist in the profiler (build before any revival).

**Next:**

- Cleanup done: schtasks `dicewars-persona-b2c` + `dicewars-b2c-eval` deleted. Worktree
  `~/dicewarsjs-personas` KEPT (holds all Batch-2/2B checkpoints); shodan main tree still pinned
  `c0d1441` (holds untracked persona exports — un-pinning is Ivan's call).
- Persona track closes at three shipped personas. Active candidates for next effort: strength-curve
  scorer build ([D-29], thread 4) or a second from-scratch seed (the +36.3 replication).

---

## 2026-07-02 — From-scratch 20M run completes & gates: +36.3 (BEATS the +27.7 warm-start headline)

**Phase:** 3 (science follow-up) · **Who:** Ivan + Claude

**Did:**

- The 20M `FROM_SCRATCH=1` run (`ppo-scratch-long`, launched 2026-06-30 via schtasks
  `dicewars-ppo-scratch`, main tree pinned `c0d1441`) finished **clean `exit 0`, attempt #1, ZERO
  restarts**, ~30 h wall at ~183 env-steps/s. Launcher auto-repacked → `ppo.pt`, self-verified reload
  into a bare `EdgePolicyNet`.
- Exported run-local (`export_weights --ckpt runs/ppo-scratch-long/ppo.pt --out
runs/ppo-scratch-long/scratch.weights.js --fixture …/scratch.fixture.json`; NB the `--no-packed`
  flag in the RUNBOOK doesn't exist at `c0d1441` — the export there is already self-contained
  JSON-in-JS, so it drops in with no sibling decoder). Parity **2.5e-5**, 102,787 params.
- Gated with the headline config (`ppo:gate --runs 20 --games 150`, 3040 seat-fair games, 8-bot FFA,
  Lookahead pin `596f781`), overriding `--weights/--fixture` to the run-local export so the shipped
  `src/ai/ppoPolicyWeights.js` (Conqueror = `ppo-long`) was never touched.

**Learned / decided:**

- **Result: 46.7 ± 2.0% vs Lookahead 10.4 ± 1.2%, paired Δ +36.3 ± 2.6 [33.8, 38.9] → ✅ BEAT.**
  That is **+8.6 pp above the BC-warm-started headline (+27.7 [25.0, 30.4])**, and the two 95% CIs are
  **disjoint** — a clean, significant separation.
- **The BC warm-start bought convergence speed, not final ceiling.** With the only variable flipped
  (random init) and everything else identical to the headline, pure self-play from nothing found the
  _stronger_ policy at full budget. Rhymes with the 1M control (+26.9 with no warm-start) already
  matching the 20M warm-start level.
- A distinct **style emerged from random weights**: more aggressive — STOP 42.3% (vs 46.6% warm-start),
  attack-win 71.4% (vs 69.4%).
- **Caveat:** single scratch seed vs single warm-start seed; gate CIs are within-run, so cross-campaign
  run-to-run variance isn't fully separable from the warm-start variable. Direction is unambiguous; gap
  is large.

**Dead ends / surprises:**

- Expected from-scratch to _compete_ (match/approach warm-start); it **exceeded** it. The intuition
  "warm-start = strength prior" was wrong at this budget — it's a speed prior.

**Next:**

- Not shipping: `ai_ppo`/Conqueror keep the `ppo-long` weights. Weights + `gate.log` retained on shodan
  at `~/dicewarsjs/ml/runs/ppo-scratch-long/`. Cleanup: delete schtasks `dicewars-ppo-scratch`, un-pin
  main tree `git checkout master` — **without disturbing the concurrent Batch-2B persona runs**
  (separate worktree `~/dicewarsjs-personas` @ `20e5be5`, task `dicewars-persona-b2c`).
- Open question if revisited: is the +8.6 pp real or seed variance? Would need ≥1 more seed per arm to
  separate — deferred (not blocking anything; personas are the active track).

---

## 2026-07-01 (evening) — Batch-2B Wave A launched; 0.5M tripwire probes PASS (both arms continue)

**Phase:** persona-roster (Batch 2B) · **Who:** Ivan + Claude

**Did:**

- Launched Wave A on shodan at 17:42 CDT off commit `20e5be5` (worktree `~/dicewarsjs-personas`,
  supervisor `/home/ilay/persona_b2c_launch.sh` via one-shot schtasks task
  `dicewars-persona-b2c` — delete after the run): `ppo-exp-g99-c04` (γ0.99, coef 0.04, clip 1.0)
  - `ppo-pred-place-b15` (placement backbone, bounty 0.15), each 1M @ 4 envs, staggered around
    the still-running 20M scratch run. Wave B (`-c08`/`-b25`) auto-chains after Wave A's `wait`.
- Both arms' fixtured `eval-000500000.*` checkpoints landed at 19:46 CDT (the #97 producer works
  mid-run, first live use); ran the [D-30] 0.5M tripwire probes (3×10, 540 matches/arm, control
  Conqueror + matched comparator).

**Learned / decided:**

- **ExpC04 @0.5M — CONTINUE.** All turtle axes clean and pointing the RIGHT way:
  ΔavgDiceReserve −4.2, ΔzeroAttackTurnFrac −0.23, ΔturnsToWin +3.9; winPct 47.8 ≈ control 48.3.
  ΔsurvivalTurn −74.7 nominally crosses the −60 line, but the matched comparator Blitz posts
  −73.1 vs the same control in the same field — a γ=0.99 **backbone** effect, not
  overextension, and there is no co-signal (winPct healthy). Exactly the false-kill the
  matched-comparator rule was added to prevent. Note: at 0.5M ExpC04 profiles ≈ Blitz
  (aggression +0.60 vs Blitz's +0.58); whether the coef adds land-grab **on top** is the 1M
  question (avgTerritory/kills bars, [D-30] dec. 5).
- **PredB15 @0.5M — CONTINUE.** No axis tripped: winPct 56.1 (> control 53.9),
  ΔavgDiceReserve −4.9, ΔturnsToWin +11.5, ΔsurvivalTurn −16.3. Kills 1.60 ≈ control 1.63 — the
  bounty signal isn't visible yet (Survivor itself posts 1.86, so the placement backbone leaves
  headroom); kills Δ≥+0.25 is a 1M/3M bar, not a 0.5M one.
- RUNBOOK §8d probe command fixed: reference comparators by bare built-in name — the
  `ml/runs/ppo-blitz/` export path only resolves from the main tree, not the persona worktree.

**Next:**

- Wave A finishes ~21:50 CDT → Wave B auto-starts; its 0.5M probes are optional overnight
  (abort would only save ~2h of idle-night GPU) — grade everything at the 1M full eval
  (RUNBOOK §8d: export `--no-packed`, behavior:profile 6×30, ppo:gate 8×80, [D-30] bars).
- Delete schtasks task `dicewars-persona-b2c` after the wave completes.

---

## 2026-07-01 — Batch-2 re-pilot resolved: corrected reward mechanics → [D-30] Batch-2B wave (flag-only)

**Phase:** persona-roster (Batch 2) · **Who:** Ivan + Claude

**Did:**

- Reviewed `BATCH2_REPILOT_FINDINGS.md` with a code-grounded multi-agent workflow (4 ground
  surveys over docs + the shaping wire, 3 design lenses — RL theory / pipeline engineering /
  product-roster — each adversarially red-teamed) plus an independent algebraic check of the
  dense reward.
- **Corrected the findings' diagnosis** (now its §7 Addendum): the reward was ALREADY a net flow
  (`env.py:145`), so §5's "stock → flow" fix was a no-op. The real mechanism:
  `coef·ΔΦ = PBRS-invariant + coef·(1−γ)·territory-held` — the residual stock term is the only
  style-relevant signal, and its optimum is turtling, so the coef cliff is **structural**.
  Amplifiers: stalling discounts the inevitable negative deltas; the elimination wipe
  (−coef·T ≈ −1.5…−2.25) dwarfs the +1 win; truncation keeps accrued dense reward while paying 0
  terminal. Predator mirror-image: `win` mode prices death at 0 while the bounty pays now.
- **Recorded [D-30]** — the Batch-2B wave: four 1M flag-only arms off `ppo-long`
  (Exp = γ0.99 + coef {0.04|0.08} + clip 1.0; Pred = placement backbone + bounty {0.15|0.25}),
  fixtured 0.5M probes via the #97 eval producer (`EVAL_EVERY=500000`), symmetric two-basin
  tripwires, matched-backbone comparators (Blitz/Survivor), pre-registered ship bars and
  pre-committed kill criteria (park Expansionist / drop Predator; target roster = 4, shipped 3 is
  complete). Launch mechanics: RUNBOOK §8d.

**Learned / decided:**

- Potential-based-shaping algebra is the right lens for dense-reward failures: any per-step delta
  reward at γ≈1 is ~policy-invariant, so cranking its coef can only amplify the `(1−γ)` stock
  residual — i.e. the turtle. Changing γ changes the OBJECTIVE the delta reward encodes
  (early-weighted average), which is the actual persona lever.
- Red-team catches that saved the wave: league snapshots are fixture-less ([D-22]) so
  mid-run probes MUST come from the eval stream (pre-flight it); every arm changes two knobs vs
  Conqueror, so signatures must be judged against matched-backbone comparators; the findings'
  footprint-gated bounty is dead on arrival (kills only ride the post-opponent-round frame, where
  Δterritory ≤ 0); tripwires need BOTH basins (c15 turtled, b04/b07 suicided — one-sided aborts
  miss the failure the redesign moves you toward).
- `--reward-mode placement` composes with `--elim-bounty` (no exclusivity in
  `validate_reward_args`) — the survival-priced Predator needs zero new code.

**Dead ends / surprises:**

- The findings' own §5 fix list mostly didn't survive review: flow-reward (already implemented),
  per-idle-turn penalty (the [D-19] additive-suicide form), footprint-gated bounty (frame-schedule
  falsified), 0.10–0.12 coef band (structurally unsafe). Rejections recorded in [D-30] so they
  don't come back.
- **Belated LOG note:** the 20M `ppo-scratch-long` control run has been training on shodan
  (pinned `c0d1441`, launched pre-#97 → NO `eval/` stream; boot/task logs in its run dir) without
  a LOG entry — [D-29]'s review spotted the gap. It was verified undisturbed throughout Batch 2.

**Next:**

- Execute RUNBOOK §8d: fast-forward `~/dicewarsjs-personas` to master, pre-flight the probe path,
  launch the wave (staggered 2+2 if the scratch run is still training), probe at 0.5M, grade at 1M
  against the [D-30] bars, and distill Batch-2 + Batch-2B results into RESULTS.md.

## 2026-07-01 — Strength-curve Phase 1 design review ([D-29]) + `ppo:gate` default-name collision fix

**Phase:** strength-curve harness · **Who:** Ivan + Claude

**Did:**

- **Reviewed the Phase-1 scorer design** (STRENGTH_CURVE.md) with a code-grounded multi-agent
  workflow: 3 ground agents (docs / gate code / producer), 3 review lenses (statistics, ML
  methodology, design-ops), every merged finding adversarially verified against the repo
  (11 confirmed, 3 refuted). **Amendments applied to the doc; all five open questions resolved —
  recorded as [D-29]** (in-field references only, per-run arrays + run-paired k=2 regression
  detector, `--watch` mode, mandatory fresh-seed confirmation, failure/provenance/transport
  policies, `runGateSweep` extraction as the prerequisite refactor).
- **Found + fixed a live bug:** since PR #74 seated `PPO` in the gate field (an arrangement
  [D-27] kept), the gate's default `--name PPO` hit the `buildGateField` collision guard —
  **bare `npm run ppo:gate` threw at field construction**. Fix: `DEFAULT_CANDIDATE_NAME = 'Candidate'` exported from
  `ppo-gate-core.mjs`, used by the CLI, pinned against the real registry by a new regression
  test in `tests/scripts/ppoGateCore.test.js`; also fixed the stale "rounded down" comment
  (`Math.round`, 17 seeds × 9 = 153 games/run). Smoke-verified: bare gate now runs (2×18-game
  probe, field `…, PPO, Candidate` — the default run doubles as a same-weights calibration probe).

**Learned / decided:**

- The design's reuse table was right about the primitives but the **sweep orchestration is
  inline in the CLI** (with `process.exit`) — Phase 1 must extract `runGateSweep` first.
- The "CIs disjoint" regression rule is underpowered (~88% against the motivating −7.6);
  run-paired k=2 t-tests on persisted per-run arrays get ~99% at ~5% family-wise FP for free
  (constant seedBase already pairs the runs).
- Constant seedBase ≠ noise-free attribution: 3 field bots are unseeded `Math.random`; shared
  maps ≈ 10% of run variance (estimate — first curve should publish the observed test-retest
  floor).
- Fresh-seed confirmation must offset `seedBase` by **≥ the run count** (offset 1 reuses 19/20
  seed blocks).

**Dead ends / surprises:**

- **The retroactive `ppo-conqueror` curve is feasible after all** — verified on shodan:
  `ml/runs/ppo-conqueror/league/` retains 30 self-contained snapshots (~100k cadence, 0→3M) +
  `manifest.json` (encodingVersion 2), plus the fixtured final export. Needs a manifest→index
  adapter + fixture-waived retro mode. (Also on shodan: `ppo-scratch-long` run dir with task/boot
  logs — launched pre-#97, so it has **no** `eval/` stream; this LOG had no entry for it.)
- Trainer telemetry was never missing: `--log-dir` is always on, so KL/entropy/value-loss/LR sit
  in `tb/` + `progress-*.csv` keyed by timestep — the scorer should point at them on a flagged
  dip, not re-record them.

**Next:**

- Build the Phase-1 scorer per the amended design: `runGateSweep` extraction → tier-1 synthetic
  acceptance test → `--watch` loop → (when shodan frees) the retroactive Conqueror curve.

## 2026-06-30 — Ship the personas: Conqueror/Blitz/Survivor in-game, PPO/BC hidden ([D-27])

**Phase:** persona-roster · **Who:** Ivan + Claude

**Did:**

- **Head-to-head vs `ppo-long`** (`ppo:gate --bar PPO`, 3060 games each) to decide the roster:
  **Conqueror −7.6 BEHIND, Blitz −0.4 TIE, Survivor +8.4 BEAT.** Continuing the win objective off
  `ppo-long` regressed the control; the placement reward (Survivor) produced the strongest net we ship.
- **Wired the player-facing roster (one PR, branch `feat/ml-persona-roster`):** `ai_conqueror`/`ai_blitz`/
  `ai_survivor` modules (the `makeBC({policy})` pattern); **Conqueror reuses `ppoPolicyWeights.js`** (= the
  hidden PPO), Blitz/Survivor ship their own packed weights (re-exported `--repack-js` from the shodan
  checkpoints, parity-verified). `builtInBots.js`: personas added; `PPO`/`BC` flagged `hidden`; personas
  flagged `persona`; new derived `PLAYER_VISIBLE_BOTS`. UI (`ArenaScreen`/`TournamentScreen`) → visible
  list; `aiConfig.js` picker swaps `ai_ppo` out for the three personas.
- **Pinned the gate field:** `buildGateField` + the two duplicate sweep filters now drop `persona` bots, so
  the canonical 8-seat `ppo:gate` table (with `PPO` baseline) is unchanged — RESULTS baselines stay valid.
- **Recalibrated** `DEFAULT_MDE.aggression` 1.0→0.3 (the pilot's measured Blitz effect was 0.42), so Blitz's
  behavioral signature passes. Tests + fixtures for all three personas; `ai_ppo` test's aiConfig assertion
  moved to `ai_conqueror`. `npm run blitz:export`/`survivor:export` added.

**Learned / decided ([D-27]):**

- The "balanced" slot stays as strong as today because **Conqueror = `ppo-long`** — we ship the strongest
  balanced net under a friendly name rather than the weaker fine-tune. `hidden` (player visibility) and
  `persona` (gate exclusion) are orthogonal flags; PPO is hidden-but-in-gate, personas are visible-but-not.
- 12-bot whole-field matches run fine (no engine player cap); Survivor is not a turtle (attacks plenty), so
  the field-health invariant holds.

**Next:**

- Open PR; let CI/tournament pick up the personas. The **placement-reward strength finding** earns a look at
  whether a placement-shaped retrain should replace the main `ai_ppo`. **Batch 2** (Expansionist + Predator)
  still queued — this pilot calibrated its MDEs.

---

## 2026-06-30 — Reward-persona pilot: 3 flag-only personas trained + evaluated (Conqueror / Blitz / Survivor)

**Phase:** persona-roster · **Who:** Ivan + Claude

**Did:**

- Launched + completed the **first persona batch** on `shodan`: Conqueror (win γ0.999, control),
  Blitz (win γ0.99), Survivor (placement γ0.999) — each warm-started from `ppo-long/ppo.pt`, 3M steps,
  `lr 1e-4`, **concurrently** (~175 fps each, ~4.7 h wall, all clean `exit 0`, attempt #1). shodan was
  updated to master `71b9e82` first; launched via the teardown-immune `dicewars-persona-pilot` schtasks
  job, deleted post-run.
- Exported all three (forward parity ≤ 2.1e-5), ran `ppo:gate` (strength) + `behavior:profile` (style).
  Full numbers + tables → RESULTS.md ("reward-PERSONA pilot" section).

**Learned / decided:**

- **Strength: 3/3 BEAT Lookahead** (paired Δ Conqueror +13.0, Blitz +20.3, Survivor +29.7; 9-bot field
  incl. a `ppo-long` seat) — the warm-start held, no collapse under reward-shaped fine-tuning.
- **Style: genuinely distinct.** Survivor signature PASS (avgPlacement↓ Δ−0.82); Blitz signature FAIL
  **only** because the placeholder aggression MDE (1.0) exceeds the real effect (0.42) — turnsToWin↓
  Δ−16.8 cleared easily, dice-reserve Δ−19.1, survivalTurn Δ−59.8. → recalibrate aggression MDE to ~0.3
  (then Blitz passes). This pilot **is** the MDE calibration the harness placeholders were waiting on.
- **Surprise: placement-reward (Survivor) is the STRONGEST and the win-reward control (Conqueror) the
  WEAKEST** — replicated across two independent fields (gate + profile). Dense placement signal probably
  trains better than sparse win/loss in 3M steps. Possible lever for the main `ai_ppo`, pending a clean
  `ppo-long` head-to-head.

**Dead ends / surprises:**

- WSL teardown bit again pre-launch (tmux + `Start-Process` both reaped on SSH disconnect) — only the
  Windows scheduled task survives. Already in the shodan memory card; re-confirmed the hard way.
- Blitz's AND-signature failing despite an obvious style shift = the harness's placeholder MDEs were
  guesses; the gate is only as good as its calibration.

**Next:**

- Ship call (D-27, Ivan's): Survivor = clear winner; Blitz = ship after MDE recalibration; Conqueror =
  control. Wire winners as `ai_<persona>` (PR #74 pattern).
- Batch 2: Expansionist + Predator (dense rewards, bite G) — calibrate `--territory-reward-coef` /
  `--elim-bounty`, env-smoke `--reward-shaping`, launch the same schtasks way.
- Optional: land calibrated `DEFAULT_MDE`s in `behavior-core.mjs`; run the placement-reward vs
  `ppo-long` head-to-head.

---

## 2026-06-30 — Shrink + lazy-load the in-browser net weights (issue #51)

**Phase:** 3 · **Who:** Claude
**Did:**

- **Packed weight format.** `export_weights.py` now emits the ~102k-param net as one base64
  little-endian Float32 blob + a shape descriptor (default `--packed`), wrapped as
  `export const BC_POLICY = unpackPolicy({…})`. New runtime decoder
  `src/ai/unpackPolicyWeights.js` rebuilds the _identical_ materialized object — nothing
  downstream (`forward`/`makeBC`/parity loaders/league snapshot loader) changes. Regenerated the
  two shipped files via the new `--repack-js` mode (no checkpoint needed): `bcPolicyWeights.js`
  2,109,608 → 549,170 B, `ppoPolicyWeights.js` 2,093,408 → 549,114 B (~74% smaller; **decoded
  weights verified bit-identical** to the originals). Fixtures untouched — float32 round-trip is
  lossless, so `bcForward`/`ppoForward` parity still passes against the existing reference logits.
- **Off the eager critical path.** `App.jsx` now lazy-loads `ArenaScreen` + `TournamentScreen`
  (the only eager importers of `builtInBots → ai_bc/ai_ppo → weights`). Eager `index` chunk
  **4,152 kB → 114 kB** (gzip 1,897 → 37); the weights live in a lazy chunk fetched only when a
  player opens Arena/Tournament or faces PPO in-game.
- PPO-league snapshots keep the self-contained `--no-packed` JSON (they're written to a transient
  run dir with no decoder sibling). Updated `snapshot_callback.py`, `test_export_weights.py`, added
  `tests/ai/unpackPolicyWeights.test.js`.
  **Learned / decided:**
- base64 inflates the 411 KB float32 binary to ~549 KB of text (the LOG's earlier "≈410 KB" was the
  raw binary). Still a big win raw + gzip, and the lazy split is what actually removes it from every
  page load. ES-module-friendly + keeps the synchronous-import contract; a raw `.bin` + `fetch()`
  would break sync-at-module-load and every Node/test importer.
- A packed module `import`s its sibling decoder by relative path, so packed exports must land in
  `src/ai/`. The exporter fails loud (sibling-existence check) rather than emitting a module that
  would `Cannot find module` at load.
  **Next:**
- Optional follow-up: split `makeBC` into a weight-free module so the in-game PPO lazy chunk doesn't
  also drag the BC weights (~0.5 MB). Deferred — it'd change `makeBC()`'s `BC_POLICY` default
  (asserted by `ai_bc.test.js`) and touch league-snapshot semantics; not worth it for a chunk that's
  already off the eager path.

---

## 2026-06-30 — Dense-reward wire for Expansionist + Predator (bite G)

**Phase:** persona-roster (training half) · **Who:** Ivan + Claude

**Did:**

- Shipped **bite G**, the last build before the persona batch: the two DENSE personas
  (**Expansionist** = net Δterritory/turn, **Predator** = elimination bounty) are now runnable.
- **Wire (one lockstep commit, JS + Python):** an opt-in **shaped obs-frame** — `HEADER_STRUCT_SHAPED`
  (`<11iffi`, +8 bytes = `deltaTerritory` f32 + `elimsByLearner` i32) — in `scripts/lib/obs-frame.mjs`
  - `dicewars_ppo/{constants,wire}.py`. Off by default ⇒ byte-identical to today (the B5/B6 pattern).
- **Env-server:** `--reward-shaping` flag + a testable `scripts/lib/ppo-reward-shaping.mjs` tracker
  (per-episode NET territory delta off `botState`; learner-attributed kills via the `onTurn` hook —
  eliminations during a turn where the learner is the acting seat, so the game-ending kill counts).
  Emits the shaped header on obs + terminal frames when enabled.
- **Trainer:** pure `env.step_reward` (mirrors `terminal_reward`) + `DiceWarsEnv` coefs
  (`territory_reward_coef`/`elim_bounty`/`shaping_clip`) that flip it to parse shaped frames AND set the
  `reward_shaping` server kwarg; CLI flags `--territory-reward-coef`/`--elim-bounty`/`--shaping-clip` +
  reward-objective provenance in the export metadata. **Launcher:** `PERSONA={expansionist,predator}` +
  the WSLENV bridge.
- **Tests:** 219 `tests/ml` JS green (shaped round-trip, tracker, mismatch guard); 104 affected
  torch-free Python tests green (wire parity + mismatch, `step_reward`, real-`step()` dense path,
  argv/launcher forwarding). Shaped golden fixture regenerated.

**Learned / decided ([D-28]):**

- The load-bearing call: the dense signal is a **reward measurement, not an observation feature**, so it
  rides the frame HEADER (which the net never sees) — **NOT an `ENCODING_VERSION` bump**. Bumping it
  would have rejected the `ppo-long` warm-start + BC/PPO weights via the load guards, for a change that
  doesn't touch the net's input. Observation version stays 2.
- Raw measurements on the wire, weights in the trainer — retuning a persona is a flag, never a JS edit.
- Dense reward is paid every step **including the terminal** (unlike the terminal OUTCOME reward), so
  Predator's winning kill and the final territory delta aren't dropped.

**Dead ends / surprises:**

- **CRITICAL bug the unit tests missed, caught by an adversarial multi-agent review:** Predator's kill
  attribution was silently DEAD. `runSelfPlayEpisode`'s `terminateOnElimination` wrapper (`guardedOnTurn`
  in `ppo-env.mjs`) forwarded only `(turnCount, state)` to `onTurn`, dropping the 3rd arg
  `currentPlayerId`. That was harmless pre-bite-G (the old `onTurn` was the arg-less `failIfLost`), but
  my env-server `onTurnFn` reads the seat → it got `undefined`, so `recordTurn`'s `byLearner` check was
  always false and `elimsByLearner` was identically 0 — a Predator pilot would have trained as a no-op
  baseline and wasted the GPU run. The tracker UNIT tests passed because they call `recordTurn` with an
  explicit seat, never through the wrapper chain. Fix: `guardedOnTurn` now forwards `currentPlayerId`;
  added two regression tests in `ppo-env.test.js` (the wrapper delivers the seat; the real tracker
  credits ≥1 kill on a winning episode). Lesson: a per-frame contract needs an INTEGRATION test through
  the real wrapper, not just a unit test of the leaf.
- The `recv_frame(..., shaped=…)` signature change broke the 2-arg monkeypatch in `test_ppo_env_unit.py`
  — fixed the harness lambdas to swallow the kwarg (caught before the test run).
- Pre-existing: this Mac's system Python is 3.9, so `test_export_onnx.py`'s `zip(strict=True)` fails (6) —
  unrelated to bite G; the sb3-gated train tests skip here and run on CI/shodan.

**Next:**

- Launch the 3 flag-only personas + Expansionist + Predator on shodan (collision-free batch); calibrate
  the dense coefs from the first run; profile via `behavior:profile` and write the first persona rows to
  `RESULTS.md`. The roster framework-acceptance decision (D-27?) stays open until the batch profiles out.

## 2026-06-29 — Persona launcher: the `PERSONA` knob (bite F)

**Phase:** persona-roster (training half) · **Who:** Ivan + Claude

**Did:**

- **Built the persona launcher** — the last thing blocking the persona _training_ track. Grounded
  first: the bite-D reward flags (`--reward-mode`/`--terminal-speed-bonus`/`--speed-ref`) are already
  wired + validated in `train.py`/`_train_common`/`env.py`, but the production shodan launcher
  `scripts/shodan/ppo-train.sh` (committed pre-bite-D) did **not** forward them and was single-run.
  Added a **`PERSONA={conqueror,blitz,survivor}`** knob (top of the launcher, before the `RUN_NAME`
  default): each persona `:=`-defaults the reward objective (mode / `GAMMA` / optional speed bonus) +
  a `RUN_NAME` + a warm-start `CHECKPOINT=runs/ppo-long/ppo.pt`. Factored the `python -m
dicewars_ppo.train` argv into `build_train_argv` (now forwards the three reward flags) so a slim
  `run_once` calls it. The `log` line records the persona/reward config; the USAGE header + RUNBOOK
  §8 carry the batch recipe. `ppo-train.cmd` forwards `PERSONA` (+ per-run knobs) into WSL via
  `WSLENV` so a per-persona schtask needs no file edit.
- **Targeted the first batch at Conqueror + Blitz + Survivor** (Ivan's call) — the three personas
  runnable with **no wire change** (bite D); Expansionist/Predator wait on the dense-reward wire
  scalar ("bite G"). Conqueror is the matched control; Blitz lowers `GAMMA` to 0.99 (the tempo lever,
  PERSONAS §5); Survivor uses `--reward-mode placement`.
- **TDD:** 9 new lean-tier tests in `test_ppo_train_launcher.py` (source-and-inspect the resolved
  config + the assembled argv, no python/torch/GPU): the byte-identical no-persona default, each
  persona's reward objective + warm-start checkpoint, explicit-override-beats-preset, unknown-PERSONA
  exit, conditional `--speed-ref`, from-scratch survives the refactor, and a `.cmd` WSLENV canary.
  Launcher suite 6→15 green; `bash -n` clean; ruff clean; the `EXIT_POINTER_REJECTED` contract canary
  still passes.
- **Corrected a factual error in PERSONAS.md** found while grounding the warm-start: the "warm-start
  critic note" claimed a Survivor inherits `ppo-long`'s win-trained value head. It does **not** —
  `MaskableEdgePolicy._build` always makes a **fresh** scalar `value_net`, and the repacked actor
  carries only `bc_net` (trunk + edge-head), never a critic. Rewrote the note: the PPO critic starts
  uncalibrated for **every** warm-start (BC or PPO), Conqueror included.

**Learned / decided:**

- **The whole persona mechanism is the `PERSONA` knob + the existing env vars.** Because the launcher
  was already fully env-parameterized (`RUN_NAME`/`GAMMA`/`CHECKPOINT`/…), and reward is computed
  Python-side in `env.step()` (the wire is untouched), no new training code was needed — just
  forwarding three flags and a preset table. Personas warm-start from `runs/ppo-long/ppo.pt` (a
  repacked BC-format actor) exactly as `ppo-long` warm-started from `bc_model.pt`.
- **Concurrency is collision-free for free:** each env-server binds an OS-assigned ephemeral port
  (`--port=0`) — already true _within_ a run's N `SubprocVecEnv` workers — and every dir is keyed on
  `RUN_NAME`, so 3 personas share only the GPU + the read-only BEAT actor. Three runs cost ≈ one.
- **`set -e` gotcha (caught by the TDD):** a trailing `[ … ] && arr+=(…)` whose test is FALSE returns
  non-zero, which made `build_train_argv` exit 1 and abort the launcher (4 tests caught it before any
  shodan run). The original `run_once` was safe only because the `&&` wasn't its last statement.
  Switched the conditional appends to `if` blocks.

**Dead ends / surprises:**

- The Windows/WSL schtasks-per-persona path can't be unit-tested locally (no cmd.exe); pinned the
  `.cmd`↔launcher coupling statically (WSLENV-forwards-`PERSONA` grep canary) and documented the
  realistic first-batch path as **3 backgrounded `nohup` runs in one WSL session** (the runs are
  short specialization passes, same-day), with schtasks as the reboot-surviving upgrade.

**Next:**

- Open the PR; on merge, on shodan: confirm `runs/ppo-long/ppo.pt` is present, launch the 3-persona
  batch (`TIMESTEPS≈3M`, a lower `LR` to protect the warm start — calibrate from the first run), then
  gate (`ppo:gate`) **and** profile (`behavior:profile`, persona-named export) each, recording win% +
  the behavioral signature in `RESULTS.md`. Ship the fun ones via the `ai_ppo` wiring pattern (PR #74).
- Still separable: **bite G** (dense-reward wire scalar → Expansionist/Predator) and the Phase-2b
  eval-harness follow-ups (Holm, determinism enforcement, `--melee`, `--csv`, curve/border axes).

---

## 2026-06-29 — Behavioral-eval harness can gate a persona (PR #80, "bite E1") — MERGED

**Phase:** persona-roster (eval half) · **Who:** Ivan + Claude

**Did:**

- **Reviewed + merged PR #80** — the first slice of the _eval half_ of the reward-persona roster
  ([PERSONAS.md](./PERSONAS.md) / [EVAL_HARNESS.md](./EVAL_HARNESS.md)). It closes the two gaps that
  blocked gating a freshly-trained persona: (1) **weight-file bot loading** — `--bots`/`--control`
  accept `Name=path/to/weights.js`, dynamic-imported + parity-checked via the same
  `loadExportedPolicy → makeBC` path `ppo:gate` uses (`parseBotSpec`); (2) the **signature PASS/FAIL
  verdict** surfaced in console + JSON (`signatureDetail`, which `signaturePass` now delegates to),
  plus `--mde axis:value,…` MDE calibration (`parseMdeOverrides`). So **EVAL_HARNESS Phase 2a is
  BUILT + MERGED** (squash `8de26c9`); the §8 persona rows are runnable the moment the weight files
  exist — no harness code change needed.
- **Review-hardened before merge.** A 4-agent PR review (code / silent-failure / tests / comments)
  flagged one real issue, independently confirmed by 3 of 4: `parseMdeOverrides` accepted an
  explicit `--mde axis:0`, which makes `|Δ| ≥ 0` always true in `signatureDetail` — silently
  collapsing the signature gate to a bare significance test (the exact "trivially-significant pass"
  the missing-MDE throw exists to prevent). Fixed to reject **non-positive** MDEs. Also added a
  **fail-fast** pre-sweep MDE-coverage check (a missing MDE on a profiled persona now exits cleanly
  before the multi-minute sweep instead of throwing an uncaught stack after it), kept `err.stack` on
  unexpected loader failures, and de-staled the "Phase 1 / Phase-2 stub" comments + a doc line-ref.
- **Verified:** a 4-lens adversarial workflow (gate-completeness / regression / comment-doc /
  test-quality) returned **all clean**. `behaviorCore` tests 42→46 (0-MDE rejection, a positive
  multi-axis AND pass, two `parseBotSpec` empty edges) + a new spawn-based
  `tests/scripts/behaviorProfile.test.js` (6 fast pre-sweep CLI exit-code cases). **Full suite 1215
  green**; CI green; lint + prettier clean.

**Learned / decided:**

- The eval harness is now **decoupled from the personas**: it's a finished, gated measurement tool
  waiting only on the persona weight files. Naming a weights bot after a `PERSONA_SIGNATURES` key
  (e.g. `Blitz`) is what opts it into that persona's gate — the display name _is_ the signature key.
- An MDE of `0` is never legitimate here (every axis whose MDE is consulted is a confirmatory
  signature axis), so the calibration path rejects it outright rather than treating it as a
  "significance-only" mode.

**Next:**

- Train the persona PPO nets (the **reward-persona roster** proper) so the harness has weight files
  to gate. Then the **Phase 2b** harness follow-ups remain separable: Holm adjustment, §3.6
  determinism enforcement, the §3.8 training-field-match assertion, the §3.5 `--melee`
  persona×persona matrix, `--csv`, and the territory-curve/border-exposure axes.

---

## 2026-06-29 — 🏁 The 20M PPO long run BEATS Lookahead (Δ +27.7) — the headline result; weights merged-prep

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Ran the full shodan campaign end-to-end (§1–§5 of `scripts/shodan/RUNBOOK.md`).** §1/§2 (2026-06-28):
  pinned shodan to `c0d1441` (detached HEAD), CUDA-safe install (`pip install -e . --no-deps` +
  `tensorboard` — torch stayed `2.12.1+cu130`, `cuda=True`, zero re-resolve), the BLOCKING resume
  checklist **96 passed** (incl. the GPU-only CUDA-RNG-restore test + both PR-6 corrupt-zip-fallback
  tests), env e2e smoke 2 passed, turtle floor 95.0%/92.5% R=3 GREEN.
- **§3 from-scratch control (1M, `FROM_SCRATCH=1`)** via schtasks `dicewars-ppo-control` → clean `exit 0`,
  ~85 min, attempt #1. Exported to a scratch path (NOT the committed weights) + gated: **PPO 40.0% vs
  Lookahead 13.1%, paired Δ +26.9 [23.8, 30.0] → ✅ BEAT.** A from-scratch BEAT **resolves task-A's
  fixed-field-exploitation caveat** — the pipeline produces real PPO learning, not artifact memorization.
- **§4 long run (20M, BC warm-start from `v2-base`)** via schtasks `dicewars-ppo-long`, R=3 PFSP league,
  production HPs. **Completed clean `exit 0`, attempt #1, ZERO restarts / pointer halts**, ~29 h @
  ~190 env-steps/s (`n_envs=12`); `explained_variance` ~0.86–0.91 throughout. Launcher auto-repacked the
  actor → `ml/runs/ppo-long/ppo.pt`, self-verified export-ready (reloads into a bare `EdgePolicyNet`).
- **§5 export + gate (the headline).** `export_weights --ckpt runs/ppo-long/ppo.pt` → `ppoPolicyWeights.js`
  (102,787 params, **JS↔Py parity 1.9e-5**) + regenerated `ppoForwardCases.json`; `npm run ppo:gate`
  (3040 seat-fair games, 440.5 s): **PPO 40.4 ± 1.6% vs Lookahead 12.7 ± 1.4%, paired Δ +27.7 ± 2.7
  [25.0, 30.4] → ✅ BEAT** (PPO STOP 46.6%, atk-win 69.4%).
- **Merge-prep (this PR).** Transferred the new weights + fixture shodan→Mac over a sentinel-extracted
  base64 channel, **sha256-verified byte-identical** (`f6be9b91…` / `0a10847d…`), replacing the committed
  task-A weights (`1a754eef…`) in `src/ai/ppoPolicyWeights.js`. Verified the encoder did not drift between
  the training pin `c0d1441` and master (`encodeObservation.js`/`ai_bc.js`/`bcForward.js`/`ml/` unchanged;
  only `ai_ppo.js` was added by PR #74). Updated RESULTS.md + this LOG + the README dashboard.

**Learned / decided:**

- **The D-7 headline BEAT gate is MET at full budget with a held-out-general PFSP league** — not just the
  task-A fixed field. The from-scratch control (+26.9) and the 20M warm-start run (+27.7) are mutually
  corroborating: the edge is genuine RL learning, ~31 pp above the canonical BC-anchor (−3.7).
- **`ai_ppo` is decoupled from its weights (PR #74):** swapping `ppoPolicyWeights.js` ships the stronger
  bot with no code change — the bot wiring + the `ai_ppo ≠ ai_bc` divergence test carry over unchanged.
- The launcher's auto-restart / pointer-halt safety net was never exercised (attempt #1, 0 restarts across
  both runs) — the resume core stayed dormant, exactly the happy path it was built to make safe.

**Dead ends / surprises:**

- Real-policy throughput is ~190 env-steps/s (`n_envs=12`), not the stub-probe's ~200 fps × parallelism —
  the 20M run took ~29 h vs the ~28 h ETA. Bounded by the SB3 learner loop, as [D-24]/B5 predicted.

**Next:**

- **Merge** this weights-swap PR (paused for Ivan's review — it changes the live `ai_ppo` bot for everyone).
- Housekeeping: finished schtasks (`dicewars-ppo-long`, `dicewars-ppo-control`, `-gate`) can be deleted.
- PR-7 = the deferred test-hardening. Reward-persona roster (PERSONAS.md / EVAL_HARNESS.md) is the next
  exploration once the headline is shipped.

---

## 2026-06-28 — Task C/E PR-6 review + hardening pass (PR #73)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Multi-agent review of PR #73** — 6 specialist reviewers (code/silent-failure/tests/comments/types) + a 4-slice adversarial-verification workflow (bash launcher / Windows `.cmd`+XML / Python error-handling / test+docs). No critical/important defects in the core logic; the verifiers re-derived it correct (empirical `bash -n` on bash 3.2 **and** 5, hand-traced the restart loop, `py_compile`, full `FileNotFoundError`-path analysis). Findings were a high-value silent-failure + a set of accuracy/observability minors.
- **Fixes applied (all landed):**
  - **Preflight now asserts `torch.cuda.is_available()` when `DEVICE=cuda`** — SB3's `get_device('cuda')` SILENTLY falls back to CPU when CUDA isn't visible, so a `cuda` run could burn the whole budget on CPU while logging `device=cuda`. The RUNBOOK/XML already PROMISED this halt; now it's real. (The single true silent budget-burner the review found.)
  - **`log()` got `|| true`** so a `tee` failure (broken pipe on a disconnected job / full disk) can't pre-empt the deliberate exit codes under `set -e`/`pipefail`.
  - **New `EXIT_CRASH_LOOP=4`** (distinct from `EXIT_POINTER_REJECTED=3`); `ppo-train.cmd` maps BOTH 3 and 4 → `exit /b 0` so Task Scheduler `<RestartOnFailure>` never re-amplifies a deliberate halt (a no-progress crash-loop was otherwise ~Count×MAX attempts). `.cmd` also gates `exec` on `cd … || exit 1`.
  - **`train.py` resume now HALTs on `FileNotFoundError` too** (a VALID-then-vanished `latest.json` TOCTOU) — it used to escape as a generic exit → launcher retry → next classify reads ABSENT → silent restart-from-0.
  - **`resume_state.py`:** separate warn-once flags for the dir-fsync-unsupported vs open-failure degrades (so the benign macOS one can't mask the serious one); `_safe_unlink` → stderr + `WARNING:` prefix.
  - **Comment-rot fixes:** `train.py`/`resume_state.py` lines still describing PR-5's "warn + fresh"/"loud fresh-start" on a rejected pointer → corrected to the PR-6 HALT.
  - **New `ml/tests/test_ppo_train_launcher.py`** (6 lean-tier tests): source the launcher and drive `main()`'s restart-loop dispatch with stubs (halt-on-3, exit-on-0, bound-on-N-no-progress, **progress-resets-the-fail-counter**, transient-retry-then-success) + a `.cmd`↔`.sh` exit-code canary pinning the `=="3"`/`=="4"` branches.

**Learned / decided:**

- **The launcher's exit-code DISPATCH (not just the constant) needed a CI pin.** The PR-5 canary only matched the `EXIT_POINTER_REJECTED` _value_; nothing tested that the launcher _acts_ on it, nor that `ppo-train.cmd`'s hard-coded `=="4"` tracked `EXIT_CRASH_LOOP`. The new bash-sourcing test + the `.cmd` canary close both, and run torch-free in the lean tier.
- **Doc promises must be code-enforced.** "preflight HALTs if the GPU isn't visible" was aspirational until this pass — exactly the silent-CPU-burn this campaign guards against.
- Verification: `ruff check .` clean; full ml suite **204 passed / 5 skipped** (the 5 sb3-gated suites; the 6 `test_export_onnx.py` failures are still this box's Python 3.9.6 `zip(strict=True)`, untouched); `bash -n` clean.

**Next:**

- Unchanged from the PR-6 entry below: on shodan, the BLOCKING PR-5 validation checklist + from-scratch control run → long BEAT run gated vs `ai_lookahead@596f781`. PR-7 = deferred test-hardening (incl. now: lazy-import sb3 in `train.py` so the fake-driven HALT/reap tests run in lean CI; the optional WSL exit-code-propagation sentinel).

---

## 2026-06-28 — Task C/E PR-6 (committed shodan launcher + schtasks runbook + auto-restart safety guard)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Pre-flight readiness pass first** (per Ivan): repo green on `master` — `npm test` 1158/1158, lint/build exit 0, ml torch-free pytest 185 passed (the 6 `test_export_onnx.py` failures are this Mac's Python 3.9.6 hitting `zip(strict=True)`, a 3.10+ feature — not a regression, not in the PR-6 path). A 5-reader + synthesis workflow over PLAN/LOG/DECISIONS/code/tests pinned PR-6 = the committed shodan launcher + schtasks runbook, with PR-4 (#71) + PR-5 (#72) confirmed MERGED on `master`.
- **Launcher `scripts/shodan/ppo-train.sh`**: owns the task-A BEAT production HPs (`--lr 2.5e-4 --ent-coef 0.01`), sizes `--n-envs` to cores under `SubprocVecEnv(forkserver)`, wires BOTH resume halves with matching dirs (`--state-dir`/`--checkpoint-every` + `--league-state-dir`/`--snapshot-store=disk`/`--league-dump-every`, `R=3`), pins `ENCODING_VERSION=2` + the commit for the whole campaign (HALTs on drift), TB + per-session CSV. Bounded auto-restart loop: relaunch the SAME command (HOLE-D caps the absolute budget) on a transient crash; HALT+alert on `EXIT_POINTER_REJECTED` or N consecutive **no-progress** failures (a checkpoint-step advance resets the counter).
- **Windows→WSL bridge** `ppo-train.cmd` + importable Task Scheduler `ppo-train-task.xml` (LogonTrigger + BootTrigger, InteractiveToken for WSL GPU) — the only disconnect+reboot-surviving pattern. Operator `RUNBOOK.md` covers the BLOCKING PR-5 shodan validation checklist, the from-scratch control run (sequenced first), launch/monitor/recovery, and the [D-24] kill gate (`ppo:gate` win% Δ vs `ai_lookahead@596f781`, 95% CI lower bound > 0; turtle floor ≥ 60% decisiveRate).
- **Auto-restart safety guard (code half, folded into PR-6).** `train.py` now HALTs with `EXIT_POINTER_REJECTED=3` on a present-but-rejected `latest.json` (was PR-5's loud-warn+fresh) — the three-way resume/fresh/HALT policy is a pure torch-free `resume_action(reason)` in `resume_state.py` (CI-tested). `load_resume_checkpoint` falls back across the retained `keep=N` SAME-build older pairs on a corrupt newest `.zip` (torch-free `resume_candidate_pairs` orders them), raising `ResumeCheckpointError` → the same HALT only when ALL retained pairs are unreadable.
- **Verification:** ruff clean on all touched files; `test_resume_state.py` 37 green locally (6 new `resume_candidate_pairs`/`resume_action` tests); `bash -n` clean. sb3 corrupt-`.zip` fallback + all-corrupt tests added to `test_resume.py` (shodan-only). Docs updated (PLAN/DECISIONS PR-4/PR-5 "DONE locally" → MERGED #71/#72).

**Learned / decided:**

- **The PR-5 "loud warn + fresh" on a rejected pointer is right for an attended run but wrong unattended.** Under the schtasks auto-restart it silently re-burns the full `--timesteps` budget from step 0 — so PR-6 evolves it to **HALT + alert** (a distinct exit code the launcher treats as do-not-retry). This is a deliberate supersede of PR-5 review-decision (b), not a contradiction.
- **The corrupt-`.zip` fallback is distinct from the keep=2 fallback PR-5 (b) refused.** PR-5 (b) refused to silently skip to keep=2 for _version/encoding-skew_ (genuinely incompatible) ckpts — PR-6 still HALTs on those. PR-6 only rolls back across SAME-build older pairs when the newest `.zip` BYTES are torn (a case (b) flagged "revisit if it bites"). Both meet at the same HALT for the incompatible case.
- **Keep the highest-consequence decision in the torch-free tier.** `resume_action` + `resume_candidate_pairs` are pure and CI-tested, mirroring `classify_latest_pointer` — the sb3 `resume.py`/`train.py` halves stay thin (and shodan-only).

**Dead ends / surprises:**

- The readiness workflow's code-reader agent hit the structured-output retry cap; the synthesis agent + I read `train.py`/`resume.py` directly to fill the gap (and to verify the two unguarded failure modes that motivated folding the safety guard into PR-6).
- This Mac has no Python ≥3.10 and no `sb3_contrib`, so the sb3-coupled resume tier (including the new corrupt-`.zip` tests) runs only on shodan; locally only the torch-free tier validates.

**Next:**

- On shodan: install/activate `[rl]`, run the PR-5 validation checklist + the new sb3 resume tests, then the from-scratch control run, then launch the long BEAT run at `R=3` and gate per [D-24].
- PR-7 (deferred): env-server `main()` persistence integration test; live cross-worker `SharedDiskStore`; live forkserver two-half resume smoke.

---

## 2026-06-28 — Task C/E PR-5 review-hardening (corrupt-sidecar degrade, CI-testable resume decision, GC orphan-sweep)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- Ran the comprehensive PR review (`/review-pr`) on the committed PR-5 diff (#72) — 4 parallel lenses (code / silent-failure / tests / comments). Implemented the actionable findings on the same branch (`ml-bot/task-ce-pr5-resume`), then adversarially re-verified the fixes with a 3-lens workflow over my own diff.
- **Corrupt RNG sidecar now DEGRADES, not aborts** (`restore_rng_sidecar`): `MaskablePPO.load` has already restored policy+optimizer+`num_timesteps` before the sidecar is read, so a torn/bit-rotted sidecar warns + continues with a FRESH RNG stream instead of bricking a fully-recoverable resume (which under the PR-6 auto-restart would be a PERMANENT crash-loop). CI + shodan regression tests.
- **GPU-resume blocker now locked in LEAN CI**: the CPU-pinning invariant is CPU-observable, so a `map_location` spy (`test_load_rng_sidecar_always_maps_to_cpu`) pins it without a GPU — the prior CUDA-gated test never ran in CI / on the Mac / on any CPU box.
- **Resume decision lifted into torch-free, CI-testable logic**: `_parse_latest` → `classify_latest_pointer` + `describe_pointer_rejection` (behavior-preserving for `read_latest_pointer`). The present-but-rejected warning is now CAUSE-SPECIFIC and NON-DESTRUCTIVE — it steers AWAY from deleting `latest.json` when the on-disk ckpt pairs are still recoverable (the old "move it aside" wording pointed at the breadcrumb). 7 new CI tests.
- **GC orphan-sweep**: `_checkpoint_steps` now unions `.zip`+`.rng.pt`, so a half-failed unlink's orphan sidecar is swept on the next pass; `_fsync_dir` macOS degrade now logs once. Tests incl. the ≥1e9 (10-digit) GC case.
- **Comment fixes folded** (from the review's comment lens): the self-contradictory "load-bearing guard (unlike dump-every)" (Node DOES also check the disk-dir case); "LISTENING timeout"→"exited before listening"; `env_server.py:144-149` line-ref → symbol; `--checkpoint-every` help ("not dynamically coupled to `--snapshot-every`"); resume-provenance note.

**Learned / decided:**

- **The model zip is the expensive recoverable asset; nothing downstream of `MaskablePPO.load` may abort a resume.** A corrupt sidecar / a single-byte-corrupt pointer must degrade or warn-and-recover — never silently restart-from-0 or crash a multi-day checkpoint.
- **No blanket auto-fallback to the retained `keep=2` checkpoint.** Version/encoding-skew on-disk ckpts are genuinely incompatible (fresh is correct), and a silent step-change is worse than a clear manual-recovery message — so the response is a cause-specific warning, not magic recovery. (Revisit only for the corrupt-pointer/dangling-ref cases if it ever bites.)

**Dead ends / surprises:**

- **The verification workflow caught a shodan-only bug I introduced**: `train.py` imported only `POINTER_ABSENT`/`POINTER_VALID`, but a shodan test referenced `tr.POINTER_CORRUPT_JSON` → `AttributeError` only on the box that runs it. Fixed by having the tests import the reason constants from their canonical module (`resume_state`) instead of reaching through `tr`, so they no longer depend on train.py's import list.
- **Self-inflicted git hiccup, fully reversed**: a bare `git stash pop` during verification grabbed a pre-existing `lint-staged automatic backup` stash and left conflict markers across 9 unrelated files. Backed up the 7 changed files, restored the 9 paths to HEAD, md5-verified the work byte-identical. Lesson: never `git stash pop` with no arg when an unrelated stash may sit on top.

**Next:**

- The PR-5 shodan checklist still applies (the sb3 tier can't run locally): `MaskablePPO.load` needs no `custom_objects`; `--device cuda` RNG restore; `_setup_learn` caps at the absolute `--timesteps` (HOLE-D); the new corrupt-sidecar/CUDA regressions. Then **PR-6** = committed shodan launcher + schtasks runbook → the long BEAT run.

---

## 2026-06-27 — Task C/E PR-5 — idempotent checkpoint/resume core (+ B6 flag forwarding, per-session CSV)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Built PR-5** ([D-26] build sequence; branch `ml-bot/task-ce-pr5-resume` off master @ PR #71 `f1224ee`). Python-side only — the Node league resume half shipped in #70.
- **Grounding workflow** mapped the _current_ code + the SB3 resume API + test seams, then adversarially verified the blueprint. Surfaced 3 genuine forks → Ivan chose: dedicated `--state-dir`+`--checkpoint-every` (50k); auto-detect a valid `latest.json`; land per-session CSV now.
- **Three deliverables:** (1) **HOLE-D** budget cap — torch-free `_remaining_timesteps` + `learn(..., reset_num_timesteps=False)`; `remaining==0` skips `learn` but still re-exports. (2) **Resume core** split into torch+sb3-FREE `resume_state.py` (RNG sidecar, atomic `latest.json` written LAST + dir-fsync, GC keep-N, pointer validation, `save_resume_checkpoint`) + sb3 `resume.py` (`load_resume_checkpoint` via `MaskablePPO.load(env=venv)` = PATH A/HOLE-C; `ResumeCheckpointCallback`). (3) **B6 flag forwarding** — `--snapshot-store`/`--league-state-dir`/`--league-dump-every` into the shared parser + `server_kwargs` (`EnvServerProcess` already emitted them since PR-2); Node-mirrored validation. Plus: per-session CSV via explicit `output_formats`; auto-detect resume (corrupt `latest.json`⇒loud warn+fresh); `--freeze-trunk`+`--state-dir` rejected eagerly.
- **4-lens implementation review** (idempotency / torch-free / SB3-API / tests+contract) on the real diff.

**Learned / decided:**

- **Split `resume_state.py` (torch, sb3-FREE) from `resume.py` (sb3)** mirroring `snapshot_manifest`/`snapshot_callback`: the lean CI tier has torch but no sb3, so keeping the riskiest hinge logic (atomic `latest.json`, GC, RNG `weights_only` round-trip) sb3-free makes it **CI-testable** (`test_resume_state.py` 13 green locally) instead of shodan-only.
- **Test-tier topology (Phase-3 PPO):** torch+sb3-free → runs anywhere w/ torch; torch-free-but-gymnasium (lean CI: `test_train_common_args`) → needs gymnasium; torch+sb3 (`test_resume`, `test_train_args`, …) → SHODAN-ONLY. Captured in the mini-env memory.

**Dead ends / surprises:**

- **Review caught 2 blockers I introduced** (both untested by the green tiers): (a) the RNG sidecar was loaded with `map_location=device`, so a `--device cuda` resume relocates the CPU RNG ByteTensor to GPU and `torch.set_rng_state` raises `TypeError` — **crashed EVERY GPU resume** (the shodan BEAT target). Fixed: `load_rng_sidecar` is CPU-pinned (no device param) + a CUDA-gated regression test. (b) two `_make_logger` test sites 3-unpacked its 2-tuple → the **sb3 tier was RED** and the per-session-CSV/TB-degrade branches had zero coverage. Fixed. Both folded with regression coverage.
- Also folded: eager `--freeze-trunk`+`--state-dir` rejection (else every checkpoint is un-resumable, discovered only after a crash); dir-fsync after `os.replace` (the pair is the only model copy); width-agnostic `_CKPT_RE` (`:09d` is a min-width → 10-digit leak at ≥1e9 steps); softened the CSV docstring (a same-step crash-loop still truncates — bounded, observability-only).

**Next:**

- **Shodan validation before merge** (sb3 tier can't run locally): `MaskablePPO.load` needs no `custom_objects`; `--device cuda` RNG restore; `_setup_learn` caps at the absolute `--timesteps` (HOLE-D); live forkserver two-half resume. Then commit + open the PR-5 PR.
- **PR-6** = committed shodan launcher + schtasks runbook → then the long BEAT run.

---

## 2026-06-27 — Task C/E PR-4 — `train.py` + torch-free `_train_common.py` (SubprocVecEnv + TB/CSV + `--from-scratch`)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Built PR-4** ([D-26] build sequence; branch `ml-bot/task-ce-pr4-train` off master @ PR #70 `97de4e4`).
  Grounded it with a **6-reader understand+readiness workflow** (synthesis confirmed the PR-1→3
  foundation is consistent, HOLE-A/B/C implemented + HOLE-D correctly deferred, B6 flags opt-in/
  byte-identical when unset), then implemented:
  - NEW torch-free `ml/dicewars_ppo/_train_common.py`: shared `DEFAULT_OPPONENTS`, `_make_env_thunk`,
    `build_parser(description)`, `_validate_args`, and `resolve_from_scratch` (the `--from-scratch`↔
    `--freeze-trunk` mutex + per-mode LR/ent-coef relaxation via a `None` sentinel). `ModelConfig` kept
    `TYPE_CHECKING`-only under `from __future__ import annotations` so the module is torch/sb3-free.
  - `train_tracer.py` re-imports them and is **byte-identical** (`build_model` gained `venv=None` +
    a from-scratch warm-start gate that is always-off for the tracer, which has no such flag).
  - NEW `ml/dicewars_ppo/train.py`: the real driver — `VecMonitor(SubprocVecEnv(start_method=forkserver))`
    constructed BEFORE `MaskablePPO` ([D-26] Q4: CUDA inits at model construction, after the env fork);
    `set_logger(configure(--log-dir, [stdout,csv(,tensorboard)]))` before `learn`; `--no-tensorboard`;
    provenance (`from_scratch`/`warm_started_from`) in the repack; `--start-method` (forkserver/spawn/fork).
  - `tensorboard>=2.12` → `[rl]` (not `[dev]`; lean CI unaffected). HOLE-D left as an explicit
    `TODO(PR-5)` (fresh runs only, `reset_num_timesteps=True`).
- **Adversarially reviewed** with a 6-dimension verify-each-finding workflow → **SHIP-AFTER-FIXES, 0
  blockers**. Folded all 6 minor findings.

**Learned / decided:**

- **The load-bearing torch-free fix.** The env-thunk closure originally captured `cfg` (the torch-ful
  `ModelConfig`), so a `SubprocVecEnv(forkserver/spawn)` worker would import torch on cloudpickle-unpickle
  — silently defeating the whole point of the extraction ([D-26] Q4) even though the module _imported_
  torch-free. Fix: hoist `max_areas`/`player_count` to locals before the closure so it captures only
  primitives + the stdlib Namespace. **Cloudpickle-proven** with a real `ModelConfig`: no
  `dicewars_bc`/`ModelConfig`/`torch` bytes in the serialized env-fn. Added a lean-tier closure-capture
  guard (`'cfg' not in co_freevars` + a primitive-only allowlist) so this can't regress.
- **HP defaults for `train.py` (decision, reversible):** warm-start keeps the protective tracer defaults
  (lr 1e-4 / ent 0.0); `--from-scratch` relaxes to lr 1e-3 / ent 0.01. The task-A BEAT config
  (`--lr 2.5e-4 --ent-coef 0.01`) is NOT baked as a default — production HPs belong to the PR-6 launcher,
  not a stale magic number in the driver.
- **`tensorboard` is a HARD import for SB3's TB sink** (it RAISES, not no-ops, when absent). `train.py`
  degrades to CSV-only + a loud WARNING if it's missing, so a long run never dies on a partial env.

**Dead ends / surprises:**

- One understand-workflow reader audited the wrong file (the BC `dicewars_bc/train.py`, not the PPO
  tracer); the synthesis caught and discarded its file-specific claims. The review's own suggested
  closure-test (`SimpleNamespace` + type-module check) would have **false-passed** — the verifier flagged
  it, so the committed guard uses a primitive allowlist + a `co_freevars` check instead.
- Local box is Python 3.9 (project targets 3.10+); validated via two throwaway venvs (lean: gymnasium-only,
  no torch; gated: system-torch + sb3-contrib 2.7.1). The 6 `export_onnx` failures are a pre-existing 3.9
  `zip(strict=)` incompat in an untouched file, not PR-4.

**Verification:** ruff clean; 29 lean torch-free tests + 114 gated/ppo tests green; both CLIs compose;
tracer parser surface confirmed unchanged; cloudpickle torch-free proof.

**Next:**

- PR-5: idempotent checkpoint/resume core (policy + optimizer + `num_timesteps` + RNG + league pool/book;
  `reset_num_timesteps=False` + `remaining=max(timesteps−num_timesteps,0)` for HOLE-D; CSV cross-session
  append; wire the B6 `--snapshot-store`/`--league-state-dir`/`--league-dump-every` flags into `train.py`).
- PR-6: committed shodan launcher + schtasks runbook (owns the production HPs). PR-7: live SubprocVecEnv
  (forkserver) smoke + env-server `main()` persistence integration test.

---

## 2026-06-27 — Task C/E foundation — PR #70 review-hardening (4-agent review)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Ran a 4-agent review of PR #70** (code-review, silent-failure-hunter, pr-test-analyzer,
  comment-analyzer). The core logic (resume cursor, HOLE-B dump order, `gc_partition` math, rehydrate
  `<=` cutoff) was independently traced correct by 3 agents — **no blocking bugs**. The review found two
  real disk-related issues on the Python producer plus comment rot from the consumer→producer GC pivot.
- **Fixed two functional issues (both surface only on the long shodan run):**
  - **Grace-zone disk leak on resume + republish window:** `_on_training_start` rehydrated from the
    _truncated manifest_ (`pool_cap` entries), so the `gc_grace` files on disk beyond it were never
    re-tracked → leaked `gc_grace` files per resume. Rewrote it to **scan disk** (`_discover_on_disk_
snapshots` + new torch-free `plan_resume`): re-adopt the whole retention set, drop+**delete** any
    file ahead of the resumed step (closes the HOLE-C republish-divergence window at the producer), and
    rewrite the manifest. Reading the manifest is dropped entirely, so a corrupt/torn manifest can no
    longer mislead the producer (dissolves the prior start-fresh/encodingVersion/KeyError concerns).
  - **Fatal GC unlink:** the `unlink(missing_ok=True)` GC loop only swallowed `FileNotFoundError`; any
    other `OSError` (EIO / read-only remount / EBUSY) crashed `model.learn()` over pure disk hygiene.
    New `_safe_unlink` logs and continues — a robustness regression vs the old best-effort eviction.
- **Comment sweep (consumer no longer GCs):** corrected ~6 stale `ppo-league.mjs` comments that still
  said the consumer "FIFO-evicts + `unlinkSync`s" / a "peer worker" deletes — re-attributed the GC race
  to the single Python producer; fixed the `refresh()` JSDoc, the fingerprint/`restore` gate notes, and
  the dead-code back-fill comment. Pointed the env-server stdout-drain comments at `env_server.py`.
- **Test-seam extraction (the PR's guarantees were untested where they execute):** `main()` isn't
  exported, so the HOLE-B write order and the resume-loop bounds had no coverage. Extracted + exported
  `makeCheckpointDumper` (pins state-then-flush order + the consecutive-failure abort),
  `formatDoneLine`, and `resumeStartEpisode`/`shouldRunEpisode` (pins `--episodes=N` as a run-total).
  Also emit the health line with a `WARN` prefix and on the **abnormal-exit** path (S-3/S-4), and added
  the `!existsSync` guard so a _present_ module's `ERR_MODULE_NOT_FOUND` (missing transitive import) is
  rethrown, not masked as a benign GC-race skip (S-1).
- **New tests:** torch-free `plan_resume` (4) + `makeCheckpointDumper`/`formatDoneLine`/loop-bounds (9) +
  the ERR_MODULE_NOT_FOUND-while-present guard (1); torch-gated callback tests for disk-scan resume,
  grace-zone re-adoption (the leak), and unlink resilience (run on shodan).

**Learned / decided:**

- **Disk-scan beats manifest-read for producer resume.** Rebuilding the tracked set from the directory
  (not the truncated manifest) is what keeps the grace zone GC-eligible AND removes the manifest as a
  trust dependency — one change closes the leak, the republish window, and the corrupt-manifest class.
- **Extract the seam to test the guarantee.** The dump-order and run-total semantics were correct but a
  silent revert would have passed CI; the fix was a small export, not a new integration harness.

**Verification GREEN:** ruff + ruff-format clean; torch-free Python (`test_snapshot_manifest.py` 16,
`test_env_server_argv.py` 6) pass; full ml JS suite **206** (+9 checkpoint/loop tests, +1 guard test);
eslint + prettier clean. Torch-gated `test_snapshot_callback.py` (disk-scan resume / leak / unlink
resilience) runs on shodan. Full repo suite + build run by the main agent.

---

## 2026-06-27 — Task C/E design (D-26) + foundation PR-1→PR-3 landed locally

**Phase:** 3 · **Who:** Ivan + Claude

**Did:**

- **Scoped task C/E (SubprocVecEnv + shodan training-ops) via a 13-agent design workflow** (4 code-readers
  → 3 design takes [minimal / robustness / ops] → synthesize → 4 adversarial-verify lenses → finalize).
  Produced a vetted, code-anchored plan of record; recorded as **[D-26]**.
- **Resolved Q1–Q6** (two genuine forks confirmed with Ivan via AskUserQuestion): new `train.py` +
  torch-free `_train_common.py`; **DROP VecNormalize** (reverses the PLAN wording); two-half idempotent
  resume (bounded-skew); `SubprocVecEnv(forkserver)` + `VecMonitor` in the parent; consumer
  ENOENT-tolerance then producer single-writer GC; `--from-scratch` control.
- **Implemented + locally tested the foundation PR-1→PR-3** on branch `ml-bot/task-ce-foundation`:
  - **PR-1 (Node crash-safety):** `episodeCount` resume seed-cursor (persisted/restored/in `stats()`;
    env-server loop starts at it); `refresh()` GC-race floor (tolerate a peer-evicted file: warn + mark
    loaded + `refreshSkips++`; dedup `fresh` by id; rethrow non-missing errors); `dumpLeagueState`
    flipped to state-then-flush (HOLE-B); schema v1→v2; DONE health mirrored to stderr.
  - **PR-2 (Python forwarding):** `EnvServerProcess` forwards `snapshot_store`/`league_state_dir`/
    `league_dump_every` to argv on their own (manifest-independent) gate; byte-identical when unset.
  - **PR-3 (snapshot GC ownership):** removed the consumer `unlinkSync`; NEW torch-free
    `ml/dicewars_ppo/snapshot_manifest.py` (`rehydrate_snapshots` + `gc_partition`); `SnapshotCallback`
    rehydrates on resume + GCs aged files after truncating the manifest (`pool_cap`/`gc_grace`).
- **Verification GREEN:** full JS suite **1147** (+6 new league tests), build + eslint + prettier clean;
  torch-free Python tiers (`test_snapshot_manifest.py` 12, `test_env_server_argv.py` 6) pass; ruff +
  py_compile clean. Updated DECISIONS (D-26), PLAN (task C/E), and this LOG.

**Learned / decided:**

- **VecNormalize is a trap here, not a feature.** The verifier (grounded in `env.py`/`policy.py`/
  `model.py`/`constants.py` + the SB3 2.9.0 source) showed obs-norm corrupts the int edge-index keys,
  `ValueError`s on the `edge_mask` MultiBinary, and breaks the masked-mean pool; reward-norm is pointless
  on a `{0,1}`/γ=0.999 return. So there is nothing VecNormalize-shaped to checkpoint — the PLAN wording
  was wrong; resume state = policy + optimizer + `num_timesteps` + RNG + league pool/book.
- **The adversarial pass earned its keep:** it found 4 concrete resume bugs (HOLE-A seed-replay double-
  count, HOLE-B disk-book double-count, HOLE-C future-snapshot republish, HOLE-D additive `--timesteps`)
  the naive design would have shipped. A→C are fixed in PR-1/PR-3; D lands in PR-5.
- **PR-1 and PR-3 interact:** PR-3 moves disk deletion to the single producer, so the GC-race tests are
  written for the final (consumer-never-unlinks) state — they delete the file directly to simulate the
  producer/peer GC, surviving the PR-1→PR-3 boundary.

**Dead ends / surprises:**

- This Mac has **no torch/sb3** (system py 3.9; the ml venv is shodan-only), so the torch-gated
  `test_snapshot_callback.py` (updated for the new GC/rehydration + `_write_manifest_atomic(entries)`
  signature) can't run locally — its logic is mirrored in the torch-free `test_snapshot_manifest.py`,
  and the wiring is verified on shodan at PR-4+. Extracting the pure helpers into `snapshot_manifest.py`
  was specifically to keep the GC/rehydration math locally testable.

**Next:**

- **PR-4** `_train_common.py` + `train.py` (SubprocVecEnv(forkserver) + VecMonitor + TB/CSV +
  `--from-scratch`; add `tensorboard` to `[rl]`) · **PR-5** idempotent checkpoint/resume core (RNG
  sidecar + atomic `latest.json` last + HOLE-D budget) · **PR-6** committed `scripts/shodan/ppo-train.sh`
  - schtasks runbook · **PR-7** deferred test-hardening. Then the long BEAT run at R=3.
- Decide commit/PR mechanics for the foundation branch with Ivan (one PR vs the 3-slice split).

---

## 2026-06-27 — Task B step B6: league persistence + SharedDiskStore (toJSON/restore; standalone PR #69, squash `d637a06`)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:** Built B6 — the league-side checkpoint/resume primitive Task E's idempotent resume will drive —
as a **standalone Node PR** (no Python touched). Scoped + adversarially reviewed via two multi-agent
workflows (12-agent design → blueprint; 5-agent review → SHIP-AFTER-FIXES, no blockers, zero phantom
findings). Two forks confirmed with Ivan up front: **standalone B6 PR** (vs bundling with E), and
**SharedDiskStore implemented + unit-tested but its live multi-worker path gated until E**.

- **B6a — store module** (NEW `scripts/lib/ppo-league-store.mjs`): `makeInMemoryStore()` (default,
  per-process `Map`, byte-identical to the B2–B5 inline book), `makeSharedDiskStore({dir,workerId})`
  (own book in memory + full-shard-on-`flush()` + fold-peers-on-`refreshGlobal()`, single-writer-per-
  shard lock-free, `workerId` = the env `seed_base` so it's restart-stable and never a PID), and
  `writeJsonAtomic` (tmp + `fsync` + `rename`, matching the snapshot producer's durability story).
- **B6b — route the book through the store** (`ppo-league.mjs`): injected `opts.store` (default
  `makeInMemoryStore`); the 3 book touchpoints (`recordResult` write, `learnerWinRate` read,
  `stats().bookSize`) go through it. **Behavior-preserving — the existing 91-case league suite passes
  unchanged.** `refresh()`/`draw()` untouched.
- **B6c — `toJSON()`/`async restore()`** (`ppo-league.mjs`): plain-JSON snapshot (counters, the win-rate
  book via `store.toJSON()`, the pool as `{id,step,weightsPath}` — NO `fn`, current array order, never
  re-sorted — and `loadedIds`). `restore()` gates BEFORE any mutation/import: version, encodingVersion,
  fingerprint (every draw/eviction-determining arg), and storeKind; rebuilds the pool by re-importing
  each `weightsPath` via `makeBC`; resets `manifestMtimeMs=-1` (force a fresh manifest re-poll). Atomic
  (imports into a local pool first, then applies). An evicted/unlinked weights file → WARN+skip+keep id
  in `loadedIds` (book record preserved); any other import error throws.
- **B6d — env-server wiring** (`ppo-env-server.mjs`): new flags `--snapshot-store=memory|disk` /
  `--league-state-dir=<dir>` / `--league-dump-every=50` + exported `resolveLeaguePersistence` (store
  selection + per-worker `league-state-<seedBase>.json` path). Restore-on-startup; `store.refreshGlobal()`
  at the episode boundary (no-op for memory); periodic dump after `recordResult` and **before** the
  zero-decision `continue`; final + SIGTERM dumps. **Persistence is OPT-IN — with none of the three flags
  the run is a strict no-op, byte-identical to B5.**

**Learned / decided:**

- **Fixed-field / snapshot-mode is byte-identical to B5** because every persistence side-effect is gated
  on `leagueStatePath` (null unless opted in) or is a store no-op for `memory`. The 91-case suite is the
  proof. `--snapshot-manifest` alone does NOT auto-enable persistence (no surprise side-files).
- **`SharedDiskStore` is shippable now without E** because the full fold algorithm is testable single-
  process: two store instances over one temp dir exercise the merge (idempotent, order-independent,
  own-shard recovery, peer fold, torn-shard skip). Only the genuinely-multi-worker properties wait for E.
- **The `fingerprint` must cover every sampler/eviction arg, not just `count`** — `pfspEpsilon`/`pfspK`/
  `reserveBaselines`/`poolCap`/baseline-id identity all steer `draw()` and FIFO eviction, so a resume
  under drifted CLI args fails loud rather than sampling/GC-ing divergently.

**Review-hardening (5-agent adversarial review → folded all worthwhile findings):**

- **S1** mkdir the league-state dir at launch (a typo'd/missing dir fails the launch, not silently on the
  first dump). **S2** dump-failure tracking — count, surface `dumpFailures=` on the DONE line, fail loud
  after 10 consecutive (a durability feature silently never persisting is worse than aborting). **S3**
  emit `storeKind` + reject a backend switch on resume (would silently zero the book). **S4** reject a
  pooled module with no `BC_POLICY` export in BOTH `restore()` and `refresh()` — `makeBC`'s default param
  would otherwise silently load the SHIPPED BC as a corrupt snapshot (empirically confirmed). **S5**
  `refreshGlobal` distinguishes benign skips (ENOENT/SyntaxError) from real FS errors (warn-once). **S6**
  the disk store recovers its own shard at CONSTRUCTION, so own-book recovery doesn't depend on the
  state file existing. Plus: atomic `restore()` (no half-apply), validate `--league-dump-every≥1`, and
  test arms for `learnerSeat` drift / store-kind switch / missing-`BC_POLICY` / book-retention-on-drop /
  the disk-store-through-`makeLeague` round-trip + peer fold.

**Tests:** NEW `ppo-league-store.test.js` (16) + `ppo-league-persist.test.js` (16); `ppo-env-server-args.test.js`
4→12. `tests/ml/` 190 green; full suite **1141 green**; eslint + build clean.

**Dead ends / surprises:**

- The env-server `main()` persistence WIRING (restore-on-startup, the dump call-sites/ordering, SIGTERM)
  is only indirectly covered (via `resolveLeaguePersistence` + the league-level persist tests) — the
  `isEntryPoint` guard blocks importing `main()`, and a full integration test needs the socket-client
  harness. **Deferred to Task E** (which runs the env-server live on shodan and needs that harness anyway).

**Next:**

- **Task E** (the long-BEAT-run prerequisite): schtasks-wrapped WSL launch; idempotent SB3 checkpoint/
  resume of policy+optimizer+VecNormalize+RNG+step; `DummyVecEnv`→`SubprocVecEnv`; TensorBoard+CSV; and
  the B6-deferred items — Python forwarding of `--snapshot-store`/`--league-state-dir`, the `refresh()`
  multi-worker snapshot-GC race hardening (a peer `unlinkSync` racing a late worker's backfill import),
  and the env-server `main()` persistence integration test + live cross-worker `SharedDiskStore`
  validation. Then the long run at R=3, gated by `npm run ppo:gate` vs `ai_lookahead@596f781`.

## 2026-06-27 — Task B step B5: snapshot-heavy throughput/decisive-rate re-probe (first live shodan exercise of the sampler)

**Phase:** 3 · **Who:** Ivan + Claude

**Did:** Built `npm run ppo:league-probe` (NEW `scripts/ppo-league-probe.mjs` + `scripts/lib/ppo-league-probe-core.mjs` + `-worker.mjs`, 23 tests in `tests/ml/ppo-league-probe.test.js`) and ran the B5 re-probe **on shodan** (16-core, Node v22). Unlike the [D-20] throughput probe (fixed field, no league), B5 drives the **real** `makeLeague` PFSP sampler end-to-end — `refresh → draw → runSelfPlayEpisode → recordResult → stats` — on a **snapshot-heavy** field, the genuine "first live exercise of the sampler" ([D-23]). Scoped + adversarially reviewed via two multi-agent workflows (7-agent scope, 5-agent review → one must-fix + should-fixes applied).

- **Snapshots without the Python producer:** `buildSnapshotManifest` writes a `refresh()`-loadable manifest + one tiny **re-export shim** per snapshot pointing at the real `ppoPolicyWeights.js` / `bcPolicyWeights.js` modules → `refresh()` `makeBC`-wraps the SAME ~2 MB module (no per-snapshot copy, no eviction at poolCap≥pool). Pool = 4 ppo + 4 bc (two distinct behaviors so the win-rate book differentiates).
- **Two decisive-rates, never conflated** (the scope-verify's central correction): **PASS A** learner-relative (`terminateOnElim:true`, the trainer's exact regime → `league.stats().decisiveRate`, the budget basis) vs **PASS B** global/[D-15] turtle (`terminateOnElim:false`, `winner!=null`). Greedy PPO-policy learner (a random learner just dies fast and skews PASS A).
- **Run** (HEAD `d3ceeec`, D-23 standard field, count=6) in an **isolated git worktree** so shodan's dirty main tree (Ivan's task-A/B state, on `ml-bot/phase3-ppo-tracer-run`) was untouched. R-sweep R∈{0,2,3,4}: RUN1 multi-worker(14) policy (throughput+turtle), RUN2 single-worker policy (warm-book decisiveRate), RUN3 multi(14) random R=3 (comparability). Full numbers + sha256 in RESULTS.md.

**Learned / decided ([D-24]):**

- **env-sim is NOT the bottleneck on a snapshot-heavy field.** GREEN at EVERY R: **50.7M (R=0, all-snapshot) → 89.9M (R=4) env-steps/12h** at 14 workers, ~25–45× the ≳2M bar. The [D-19] worry — in-process net-policy opponents could make env-steps prohibitive — is **refuted**. The real binding rate is the SB3/PPO learner loop (task-A's 1M run was GPU/DummyVecEnv-bound at ~17 eff steps/s, not env-sim-bound) → lifted by task C/E `SubprocVecEnv`. B5 closes the [D-22] env-sim question.
- **R = 3 LOCKED** (D-23 default confirmed). All R are GREEN and turtle-healthy (global 85–95%, ≫ the 60% floor); warm-book learner-relative decisiveRate 95.3% at R=3. No throughput or turtle pressure to deviate, so keep the full [D-15] defense (3 aggressive baselines/game). The snapshot field does **not** turtle — even R=0 (all-snapshot) is 90.5% global-decisive.
- **MAX_EDGES 64 still safe:** numEdges p100 ≤ 27, 0 overflow on the snapshot-heavy field.
- **Cadence N (open-Q4) resolved:** per-move cost is pool-size-invariant; ~2 MB/snapshot resident in the ESM registry → on 128 GB shodan, memory is unconstrained at realistic N. Decouple N from throughput; pick N so the pool fills to poolCap=40 within the first budget unit (task-C/E tuning).
- **Snapshot per-move cost** ~1.2 ms single-thread / ~2.2 ms under 14-worker contention on 16 cores (vs [D-20]'s ~0.8 ms on a lighter field/box) — still GREEN by a wide margin.

**Dead ends / surprises:**

- **shodan ssh is triple-nested** (Mac→Windows cmd→`wsl`→bash): the `shodan-wsl` alias has `RemoteCommand wsl ~` so it rejects an inline command, and `ssh shodan "wsl bash -lc '…'"` lets **cmd.exe** eat `|` and mangle `$()`/`(`. Fix: pipe a script via **stdin** (`ssh shodan "wsl bash" < script.sh`) — zero metacharacters on the command line. Also: WSL tears down `/tmp` (tmpfs) between separate ssh sessions, so the run must be **one session** with the worktree under `/home`.
- Review must-fix caught a real one: the throughput denominator originally included per-worker **cold start** (re-parsing the ~4 MB policy modules + `refresh()`), which deflates steps/s ~15–35% at scale and could falsely downgrade a GREEN verdict. Now throughput = `learnerDecisions / max(per-shard steady-state elapsedMs)` (cold start excluded), wall reported separately.

**Next:**

- **B6** — league persistence (`toJSON()/restore()`, the snapshot pool + win-rate book + counters) for idempotent checkpoint/resume, landing with task E (`SubprocVecEnv`). Then the long BEAT run (task C/E) at R=3, gated by `npm run ppo:gate` vs `ai_lookahead@596f781`.

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
- **Tests.** NEW `tests/ml/ppo-league-pfsp.test.js` (21 tests: field shape, reserve rules incl. the
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

**Second-pass review hardening (multi-agent `/review-pr`, follow-up commit).** A 5-agent review (code /
tests / silent-failure / comments / type-design) found no correctness bug in the production path but
flagged four silent-degradation footguns, all fixed:

- **Dead-PFSP guard (was: silent no-op).** When reserved baselines fill every seat
  (`min(R, #reserveBaselinePool) >= count`, e.g. default `R=3` on a 4-player game ⇒ `count=3`),
  `draw()` seated ZERO snapshots despite a loaded pool — PFSP silently off, `stats()` still healthy.
  `makeLeague` now throws at construction when a manifest is configured (decidable from config alone;
  fixed-field mode is exempt). The production 7-player path (`count=6`) is unaffected.
- **Persistent no-seatBeat now fails loud.** A one-off missing `seatBeat[]` stays warn-once, but past
  `MAX_NO_SEATBEAT_GAMES` (10) `recordResult` throws — a persistent contract break leaves the win-rate
  book uncredited and collapses PFSP to uniform, which the warn-once alone let run silently for hours.
  The cumulative count is exposed on `stats()` and the `PPO_ENV_SERVER DONE` line (`noSeatBeatGames=`).
- **Node-side flag bridge now tested.** NEW `tests/ml/ppo-env-server-args.test.js` covers the middle
  hop the Python argv test couldn't reach: `parseArgs`/`numArg` actually parse `--reserve-baselines`/
  `--pfsp-epsilon`/`--pfsp-k` and default them to the B4 values. `ppo-env-server.mjs` now guards its
  `main()` behind an `isEntryPoint` check and exports `parseArgs`/`numArg` so a test can import without
  spawning the server.
- **Doc fixes.** Corrected the misleading `train_tracer._validate_args` comment (in fixed-field mode the
  knobs are NOT forwarded, so the Python guard is the _sole_ check — not "Node validates anyway");
  retired the stale "until B4 wires the book into `draw()`" note on `stats()`; relabelled "aggressive
  baselines" → "non-`ai_bc` baselines" (the reserve set includes `ai_defensive`); fixed the "17 tests"
  count above to 21. New tests: 3 dead-PFSP-guard cases + 1 persistent-no-seatBeat case + the 4 Node
  flag-bridge cases.

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
