# Plan — ML / Self-Play Bot

Detailed, trackable phases. Each phase has an **objective**, the **tasks** to do,
**acceptance criteria** (measurable "done"), and a **go/no-go gate** — the
decision we make before investing in the next phase. The gates are the whole
point: they let us find out _early and cheaply_ whether learning is worth the
GPU-weeks.

See [`README.md`](./README.md) for the high-level strategy and the status
dashboard. Record results in [`RESULTS.md`](./RESULTS.md), session notes in
[`LOG.md`](./LOG.md), and decisions in [`DECISIONS.md`](./DECISIONS.md).

> **Evaluation gate (applies to every phase that produces a bot):** beat
> **`ai_lookahead`** (the field-strongest bot, pinned `596f781` — re-baselined from
> `ai_strategist` per [D-7](./DECISIONS.md)) on `npm run arena:sweep` (multi-seed,
> 95% CIs), seat/turn-order controlled, edge statistically significant. Strategist
> stays as a secondary reference.

---

## Phase 0 — Quick-win search bot · ⬜ Not started · ~2–4 days

**Objective.** A pure-JS chance-node expectimax bot that needs no ML, no Python,
no GPU, and no engine changes — and very plausibly becomes the new strongest bot.

**Why first.** Bank a likely win, and _answer the critical question early_: does
**search alone** beat `ai_strategist`? If it doesn't, plain self-play RL almost
certainly won't either, and we've spent days, not weeks.

**Tasks.**

- [ ] New bot file (e.g. `src/ai/ai_expectimax.js`) using the modern contract.
- [ ] Depth-1: for each move in `getValidMoves`, compute the `WIN_TABLE`-weighted
      expectation of `ai_strategist`'s board evaluation over the two battle
      outcomes (win → captured territory gets `attackerDice-1`, source → 1; loss →
      source → 1). Pick the argmax; return `null` (STOP) when nothing beats
      holding.
- [ ] Reuse `ai_strategist`'s evaluation as the leaf heuristic (extract/share it
      rather than copy-pasting if practical).
