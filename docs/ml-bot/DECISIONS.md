# Decisions — ML / Self-Play Bot

Lightweight ADR (Architecture Decision Record) log. Each entry: the decision, the
context, why, and the alternatives rejected. Add an entry at each real
fork-in-the-road. Supersede rather than delete — keep the history.

Status values: **Accepted** · **Proposed** · **Superseded by D-x** · **Revisited**

---

## D-1 — Search first, learning second · Accepted (2026-06-21)

**Decision.** Build a pure-JS chance-node search bot (Track A) _before_ investing
in self-play RL (Track B), and gate every step on `arena:sweep` vs `ai_strategist`.

**Why.** `ai_strategist` is a strong exact-odds baseline. Prior art on this game
class (KTH Risk AlphaZero/ExIt thesis; Moy & Shekh hex-wargaming) shows naive
self-play RL losing to good heuristics until bootstrapped. Search reuses the eval
and odds we already have, likely wins in days, and tells us early whether the
problem is even tractable before spending GPU-weeks.

**Rejected.** Jumping straight to RL — high cost, high risk of plateauing at or
below the heuristic with no cheap early signal.

---

## D-2 — Model-free PPO, not AlphaZero / MuZero · Accepted (2026-06-21)

**Decision.** If we train a learned bot, use **self-play PPO with action masking**
(SB3 MaskablePPO first; CleanRL/RLlib for leagues).

**Why.** The game is **stochastic** (dice = chance nodes) **and 8-player
free-for-all** (not 2-player zero-sum). PPO absorbs dice variance natively, handles
N agents via parameter sharing, and consumes the `getValidMoves` mask directly.

**Rejected.**

- `alpha-zero-general` — hard-coded 2-player/deterministic/perfect-info.
- `muzero-general` — explicitly lists >2 players _and_ stochasticity as
  unsupported; and MuZero's model-learning is wasted when we already have a fast
  exact simulator.
- OpenSpiel bundled AlphaZero — game layer supports chance + multiplayer, but the
  _trainer_ is 2-player-zero-sum only.

---

## D-3 — JS engine is the single source of truth; Python for training only · Accepted (2026-06-21)

**Decision.** Keep the game engine in JS. Bridge to Python for _training only_ via
a PettingZoo AEC env (subprocess/socket) wrapping the existing arena harness.

**Why.** The JS engine is the product. Re-porting it to Python duplicates logic
and invites drift (the trained bot would play a subtly different game than it
ships into).

**Rejected.**

- Port the engine to Python (fastest training, but drift risk on the product).
- Pure-tfjs training (avoids the bridge, but slow training + DIY RL ecosystem).

**Open risk.** The subprocess/socket bridge adds per-step IPC latency that can
dominate wall-clock — mitigate with many parallel env workers and a compact
(non-JSON-per-step) state. Revisit if throughput is unacceptable.

---

## D-4 — Deploy via ONNX Runtime Web · Accepted (2026-06-21)

**Decision.** Train in PyTorch → export to ONNX → run in-browser inference via
ONNX Runtime Web, wrapped as a normal `(BotState) → {from,to}|null` bot.

**Why.** It's the robust, future-proof deployment path and keeps the shipped bot a
first-class in-browser bot like every other. A small MLP/GNN policy is trivially
WASM-fast. **TensorFlow.js** is the fallback (pure-JS deploy, or no-Python
train+infer for a small net).

---

## D-5 — Evaluation gate = `arena:sweep` (seat-controlled, with CIs) · Accepted (2026-06-21) · opponent amended by [D-7](#d-7--the-bar-is-lookahead-2532-not-strategist-1418--accepted-2026-06-21--amends-d-5)

**Decision.** "Better" means a statistically significant win-rate/ELO edge on
multi-seed `arena:sweep`, controlling seat/turn-order. _The opponent of record was
`ai_strategist`; **[D-7] re-baselined it to `ai_lookahead`** (the actual field
leader). The method below is unchanged — only the bot being beaten changed._

**Why.** Battles are high-variance (dice). Single-seed results are noise.
Turn-order is shuffled, so seat effects must be controlled to measure skill, not
first-mover luck.

---

## D-6 — Bot convention: legacy for the search baseline, modern for the learned bot · Accepted (2026-06-21)

