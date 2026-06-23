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
  `README.md`, and a **hermetic 27-test pytest suite** (builds a tiny synthetic corpus
  — no real data needed; torch/onnxruntime tests skip if absent).
- **Verified end-to-end on the real 300-game sample corpus** (24,254 Lookahead-seat
  steps): val move-match climbed **33% → 47% in 8 untuned CPU epochs** (random
  baseline ≈14% over ~6.9 edges/step). ONNX export → **ORT parity max |Δlogits| ≈
  5e-7**, dynamic-edge inference confirmed, sidecar contract written. 27/27 green;
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

- None structural. (A hand-computed expected value in one loss test had a sign slip;
  the cross-check against `torch.cross_entropy` caught it — implementation was right.)

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