- [ ] Register in `src/arena/builtInBots.js`.
- [ ] Extend to depth-2 (expand the best-K moves one ply deeper) and compare.
- [ ] Benchmark with `npm run benchmark-bot`; record timing (must stay playable
      in-browser — see the Lookahead bot's ~243 ms/game as the "too slow" marker).

**Acceptance criteria.**

- Passes `npm run validate-bot` (syntax, compile, runtime) and is deterministic
  given a seed (no `Math.random`).
- Runs a full `arena:sweep` vs `ai_strategist` and the result is recorded in
  `RESULTS.md`.

> **Baseline timing.** PR #35 (`fix/strategist-endgame-turtle`) changed
> `ai_strategist` and **merged to master on 2026-06-21 as `f5fedb2`** — the
> blocker is cleared. Pin that strategist SHA in the `RESULTS.md` row so the
> baseline isn't measured against an in-flight version. See `RESULTS.md` for the
> convention.

**Go/No-Go gate.** _(Outcome recorded 2026-06-21 — see `RESULTS.md` / `LOG.md`.)_

- Default-weight Expectimax **lost** the FFA; weight-tuning (`attackThreshold 0.3`,
  `threat 2.0`) made it **rank 1–2 by ELO** and beat Strategist on ELO/placement
  significantly, but only **tied on win%** — and it **does not beat the real bar,
  `ai_lookahead`** (~25% vs ~15%). Shipped as a net improvement; the headline gate
  (beat Lookahead) is **open**.
- Search viability is **proven** (Lookahead is a search bot and the field leader),
  so this is not a Track-B-kill signal. The win% ceiling is structural ([D-8]): a
  fixed attack threshold can't both stay patient and press to close out.
- **Update 2026-06-22 — press-mechanism built ([D-9]).** Added the posture-adaptive
  threshold + elimination term + a low-odds risk floor to `ai_expectimax`. Result
  across 16,800 seat-fair games: Expectimax **ties `ai_lookahead` on win%** (22–23%
  vs 22.5–23.9%), **significantly out-places it** (paired 51.2%, p≈0.002), is ELO
  co-leader, and ties the 1v1 duel — i.e. **parity / joint-strongest**, up from rank
  6/7. **The headline gate (a _significant win% edge_ over Lookahead) is still NOT
  met — it's a tie.** Landed anyway as a strict improvement over the prior shipped
  Expectimax.
- **Next:** the same "places better, win% ties" ceiling now caps
  Expectimax-vs-Lookahead one tier up; threshold/elimination/floor tuning converges
  to parity, not a decisive win. Crossing it needs a better board **evaluation** or
  deeper **search** → **Track B (learned policy)** or an eval rework, not more
  posture tuning.

---

## Phase 0.5 — Eval-rework spike (Track A, bounded) · ❌ Killed at 2/4 swings — no gate cross ([D-11], 2026-06-22)

> **Outcome.** None of the three structural terms beat the D-9 baseline: neutral at
> best, harmful when grown, across two seeds at two power levels (RESULTS / [D-11]).
> Same parity ceiling as D-8/D-9 — bolt-on eval terms perturb a near-local-optimum
> eval rather than break it. Dud params reverted; **pivot to Track B (Phase 1).**

**Objective.** Answer the last _cheap_ question before committing weeks to Track B:
is there an **outright-win% edge over `ai_lookahead`** still hiding in a better board
**evaluation** (not weights)? [D-9] showed posture/threshold tuning converges to
parity; the eval's _feature set_ — not just its weights — was never reworked.

**Why now (gate philosophy).** Pure JS, no GPU, days not weeks. Either it crosses
the open Phase-0 gate (ship it, possibly defer RL), or a bounded basket also
converges to parity — the _earned_ signal that search valuation is tapped out and
Track B is worth the GPU-weeks. Bounded swings, not unbounded tuning.

**Approach.** Each candidate feature is a new `DEFAULT_PARAMS` weight defaulting to
`0`, so `makeExpectimax()` stays the shipped (D-9) bot until a sweep turns it on —
reusing the whole `makeExpectimax` / `_tune.mjs` / `_baseline.mjs` infra, zero engine
changes.

**Feature basket (approved 2026-06-22 — all tested, none cleared).**

- [x] `mergePotential` — latent income from the best _unifying_ capture. **Dud:**
      neutral when tiny, harmful as it grows (redundant with the chance-search).
- [x] `fieldRivalIncome` — suppress the _trailing_ field (Σ rival income − leader's).
      **Dud:** lone Swing-1 bump (+0.9%) didn't replicate at higher power.
- [x] `trappedDice` — penalize idle interior strike dice. **Dud:** neutral→harmful
      (fights the income term).
- [ ] `supportedBorder` (defensibility) — gated on the first three showing life;
      **not reached** (precondition unmet).

**Loop.** `_tune.mjs --games ~1000` coarse single-term + pairwise screens →
promote finalists to `_baseline.mjs` (seat-fair + paired + 1v1) on a held-out
`--seedbase`.

**Budget / kill criterion.** **Capped at 4 sweep swings** (matching how posture
tuning was capped at four). If no config clears the gate within 4 swings, record it
in `DECISIONS.md` as the earned "search valuation is tapped out" signal and move to
Phase 1. Each swing's result goes in `RESULTS.md`.

**Go/No-Go gate.** A **statistically significant outright-win% edge over
`ai_lookahead`** on a clean seat-fair sweep → land the reworked eval as the new
default and the Phase-0 headline gate is finally **met**. Otherwise → Track B.

---

## Phase 1 — Harness hardening for self-play · ✅ Done (2026-06-23) · ~3–5 days

> **Scope corrected 2026-06-22 after a verified surface-map ([D-12]).** Two PLAN
> assumptions were wrong: (a) the O(n²) `history` append is **not** the throughput
> lever — it is ~1–2% of per-move cost at realistic game lengths (~378 actions);
> the per-move `cloneAreas` + `clonePlayers` + 7× `findLargestConnectedGroup`
> (~19× the history cost) dominates. (b) Parallel self-play is **greenfield** —
> there is zero worker/process code in the repo; the "~266 g/s on 4 procs" figure
> came from a deleted, uncommitted probe. Decisions: **optimize per-move allocation
> now** (task 3 promoted to first-class) and **build a committed, reusable self-play
> harness** (`scripts/selfplay.mjs`) that Phase 2 reuses to generate its 100k–1M
> games. Work branch: `ml-bot/selfplay-harness`.

**Objective.** Turn the headless arena into a fast, reproducible, _instrumented_,
_parallel_ self-play environment. No learning yet.

**Tasks.**

- [x] **(1) Training-mode `recordHistory` flag.** Read `state.config.recordHistory
!== false` inside `applyAttack`/`applyEndTurn` (`StateManager.js:199,244`) — no
      signature change, stays pure. Add to the `createGame` config allowlist
      (`GameRunner.js:32-39`, default on) and forward it through `runMatch`
      (`matchRunner.js:153`, which currently drops unknown config) and `arenaRunner`.
      **Defaults ON (history recorded); training opts out via `recordHistory:false`** so the browser `GameController` (reads
      `history[last].result` for animation, `:398/:572`) and replay/tournament
      persistence (`createReplay`, `run-online-tournament.mjs:178`) are unaffected.
      A memory / asymptotic-safety win, **not** a throughput one.
- [x] **(2) Explicit seeds end-to-end + determinism test.** Gate a "require explicit
      seed (throw if missing)" behind training-mode so the production UI keeps its
      random seed (`GameRunner.js:38` `Math.random` fallback). Add
      `tests/engine/determinism.test.js` (node env, **no** jsdom): same seed →
      identical winner/turns/placements using **seed-pure bots only** (Strategist,
      Lookahead, Expectimax, Defensive — never the 3 `Math.random` bots
      default/example/adaptive); assert `history.length === 0` under
      `recordHistory:false`. Fix: persist `dicePerArea` in the replay config
      (`replayFormat.js:58-64`) so round-trip doesn't silently diverge on non-default
      dice.
- [x] **(3) Per-move allocation trims — first-class ([D-12]). DONE (2026-06-23).**
      Two behavior-preserving trims to `src/engine/StateManager.js`: (a) dropped the
      redundant **double-clone of `areas` per end-turn** — `applyEndTurn` no longer
      pre-clones; it passes `state.areas` straight to `distributeReinforcements`, which
      is pure and already clones internally; (b) **gated `findLargestConnectedGroup`**
      in `recalcPlayerStats` to the only players an action can change — the attacker
      and the captured territory's former owner on a capture, nobody on a failed attack
      or end-turn — down from a union-find pass for all 7 players every action. Result:
      **≈1.9× pure-engine
      throughput** (≈215 → ≈414 games/s; the learner's engine→tensor path gets this
      directly), +3–5% on the bot-search-dominated self-play field, byte-identical
      games. Guarded by a 5-seed per-action invariant fuzz test
      (`StateManager.test.js`); 850 tests green. The `clonePlayers` shallow-share
      landmine still holds (Player fields stay primitive). **Bot-side `join`-matrix
      fast-path: NOT pursued (deferred).** The strong bots route through
      `adaptLegacyBot` → `createLegacyViewFromBotState`, rebuilding an O(areas²) `join`
      matrix per move, but it was never isolated as a bottleneck — the field is
      depth-2-search-dominated, and the learner reads engine→tensor and never touches
      that chain ([D-13]), so this stays a measured-and-only-if future micro-opt, not a
      gate blocker.
- [x] **(4) Trajectory export** (`src/arena/trajectoryExport.js`, beside
      `replayFormat.js`). **Landed.** Per-step `{observation: BotState, legalMoves
(getValidMoves + an explicit STOP), chosenMove, outcome}` + terminal
      `{winner, placements, turnCount}`. Hooked via an `onStep`/`recordTrajectory`
      option threaded `runMatch → runBotTurn`: observation captured **before**
      `applyAction`, outcome after, **rejected/invalid moves skipped**, STOP tuple
      emitted at the turn-ending `END_TURN`. **Decision (confirmed with Ivan):
      lean is canonical on disk, fat is derived** (per [D-13]) — the recorder
      records the **lean action list out-of-band from `state.history`** (so it
      survives `recordHistory:false`, where the plain `createReplay` would yield
      nothing — the crux), and the fat steps are re-derivable via
      `createBotState(replayToState(replay, i))` (`trajectoryFromReplay` — also the
      Phase-2 tensor-expansion pass). Invariant: **one fat step per applied action**
      (`fatSteps ≡ lean action list`), so re-derivation reproduces live capture
      step-for-step. The lean record reuses the replay envelope
      (`createReplayFromActions`, extracted from `replayFormat.js`) + an
      `observationSchemaVersion` stamp (encoding finalized in Phase 2 — [D-Encoding]).
      Tests: `tests/arena/trajectoryExport.test.js` (36, incl. review hardening) with
      the headline `rederived === live` round-trip under `recordHistory:false`; sample
      `tests/fixtures/trajectories/sample.jsonl` (3 games) round-trips.
      **Scope split (confirmed): `scripts/selfplay.mjs` + at-scale JSONL streaming
      stay task 5.** `arenaRunner` forwards `recordTrajectory`/`onStep` but retains
      `matches[]` — task 5's harness calls `runMatch` directly and streams.
- [x] **(5) Committed parallel self-play harness** (`scripts/selfplay.mjs` +
      `npm run selfplay` — [D-12]). `worker_threads` pool (default ~50% cores, to
      respect the test-lock machine policy in CLAUDE.md). **Pass bot identifiers, not
      closures** (bot fns aren't structured-cloneable — workers import bots
      themselves). **Stream trajectories to JSONL** — never retain
      `matches[]`/`finalState` (a RAM blow-up at 100k+ games). Aggregate ELO/stats in a
      single-threaded post-pass (`runArena`'s ELO update is path-dependent). Measure on
      a **heterogeneous / decisive field** — NOT identical Strategist, which 0-attacks
      and stalemates to `maxTurns` every game. **Design it shardable by seed range**
      (`--seed-start`/`--seed-count`/`--out`) so the JSONL concatenates losslessly
      across machines — data-gen fans out across all cores on every available machine,
      not one box (engine determinism + game independence make the merge clean — [D-13]).
      **Data-quality filter at consumption — this harness owns forced-end cleanup
      ([D-14]).** Task-4 records every turn-end as a voluntary STOP (explicit-(c)); the
      rare forced ends are dropped here, where the signals already live as first-class
      per-bot counters on `botStats`: a game where a teacher's `errors`, `invalidMoves`,
      or `maxMovesHit` is **> 0** is **quarantined** (teacher misbehaved or hit the move
      cap — <0.1% of games for a well-behaved teacher). `maxMovesHit` is an explicit
      counter (not derived from turn length), so the whole game is dropped uniformly
      across all three signals. Keeps the lean record pure; no per-action markers in the
      format.
      **Scaffold landed (2026-06-22):** committed `scripts/selfplay.mjs` + `npm run selfplay`,
      with the worker-agnostic core split into `scripts/lib/selfplay-core.mjs`
      (`generateShard` streams clean trajectories via an injected writer and never retains
      `MatchResult`/`finalState`; `forcedEndReason` is the D-14 quarantine predicate;
      `aggregateStats` is the single-threaded path-dependent ELO post-pass over seeds;
      `makeFileWriter` is a backpressure-free `fs.writeSync` JSONL sink) and the
      `worker_threads` entry in `scripts/lib/selfplay-worker.mjs` (receives bot **names**,
      not closures). CLI is shardable by seed range (`--seed-start`/`--seed-count`/`--out`,
      contiguous blocks concatenated in seed order), defaults to a seed-pure heterogeneous
      decisive field, warns on `Math.random` bots, and reports throughput + clean-rate +
      action-count distribution + ELO. Tests: `tests/scripts/selfplay.test.js` (covers the
      core, worker plumbing, CLI validation, the single-core inline path, and a worker-pool
      e2e that round-trips seed-ordered JSONL). **Closed (2026-06-23):** the
      before/after-trims and single-core-vs-N-worker throughput numbers are in
      `RESULTS.md` and near-linear scaling is confirmed from the committed harness (1→4
      workers 3.04× on 8 cores), not the lost probe.

**Acceptance criteria.**

- Determinism test green; lean replay round-trips a full game to an identical final
  state (already works — `GameRunner.test.js:205` — extended through the arena path),
  and each fat trajectory step is replay-derivable
  (`createBotState(replayToState(replay, i)) === step.observation`).
- A sample exported `.jsonl` trajectory exists and round-trips.
- `RESULTS.md` records self-play throughput **before vs after** the per-move trims,
  single-core vs N-worker (near-linear scaling re-established from committed code, not
  the lost probe), plus the action-count distribution and completion rate of the
  measured field.

**Go/No-Go gate — ✅ MET (2026-06-23).** Reproducible + instrumented + parallel
(near-linear scaling confirmed: 1→4 workers 3.04×) + per-move trims landed with recorded
before/after numbers (≈1.9× engine-only) → **proceed to Phase 2 (imitation baseline).**
**Gate reframed ([D-12]):** the old "≥100 g/s/core" absolute is only
meaningful for a _cheap_ heuristic field; `ai_lookahead` (the Phase-2 clone target) is
~4 g/s/core and no engine micro-opt changes that — Phase-2 data-gen is
**parallelism-bound** (≈ minutes-to-hours across cores), which is exactly what the
committed harness delivers. The gate is "scaling confirmed + numbers recorded," not a
single absolute g/s.

---

## Phase 2 — Imitation baseline (de-risk learning before RL) · 🟨 In progress · ~1–2 weeks

**Objective.** Prove the **entire** JS → train → ONNX → in-browser pipeline on an
_easy_ objective: clone `ai_strategist` with a small neural net. This de-risks
everything technical before we gamble on RL.

**Tasks.**

- [ ] Generate ~100k–1M self-play games of the **strongest heuristic to imitate —
      `ai_lookahead`** (per [D-7]; cloning the field leader both de-risks the
      pipeline and yields a stronger starting policy than cloning Strategist would);
      export trajectories (minutes-to-hours on 8 cores). _A 300-game sample exists
      (`corpus-fullfield-300`, used to validate the trainer); the parity-run corpus is
      still to generate on the fleet ([D-13], full 7-bot field per [D-15])._
- [x] Decide the encoding — **[D-Encoding] Accepted**: graph over ≤31 territory
      nodes (relational owner, dice, is-mine/is-enemy, is-border, per-edge win-prob
      from `WIN_TABLE`); masked edge head over legal `(from,to)` + explicit STOP;
      shipped as `encodeObservation.js` + `encode-corpus.mjs` (packed tensors + manifest).
- [~] Train a small masked policy/value net (GNN or per-edge MLP) by behavioral
  cloning — **trainer scaffolded ([D-16]): `ml/dicewars_bc/` (masked per-edge MLP + aux value head, segmented CE, game-level split, hermetic test suite).** Smoke-tested
  on the 300-game sample (val move-match 33%→47%, 8 untuned CPU epochs). _The
  parity-grade run (big corpus + tuning on the GPU box) is pending._
- [~] Export to ONNX; load in-browser via ONNX Runtime Web; wrap as a normal bot —
  **ONNX export done** (`ml/dicewars_bc/export_onnx.py`: logits-only single-step
  graph, dynamic edges, ORT parity ≈5e-7, contract sidecar). _In-browser
  ONNX-RT-Web wrapper not built yet — needs `onnxruntime-web` + a label-free
  encoder extracted from `encodeStep` (see [D-16] "Next slice")._
- [ ] Evaluate the in-browser net on `arena:sweep` vs **`ai_lookahead`** (the bar,
      per [D-7]; Strategist as secondary reference).

**Acceptance criteria.**

- The cloned net **matches `ai_lookahead`'s strength** (within CI) on
  `arena:sweep` — it's imitating it, so parity is the bar.
- The same ONNX model runs in Node and in-browser with identical action choices
  on fixed seeds (cross-bridge action-encoding test passes).

**Go/No-Go gate.**

- **Reaches ~parity** → the pipeline works; proceed to Phase 3 (RL).
- **Can't reach parity** → the encoding (not RL) is the problem. Fix encoding
  before any RL. Do **not** proceed until a net can at least clone the heuristic.

---

## Phase 3 — Self-play RL (PPO) · 🟨 In progress (kicked off 2026-06-25) · ~3–6 weeks (real plateau risk)

**Objective.** Train a self-play policy that is _genuinely stronger_ than
**`ai_lookahead`** (the bar, per [D-7]; `ai_strategist` is only a secondary
reference) — the ambitious, uncertain part.

> **Architecture finalized in [D-19]** (scope-grounded against code + adversarially
> verified, the way [D-12] grounded Phase 1). **PettingZoo AEC**, one learner seat
> external + 7 seats in-process; a **persistent Node env-server** over a local binary
> socket (NOT per-step JSON — [D-3] trap); policy **reuses the `EdgePolicyNet` trunk +
> per-edge head** with a fresh scalar critic; the **observation IS the v2 encoding**
> ([D-18]). **Four decisions (Ivan, 2026-06-25):** (1) **warm-start from v2-BC + a short
> from-scratch control**; (2) **full 8-FFA vs a heterogeneous PFSP league from step one**
> — _deviates from the old 3–4p-symmetric task below_, grounded in [D-15] (mirrors
> turtle); (3) **sparse terminal-win reward first**, annealed potential-based shaping
> only if too slow (placement = the ELO trap); (4) **fixed env-step budget + kill
> threshold**, sized after the throughput probe. **Three verification findings:** the
> throughput bottleneck is the **in-process heuristic opponents, not the wire**
> (~1.7–5 ms/learner-step; reachability UNPROVEN until the probe runs); the variable-
> length edge head needs **pad-to-validated-`MAX_EDGES` + mask** (MaskablePPO wants a
> fixed Discrete); and a **gate-breaking SB3→EdgePolicyNet repack gap**
> (`export_weights.py` `getattr`s a bare `EdgePolicyNet`) that must be built + parity-
> asserted or the graded bot ≠ the trained policy.

**Tasks — first tracer slice (smallest end-to-end; steps 1–3 are decision-independent
and de-risk the two biggest unknowns).**

- [x] **(1)** Node env-server (`scripts/ppo-env-server.mjs` + `scripts/lib/{ppo-env,obs-frame,ppo-socket-worker}.mjs`)
      — **done 2026-06-25.** Lower-risk seam than editing `runBotTurn`: reuse `runMatch`
      **verbatim** and inject the learner as a synchronous bot-fn shim (`runBotDirect` already
      calls bot fns sync). The shim encodes via `encodeObservationForInference`, emits a
      self-describing binary frame (header + the corpus's f32/i32 tensor bytes — **no mask
      blob**, the inference encoder emits only legal edges ⇒ implicit all-ones), and blocks on
      an i32 index. The sync blocking read (brief risk #1) is isolated to a **worker thread that
      owns the socket** while the main thread parks on `Atomics.wait`. End-to-end transport
      proven by `scripts/ppo-env-smoke.mjs` (`npm run ppo:env-smoke`).
- [x] **(2)** Cross-bridge **action-encoding parity test** (`tests/ml/ppo-action-parity.test.js`,
      11 cases) + env-core oracle (`tests/ml/ppo-env.test.js`, 9 cases) — **green 2026-06-25.**
      Action source is always the encoder's own `moves[]` (never a fresh `getValidMoves`); the
      suite asserts the attack ordering coincides with `getValidMoves`, STOP is the unique last
      slot, `decodeAction(enc, argmax(logits))` reproduces `ai_bc` exactly (bridge-decode ==
      shipped-bot decode), and the frame round-trips byte-for-byte. The integration oracle
      confirms a learner reproducing `ai_bc` yields a final state byte-identical to a pure
      `runMatch` (move-for-move, RNG and all) at three seats.
- [x] **(3)** **Throughput probe** (`scripts/ppo-throughput-probe.mjs` +
      `lib/ppo-probe-core.mjs`, `npm run ppo:throughput-probe`) — **done 2026-06-25, GREEN
      ([D-20]).** Local (Mac, 8-core) realistic league = **644 steps/s single-thread, 1,933 @4
      workers** → **~84M env-steps in a 12h unit** (~40–80× the ≳1–2M bar); reachability PROVEN,
      the in-process-opponent cost is not a blocker. Measures the real PPO model (terminate the
      episode at learner elimination, not game-over) via `runMatch`'s `onTurn`. Re-confirm on
      shodan before locking the budget.
- [x] **(4)** Python `[rl]` deps (`stable-baselines3`, `sb3-contrib`, `pettingzoo`) +
      minimal env. **`MAX_EDGES` validated 2026-06-25 ([D-20]): observed p100 ≈ 26
      (p99 15, mean ~5, zero overflow over ~100k decisions) → use `MAX_EDGES = 64`** (margin;
      D-19's ~64–128 was conservative, far under sb3-contrib #247's ~1400).
      **Scaffolded 2026-06-25:** new in-repo package `ml/dicewars_ppo/` — `constants` (the v2
      wire/encoding contract + `MAX_EDGES`), `wire` (Python port of `obs-frame.mjs` + socket
      framing), `env_server` (launch/supervise `ppo-env-server.mjs`), and `env.DiceWarsEnv`
      (`Discrete(MAX_EDGES)` + `action_masks()`, padded v2-tensor `Dict` obs, sparse terminal-win
      reward). **Realized as a single-agent `gymnasium.Env`, not a PettingZoo AEC env** — the
      env-server runs all opponent seats in-process and exposes only the learner, so a plain
      masked Gym env is what MaskablePPO consumes (refines D-19's wording; holds for the whole
      phase since PFSP snapshots also run in-process). `[rl]` extra added to `pyproject.toml`.
      Cross-language wire parity is green two ways: a hermetic byte-exact golden-fixture test
      (`tests/test_ppo_wire.py`) and a live 132-decision run against the real Node server. The
      end-to-end Gym smoke (`tests/test_ppo_env.py`) runs on shodan once `pip install -e .[rl]`.
      **Merged 2026-06-25 (#58, `b8b91d1`)** with a review-pass hardening: bounded `recv_frame`
      length prefix (OOM/desync guard), reap-safe `EnvServerProcess.close()` + a `weakref.finalize`
      GC backstop against orphaned Node children, and a hermetic env/socket unit-test tier wired
      into `ml-ci.yml` (gymnasium installed there; the live smoke still skips, no `node` in CI).
- [x] **(5)** Custom SB3 `MaskableActorCriticPolicy` (`ml/dicewars_ppo/policy.py`) — EdgePolicyNet
      trunk + per-edge head as the actor, fresh scalar critic off `ctx`; overrides
      `forward`/`evaluate_actions`/`predict_values`/`get_distribution` to gather padded-`MAX_EDGES`
      logits straight from the obs `Dict` into a `MaskableCategorical` (the ragged per-edge head
      doesn't fit SB3's `features_extractor→action_net` mold). **Warm-start** (`warm_start_from_bc`
      / `load_bc_checkpoint`) loads trunk + `edge_head` from the v2-BC checkpoint, asserting
      `encoding_version == 2` + v2 feature widths; the **gate-breaking repack gap ([D-19]) is
      closed up front** by `repack_to_bc_checkpoint` (actor → bare-`EdgePolicyNet` `.pt`) with a
      round-trip parity test. The edge-head gather was extracted into
      `EdgePolicyNet.edge_logits_from_context` so the BC forward/ONNX export and the PPO actor share
      one source of truth (behavior-preserving — BC `test_model`/`test_export_onnx` green, ONNX
      trace unchanged). **Validated on shodan 2026-06-25** (branch `ml-bot/phase3-ppo-policy`):
      ruff clean, 12 BC-parity + 8 new hermetic policy tests pass, and the **real deployed
      `v2-base` checkpoint** warm-starts, repacks byte-identically, and drives the live Node
      env-server through a full episode picking only legal actions. _Hermetic policy tests gated on
      sb3-contrib/gymnasium (run on shodan, skip in BC CI like the live env smoke)._ **Merged
      2026-06-25 (#59, `a5b2bb8`).**
- [~] **(6)** Tiny tracer PPO run (`ml/dicewars_ppo/train_tracer.py`) — warm-start the policy from
  the v2-BC checkpoint, run `MaskablePPO` over `DiceWarsEnv` vs a **fixed seed-pure heterogeneous
  JS field** (`ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive`, no PFSP/snapshots yet)
  with the **sparse terminal-win reward** ([D-19] decision 3), a handful of updates, then **repack**
  the trained actor to BC format and verify it reloads into a bare `EdgePolicyNet` (the step-7
  target). Low default LR protects the warm start; `--freeze-trunk` trains the critic only.
  **Folded in the deferred `truncated`-vs-`terminated` wire fix:** a new `truncated` i32 header
  field (frame 44→48 bytes) marks a `maxTurns` stalemate cap as a Gym **truncation** (SB3 bootstraps
  `V(s)`) vs a `winner=-1` mid-game elimination (a genuine terminal) — computed in
  `runSelfPlayEpisode` (`finalState.phase !== GAME_OVER`), carried on the wire, surfaced by
  `step()`. **Validated on shodan 2026-06-25** (branch `ml-bot/phase3-ppo-tracer-run`): ruff clean;
  30 wire/env/policy + 1 live env smoke pass; the run completes 4 updates (critic
  explained-variance → 0.74), repacks + reloads export-ready, and `--freeze-trunk` preserves the
  warm-started actor byte-for-byte (22 tensors). JS suite (obs-frame + ppo-env, +truncation test)
  green. _PR pending._
- [~] **(7)** **Repack → export → register → gate:** SB3 sub-modules → bare BC-format
  `EdgePolicyNet` `.pt` (with parity assertion) → `export_weights.py` → regenerated
  JS↔Py fixture → register via `makeBC({policy})` → `arena:sweep` win% vs
  `ai_lookahead@596f781` with 95% CIs. **JS-side gate scaffolded 2026-06-25** (the
  Python repack/export already worked unchanged — proven on shodan in step 6). What
  landed and how to run it:
  - **Export recipe (torch box).** `export_weights.py` consumes the repacked PPO
    checkpoint as-is (it's a bare `EdgePolicyNet` ckpt; the extra `ppo_*`/`teacher`
    provenance keys are ignored, `selection_metric` is `None`). Wired as
    `npm run ppo:export` (= `python -m dicewars_bc.export_weights --ckpt
checkpoints/ppo-tracer.pt --out ../src/ai/ppoPolicyWeights.js --fixture
../tests/fixtures/bc/ppoForwardCases.json`). Covered by `ml/tests/test_export_weights.py`
    (torch-only, repack-format incl. provenance keys + v2 widths — runs in the BC CI tier).
  - **Register + gate (here, no GPU).** `npm run ppo:gate` (`scripts/ppo-gate.mjs`)
    dynamic-imports the exported weights, runs a **mandatory parity pre-flight** (the
    shared `scripts/lib/load-bc-policy.mjs` — also now backs the capacity probe),
    registers the net via `makeBC({ policy })` (the exact in-browser path), and runs a
    seat-fair 8-bot FFA sweep reporting candidate & `Lookahead` win% with 95% CIs **plus
    the paired per-run Δwin%** and a **BEAT / TIE / BEHIND** verdict (`scripts/lib/ppo-gate-core.mjs`).
    Gate PASSES only on **BEAT** (paired Δ CI strictly above 0). Judge on **win%, not
    ELO**. Tests: `tests/scripts/{loadBcPolicy,ppoGateCore}.test.js` + `tests/ai/ppoForward.test.js`
    (PPO parity, skips until the export artifacts exist).
  - **Stand-in validated on this Mac (2026-06-25):** `ppo-gate.mjs --weights
src/ai/bcPolicyWeights.js --fixture …/forwardCases.json` reproduces the known BC
    anchor (≈13% vs Lookahead ≈18%, parity 2.4e-5, STOP ≈52%) → the whole
    repack→export→register→gate machinery is proven.
  - **First REAL gate run (2026-06-25, on shodan).** Regenerated `checkpoints/ppo-tracer.pt`
    (`train_tracer --timesteps 2048`, the step-6 artifact wasn't kept), exported → `npm run
ppo:gate` over **3040 seat-fair games**: PPO **11.5 ± 1.3%** vs Lookahead **15.1 ± 1.1%**,
    paired **Δ −3.6 ± 1.7 pp [−5.3, −1.9]** → ❌ **BEHIND** (parity 3.0e-5, STOP 55%, atk-win 81%).
    Exactly the tracer expectation (≈BC, BEHIND the bar). Loop closed end-to-end on a real
    trained policy; the **BEAT** that actually closes step 7 is the scaling work below. See LOG.
  - **Bar pin:** in-repo `ai_lookahead` differs from `596f781` only in comments
    (verified `git diff`), so it is the behavioral `@596f781` bar (as RESULTS.md
    already treats it).
  - **Registration scope (decision):** the gate harness registers the candidate
    **dynamically** via `makeBC({policy})`; a **permanent** `src/arena/builtInBots.js`
    entry (which the plain `arena:sweep` reads) is deferred to **Phase 4**, gated on the
    bot actually clearing BEAT — shipping a tracer-strength net into the field would
    dilute the registry. A static import of the not-yet-existing `ppoPolicyWeights.js`
    would also break the build/suite; the dynamic harness is the green, honest path.
  - **Expectation:** the _tracer_ policy is a loop-closer, not a strength run — it should
    land ≈ the BC clone (TIE/BEHIND). A real **BEAT** is the Phase-3 scaling goal below.

**Tasks — scaling (after the tracer slice closes the loop). Design + sequencing fixed in [D-22].**

- [x] **(A) Fixed-field diagnostic gate — FIRST, zero new code ([D-22] decision 3). ✅ PASSED 2026-06-27.** Scale the
      existing `train_tracer.py` run on the fixed heterogeneous field (no PFSP) with **learning-enabled
      HPs** (its defaults are tracer-low — `lr=1e-4`, `ent_coef=0`, 2048 steps — and won't learn by
      design), then `npm run ppo:export` + `npm run ppo:gate`. Answers the one binary unknown cheaply:
      _does PPO move past the BC ceiling (12.5%) toward Lookahead at all?_ A flat result is the plateau
      kill-signal (reward/credit-assignment/encoding, not opponent distribution). **Limitation:**
      `train_tracer` has no checkpoint/resume/logging and uses `DummyVecEnv` (sequential) — fine for a
      bounded diagnostic, but task (E) is the prerequisite for the long run.
      **DONE 2026-06-27 — emphatic PASS.** The 1M-step run (warm-start v2-BC, `lr 2.5e-4`/`ent_coef
0.01`, on shodan via a teardown-immune schtasks task) scored `npm run ppo:gate` **Δ +33.4 ±2.4
      [31.0, 35.8]** (PPO 45.2% vs Lookahead 11.8%, 3040 seat-fair games) → the **first BEAT** of the
      D-7 headline gate, a ~37-pt move off the −3.7 BC anchor. Weights = **PR #63**. **Caveat:** 4 of
      the 7 gate opponents (incl. all 3 strong ones) were training opponents → partly fixed-field
      _exploitation_ (also beats the 3 held-out bots → partial generalization); this green-lights task
      B. Full record: RESULTS.md + LOG.md + [D-23].
- [~] **(B) PFSP opponent league ([D-22]) — Node-resident. 🔵 B1–B4 DONE 2026-06-27 (PRs #62/#64/#65 + PFSP sampling on); B5 next → [D-23].** New `scripts/lib/ppo-league.mjs` (pool +
  seeded `mulberry32` sampler + win-rate book) inside the env-server; the loop draws
  `league.draw(seed)` per episode (replaces the static `opponents` const at `ppo-env-server.mjs:259`).
  **Fixed-field is the empty-pool degenerate mode of this same pipeline** — so (A) and (B) share
  code. Snapshots: Python SB3 callback `repack → export_weights` (weights-only — no per-snapshot
  fixture needed, [D-22] decision 6) → atomic `manifest.json`; Node hot-loads via `makeBC({policy})`
  (fresh filename per snapshot — ESM URL cache). Sample `w(S)=max(ε,1−learnerWinRate(S))^k`; reserve
  **R≈3–4 aggressive baselines every game** ([D-15] turtle defense); hold `player_count` constant.
  **Win-rate attribution is the real work item** — pairwise/placement-relative, **excluding
  `maxTurns` truncations**. Honor: freeze `ENCODING_VERSION`; dedup via `uniquifyNames` `#N`;
  re-probe decisive-rate + throughput on a snapshot-heavy field before locking the budget.
  _Open: per-worker vs shared-disk-global stats — lean shared-disk-global, pluggable ([D-22])._
  **Build sequence — scoped in [D-23]** (verifier-corrected: `count = playerCount−1 = 6`, so R=3
  leaves 3 PFSP seats; baselines threaded from the resolved `opts.opponents`; extend the
  `EnvServerProcess` signature; GC evicted snapshot `.js` files): **B0 ✅** **PR #62 (hard prereq)
  MERGED** (`snapshot-manifest`/`-store` flags + `ENCODING_VERSION=2` freeze deferred to B3, when
  snapshots first need them) → **B1 ✅** empty-pool league `== task A` (content-identical parity —
  the milestone; PR #64) → **B2 ✅** per-seat `seatBeat[]` on both outcome shapers
  (`summarizeOutcome` from placements, `eliminationOutcome` synthesized from `coElimSeats`) +
  id-keyed win-rate book (`recordResult` credits, `winRate(id)`; truncations excluded;
  zero-decision episodes booked per [D-23] open-Q2) → **B3 ✅** snapshot
  pipeline: NEW `ml/dicewars_ppo/snapshot_callback.py` (`SnapshotCallback` → repack →
  `export(…, fixture_path=None)` → fsync-then-`os.replace` atomic `manifest.json`); league `refresh()`
  polls the manifest at each episode boundary, `makeBC`-loads new snapshots (fresh filename → ESM URL
  cache), FIFO-evicts past `poolCap` + GCs the `.js`; env-server `--snapshot-manifest`/`-pool-cap`
  flags; `train_tracer` `--snapshot-dir`/`-every`/`-pool-cap`; `EnvServerProcess` forwards them. _(B3
  deviations from [D-23]: `--snapshot-store` deferred to B6 with `SharedDiskStore`, not a dead flag
  now; `--snapshot-pool-cap` added/forwarded since the pool cap is the consumer setting; the producer
  manifest is append-only — entries are tiny, prune later if needed. `draw()` does NOT sample the pool
  yet — that is B4 — so B3 is behavior-preserving for episode outcomes.)_ → **B4 ✅** PFSP weighting
  **on**: non-empty-pool `draw(seed)` seeds a `mulberry32` (extracted to NEW `scripts/lib/mulberry32.mjs`,
  re-exported from `ppo-probe-core.mjs`) and seats `count−R` snapshots by `w(S)=max(ε,1−winRate)^k`
  (`ε=0.05`,`k=2`; cold-start `winRate=0`→max weight; ε-floor keeps total>0 so a mastered snapshot is
  never starved) **with** replacement + `R=3` DISTINCT aggressive baselines (CSV ids minus `ai_bc`)
  **without** replacement, then Fisher-Yates shuffles opponent→seat so neither group binds to fixed
  turn-order seats. **Empty pool stays byte-identical to task A.** Env-server
  `--reserve-baselines`/`--pfsp-epsilon`/`--pfsp-k`; `train_tracer`/`EnvServerProcess` forward them
  (only with `--snapshot-dir`, since the knobs only bite a non-empty pool). _(B4 deviation from [D-23]:
  `mulberry32` extracted to its own module instead of imported from `ppo-probe-core.mjs`, so the league
  doesn't pull the benchmark tool/env runner into its module graph — probe-core re-exports it, so its
  test is unchanged.)_ First live exercise on shodan at B5. → **B5** throughput/decisive-rate re-probe
  on a snapshot-heavy field; re-validate `R` against the real `count` → **then** lock the env-step
  budget → **B6** persistence (`toJSON()/restore()`) + `SharedDiskStore` (with task E).
- [ ] **(C)** Scale envs across cores; add the short **from-scratch control** run ([D-19] decision 1).
- [ ] **(D)** Add **annealed potential-based reward shaping** (Δlargest-group/territory/dice/elims,
      `F = γΦ(s′)−Φ(s)`, env-side in JS) only if terminal-only learning is too slow.
- [ ] **(E) shodan training-ops (prerequisite for the long BEAT run):** schtasks-wrapped WSL launch
      (the only disconnect-surviving pattern); idempotent checkpoint/resume of policy + optimizer +
      VecNormalize + RNG + step + pool; TensorBoard + a flat CSV that survives sessions; swap
      `DummyVecEnv` → `SubprocVecEnv` for real cross-core parallelism.

**Acceptance criteria.**

- Training is reproducible (seeded) and logged.
- Gated on `arena:sweep` **win%** vs **`ai_lookahead`** (pinned `596f781`, per
  [D-7]) with 95% CIs at each checkpoint. Judge on **win%, not ELO** — ELO is a
  trap for this bot (it rewards survival/placement; see `RESULTS.md`).

**Go/No-Go gate (and kill criterion).**

- **Statistically significant win-rate edge over `ai_lookahead`** (the bar, per
  [D-7]) → proceed to Phase 4 with the RL bot as the candidate.
- **No significant edge after a few training iterations** → treat as a **plateau
  signal** (exactly what the Risk thesis hit). Don't pour unbounded compute in.
  Record in `DECISIONS.md`; fall back to shipping the best of Track A / Phase 2.

---

## Phase 4 — Ship the strongest bot · ⬜ Not started · ~2–4 days on top of the winner

**Objective.** Wire whichever candidate won `arena:sweep` most decisively (Track A
search bot, the imitation net, or the RL net) as a real shipped bot.

**Tasks.**

- [ ] Finalize as a built-in or community bot running **purely in-browser** (ONNX
      Runtime Web for a learned net; nothing extra for the JS search bot).
- [ ] Add to the tournament pool (`npm run tournament`).
- [ ] Document the bot in `docs/BOT_GUIDE.md` and update `README.md`.
- [ ] Final `arena:sweep` + tournament numbers recorded in `RESULTS.md`.

**Acceptance criteria.** The bot is selectable in-game, runs in-browser, and its
strength vs the field is recorded.

**Done = the dashboard in `README.md` shows the winner shipped.**

---

## Effort summary

| Track / milestone                              | Effort             | Compute               |
| ---------------------------------------------- | ------------------ | --------------------- |
| Track A search bot (Phase 0)                   | 2–4 days           | none, no GPU          |
| End-to-end pipeline via imitation (Phases 1–2) | ~1.5–3 weeks       | CPU only              |
| Self-play PPO that _plausibly_ wins (Phase 3)  | 1–2 months focused | single-GPU days–weeks |

**Likely win in days (search); uncertain win in weeks-to-months (learned RL).**