**Decision.** Write the **search baseline (`ai_expectimax`, Phase 0)** in the
**legacy** convention — `(game) → 0|void`, mutating `game.area_from`/`area_to`,
reading `game.adat`/`get_pn()` — like every other built-in. Write the eventual
**learned bot (Phase 4 deploy, per [D-4](#d-4--deploy-via-onnx-runtime-web))** in the
**modern** convention — a pure `(BotState) → {from,to}|null`.

**Why.** The two conventions are interchangeable at the arena boundary
(`adaptLegacyBot` synthesizes a legacy view from `BotState`), so this is about
fit, not capability:

- The search baseline exists to be measured against `ai_strategist` (D-5). Writing
  it legacy-style lets it mirror the sibling's exact data-access patterns and reuse
  the same connectivity economics — apples-to-apples is the whole point.
- The learned bot is net-new, has no sibling to mirror, and benefits from the
  clean read-only `BotState` contract (the documented public bot API). It carries
  no reason to adopt the mutable legacy view.

**Caveat (informational).** The synthesized legacy view is lossy in two fields —
`adat[i].size` is hard-coded to `1` ("exists"), and turn order `jun` is synthetic.
`ai_expectimax` (and `ai_strategist`) read neither: both rebuild ownership/dice/
adjacency and compute largest-connected-group themselves. A future legacy bot that
relied on real territory size or seat order would get degraded data — another
reason new bots should prefer the modern convention.

**Rejected.** Writing the search baseline in the modern convention — would have
diverged from `ai_strategist`'s structure and muddied the head-to-head comparison
the whole Phase 0 gate depends on.

---

## D-7 — The bar is `Lookahead` (~25–32%), not `Strategist` (~14–18%) · Accepted (2026-06-21) · amends [D-5](#d-5--evaluation-gate--arenasweep-vs-ai_strategist-with-cis)

**Context.** The plan everywhere named `ai_strategist` as "the current strongest
bot" and the bar to beat. The Phase 0 baseline sweep (see `RESULTS.md`,
2026-06-21) contradicts that premise: **`ai_lookahead` tops the 7-bot FFA at
~26–32%, far ahead of `ai_strategist` at ~14–18%.** Lookahead — a depth-1
chance-node searcher — is already the strongest built-in by a wide, significant
margin.

**Decision (accepted by Ivan, 2026-06-21).** **`ai_lookahead` is the incumbent to
beat** for any new bot (search or learned). A candidate "wins" the gate only when
it beats `Lookahead` with a statistically significant win-rate/ELO edge on
seat-controlled `arena:sweep` (the D-5 method, just with Lookahead as the
opponent of record). **Pin `Lookahead` like the old baseline: it last changed at
`596f781`** (PR #30) — record that SHA in the "Lookahead @" column of `RESULTS.md`,
and re-baseline if Lookahead changes. Implications:

- The Phase 0 "does search beat the baseline?" question is **already answered _yes_**
  by a sibling search bot — so a default-weight Expectimax losing was _not_ a
  Track-B-kill signal (D-1's "search can't win here" trigger does not fire).
- Phase 0 / any phase "succeeds" only by producing the **new field-strongest** bot
  (beating Lookahead), not merely clearing the lower Strategist bar.
- The tuned Expectimax landed in [D-8] (rank 1–2 by ELO, beats Strategist) **does
  not pass this gate** — it trails Lookahead on win% (~14–16% vs ~25%). It ships as
  a genuine improvement, but Phase 0's headline gate is now **open** against
  Lookahead.

**Strategist's ongoing role.** Kept as a **secondary reference** (a known, stable
quantity) reported alongside Lookahead in `RESULTS.md` rows — useful for continuity
and for sanity-checking, but no longer the bar that decides "shipped / proceed."

**Rejected.** Continuing to treat Strategist as "strongest" — it demonstrably
isn't, and optimizing against a beaten baseline understates the difficulty and
risks shipping a bot weaker than one we already have.

---

## D-8 — Phase-0 weight-tuning hit a structural ceiling: a fixed threshold can't both press and stay patient · Accepted (2026-06-21)

**Context.** Tuning `ai_expectimax`'s existing scalar params (sweeping
`attackThreshold` × `threat` × weight perturbations vs Strategist) lifted it from
the worst "smart" bot (7.1% win, ELO 1140, loses everything) to Strategist-class —
**but the improvement was entirely on consistency, not closing.** Across every
viable config and every seed range, the tuned bot beats Strategist on **ELO and
head-to-head placement** (p ≈ 0) yet **ties-or-trails on outright win%** (best
~13.8% vs Strategist ~15.3%), and none approach `Lookahead` (~25%). See
`RESULTS.md` 2026-06-21.

**Decision.** Land the best all-around config (`attackThreshold: 0.3`,
`threat: 2.0`) as the shipped default — a large, significant net improvement — and
treat the Phase-0 gate as **partially met** (ELO/placement edge, no win% edge), per
Ivan's call. **Stop weight-tuning the existing structure**: the data shows a single
_fixed_ `attackThreshold` cannot beat Strategist on win%, because the same patience
that prevents FFA over-extension also prevents pressing to close out won games.
Strategist is boom-or-bust (wins more, places worse); patient Expectimax is steady
(places better, wins less).

**Why this matters for the roadmap.** The eval _terms_ are sound — Expectimax ties
Strategist 1v1 and out-places it in the FFA — so the bottleneck is the **decision
policy** (when to attack / stop / press), not the board valuation. The proven fix
is a **posture-adaptive threshold + a press/elimination term**, exactly what makes
`Lookahead` (depth-1) the field leader at ~32%. This is encouraging for Track B:
the lever is a _policy_, which is precisely what a learned net optimizes. It also
sharpens D-1/D-7 — "search first" already succeeded (Lookahead); the open frontier
is learning (or hand-coding) a better _policy_ than a fixed heuristic threshold.

**Rejected.** (a) Continuing to sweep the existing scalar params — the win% ceiling
is structural, so more tuning won't cross it. (b) Adding the structural
press-mechanism in this pass — that is a redesign beyond "iterate the eval weights"
(the Phase-0, step-3 scope); it is the natural next iteration, recorded here so it
isn't lost.

---

## D-9 — Press-mechanism built into `ai_expectimax`: reaches parity with Lookahead (significant placement edge, win% tie) — gate still open · Accepted (2026-06-22) · follows [D-8](#d-8--phase-0-weight-tuning-hit-a-structural-ceiling-a-fixed-threshold-cant-both-press-and-stay-patient)

**Context.** [D-8] named the structural fix for Expectimax's win% ceiling — a
**posture-adaptive threshold + elimination term** (the `ai_lookahead` mechanism) —
and deferred it as "the natural next iteration." This is that iteration.

**Decision.** Build the press-mechanism into `ai_expectimax` and land the tuned
config as the new shipped default:

- **Posture-adaptive attack threshold** (`postureThreshold`): an inverted-U (∩) bar
  (high/patient in the middle, low/decisive at both strength extremes) —
  PRESS (`pressThreshold`, negative) when dominant (dice share > `pressDiceShare`,
  or ahead in a heads-up duel); WEAK (`weakThreshold`, low) when weak in a crowd;
  steep BASE (`baseThreshold`) otherwise. Replaces the single fixed `attackThreshold`
  (kept as a nullable fixed-bar override for tests/tuning).
- **Strengthened elimination term** (`activeRival`): already flows through the
  chance-node search as a win-prob-weighted elimination bonus; tuned, not the order-
  of-magnitude-too-weak 0.4 it was.
- **Low-odds risk floor** (`lowOddsFloor`/`lowOddsPenalty`): a third ingredient,
  beyond the two D-8 named — mirrors Lookahead's `LOW_ODDS_PENALTY`. Pure expectimax
  under-penalizes coin-flips in a 7-way elimination game (an EV-neutral gamble exposes
  you to the _other_ five rivals); this docks low-win-prob attacks. It was needed to
  close most of the residual gap the posture+elimination terms left.

**Landed config:** `{ baseThreshold: 1.2, pressThreshold: -2.5, weakThreshold: 0.15,
pressDiceShare: 0.38, weakDiceShare: 0.15, activeRival: 2.0, lowOddsFloor: 0.78,
lowOddsPenalty: 5.0, searchDepth: 2, topK: 6 }`.

**Result (3 disjoint-seed × 5600-game seat-fair runs = 16,800 games; see RESULTS).**

- **Win% vs Lookahead: a statistical TIE** — Expectimax 22–23% vs Lookahead
  22.5–23.9% (overlapping CIs across all 3 runs; Lookahead a hair ahead on raw
  outright wins, −0.84% pooled).
- **Placement: Expectimax SIGNIFICANTLY out-places Lookahead** — pooled paired
  51.2%, z = 3.09, **p ≈ 0.002**. It is the more _consistent_ bot.
- **ELO: co-leader** (Expectimax ahead in 2 of 3 runs).
- **1v1 duel: a TIE** (49.5%) — the pre-press shipped default _lost_ the duel
  (45.3%, p = 0.007), so the press-mechanism also fixed the head-to-head deficit.
- Beats `ai_strategist` decisively (22% vs 13–14%).

Net: Expectimax went from rank 6/7 (lost everything, trailed Lookahead by ~10 win%
points) to the **joint-strongest bot in the field**.

**Gate status: the headline gate (a statistically significant WIN% edge over
Lookahead) is NOT met — it is a tie.** Phase 0's headline gate stays **open** on
the win% metric. The bot ships as the new default regardless, because it is a
strict, large improvement over the previous shipped Expectimax (which lost to
Lookahead).

**Key finding for the roadmap.** The same "places better, win% tie" ceiling that
capped Expectimax-vs-Strategist ([D-8]) now caps Expectimax-vs-Lookahead one tier
up. Threshold / elimination / risk-floor / depth tuning converges to **parity**,
not a decisive win — consistent with the prior-art difficulty thesis. Crossing to a
decisive win% edge over Lookahead likely needs a better board **evaluation** or
deeper **search**, not more posture tuning — i.e. **Track B's learned policy** (or
a separate eval rework), which is the open frontier ([D-7]/[D-8]).

**Rejected.** (a) Pushing posture/press params harder — four multi-seed sweeps
converged to the same ~tie ceiling; press beyond −2.5 trades ELO for no win% gain.
(b) Not landing it — config B is strictly stronger than the previous shipped
Expectimax. (c) Claiming the gate met — the win% edge is a tie, not significant;
overclaiming would understate the remaining difficulty.

---

## D-10 — Posture bar gates interior search nodes, not just the root commit: kept as policy-consistent valuation; decoupling A/B deferred · Accepted (2026-06-22) · follows [D-9](#d-9--press-mechanism-built-into-ai_expectimax-reaches-parity-with-lookahead-significant-placement-edge-win-tie--gate-still-open)

**Context.** The PR #39 review (the press-mechanism, [D-9]) flagged that
`postureThreshold` is threaded unchanged into every recursive `search` call, so the
accept gate `best.value > stopValue + threshold` fires at **every** node, not only
the root commit decision. Interior nodes therefore report a value shaped by the
posture bar (in PRESS a node can return a continuation worth up to `|pressThreshold|`
_less_ than stopping; BASE biases the other way), and that value is mixed into the
parent's EV. `ai_lookahead` deliberately does **not** do this — its
`bestContinuationGain` floors continuation at `max(0, …)` (a neutral bar) and applies
posture only at the root (`bestScore > threshold`).

**Decision.** Keep the current behavior and document it accurately, rather than
silently changing a tuned, shipped bot. The honest framing is **policy-consistent
valuation**: the bot's real policy _is_ threshold-gated, so valuing interior nodes
under the same bar predicts what the bot will actually do (stop when attacks don't
clear the bar) better than a neutral max, which would assume a future self that
greedily grabs every positive-EV scrap it won't actually take. The [D-9] config was
tuned with this behavior in place, so changing it would invalidate that tuning. The
`postureThreshold` and `search` doc comments now state this (and the caveat below)
explicitly, replacing the bare "applied at every search node."

**Known caveat.** The bar is the _root_ posture, frozen, applied to deeper boards
whose own posture could differ; a truly policy-consistent valuation would recompute
posture per node. Negligible at the shipped `searchDepth: 2` (a board one ply out
rarely changes posture bucket), but the approximation worsens as depth grows.

