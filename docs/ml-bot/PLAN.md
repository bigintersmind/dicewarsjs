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

- [ ] **(1)** Node env-server (`scripts/ppo-env-server.mjs`): one
      `createGame({seed, recordHistory:false})`, `matchRunner.js` `runBotTurn` inverted to
      yield to a socket on the learner's turn and run the other 7 seats in-process; emits a
      compact binary obs frame (reuse `encode-corpus.mjs`'s f32/i32 CSR layout) + `moves[]` + mask; blocks on an i32 action index.
- [ ] **(2)** Cross-bridge **action-encoding parity test** (new fixture): on fixed seeds,
      the sampled index → the encoder's own `moves[]` → the correct `{from,to}|null` —
      **never** a fresh `getValidMoves` (orderings differ). Green **before** any training.
- [ ] **(3)** **Throughput probe** with a no-op learner against the **real lookahead
      league** — measure learner-steps/sec for 1 vs N envs. Acceptance = the steps/sec
      needed to reach the PPO step budget within the compute cap. Sizes decision (4).
- [ ] **(4)** Python `[rl]` deps (`stable-baselines3`, `sb3-contrib`, `pettingzoo`) +
      minimal PettingZoo AEC env; validate `MAX_EDGES` against selfplay's p100 action count.
- [ ] **(5)** Custom SB3 `ActorCriticPolicy` (EdgePolicyNet trunk extractor + padded-
      `MAX_EDGES` `MaskableCategorical` + fresh scalar critic); **warm-start** trunk +
      `edge_head` from the v2-BC checkpoint, assert `encoding_version == 2`.
- [ ] **(6)** Tiny tracer PPO run: 1–2 envs, 1 learner + 7 fixed JS baselines (no
      snapshots/PFSP yet), terminal-win reward only, warm-started, a handful of updates.
- [ ] **(7)** **Repack → export → register → gate:** SB3 sub-modules → bare BC-format
      `EdgePolicyNet` `.pt` (with parity assertion) → `export_weights.py` → regenerated
      JS↔Py fixture → add to `src/arena/builtInBots.js` via `makeBC({policy})` →
      `npm run arena:sweep` win% vs `ai_lookahead@596f781` with 95% CIs.

**Tasks — scaling (after the tracer slice closes the loop).**

- [ ] **PFSP opponent league** — snapshots exported to the `bcForward` JS weight format and
      run **in-process** (never evaluated back in Python); sample ∝ win-rate vs the current
      learner; fixed strong baselines in every game keep games decisive ([D-15]).
- [ ] Scale envs across cores; add the short **from-scratch control** run (decision 1).
- [ ] Add **annealed potential-based reward shaping** (Δlargest-group/territory/dice/elims,
      `F = γΦ(s′)−Φ(s)`, env-side in JS) only if terminal-only learning is too slow.
- [ ] **shodan ops:** schtasks-wrapped WSL launch (the only disconnect-surviving pattern);
      idempotent checkpoint/resume of policy + optimizer + VecNormalize + RNG + step + pool;
      TensorBoard + a flat CSV that survives sessions.

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