**Revisit trigger / deferred A/B.** If `searchDepth` is ever raised, reconsider
decoupling: add an optional `interiorThreshold` param (default = current = the root
bar) and sweep `interiorThreshold: 0` (neutral interior, lookahead-style) against the
default via `_tune.mjs` / `_baseline.mjs --cand`. If neutral-interior wins, flip the
default — decoupling earned with data; if it's a wash, this decision is confirmed
empirically. **Not run now**: at depth 2 the expected effect is marginal (the gate
only changes a node's answer when a follow-up sits inside the threshold band), and it
is out of scope for the PR-#39 review follow-up.

**Rejected.** (a) Decoupling now (neutral interior bar + re-tune) — changes shipped
behavior and invalidates the [D-9] tuning for a marginal expected gain at depth 2;
deferred to the A/B above. (b) Documenting it as deliberate "continuation shaping"
without the policy-consistency rationale or the frozen-posture caveat — that dresses
up a structural side effect as intent; the comments now give both honestly.

---

## D-11 — Eval-rework spike: structural eval terms don't break the parity ceiling; pivot to Track B · Accepted (2026-06-22) · follows [D-10](#d-10--posture-bar-gates-interior-search-nodes-not-just-the-root-commit-kept-as-policy-consistent-valuation-decoupling-ab-deferred)

**Context.** [D-9] left the Phase-0 headline gate open: `ai_expectimax` reached
parity with Lookahead (significant placement edge, win% tie) but no significant
**outright-win%** edge, and concluded that crossing it needs a better board
_evaluation_ or deeper _search_, not more posture tuning. Before committing weeks to
Track B (learned policy), we ran one last _cheap_ Track-A spike (Phase 0.5): is a
win% edge hiding in a better **eval feature set** (not weights)? Approved basket of
three structural terms, each a `DEFAULT_PARAMS` weight defaulting to 0 so
`makeExpectimax()` stayed the D-9 bot until swept: `mergePotential` (latent
unifying-capture income), `fieldRivalIncome` (suppress the trailing field, not just
the leader), `trappedDice` (idle interior strike dice). **Capped at 4 sweep swings.**

**Decision.** **Kill the spike at 2 of 4 swings** — the basket does not cross the
gate — **revert the three dud params** (do not ship inert, known-negative weights),
and **pivot to Track B (Phase 1)**. The earned signal: search valuation is tapped out
at this eval structure.

**Result (see RESULTS 2026-06-22).**

- **Swing 1** (single-term magnitude screen, 1000 games, seed 1): `mergePotential` and
  `trappedDice` are neutral-when-tiny, **harmful-when-grown** (no upside); the only
  statistically real effect was a degradation (`mergePotential 1.0`, paired p=0.0016
  worse). `fieldRivalIncome 0.2` was the lone positive (+0.9% win%, within noise,
  non-monotonic).
- **Swing 2** (focused high-power screen, 3000 games, seed 2): the `fieldRivalIncome
0.2` bump **did not replicate** — at higher power on fresh maps no config beats the
  D-9 baseline (best, 0.25, is dead-even; higher magnitudes significantly worse; both
  pairwise combos underperform). `supportedBorder` (gated on "the first three show
  life") moot.

**Why this matters for the roadmap.** This is the same "places better, win% ties"
ceiling D-8 hit (vs Strategist) and D-9 hit (vs Lookahead), now confirmed a third
context: bolt-on structural eval terms perturb a near-local-optimum eval rather than
break it. Diagnostically the terms are redundant or counterproductive — `mergePotential`
largely re-derives what the chance-search already values, `trappedDice` fights the
income term. **Track-A search has been given a thorough shake (posture, elimination,
risk-floor, depth, and now eval features) and converges to parity.** Crossing to a
decisive win% edge over Lookahead is now firmly Track B's job: a learned policy/eval
([D-7]/[D-1]). Phase 1 (self-play harness hardening) is next.

**Rejected.** (a) Spending Swings 3–4 to reconfirm a dead pattern — the 4-swing cap
was a ceiling, not a quota; two independent seeds at two power levels already agree,
and the terms trend harmful (not merely neutral). (b) A joint base-weight re-tune as a
"last fair shot" — the one stone left unturned, but the terms degrade even at the
frozen D-9 optimum, and D-9 already showed joint weight-tuning converges to parity;
not worth a swing. (c) Shipping the three params at weight 0 "for future use" — dead,
known-negative config surface; the finding is preserved here and in RESULTS, the code
is reverted to the clean D-9 eval.

---

## D-12 — Phase-1 scope corrected by a verified surface-map: history isn't the perf lever, parallelism is greenfield; optimize per-move now + build a committed harness · Accepted (2026-06-22) · follows [D-11](#d-11--eval-rework-spike-structural-eval-terms-dont-break-the-parity-ceiling-pivot-to-track-b)

**Context.** Before writing any Phase-1 (self-play harness hardening) code, we ran a
fan-out **map + adversarial verification** of the whole Phase-1 surface area — 6
subsystem readers + 5 skeptics over the engine, arena, scripts, and ml-bot docs.
Three of the five load-bearing claims the PLAN rested on came back refuted or partial.

**Findings (verified against code).**

- **The O(n²) `history` append is _not_ the throughput lever.** Component microbench at
  realistic game length: per-move cost is dominated by `cloneAreas` + `clonePlayers` +
  7× `findLargestConnectedGroup` (~4.7 µs); the `[...state.history]` spread is ~0.25 µs
  at depth 378 (~19× smaller). Real decisive games average ~378 actions (max ~741) — the
  quadratic term only bites in the thousands. The history fix is worth doing for
  **memory + asymptotic safety** (every retained immutable state holds a growing array)
  and is cheap/low-risk, but it cannot clear the written "≥100 g/s/core" gate
  (Strategist self-play ~77 g/s; the per-move trims are the real lever).
- **Parallel self-play is greenfield.** Zero `worker_threads`/`child_process`/`cluster`
  anywhere; every path is a sequential loop through `runArena` → `runMatch`. The
  "~266 g/s on 4 procs / near-linear" figure came from a **deleted, uncommitted**
  feasibility probe — not reproducible from the tree. Task 5 is build-and-measure, not
  "confirm."
- **The history flag has real non-arena consumers** — the browser `GameController`
  (`:398/:572`, battle animation) and replay/tournament persistence (`createReplay`,
  `run-online-tournament.mjs:178`) read `state.history` — so `recordHistory` must default
  ON (history recorded), with the training harness opting out via `recordHistory:false` to
  stay engine/arena-only. The arena hot loop itself never reads history (safe).
- **Confirmed:** seeding is fully deterministic except the `createGame` `Math.random`
  seed-fallback + the 3 known `Math.random` bots (default/example/adaptive); round-trip
  replay already works today (`replayGame` re-applies _recorded_ actions, proven by
  `GameRunner.test.js:205` — even with a `Math.random` bot). The enabling precondition
  is just "capture an explicit seed" (task 2), plus persisting `dicePerArea` in the
  replay config.

**Decision.**

1. **Optimize per-move allocation now** — promote task 3 (clone/recalc trims) from
   "optional" to a **first-class Phase-1 goal**, since self-play data-gen cost is a real
   Phase-2 risk. Keep the cheap history flag too (memory/safety).
2. **Build a committed, reusable self-play harness** (`scripts/selfplay.mjs` +
   `npm run selfplay`), not a throwaway probe — Phase 2 uses the same harness to
   generate its 100k–1M games. `worker_threads` pool, bot-identifiers-not-closures,
   JSONL streaming, single-threaded deterministic aggregation.
3. **Reframe the Phase-1 throughput gate** from a single "≥100 g/s/core" absolute to
   "near-linear parallel scaling confirmed + per-field before/after numbers recorded."
   `ai_lookahead` (the Phase-2 clone target) is ~4 g/s/core and no engine opt changes
   that — Phase-2 data-gen is parallelism-bound, which the committed harness delivers.

**Why this matters.** The PLAN as written would have spent Phase-1 effort on the wrong
lever (history) and assumed a parallel substrate that doesn't exist. Correcting now
keeps the gate honest and ensures the harness built in Phase 1 is the one Phase 2
actually needs.

**Rejected.** (a) Keep the hard ≥100 g/s/core gate and chase it on the real field —
unachievable for the lookahead-clone field at any engine speed (the bot fn dominates),
so a misleading bar. (b) An internal throwaway `_selfplay.mjs` for Phase-1 numbers only
— wastes the build; Phase 2 needs a real generator. (c) Treat history removal as the
throughput task — measured at ~1–2% of per-move time.

---

## D-13 — Compute topology: distribute data-gen across machines (seed-range shards), train on the GPU box · Accepted (2026-06-22) · follows [D-3](#d-3--js-engine-is-the-single-source-of-truth-python-for-training-only)

**Context.** Track B's cost splits cleanly: Phases 1–2 (self-play game generation /
imitation data) are **CPU/engine-bound and embarrassingly parallel**; Phase 3 (PPO) is
**GPU-bound**. The hardware available is a small personal fleet — several multi-core CPU
machines plus one workstation with a CUDA GPU. (Exact hostnames/specs are kept out of
this public repo; they live in the maintainer's local notes.) The question that prompted
this: are we anchoring on a single machine?

**Decision.**

- **Data-gen (Phases 1–2)** distributes across **all CPU cores on every available
  machine**. The committed `scripts/selfplay.mjs` ([D-12]) is **shardable by seed range**
  — each machine runs a disjoint range and emits JSONL that concatenates losslessly (the
  engine is seed-deterministic and games are independent). An always-on, otherwise-idle
  machine is the unattended workhorse (full cores); interactive machines cap at ~50% to
  stay usable.
- **Training (Phase 3, and the Phase-2 clone-net fit)** runs on the **GPU workstation**
  (Linux/WSL, Python/PyTorch+CUDA per [D-2]/[D-3]); Phase 3 runs the _full_ loop
  (engine env workers + PPO learner) **co-located** there so the [D-3] bridge is a
  local socket, not a network hop.
- **Cross-machine fidelity:** replay round-trips are engine-only (integer Mulberry32
  RNG) → bit-identical across machines/CPU arches, and we record the _actual moves
  taken_, so generate-here/replay-there is safe. We do **not** rely on re-deriving a
  bot's move from an observation (that involves FP eval that can differ across arches).

**Why.** Anchoring on one machine wastes most of the available throughput and the only
GPU. At ~4 g/s/core for the `ai_lookahead` teacher (the Phase-2 clone target), a few
machines' worth of cores aggregate to enough self-play throughput to generate **1M
imitation games in a few hours** (100k in well under an hour) — Phase-2 data-gen is
comfortably tractable distributed, vs the better part of a day tying up a single box.

**GPU workstation — capacity notes.** The training box is a consumer desktop with a
mid-to-high-end CUDA GPU, an 8-core/16-thread CPU, and large RAM/disk — ample for this
project. Implications:

- The planned nets are _tiny_ (masked policy/value over ≤31 nodes — [D-Encoding]), so
  **GPU VRAM is a non-constraint** — the GPU is overkill for the net → fast iteration,
  and it confirms **env throughput / the JS→Py bridge — not GPU — is the Phase-3
  bottleneck** (so the Phase-1 harness work is squarely on the critical path).
- **Run the whole stack in Linux/WSL** — the path of least resistance for PettingZoo/SB3,
  with CUDA passthrough for the GPU. Node engine + PyTorch trainer in one Linux box.
- **Storage strategy:** keep the **lean replay** (seed + actions) as the canonical
  on-disk dataset (single-digit GB for 1M games) and expand to packed tensor shards
  (`.npz`, tens of GB) in a one-time JS pass for training — avoids both TB-scale fat
  JSON and per-epoch re-expansion; ample RAM also holds large replay buffers in memory.

**Rejected.** (a) Single-machine data-gen — leaves throughput and the GPU on the table.
(b) A central distributed-RL learner fed by remote env workers in Phase 3 — real
complexity we don't need; one GPU box suffices for the planned (small) net sizes.

---

## D-14 — Forced turn-ends are recorded as voluntary STOP; data-quality enforcement lives at the task-5 data-gen boundary, not in the per-step record · Accepted (2026-06-22) · follows [D-13](#d-13--compute-topology-distribute-data-gen-across-machines-seed-range-shards-train-on-the-gpu-box)

**Context.** The trajectory recorder (task 4) emits a STOP training step at every
non-`GAME_OVER` turn end. The match harness ends a turn for four reasons: the bot
voluntarily returns null, the bot throws, it emits `MAX_CONSECUTIVE_INVALID` bad moves,
or it hits the `MAX_MOVES_PER_TURN` cap. The recorder cannot tell these apart from the
applied action alone — all four produce an identical `END_TURN`. Recording the forced
three as a "the policy chose to STOP" label is a mislabeled imitation target. PR-#42
review (three independent reviewers) flagged that the code was _silently_ doing this.

**Decision — explicit-(c) now, filter at the data-gen boundary later.**

- **PR #42 (task 4): explicit labeling + a forced-end signal.** Keep recording every
  `END_TURN` as a voluntary STOP (option (c)), but say so loudly — at the STOP emit site,
  in the `runBotTurn` `onStep` JSDoc, and in the `TrajectoryStep` typedef — and surface the
  one forced-end case the existing stats couldn't see: a `maxMovesHit` per-bot counter on
  `MatchResult.botStats`, with `MAX_MOVES_PER_TURN` now exported as the single source of
  truth. No change to the lean action list; the `rederived === live` round-trip is untouched.
- **Task 5 (self-play harness): filter at consumption**, because every problematic case
  is now a first-class per-bot counter on `MatchResult.botStats`, detectable without
  touching the per-step record:
  - bot-error / repeated-invalid (cases 2–3) → `botStats[teacher].errors`
    or `.invalidMoves > 0` ⇒ **quarantine the whole game** (loses <0.1% of games for a
    well-behaved teacher).
  - force-end at the cap (case 4) → `botStats[teacher].maxMovesHit > 0` (incremented when a
    turn exhausts the `MAX_MOVES_PER_TURN` cap) ⇒ **quarantine the whole game**, uniformly
    with cases 2–3. (An earlier draft proposed deriving this from "turn length ===
    `MAX_MOVES_PER_TURN`"; rejected — the recorded run is `cap` ATTACKs **plus** the trailing
    STOP, and a legitimate 100-attack voluntary turn is indistinguishable by length. An
    explicit counter is unambiguous and needs no per-turn action-length reconstruction.)

**Why.** The signals already live at the data-gen boundary, which is the layer that
actually owns "is this game clean enough to train on." Pushing enforcement there keeps
the canonical lean format pure and exactly round-trippable, matches the real ~0%
frequency, and adds only a single integer stat to `matchRunner` — no change to the
recorder, the lean format, or re-derivation.

**Rejected.** (d) A per-action forced-end marker in the lean record — the "correct,"
self-describing fix, but it bloats the canonical format and adds coordinated changes
across recorder + matchRunner + re-derivation for a case the `ai_lookahead` teacher
essentially never hits. **Escape hatch if we later train on a noisier teacher:** a tiny
`metadata.forcedEndTurns: number[]` (action indices, usually empty) — keeps the action
list pure and the round-trip intact — is preferred over per-action flags. Not built now.

---

## D-15 — Duplicate-seat support landed, but a pure Lookahead mirror is a turtle equilibrium; the Phase-2 corpus uses a heterogeneous decisive field · Accepted (2026-06-23) · refines the [D-Encoding](#d-encoding--mdp--state--action--reward-shape--accepted-2026-06-23--finalizes-the-2026-06-21-proposal) teacher-data sub-decision

**Context.** [D-Encoding]'s teacher-data sub-decision recommended **option (a)**: add
duplicate-seat support to `scripts/selfplay.mjs` so an `N×Lookahead` pure self-play
field is expressible (most label-dense, on-policy, reproducible). The support was built
this session — a `<count>x<Bot>` multiplier (`expandFieldTokens`) plus `#n`
seat-display-name uniquification (`assignSeatNames`/`resolveSeats`) in
`scripts/lib/selfplay-core.mjs`. `matchRunner` rejects a duplicate-name field and ELO is
keyed by name, so the unique `#n` names let one policy fill many seats while each seat is
tracked independently (e.g. `Lookahead#1..#7`). Tests cover the multiplier, uniquifier,
resolver, a direct `generateShard` mirror, and a CLI worker-pool e2e. Then we ran it.

**Finding (empirical).** A pure `7×Lookahead` mirror **stalemates ~100% of games** — a
true symmetric-turtle equilibrium, not a turn-cap artifact:

| Field (7p)                        | Decisive (winner≠null) | Notes                                    |
| --------------------------------- | ---------------------- | ---------------------------------------- |
| 7×Lookahead, maxTurns 500         | ~3% (4/150)            | mean ~553 actions                        |
| 7×Lookahead, maxTurns 2000        | **0% (0/24)**          | mean ~2046 actions — just turtles longer |
| 6×Lookahead,Strategist            | ~12% (10/80)           | one odd seat doesn't break it            |
| 5×Lookahead,Strategist,Expectimax | ~12% (10/80)           | nor two                                  |

Lookahead is _patient_ (`BASE_THRESHOLD` 2.2): in a balanced symmetric N-way standoff no
bot gets dominant enough to trigger its PRESS posture, so all hold and the game never
resolves. (Contrast: the default 4-bot heterogeneous field is 100% decisive; the
canonical 7-bot arena resolves because its weak/aggressive members — incl. the
`Math.random` bots — break symmetry and get eliminated, concentrating territory until
someone wins.) Raising `maxTurns` only lengthens the turtle.

**Why it matters.** A non-decisive game is poor imitation data: almost every step is a
turtling STOP, `winner` is null (no terminal reward for the aux value head), and the
"policy" being imitated is a degenerate mutual hold. Pure-mirror data would teach the
clone to turtle.

**Decision.** Keep the duplicate-seat feature — it is correct, tested, and useful as
harness infrastructure (controlled / low-player-count mirror experiments) — **but the
Phase-2 teacher corpus does NOT use a pure Lookahead mirror.** Generate it from a
**heterogeneous, decisive field that includes Lookahead, imitating Lookahead's seat**
(the trajectory stamps `playerId` per step, so filtering to the teacher seat is trivial).
This is ADR option (b)/(c), now empirically favored over (a). Validate the decisive rate
of the chosen field before the big run; to raise teacher-label density, add Lookahead
seats only up to the point the field still resolves — _aggressive_ opponents, not more
patient mirrors, are what break the turtle.

**Validated (2026-06-23) — the corpus generator is the full 7-bot arena field**
(`Lookahead,Strategist,Expectimax,Defensive,Default,Example,Adaptive`), imitating
Lookahead's seat (seat 0). It wins the corpus-field screen on every axis (see RESULTS):
**85% decisive** (highest; fewest stalemates), the **exact eval distribution** (the gate
is this 7-bot FFA), and a **balanced 55%-attack label split** (Lookahead plays actively,
not turtling) — vs the seed-pure `2×Look,2×Strat,2×Expect,Defensive` alternative's 64% /
40%-attack. Yields ~80.8 teacher steps/game (~8M `(obs,move)` pairs per 100k games).
**Cost:** the 3 `Math.random` bots make games non-reproducible from seed (cross-machine
_dedup_ lost) — fine under disjoint seed ranges; recorded moves stay valid/replayable
(D-13). The seed-pure 2× field is the reproducible fallback. Stalemate games (~15%) are
kept (valid labels; `placements` is a full ranking even when `winner` is null).

**Rejected.** (a) A pure / heavy `N×Lookahead` mirror corpus — ~0% decisive (turtle
equilibrium). Raising `maxTurns` to salvage it — confirmed 0% at 2000. (b) The seed-pure
2× heterogeneous field as the _primary_ corpus — reproducible, but lower decisive rate
(64%) and more STOP-heavy labels (40% attacks); kept as the fallback, not the default.

---

## D-Encoding — MDP / state / action / reward shape · **Accepted (2026-06-23)** · finalizes the 2026-06-21 proposal

**Status.** The 2026-06-21 proposal (graph nodes; masked edge+STOP action head;
terminal+shaped reward; one shared per-player policy) is **finalized and accepted**
unchanged in substance, now made concrete and grounded against the code at the start
of Phase 2. The original proposal targeted cloning `ai_strategist`; per [D-7] the
**teacher is `ai_lookahead`** (the field-strongest bot, pinned `596f781`). The encoding
gate is unchanged: _if a net cannot clone the teacher under this encoding, the encoding
is wrong — fix it before any RL._

**Information-completeness (why this gate is well-posed).** Verified against
`src/ai/ai_lookahead.js`: the teacher reads only per-area `owner`/`dice`/adjacency,
per-player `territories`/`dice`/`largestGroup`/`stock` (and `cohesion =
largestGroup/territories`), and per-edge win-prob from `WIN_TABLE`. Every one of those
is present in `BotState` (`src/arena/botState.js`) or computable from `getValidMoves`
(which returns `{from, to, attackerDice, defenderDice}`). So the encoding below is a
**lossless view of the teacher's own inputs** — a net that fails to clone is limited by
capacity/optimization or the encoding's _shape_, not missing information.

### State — graph over a fixed territory-id node space

- **Nodes.** Territory ids `1 .. maxAreas-1` (`DEFAULT_AREA_MAX = 32`; id 0 is the
  unused sentinel → ≤31 real nodes). Pad the node tensor to `config.maxAreas` with a
  **present-mask** (`area.size > 0`). **Topology is fixed for the whole game** — which
  ids exist and the adjacency never change; only `owner`/`dice` change per step (exactly
  what `ai_lookahead` exploits by precomputing neighbors once). Build adjacency once per
  game, share across all its steps.
- **Per-node features** (present nodes; absent ids masked):
  - `dice / MAX_DICE` (8) — scalar (an 8-way one-hot is a fallback if the scalar
    under-fits).
  - `is_mine` (`owner === me`), `is_enemy` (present & `owner !== me`), `is_border`
    (`BotState.isBorder`).
  - Owner is encoded **relationally** (`is_mine`/`is_enemy` + per-player globals), **not**
    as an absolute seat one-hot — a symmetric policy must not depend on seat identity.
    (Revisit per-owner node grouping only if the clone misses parity; the gate decides.)
- **Per-player globals** (≤ `playerCount`, default 7), each normalized and relative to me
  where natural: `territories`, `totalDice`, `connectedTerritories` (largestGroup),
  `reinforcements` (stock), `eliminated`, `is_me`; plus board scalars **my dice-share**
  (= my `totalDice` / Σ `totalDice`), `activePlayers`, and `gamePhase`. These directly
  feed the teacher's posture (PRESS/WEAK/BASE bar keys off dice-share & active count) and
  its leader/field terms — including them is what lets a feed-forward net reproduce the
  posture-adaptive policy without re-deriving the search.

### Action — masked edge head + explicit STOP

- One logit per legal directed attack edge `(from,to)` from `getValidMoves`, **plus one
  explicit STOP logit**; softmax over `[legal edges…, STOP]`, masked **exactly** by
  `getValidMoves` (the engine's free legal-action mask). An **edge/pointer head** over the
  variable-length legal set — **not** a flat 31×31 head (sparse, wasteful).
- **Per-edge features (the engineered crux — "don't make the net learn dice math"):**
  `winProb = WIN_TABLE[attackerDice][defenderDice]`, `attackerDice/8`, `defenderDice/8`,
  plus the from/to node representations. (Defender exposure / capture-threat is derivable;
  let the net/message-passing infer it before adding it explicitly.)
- A turn is a **sequence of single attacks ended by STOP** — the net is queried once per
  applied action, matching the trajectory's one-step-per-action record (the
  `fatSteps ≡ actions` invariant in `trajectoryExport.js`).

### Labels & reward

- **BC label:** the teacher's `chosenMove` per step (chosen-edge index or STOP),
  cross-entropy over the masked legal set. Imitate **only the teacher's seat** — filter
  steps to `step.playerId === <teacher seat>` (the record stamps `playerId` per step).
- **Reward (recorded now, shaping deferred to Phase 3):** terminal `winner`+`placements`
  are already in the lean record. An **auxiliary value head** regressing terminal
  placement/win is optional for BC but **recommended** (multi-task; the same architecture
  warm-starts Phase-3 PPO). Dense shaping (Δlargest-group income, dice/territory deltas,
  eliminations) is a Phase-3 concern.

### Padding / batching / offline expansion

- Fixed node width = `maxAreas` (+ present-mask); fixed globals width = `playerCount`;
  ragged legal-edge sets via a padded edge tensor + action mask. Everything is
  seed-deterministic, so the one-time **tensor-expansion pass reuses
  `trajectoryFromReplay`** (`src/arena/trajectoryExport.js`) to reproduce identical
  observations offline from the lean dataset (D-13's "expand lean → packed `.npz`").

### Net architecture (guidance, not part of the encoding contract)

The gate constrains the **encoding**, not the net. Start with the simplest learner that
can clone — a masked per-edge MLP over node+global+edge features — and **escalate to a
1–2 layer GNN** (message passing over the static adjacency) only if the MLP can't reach
parity, since the teacher's value leans on `largestGroup` (a global graph property). The
clone need only reproduce the policy mapping (obs → move), not the depth-2 search itself.

### Sub-decision — teacher-data field & player count (decide before the big corpus run)

- The clone is gated on the canonical **7-player FFA** `arena:sweep`. The teacher is
  player-count- and posture-sensitive (thresholds key off `activePlayers`/dice-share;
  `DUEL_LEADER_WEIGHT` at 2p), so the corpus should be **7-player games in which
  `ai_lookahead` plays**, imitating only its seat.
- **Harness gap (found 2026-06-23):** the committed `scripts/selfplay.mjs` requires
  **distinct** bot names (ELO/wins are keyed by name; `matchRunner` rejects duplicates),
  and only **4 seed-pure built-ins** exist (Strategist/Expectimax/Lookahead/Defensive) —
  so neither an `N×Lookahead` pure-self-play field nor any reproducible 7-distinct-seed
  field is expressible today. Resolution options for the corpus:
  - **(a) Add duplicate-seat support** (seat-suffixed names) → `N×Lookahead` pure
    self-play: most label-dense, on-policy, keeps seed-reproducibility. _Was recommended;
    **built and then retired as the corpus recipe by [D-15]** — a pure Lookahead mirror is
    a turtle equilibrium (~0% decisive), so the corpus uses a heterogeneous decisive field
    (b/c) instead. The duplicate-seat feature itself stays as harness infrastructure._
  - **(b) Full 7-bot arena field** incl. the 3 `Math.random` bots: matches the eval field
    but games aren't reproducible-from-seed (recorded moves are still valid/replayable —
    we store actual moves, D-13 — only the cross-machine seed-merge guarantee weakens).
  - **(c)** A mix of the above.
- **This tracer shard uses the committed harness unchanged** — the default 4-bot seed-pure
  decisive field (4-player, fully reproducible, 100% clean) — solely to exercise the
  encoding/tensor-expansion pipeline and round-trip tests. It is **not** the training
  corpus; the 4p-vs-7p mismatch is fine for pipeline development and is flagged here so the
  shard isn't mistaken for final data.

---

## D-16 — The BC trainer lives in-repo at `ml/`; logits-only single-step ONNX is the inference contract · Accepted (2026-06-23) · follows [D-3](#d-3--js-engine-is-the-single-source-of-truth-python-for-training-only) / [D-4](#d-4--deploy-via-onnx-runtime-web)

**Context.** Phase 2's data pipeline is done (encoder + `npm run encode-corpus` →
packed tensors + `manifest.json`). The next milestone is the behavioral-cloning
trainer **(Python) → ONNX → in-browser bot**. The one genuinely open fork was
**where the Python training code lives**; the net/framework/target were already
fixed by [D-Encoding] (masked per-edge MLP, escalate to GNN only if needed),
[D-4] (PyTorch → ONNX → ONNX Runtime Web), and [D-13] (train on the GPU box).

**Decision — in-repo `ml/`.** A self-contained Python package `ml/dicewars_bc/`
(`pyproject.toml`, own venv, `pip install -e .[onnx,dev]`), excluded from the JS
toolchain (`ml/` added to `.prettierignore`; ESLint's `--ext .js,.jsx,.mjs`
already skips it; training artifacts gitignored via `ml/.gitignore`, corpora
already gitignored under `data/selfplay/`).

- **Why in-repo (over a separate repo / local-only).** The **encoding contract**
  is the coupling point: `manifest.json`, `ENCODING_VERSION`, and the
  feature-column order all live in `src/arena/encodeObservation.js`. Keeping the
  trainer beside it means an encoding change and the matching trainer change land
  in **one commit**, and the version coupling is enforceable
  (`dicewars_bc.manifest.EXPECTED_ENCODING_VERSION` is asserted against every
  corpus at load). `docs/ml-bot/` already tracks ML work in-repo; a separate repo
  would split the contract across two histories and invite silent drift. Local-only
  on the GPU box was rejected outright — it contradicts the "survives across
  sessions" ethos.
- **Package shape.** `manifest.py` (load + validate the contract), `dataset.py`
  (memmap-backed `Dataset`, CSR-aware `collate`, **game-level** train/val split to
  avoid same-game leakage), `model.py` (`EdgePolicyNet`: per-node + per-player
  encoders, **mean-pool over seats** for seat-symmetry, context MLP, per-edge head,
  aux value head), `losses.py` (**segmented** cross-entropy / accuracy over the CSR
  edge slices), `train.py`, `export_onnx.py`. Hermetic pytest suite builds a tiny
  synthetic corpus (no real data needed). The masked-softmax is **per step** over
  its `getValidMoves` + STOP slice — never across steps.

**Inference contract (the crux for the in-browser bot).** The exported ONNX graph
is **logits-only for one decision step**: inputs `nodes [B,maxAreas,Fn]`,
`players [B,P,Fp]`, `board [B,Fb]`, and the flat edge tensors `edge_feat [E,Fe]` /
`edge_from [E]` / `edge_to [E]` / `edge_batch [E]`; output `edge_logits [E]` (+ aux
`value [B,2]`). The `edges` and `batch` axes are **dynamic**; at inference B=1 and
`edge_batch` is all-zeros. **Every edge is legal** (the set is `getValidMoves` +
STOP), so the bot just `argmax`es the logits — `argmax → {from,to}` from
`edge_index`, or the STOP edge → `null`. **No masking, no softmax, no scatter in
the graph** — the segment/softmax math stays Python-side (training loss only), so
the export is portable to ONNX Runtime Web. The segmented softmax never appears in
ONNX, sidestepping `scatter_reduce`-opset concerns. A sidecar `<model>.onnx.json`
stamps `encodingVersion` + the I/O contract so the JS wrapper asserts compatibility
before trusting the model. Export self-checks PyTorch-vs-onnxruntime parity
(observed max |Δlogits| ≈ 5e-7 on the 300-game sample).

**Validated (2026-06-23).** Trained on the real 300-game sample corpus (24,254
Lookahead-seat steps): val move-match climbed 33% → 47% in 8 untuned CPU epochs
(random baseline ≈14% over ~6.9 edges/step) — the trainer learns; ONNX export +
ORT parity + dynamic-edge inference all green (hermetic pytest suite). This is a
**pipeline smoke test, not the parity gate** — that needs the 100k–1M-game corpus
([D-13]) + tuning on the GPU box, evaluated on `arena:sweep`.

**Rejected.** (a) A separate `dicewarsjs-ml` repo — clean toolchain split, but the
encoding contract drifts across two histories. (b) Local-only on `shodan` — not
versioned/reproducible. (c) Putting the masked softmax/argmax **inside** the ONNX
graph — couples the export to `scatter_reduce` opset support and gains nothing
(argmax over all-legal logits is one JS line).

**Next slice (not built here).** The in-browser bot: add `onnxruntime-web` to the
JS deps and write a `src/ai` wrapper that builds the input tensors from a live
`BotState` the **same way** `encodeObservation.js` does — which needs a **label-free
encoder** extracted from `encodeStep` (it currently requires a `chosenMove` to
compute the BC label). Then run the session and `argmax`. Evaluate on
`arena:sweep` vs `ai_lookahead` (the Phase-2 parity gate).

## D-17 — The BC gap is NOT capacity-limited; localize encoding vs factorization before the PPO fork · Accepted (2026-06-24) · follows [D-16](#d-16--the-bc-trainer-lives-in-repo-at-ml-logits-only-single-step-onnx-is-the-inference-contract)

**Context.** After the STOP-de-bias retrain (#55) the calibrated BC clone wins ~6.4% vs
Lookahead's ~20% — a residual ~13 pt gap attributed to the "encoding/architecture ceiling"
but never measured. Three candidate causes: (a) **capacity** — the per-edge MLP is too small;
(b) **features** — the encoding lacks information (notably board adjacency: the corpus carries
only action-head candidate edges, no full adjacency); (c) **factorization** — the architecture
(independent per-edge scoring + masked-mean pooling, no message passing) can't represent the
teacher's relational reasoning regardless of size or features. The fork ahead (GNN warm-start
vs greenfield PPO, [D-2]) is expensive, so localize the cause first with a cheap probe (Ivan's
call: "cheap ceiling probe first; destination is PPO either way").

**Decision.** (1) Rule out / in **capacity** with a zero-code width sweep, judged on **win%**
(the gating metric, [D-7]) not just val move-match (the known-misleading proxy, [D-15]/Phase-2
STOP sweep). (2) Given the result, **proceed to encoding-v2** — add a board-adjacency blob +
richer node/edge features and bump `ENCODING_VERSION 1→2` (3-site lockstep:
`encodeObservation.js`, `manifest.py EXPECTED_ENCODING_VERSION`, `ai_bc.js` load guard),
re-encode the 100k corpus, retrain the **same** MLP, and arena-confirm. This splits
feature-limited (acc/win rises on richer features) from factorization-saturated (still flat →
needs message passing / RL). (3) Tooling: `makeBC({ policy })` (`src/ai/ai_bc.js`) — a
backward-compatible param to arena-eval candidate checkpoints without overwriting the shipped
`bcPolicyWeights.js` — and `scripts/_probe-capacity-arena.mjs` (parity pre-flight + config×bias
peak-win% comparison).

**Evidence (capacity sweep, full tables in RESULTS.md Phase 3).** Three widths, same 100k
corpus + recipe (`--epochs 6 --stop-weight 0.5 --select-by stop-cal`), on `shodan`:

- **Proxy flat:** val move-match 56.75% (102k) → 57.19% (403k) → 57.33% (1.0M). 10× params →
  +0.58 pt.
- **Real metric flat-to-declining:** peak arena win% (matched STOP operating point, 95% CIs)
  6.7 ± 0.8 (102k) → 6.6 ± 1.2 (403k) → 5.1 ± 0.9 (1.0M). The 1M net is if anything _worse_.
  Compared at each width's _peak_ over a bias grid because val-STOP-calibration does not
  transfer to the arena distribution uniformly across training length (6-epoch nets turtle
  harder than the deployed 2-epoch model). Harness validated: the deployed model reproduces its
  known ~6.4%.

**Consequences.** Capacity is closed as the lever — **do not scale the MLP**. The encoding-v2
work is **not throwaway even though the destination is PPO** ([D-2]): a competitive PPO/GNN
policy needs adjacency in its observation, so v2 front-loads that. BC's own ceiling remains
**parity, never beat** ([D-15] reframe) — the encoding-v2 BC retrain is **diagnostic**; the
durable payoff is the reusable enriched observation and a sharper PPO design. If v2 leaves win%
flat (factorization-saturated), skip further BC tuning and fork straight to PPO with a
message-passing policy.

**Rejected / not chosen.** (a) Straight to PPO without localizing — risks building PPO on an
impoverished observation and re-discovering the same gap expensively. (b) A bigger MLP — ruled
out by this evidence. (c) A standalone GNN-BC probe instead of encoding-v2 — needs the adjacency
blob anyway (same re-encode cost) _plus_ new architecture, and its result (parity at best) is
lower-value than producing the reusable v2 observation.

## D-18 — The BC gap was FEATURE-LIMITED, not factorization-saturated; encoding-v2 ships as the deployed BC and the PPO observation; fork to PPO for the residual · Accepted (2026-06-25) · resolves [D-17](#d-17--the-bc-gap-is-not-capacity-limited-localize-encoding-vs-factorization-before-the-ppo-fork)

**Context.** [D-17] closed capacity and split the remaining gap into **features** vs
**factorization**, to be decided by encoding-v2: same 102k MLP + same recipe, only the encoding
enriched (engineered local-neighbourhood features, not a raw adjacency blob — the per-edge MLP
can't message-pass over one, and PPO builds its observation live anyway; Ivan's call:
"engineered features only"). Feature-limited ⇒ win% rises on richer features; factorization-
saturated ⇒ still flat → needs message passing / RL.

**Decision.** Accept the **feature-limited** verdict and **ship encoding-v2** (`ENCODING_VERSION
2`): node 5→8 (`enemyNbrDiceMaxNorm`, `enemyNbrFrac`, `degreeNorm`), edge 4→7
(`tgtRetakeThreatNorm`, `srcVacateThreatNorm`, `tgtEnemyNbrFrac`). The retrained weights replace
the deployed `src/ai/bcPolicyWeights.js` (default `stopBias 0`). **Fork to PPO** for the residual
gap — no further BC feature/architecture tuning, as BC's ceiling is parity-not-beat ([D-15]).

**Evidence (full tables in RESULTS.md Phase 3 — encoding-v2).** Same net, same 100k corpus,
only the encoding differs vs the [D-17] `c0_base` twin:

- **Proxy jumped:** val move-match **0.5675 → 0.7328** (+16.5 pt) — the six engineered
  attack-consequence features made the teacher's moves far more predictable.
- **Gate followed (the decisive part):** peak arena win% **6.7 ± 0.8 → 12.5 ± 1.4** (15×130,
  same 8-bot field, CIs disjoint [5.9,7.5] vs [11.1,13.9]). Unlike the capacity sweep (+0.58 pt
  proxy → flat win%), this proxy gain **carried to the gate**. Native gap to Lookahead (~17%)
  ~halved: ~13 pt → ~4.6 pt.
- **STOP self-calibrated:** peak at `stopBias 0` (native STOP 53% vs v1's ~71% turtle); positive
  bias now only hurts. No deploy-time tuning needed.

**Consequences.** (1) The v2 observation is the **durable artifact** ([D-2] reuse) — it is
_both_ the shipped BC encoding _and_ the PPO input, so the work survives the BC→PPO fork.
(2) BC tuning is **done**: the residual ~4.6 pt is the imitation ceiling (BC clones, Lookahead
searches), which only RL crosses. (3) The lockstep version bump touched
`encodeObservation.js`, `manifest.py`, `ai_bc.js` (load guard), `export_weights.py`/
`export_onnx.py` fixtures, and the JS/Python test fixtures + the `encode-corpus` end-to-end
version assertion — all green at v2.

**Rejected / not chosen.** (a) A raw adjacency-CSR blob in the corpus — the current MLP can't
message-pass over it and PPO won't consume it (builds observations live), so it would add bytes
with no model benefit (Ivan: "engineered features only"). (b) Further BC feature engineering to
chase the last ~4.6 pt — diminishing returns against an imitation ceiling; PPO is the right
lever. (c) Re-running the capacity sweep on v2 — capacity was already closed independent of
encoding ([D-17]); 102k suffices.

## D-19 — Phase-3 PPO architecture: in-process self-play env over a Node↔Python socket, EdgePolicyNet-trunk policy warm-started from v2-BC, PFSP league in the full 8-FFA · Accepted (2026-06-25) · follows [D-18](#d-18--the-bc-gap-was-feature-limited-not-factorization-saturated-encoding-v2-ships-as-the-deployed-bc-and-the-ppo-observation-fork-to-ppo-for-the-residual) · grounds [D-2](#d-2--model-free-ppo-not-alphazero--muzero--accepted-2026-06-21) / [D-3](#d-3--js-engine-is-the-single-source-of-truth-python-for-training-only--accepted-2026-06-21) / [D-13](#d-13--compute-topology-distribute-data-gen-across-machines-seed-range-shards-train-on-the-gpu-box--accepted-2026-06-22)

**Context.** [D-18] forked to PPO: BC is at its imitation ceiling (encoding-v2 → 12.5% win% vs
Lookahead ~17%; residual ~4.6 pt is the clone-vs-search gap only RL crosses). Before writing any
Phase-3 code we ran a fan-out **surface-map + adversarial verification** (5 parallel readers over
the JS rollout assets / Python BC trainer / JS↔Python bridge options / SB3+PettingZoo ecosystem /
shodan ops, then a synthesis stressed by 3 skeptics) — mirroring how Phase 1 began ([D-12]). The
verification **corrected two load-bearing claims and surfaced one gate-breaking gap** (below); the
four strategy forks were taken to Ivan and decided. The architecture inputs were already locked:
[D-2] (model-free MaskablePPO, not AlphaZero), [D-3] (JS engine is source of truth; Python trains
only, bridged via a PettingZoo AEC env), [D-13] (train co-located on the GPU box, local socket).

**Decision — the Phase-3 PPO design.** Grounded against code (file:line verified this session):

- **Env.** A **PettingZoo AEC** env with **one learner seat external** and the other 7 seats run
  **in-process in Node**. The training **observation IS the v2 encoding**, emitted live by
  `encodeObservationForInference` (`src/arena/encodeObservation.js:471`, `ENCODING_VERSION = 2` at
  `:43`) — the durable artifact from [D-18], unchanged from the shipped BC/`ai_bc`. A "step" is **one
  attack decision** (not a whole turn); the trailing STOP edge = `END_TURN`. The env reconstructs the
  chosen `{from,to}|null` from the **encoder's own parallel `moves[]` array, NEVER a fresh
  `getValidMoves`** (the two orderings differ — highest-severity correctness trap). Terminal reward
  only at `phase===GAME_OVER`; turtles truncate at `maxTurns` with reward 0.
- **Bridge.** A **persistent Node env-server** (engine + v2 encoder in-process) exchanging **compact
  binary length-prefixed frames** over a **local Unix socket** to N vectorized envs co-located on
  shodan, reusing `encode-corpus.mjs`'s f32/i32 CSR wire layout so Python decodes a live obs with the
  same parser as the offline corpus. **Rejected:** per-step stdio-JSON (the [D-3] latency trap) and
  re-implementing the encoder in Python (a second source of truth that drifts from the parity-tested
  JS encoder).
- **Policy net.** **Reuse `EdgePolicyNet`'s trunk + per-edge head** (`ml/dicewars_bc/model.py`) as
  the PPO actor; **fresh scalar critic** off `ctx` (BC's 2-output won/placement value head is not a
  bootstrappable return — reinit, optionally keep as an aux task). [D-17] ruled out capacity and
  [D-18] confirmed the v2 features suffice, so the per-edge MLP is a sound PPO policy start; a
  message-passing GNN stays the documented escalation if it saturates.
- **Action masking (corrected).** `EdgePolicyNet`'s **variable-length** edge head does **not** drop
  into sb3-contrib MaskablePPO, which requires a **fixed `Discrete(N)` + boolean mask**. Resolution:
  **pad the per-edge head to a validated `MAX_EDGES`** (selfplay p100 of the action-count
  distribution, ~64–128 — well under sb3-contrib **#247**'s ~1400-action sparse-mask crash zone, NOT
  the ~992 theoretical all-pairs max) **+ mask the tail** (custom `ActorCriticPolicy` whose features
  extractor is the EdgePolicyNet trunk; `MaskableCategorical` over the padded logits). A fully-custom
  ragged distribution (reuse `losses.py`'s segmented softmax) is held as escalation. Treat [D-2]'s
  "MaskablePPO" as **"PPO + action masking,"** not necessarily the literal class.

**The four strategy decisions (Ivan, 2026-06-25).**

1. **Warm-start from v2-BC + a short from-scratch control.** Mechanically trivial — a PPO actor with
   the same `ModelConfig` has byte-identical Linear shapes, so
   `EdgePolicyNet(ModelConfig(**ckpt['config'])).load_state_dict(ckpt['state_dict'])` loads trunk +
   `edge_head` straight in; only the value head reinits. Run a short fresh control on the same gate so
   the choice is data-backed. Use a low initial LR / KL constraint (optional brief trunk freeze) so
   PPO doesn't wipe the BC prior before the critic + shaping stabilize.
2. **Full 8-player FFA against a heterogeneous league from step one** — **deviates from the written
   PLAN's "3–4p symmetric self-play first."** Grounded in [D-15]: symmetric low-player mirrors turtle
   to ~0% decisive (winner=null → ~0 terminal reward → no gradient), and the gate IS the 8-bot FFA.
   Heterogeneity (fixed strong baselines + snapshots) makes games ~85% decisive and matches the gate
   distribution. Player-count / opponent-strength ramps are difficulty knobs only if 8-FFA proves
   unstable — never a symmetric mirror.
3. **Sparse terminal-win reward first (win=1/loss=0), add annealed potential-based shaping if
   learning is too slow.** Win is the gate metric ([D-7]); placement/survival is the **ELO trap**
   ([D-7]/[D-8]/[D-9] shipped consistent-but-never-wins bots) and stays auxiliary at most. Shaping,
   when added, is **Ng-style `F = γΦ(s′) − Φ(s)`** over quantities the encoder already exposes
   (Δlargest-group income / territory / dice / eliminations — what `ai_strategist` optimizes),
   computed env-side in JS and **annealed to 0** so the final policy optimizes pure win%.
4. **Fixed env-step budget + kill threshold.** No statistically-significant win% edge over Lookahead
   after the first budget unit → declare plateau, fall back to the shipped BC / Track-A bot. Mirrors
   Phase 0.5's 4-swing cap. **The budget can only be sized after the throughput probe (slice step 3)
   returns real learner-steps/sec.**

**League (PFSP).** No maintained drop-in self-play league exists in SB3/PettingZoo; build a
**Prioritised Fictitious Self-Play** league (AlphaStar pattern; CleanRL's `ppo_pettingzoo_ma_atari`
as the mechanics reference). Each 8-FFA game = 1–2 learner seats + 2–3 fixed strong JS baselines
(`ai_lookahead@596f781` the gate opponent, plus Strategist/Expectimax) + 2–3 frozen PPO snapshots.
**Snapshots MUST run as in-process JS bots** (export each to the `bcForward` weight format and load
via `makeBC({policy})`) — evaluating them back in Python turns ~1 boundary crossing/turn into up to
8 and erases the in-process amortization.

**Two adversarial corrections + one gate-breaking gap (the verification's real payoff).**

- **Throughput bottleneck is the in-process heuristic opponents, NOT the wire (corrected).** The
  synthesis claimed ~13 µs/step (learner applyAction+encode) vs a ~50–200 µs JSON round-trip,
  concluding binary framing was decisive. That omits the dominant cost: every STOP runs all 7
  non-learner seats in-process, and the league deliberately includes `ai_lookahead`/`strategist`/
  `expectimax` (~4 games/s/core, ~250 ms/game). Amortized over ~50–150 learner decisions/game, real
  per-learner-step wall-clock is **~1.7–5 ms — ~100–400× the quoted figure.** So the wire is ~2–10%
  of a step (binary framing is a cheap nicety, not the linchpin), and **the [D-3] "plateau-by-
  slowness" risk is relocated from the wire into opponent simulation — which no bridge format fixes.**
  The levers are cheaper-early-opponents / more parallel envs (scales with cores) / reduced lookahead
  depth. **Reachability ("millions of steps in budget") is UNPROVEN until a throughput probe runs
  against the actual lookahead league** — the probe's acceptance bar is learner-steps/sec needed to
  hit the budget, not "IPC non-dominant."
- **Variable-length edge head ≠ fixed MaskablePPO Discrete** (corrected) → pad-to-validated-`MAX_EDGES`
  - mask (above).
- **MISSING SB3→EdgePolicyNet repack adapter (gate-breaking, NEW).** `export_weights.py:140` does
  `getattr(model, attr)` for `{node_encoder, player_encoder, context, edge_head, value_head}` on a
  **bare** `EdgePolicyNet` (`:118` `EdgePolicyNet(config)`, `:119` `load_state_dict`). An SB3
  `ActorCriticPolicy` wraps the trunk under a different state_dict namespace and the PPO critic is a
  fresh scalar head — so `export_weights.py` will **not** find `.node_encoder` on an SB3 object and
  **fails**. Without an explicit **repack step** (SB3 sub-modules → a bare BC-format `EdgePolicyNet`
  `.pt`, with an EdgePolicyNet-shaped `value_head` so the parity fixture still runs), the **graded bot
  ≠ the trained policy** and the gate is meaningless. This repack is the single silent break point and
  **needs its own parity assertion + a regenerated JS↔Py fixture** before any real run. The eval path
  is otherwise proven (BC was graded this way, RESULTS.md): registration is a static array edit in
  `src/arena/builtInBots.js` (`:36` `{ id: 'ai_bc', name: 'BC', fn: ai_bc }`) and `makeBC({policy})`
  (`src/ai/ai_bc.js:67`) + `bcForward.js` consume the exported weights synchronously, unchanged.

**First tracer slice (smallest end-to-end, ordered — see PLAN Phase 3).** (1) Node env-server +
binary wire; (2) **cross-bridge action-encoding parity test** (sampled index → encoder `moves[]` →
correct `{from,to}|null`) green BEFORE training; (3) **throughput probe** against the real lookahead
league (sizes the budget); (4) Python `[rl]` deps + minimal AEC env; (5) custom policy + warm-start;
(6) tiny PPO run (1–2 envs, 1 learner + 7 fixed baselines, terminal-win only, a handful of updates);
(7) **repack → export → register → `arena:sweep`** win% vs Lookahead with CIs. Steps 1–3 are
decision-independent and de-risk the two biggest unknowns (fast enough? index round-trips correctly?).

**Biggest risk (the documented kill-risk).** Self-play RL may converge to win% **parity** with
Lookahead — exactly the ceiling Track A hit ([D-8]/[D-9]/[D-11]) and the Risk-thesis prior art warns
of — and never cross to a significant edge. Mitigated by warm-starting above random, training directly
against Lookahead, PFSP against collapse, and the pre-set budget + kill threshold (decision 4) → clean
fallback to the shipped BC bot rather than unbounded spend.

**Rejected.** (a) Following the PLAN's 3–4p symmetric curriculum — [D-15] turtle equilibrium. (b)
Per-step stdio-JSON bridge / a Python re-port of the encoder — [D-3] latency trap / drift. (c) A
placement/survival reward — the ELO trap. (d) Scaling the MLP or chasing the head architecture before
PPO — [D-17]/[D-18] closed capacity and confirmed features; the residual is the imitation ceiling, an
RL problem. (e) Open-ended compute — the kill-risk is precisely an unbounded plateau.
