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

---

## D-20: Phase-3 throughput PROVEN green + `MAX_EDGES` = 64; episodes terminate at learner elimination · Accepted (2026-06-25)

**Context.** [D-19] left two things unproven before any Python/PPO work: whether the in-process-opponent
loop is fast enough to reach a real env-step budget (the bottleneck [D-19] relocated from the wire into
opponent simulation — "reachability UNPROVEN until a probe runs against the actual lookahead league"),
and the true per-decision action-count that sizes `MAX_EDGES`. Tracer step 3 (`scripts/ppo-throughput-probe.mjs`,
`npm run ppo:throughput-probe`) measured both. Decision-4's first budget unit was set to **fail-fast,
~one overnight (~12h)** (Ivan, 2026-06-25).

**Decisions.**

1. **GO — throughput is not the blocker.** Local (Mac, 8-core), realistic 8-FFA league
   (Lookahead/Strategist/Expectimax/4×BC): **644 learner-steps/s single-thread, 1,933 @4 workers**
   (~483/core). A ~12h unit ⇒ **~28M env-steps single-thread, ~84M @4 workers** — ~40–80× the
   ≳1–2M GREEN bar. Worst-case (7×Lookahead) is faster (1,140 / 3,496 — fewer expensive bots). Build
   tracer steps 4–7. (Local number; **re-confirm on shodan** — more cores, different CPU — before
   locking the literal budget, but the margin is large enough that the GO is robust.)

2. **`MAX_EDGES` = 64.** Observed per-decision `numEdges` (legal attacks + STOP) p100 ≈ **26** (p99 15,
   mean ~5), **zero overflow** over ~100k decisions across both leagues. [D-19]'s ~64–128 estimate was
   conservative; 64 gives ~2.5× margin over the observed p100 (a trained policy may reach slightly
   busier boards than the random stub, but `numEdges` is board-structure-bounded), and is trivially
   under sb3-contrib #247's ~1400 sparse-mask crash zone. The Python AEC env (step 4) fixes the action
   space at 64 and masks the pad tail.

3. **The PPO episode terminates at the learner's elimination, NOT at game-over.** A single-learner env
   returns a terminal (reward = loss) the moment the learner is knocked out; simulating the
   opponent-only tail afterward produces zero learner steps and is the throughput artifact that made an
   early full-game probe look ~2× slower. The probe models this via `runMatch`'s `onTurn` hook (no
   engine edit). **Follow-up for step 1 — DONE (2026-06-25).** `runSelfPlayEpisode` now takes a
   `terminateOnElimination` flag (default off → the full-game integration oracle stays byte-identical):
   an internal `onTurn` guard unwinds `runMatch` at the learner's elimination and synthesizes the
   terminal there. Placement is exact, not approximate — a player's finishing rank is fixed the moment
   it dies (everyone still alive outlives it), so `rank = #alive` reproduces `calculatePlacements`'
   game-over value with no tail (asserted against the engine on a fixed seed in `tests/ml/ppo-env.test.js`).
   **Refined by [D-21] (2026-06-25):** `rank = #alive` is exact only when the learner is the SOLE death that
   turn; a same-turn co-elimination with a higher-seat-id player needs a `+co-eliminees` correction to match
   `calculatePlacements` (it was off by one rank in ~4% of losing episodes).
   The env-server sets the flag (terminal frame at elimination: `won=0`, `winner=-1` while undecided,
   placement = locked-in rank); the throughput probe was refactored onto the same flag, dropping its
   bespoke sentinel-throw. ~2× free throughput on the env-server path + correct single-learner PPO
   semantics. (Smoke re-verified end-to-end over the socket.)

**Notes.** Per-move cost (realistic league): BC-snapshot stand-in ~0.8 ms (priciest — a forward pass),
Lookahead ~0.3–0.4 ms, Expectimax ~0.16 ms (far cheaper than the solo-bot "too slow" marker — board
size + memoization), Strategist ~0.02 ms. Worker-pool scaling ~3× on 4 workers of an 8-core box
(~75%/core) — a faithful CPU-bound proxy for SB3 `SubprocVecEnv`. Full numbers: `RESULTS.md`
"Phase-3 PPO throughput probe" + `LOG.md` 2026-06-25.

---

## D-21 — Env↔learner control plane: signal via the `onTurn` seam, a per-decision watchdog, fail-loud on desync; placement gains a same-turn co-elimination correction · Accepted (2026-06-25) · hardens [D-19](#d-19--phase-3-ppo-architecture-in-process-self-play-env-over-a-nodepython-socket-edgepolicynet-trunk-policy-warm-started-from-v2-bc-pfsp-league-in-the-full-8-ffa--accepted-2026-06-25) / [D-20](#d-20-phase-3-throughput-proven-green--max_edges--64-episodes-terminate-at-learner-elimination--accepted-2026-06-25)

**Context.** Review of the tracer slice (PR #57) surfaced that the learner runs as an ordinary bot fn, so
`runBotDirect` (`src/arena/botRunner.js`) catches **every** throw it makes and converts it to a silent
turn-forfeit. Two "error paths" written to fail loud were therefore **dead on the live path**:
`chooseAction`'s `EnvClosed` on disconnect (so the `if (err instanceof EnvClosed) break` was dead code — a
vanished client made the `--episodes=0` server spin full matches forever) and `decodeAction`'s out-of-range
guard (a learner↔env action-space desync silently produced a stream of valid-looking, corrupt low-reward
episodes). An adversarial verification workflow (4 verifiers + a completeness critic) then found two more
deadlocks behind the JS-only `failSafe`: a hard worker death (OOM/segfault — no JS exception) or a
connected-but-silent learner parked the main thread's `Atomics.wait` forever (its blocked event loop can't
run `worker.on('error')`).

**Decisions.**

1. **All env↔learner control signals travel via the `onTurn` seam, never a `chooseAction` throw.** `runMatch`
   does not wrap its `onTurn` callback in try/catch, so a throw there propagates out of `runSelfPlayEpisode` —
   the one abort path the engine's bot-fn try/catch can't swallow. `chooseAction` records _why_ the learner
   was lost (`lostError`) and a `failIfLost` onTurn guard re-raises it on the next turn boundary (≤1 forfeited
   turn of slack); the worker always posts `closed` on socket loss.

2. **A per-decision watchdog.** `--decision-timeout-ms` (default 120 s — inference is sub-second; 0 disables)
   bounds the main-side `Atomics.wait`, so a hung learner or a hard worker death aborts loud instead of
   deadlocking. This is the gate the verification critic put on long unattended training (shodan, steps 4–7).

3. **A clean disconnect is exit 0; a timeout or an action-space desync is fatal (exit 1).** An out-of-range
   action index is a trainer-side masking/`MAX_EDGES` bug, not a recoverable move — surface it loud with a
   diagnostic rather than forfeit and poison the data. The protocol contract the Python client must honor:
   reply within the deadline, never send an index outside `[0, numEdges)`.

4. **Placement gains a same-turn co-elimination correction (refines [D-20] pt 3).** `runMatch` appends
   simultaneous eliminations to `eliminationOrder` in ascending seat id and `calculatePlacements` reverses
   that, so a co-eliminee with a HIGHER id than the learner finishes ABOVE it yet isn't counted in `#alive`.
   `eliminationOutcome` now uses `rank = aliveCount + (higher-id same-turn co-eliminees)` — verified exact vs
   `calculatePlacements` over a 1,560-game oracle sweep (0 mismatches; the naive `#alive` model was wrong in 19).

**Rejected.** A heartbeat/bounded-retry protocol over the socket (more moving parts than a per-decision
deadline buys for a single-learner env). Signaling the disconnect by throwing from `chooseAction` and
"catching it later" — impossible, `runBotDirect` eats it first; that _was_ the original dead-code bug.

**Notes.** No engine or shipped-bot changes — all in `scripts/` + `tests/ml/`. Regression coverage:
`npm run ppo:disconnect-smoke` (disconnect → exit 0, watchdog → exit 1, desync → exit 1) + 22 new unit tests.
Full suite 965 green; CI green on `be126bc`. Session: `LOG.md` 2026-06-25 "review hardening".

---

## D-22 — PFSP league is Node-resident; build ONE league pipeline and run fixed-field as its empty-pool mode (cheap "does PPO learn?" gate first) · Accepted (2026-06-26) · follows [D-19](#d-19--phase-3-ppo-architecture-in-process-self-play-env-over-a-nodepython-socket-edgepolicynet-trunk-policy-warm-started-from-v2-bc-pfsp-league-in-the-full-8-ffa--accepted-2026-06-25) / [D-20](#d-20-phase-3-throughput-proven-green--max_edges--64-episodes-terminate-at-learner-elimination--accepted-2026-06-25) / hardened by [D-21](#d-21--envlearner-control-plane-signal-via-the-onturn-seam-a-per-decision-watchdog-fail-loud-on-desync-placement-gains-a-same-turn-co-elimination-correction--accepted-2026-06-25)

**Context.** PR #61 closed the Phase-3 tracer slice — the `repack → export → register → gate`
chain is proven on a real trained PPO policy (tracer: 11.5% vs Lookahead 15.1%, paired Δ −3.6 pp,
❌ BEHIND, exactly the loop-closer expectation). What remains is the **scaling** work toward an
actual BEAT, of which the **PFSP opponent league** ([D-19]) is the central algorithmic piece. Before
writing it we scope-grounded the design against the code (the [D-12]/[D-19] method): a 6-reader
surface-map of the exact seams + two independent design takes (minimal-change vs best-architecture) +
an 8-claim adversarial verification pass (1 refuted, 2 qualified). Both takes converged on the same
architecture; verification corrected the naive plan in four places.

**Decisions.**

1. **The league is Node-resident; Python only _produces_ snapshot artifacts.** The opponent pool,
   the per-episode sampler, and the win-rate book all live in a new `scripts/lib/ppo-league.mjs`
   inside the env-server. This is **forced by the wire, not a preference**: the learner→env uplink is
   a bare 4-byte i32 action with no message type and `env.reset()` sends zero bytes
   (`ml/dicewars_ppo/wire.py:266-269`, `scripts/lib/ppo-socket-worker.mjs:113`, `ml/dicewars_ppo/env.py:140-156`),
   so Python cannot select opponents per-episode without adding a typed inbound control frame — the
   exact path [D-21] hardened with fail-loud desync guards (the riskiest place to touch). The Node
   episode loop already has a per-episode hook and `runSelfPlayEpisode` rebuilds its roster fresh
   from `cfg.opponents` every call with **zero cross-episode state** (verified — `scripts/lib/ppo-env.mjs:153-197`),
   so a Node-side draw is a zero-wire, zero-restart change. Independently matches [D-19]: snapshots
   run in-process as JS bots via `makeBC({ policy })`, never evaluated back in Python.

2. **Build ONE league pipeline; fixed-field is its degenerate empty-pool mode — not throwaway code.**
   Replace the loop-invariant `opponents` constant (`scripts/ppo-env-server.mjs:259`, resolved once at
   `:127`) with `league.draw(seed)`; with an empty snapshot pool the sampler fills all seats from the
   fixed baselines = today's tracer field. So the cheap gate exercises the exact same draw/record/refresh
   paths the real league uses, and turning PFSP on is a cadence flag, not a re-architecture.

3. **Sequencing: fixed-field-first, then PFSP — reconciled with [D-19].** The one unknown that gates
   the whole phase is binary and cheap: _does PPO move past the BC ceiling (12.5%) toward Lookahead
   at all?_ Answer it first on the existing fixed heterogeneous field (zero new code), then flip
   snapshots on for the long-horizon BEAT run. [D-19]'s "PFSP from step one" warned about a _static_
   field overfitting over the **long** horizon; that does not bite a short diagnostic, and the tracer
   field is 5 distinct strategies (not the all-Lookahead mirror [D-15] warns about), so it has neither
   the turtle nor a single-exploit problem. The asymmetry is decisive: if PPO doesn't move on a strong
   heterogeneous field, a fancier opponent distribution wouldn't have saved it (the failure would be
   reward/credit-assignment/encoding) — so PFSP-first would burn the league build for nothing.

4. **Sampling & anchoring.** Per episode, reserve **R ≈ 3–4 aggressive baselines**
   (`ai_lookahead, ai_strategist, ai_expectimax, ai_defensive`) in _every_ 8-FFA game; PFSP-sample
   only the remaining `7 − R` seats. This is the structural defense against the [D-15] turtle
   equilibrium (snapshots are BC/PPO-lineage and STOP-biased). Weight `w(S) = max(ε, 1 − learnerWinRate(S))^k`
   ([D-19]'s "∝ win-rate vs the learner" = focus on opponents that beat the learner; ε floor keeps new
   snapshots sampled). RNG = `mulberry32(seedBase + ep)` — deterministic, never `Math.random`. **Hold
   `player_count` constant** (`runMatch` derives it from `bots.length`; varying it rescales the board —
   vary identity only).

5. **Win-rate bookkeeping is the real work item, attributed pairwise.** Today's outcome objects carry
   _only the learner's_ result, with no per-opponent attribution — so the league must add placement-relative
   crediting: the learner "beat" snapshot `S` iff it outplaced `S` (from `result.placements`, or
   `finalState.players[].eliminated` on early elimination). **Exclude `maxTurns` truncations**
   (`truncated=1`) from win-rate stats — counting stalemates as losses biases the sampler back toward
   turtle fields; log truncation rate separately as a decisiveness health metric.

6. **Snapshot pipeline (verification-corrected).** A periodic Python SB3 `BaseCallback` does
   `repack_to_bc_checkpoint(model.policy)` (in-memory, drops the PPO critic, keeps `value_head`) →
   `export_weights.export(...)` → atomic `manifest.json` rewrite (the "new snapshot available" signal —
   no wire message). Node polls the manifest at episode boundaries and loads new snapshots once via
   `makeBC({ policy })`, caching `{ id, fn }` (**fresh filename per snapshot** — ESM `import()` caches by
   URL). **Snapshots do NOT need a per-snapshot parity fixture** (a naive claim, refuted): the in-process
   `makeBC` path needs only weights + matching `encodingVersion`/`maxAreas`; the `.fixture.json` is
   required _only_ if a snapshot is routed through `loadExportedPolicy`'s offline parity pre-flight
   (the gate/capacity-probe trust step). So snapshot export is weights-only; parity is an optional
   one-time check at export time.

**Constraints surfaced (must honor).**

- **Freeze `ENCODING_VERSION` (currently 2) for the whole run.** `makeBC` hard-throws on encoding skew
  (`src/ai/ai_bc.js:72-77`), so the league cannot pool snapshots taken across a version bump — they
  become _unloadable_ mid-run, not gracefully degraded. A bump means re-export/invalidate older snapshots.
- **Dedup is `uniquifyNames` appending `#N`** (`scripts/lib/ppo-env.mjs:328`), not an `@i` seat suffix
  (which doesn't exist). Any roster with repeated snapshots must route through `runSelfPlayEpisode`'s
  roster build (which calls it) or it hits `runMatch`'s unique-name throw (`src/arena/matchRunner.js:235`).
- **Re-probe decisive-rate + throughput on a snapshot-heavy field** before locking the env-step budget:
  a BC-forward seat costs ~0.8 ms/move vs ~0.02–0.4 ms for heuristics ([D-20]), and [D-15]'s
  decisive-rate was only validated for hand-picked fields.

**Open sub-decision (deferred to build time): cross-worker stats.** Per-worker-independent leagues
(simpler; noisier sampling on small per-worker counts) vs a shared-on-disk global league
(append-only per-worker result logs folded into one `winrates.json`; lower variance; ~1 extra day).
Lean **shared-disk-global with a pluggable backend**, since PFSP sampling quality directly affects the
BEAT outcome — but ship per-worker if the aggregator proves more than ~1 incremental day.

**Rejected.** A Python-driven sampler (would require extending the [D-21]-guarded wire for no v1
benefit). A throwaway standalone fixed-field harness (Take A's first cut) — it pays back its 2–3 day
head start re-integrating PFSP and rebuilding per-worker stats into a global league later; decision 2
makes fixed-field a _mode_ of the one pipeline instead.

**Notes.** Effort ≈ 1 week for the clean PFSP-ready pipeline, with the fixed-field gate runnable on
day 2–3 (empty pool = tracer field, no snapshot callback needed yet). Grounding: design workflow
(6-reader map + 2 design takes + 8-claim adversarial verify). **Caveat for the scaling run:**
`train_tracer.py` takes the knobs (`--timesteps/--lr/--ent-coef/--n-envs`) so the fixed-field gate
needs no new code, but its _defaults_ are tracer-low (won't learn) and it has **no checkpoint/resume,
no TensorBoard/CSV, and uses `DummyVecEnv`** (sequential) — fine for a bounded diagnostic, but the
durable **shodan training-ops** task (PLAN Phase-3 scaling) is the prerequisite for the long BEAT run.

---

## D-23 — Task B build scope: the PFSP opponent league (Node-resident) · Proposed (2026-06-27) · follows [D-22](#d-22--pfsp-league-is-node-resident-build-one-league-pipeline-and-run-fixed-field-as-its-empty-pool-mode-cheap-does-ppo-learn-gate-first--accepted-2026-06-26) · **hard prerequisite: PR #62**

**Context.** The fixed-field 1M run passed the headline gate (PR #63, paired **Δ +33.4 pp** vs
`ai_lookahead` — first BEAT), which per [D-22]'s material-gain branch green-lights Task B: a
**Prioritised Fictitious Self-Play (PFSP)** opponent league so the learner trains against an
ever-growing pool of _its own past snapshots_, weighted toward the ones that beat it, instead of a
static field it can overfit over the long horizon ([D-19]). Scoped via a 9-agent workflow (4
code-readers → 3 design takes → synthesize + adversarial verify; verdict "mostly-sound" — the
corrections below are folded in). The league is **Node-resident** ([D-22], forced by the i32-only
wire). Task B is one behavioral change: replace the loop-invariant `opponents` const in
`scripts/ppo-env-server.mjs` with a per-episode `league.draw(seed)`. **Fixed-field (Task A, shipped)
is the empty-pool degenerate mode of this same pipeline** — A and B share all draw/record/refresh
code.

**File manifest.**

- NEW `scripts/lib/ppo-league.mjs` — pool + seeded `mulberry32` sampler + win-rate book + R reserved
  baselines. (imports `mulberry32` from `ppo-probe-core.mjs:30`, `makeBC` from `ai_bc.js:67`,
  `BUILT_IN_BOTS`.)
- NEW `scripts/lib/ppo-league-store.mjs` — pluggable win-rate backend: `InMemoryStore` (default,
  per-worker) + `SharedDiskStore` (opt-in, lands with Task E).
- NEW `ml/dicewars_ppo/snapshot_callback.py` — `SnapshotCallback(BaseCallback)`: periodic repack →
  `export_weights(..., fixture_path=None)` → atomic `manifest.json`.
- MOD `scripts/ppo-env-server.mjs`: `:127` const → `makeLeague(...)`; loop-top `league.refresh()`;
  `:259` draw `league.draw(seed)`; post-episode `league.recordResult(drawn, result)` (inside PR
  #62's per-episode decision-count gate); `KNOWN_FLAGS` (`:52-63`) gains
  `snapshot-manifest`/`snapshot-store`.
- MOD `scripts/lib/ppo-env.mjs`: add a per-seat `seatBeat[]` vector to BOTH `summarizeOutcome`
  (`:259`) and `eliminationOutcome` (`:299`); thread a `coElimSeats` Set out of `guardedOnTurn`
  (`:209-230`, which already iterates the same-turn co-eliminations for `abortCoElimAbove`).
- MOD `ml/dicewars_ppo/train_tracer.py:150`: attach `SnapshotCallback`; add `--snapshot-dir` /
  `--snapshot-every` / `--snapshot-pool-cap` to `build_parser`.
- MOD `ml/dicewars_ppo/env_server.py`: **extend the `EnvServerProcess.__init__` signature (`:72-90`,
  keyword-only, no `**kwargs`)** for `snapshot*manifest`/`snapshot_store` AND forward them in the
argv builder (`:104-118`) — *[verifier correction: a new kwarg cannot flow opaquely through_
  `DiceWarsEnv` → `EnvServerProcess(**server_kwargs)` _without the param existing, so it would
  `TypeError`; `env.py` itself needs no change].\_

**League API (`makeLeague`).** `draw(seed) → {opponents:{name,fn}[], drawn:{id,kind,seat}[]}` (both
length `count`, index-parallel; empty-pool branch returns `resolveOpponents(csv, count)` verbatim →
byte-identical to Task A, since outcome depends only on seed × ordered fns); `recordResult(drawn,
result)`; `refresh()` (poll manifest, hot-load new snapshots via `makeBC({policy})` with a **fresh
filename per snapshot** — ESM caches by URL); `addSnapshot`; `winRate(id)`; `stats()` (the [D-22]
decisive-rate health metric); `toJSON()/restore()` (Task-E checkpoint/resume). **`baselines` are
threaded from the resolved `opts.opponents` (the trainer passes `DEFAULT_OPPONENTS`), NOT a hardcoded
default inside `makeLeague`** — the env-server's own bare default is `ai_bc` (a single cycled bot),
so empty-pool == fixed-field parity holds per-launch only when the resolved csv is used _[verifier
correction]._

**Win-rate attribution** (the [D-22] "real work item"). Book = `Map<id,{wins,games}>` keyed by stable
opponent id (snapshot id / baseline id), **never** the `uniquifyNames` `#N` display name. Strict
**pairwise placement-relative** (exactly `elo.js:56-67` restricted to learner-containing pairs); one
FFA game with `m` snapshot seats → `m` independent records. The one code extension is a per-seat
`seatBeat[]` on both outcome shapers so the league reads it path-agnostically: the full-game path
compares `placements`; the early-elimination path (the common one under `terminateOnElimination:true`,
`placements===null`) derives it from `players[s].eliminated` + the same-turn `coElimSeats` seat-id
tie-break, **preserving the ~2× throughput win** instead of paying for full `placements`.
`recordResult` EXCLUDES `result.truncated` (maxTurns stalemate) entirely — counting stalemates as
losses would bias the sampler back toward turtle fields.

**Snapshot pipeline + stats locality.** Producer: `SnapshotCallback._on_step()` every N steps →
`repack_to_bc_checkpoint` (`policy.py:261`) → `export(tmp.pt, snap-<step>.weights.js,
fixture_path=None)` → atomic publish (weights fsynced **first**, then `os.replace(manifest.tmp,
manifest.json)`; schema `{encodingVersion:2, snapshots:[{id,step,weights,createdAt}], latestStep}` —
a NEW manifest, distinct from the BC-corpus `manifest.py` one). Consumer: Node `refresh()` diffs the
manifest and `makeBC`s each new id (NOT `loadExportedPolicy` — that mandates the absent parity
fixture; `makeBC` needs only weights + matching `encodingVersion`/`maxAreas`). **Frozen invariant:
`ENCODING_VERSION = 2` for the whole run** (`makeBC` hard-throws on skew → a mid-run bump makes pooled
snapshots _unloadable_, not gracefully degraded). **Stats locality (chosen): ship the pluggable
`store` now, default `InMemoryStore` (per-worker); land `SharedDiskStore` with Task E** when
`SubprocVecEnv` makes per-worker books noisy ([D-22] leans shared-disk-global; the interface makes it
a one-line swap). **Disk retention: GC the evicted snapshots' `.js` files** — `poolCap` bounds the
live (sampleable) pool and, via the GC, disk; it does NOT bound process memory (Node's ESM registry
retains every dynamic-`import()`ed snapshot module for the run), and the mandatory fresh-filename
guarantees unbounded disk growth without the GC _[verifier correction; memory caveat added post-review]._

**Sampler params (chosen defaults — all CLI knobs).** `w(S)=max(ε,1−winRate(S))^k`; `ε=0.05`, `k=2`,
`poolCap=40` (FIFO-by-step eviction — keeps the most recent/hardest snapshots; FIFO avoids the
catastrophic-forgetting risk of "evict most-mastered"), cold-start `winRate=0` (a new snapshot gets
max weight → sampled hardest first). **Reserve `R=3` aggressive baselines every game** (the [D-15]
turtle-equilibrium defense; reserve set = baselines minus `ai_bc`, the STOP/turtle lineage).
**`count = playerCount − 1 = 6` at the default `playerCount = 7`** (NB the env trains 7-FFA while the
gate evaluates 8-FFA), so R=3 leaves **3** PFSP seats _[verifier correction — the synthesis's "4 PFSP
seats / count=7" was off by one]._ `R` must be re-validated against the real `count` on a
snapshot-heavy field (B5).

**Build sequence (incremental, individually testable).**

- **B0 — merge/rebase PR #62 first** (hard prerequisite, below) + add the CLI flags + document the
  `ENCODING_VERSION=2` run-invariant. No behavior change.
- **B1 — empty-pool league == Task A** (the parity milestone): `makeLeague` + `draw` empty-pool branch
  wired at `:127`/`:259`; `recordResult` telemetry-only. **Acceptance: byte-identical rosters/outcomes
  to the current fixed field** (same seeds → same field → same `placements`/`won`).
- **B2 — `seatBeat[]` + win-rate book** (both shapers, `coElimSeats` threaded; truncations excluded).
- **B3 — snapshot pipeline** (callback → repack → `export(..., fixture_path=None)` → atomic manifest;
  Node hot-load via `makeBC`, fresh filename).
- **B4 — PFSP weighting on** (`w(S)` + R reservation; seeded-deterministic, weight-monotone in
  `1−winRate`, empty-pool fallback).
- **B5 — throughput / decisive-rate re-probe** (snapshot-heavy field via `league.stats()` / the
  throughput probe; BC-forward seats cost ~0.8 ms/move vs ~0.02–0.4 ms heuristic — [D-20]); tune
  `R`/cadence, **THEN lock the env-step budget** (the [D-22] gate).
- **B6 — persistence + `SharedDiskStore`** (`toJSON()/restore()`; with Task E).

**Open questions (for Ivan).** (1) **stats locality** — confirm shared-disk-global is wanted for Task
E, or accept noisier per-worker. (2) **zero-decision episodes (PR #62 interaction)** — skipped for PPO
(no transition) but a real, decisive placement loss; **recommend recording it for win-rate** (it
correctly up-weights a field that crushes the learner fast — exactly what PFSP wants), but it's a
genuine policy call, and the `recordResult` call must sit where it can see the skip flag. (3) sampler
HPs are reasoned, not tuned. (4) snapshot cadence `N` coupled with `R` in the B5 re-probe.

**Dependencies.** **PR #62 (`fix(ml): skip zero-decision episodes`, `5a665ff`) is a HARD, currently
OPEN prerequisite** — it touches the exact episode loop Task B modifies, and the zero-decision skip
interacts with `recordResult` attribution; **merge or rebase it first (= B0).** Task A (shipped) —
empty-pool reproduces it. Task C (from-scratch control + cross-core) — the snapshot callback is
mode-agnostic; C is where cross-worker aggregation becomes load-bearing (intertwined with the `store`
backend). Task D (reward shaping) — orthogonal (env-side JS reward). Task E (`SubprocVecEnv` +
checkpoint/resume) — must persist the league pool + book + counters (B6).

**Status: In progress (B0–B4 shipped 2026-06-27).** B0 (PR #62 merged) · B1 (PR #64, empty-pool
parity) · B2 (per-seat `seatBeat[]` + win-rate book) · B3 (snapshot pipeline:
`ml/dicewars_ppo/snapshot_callback.py` + league `refresh()` + the `--snapshot-*` flags) · B4 (PFSP
sampling on in `draw()`). **B3
deviations from this scope:** (a) `--snapshot-store` deferred to B6 with `SharedDiskStore` rather than
shipping a dead flag now; (b) `--snapshot-pool-cap` added and forwarded through `EnvServerProcess`
(the pool cap is the consumer-side setting that must reach the Node league — D-23's literal list only
named `snapshot_manifest`/`snapshot_store`); (c) the producer `manifest.json` is append-only (entries
are tiny; prune in B5/B6 if it matters); (d) `draw()` does NOT sample the pool until B4, so B3 is
behavior-preserving. **B4 implementation notes.** Non-empty-pool `draw(seed)` seeds a `mulberry32`
stream and fills `count` seats: `reserveCount = min(R, count, #distinctReserveBaselines)` aggressive
baselines (CSV ids minus `ai_bc`) sampled WITHOUT replacement, then `count − reserveCount` snapshots
sampled WITH replacement by `w(S) = max(ε, 1 − learnerWinRate(S))^k` (ε=0.05, k=2; cold-start
`winRate=0` → weight 1 → sampled hardest; ε>0 floors every weight at ε^k>0 for sane k so a mastered
snapshot is never starved — with a `total===0 → uniform` fallback for the pathological-k case where
ε^k underflows to 0.0 in IEEE-754), then a Fisher-Yates shuffle of opponent→seat (same seeded stream)
so neither group binds to fixed turn-order seats. Deterministic given (seed, pool, book). The PFSP
knobs are validated UNCONDITIONALLY on both sides (Node `makeLeague` and Python `_validate_args`), and
the reserve-pool build re-validates ids beyond the cycled `count` (which `resolveBaselineField` skips).
Knobs are env-server flags `--reserve-baselines`/`--pfsp-epsilon`/`--pfsp-k`, forwarded by
`train_tracer`/`EnvServerProcess` on the `--snapshot-dir` branch (they only bite a non-empty pool).
**B4 deviation from this scope:** `mulberry32` was **extracted to NEW `scripts/lib/mulberry32.mjs`**
(re-exported from `ppo-probe-core.mjs` so its test/consumers are unchanged) instead of imported from
`ppo-probe-core.mjs` as the file manifest said — the league is a runtime lib and should not pull the
throughput-benchmark tool (and, through it, the env runner) into its module graph just to borrow a PRNG.
The Node sampler is unit-tested (`tests/ml/ppo-league-pfsp.test.js`) and the Python flag bridge by
`ml/tests/test_env_server_argv.py`; it gets its first live exercise on shodan at B5. **Next: B5**
(throughput/decisive-rate re-probe on a snapshot-heavy field; re-validate `R` against the real `count`).

**Grounding.** 9-agent scoping workflow (4 code-readers mapping env-server / training-snapshot /
match-stats / locked-decisions → 3 design decisions → synthesize + adversarial verify). One design
agent (stats-locality) hit the structured-output retry cap; the synthesizer reconstructed that piece
from the maps, and the verifier confirmed it against the code.

**B5 done (2026-06-27): all six steps B0–B5 shipped.** B5 = the throughput/decisive-rate re-probe;
its empirical result + the budget-gate resolution are [D-24](#d-24--b5-the-snapshot-heavy-re-probe-env-sim-is-not-the-bottleneck-r3-locked--accepted-2026-06-27).

---

## D-24 — B5: the snapshot-heavy re-probe — env-sim is NOT the bottleneck, R=3 locked · Accepted (2026-06-27) · resolves the [D-22](#d-22--pfsp-league-is-node-resident-build-one-league-pipeline-and-run-fixed-field-as-its-empty-pool-mode-cheap-does-ppo-learn-gate-first--accepted-2026-06-26) budget gate · closes [D-23](#d-23--task-b-build-scope-the-pfsp-opponent-league-node-resident--proposed-2026-06-27--follows-d-22--hard-prerequisite-pr-62) step B5

**Context.** [D-22] deferred locking the env-step budget until a re-probe on a **snapshot-heavy** field —
the field the PFSP run actually trains against once its pool fills with net-policy snapshots (BC-forward
~0.8 ms/move, far costlier than the cheap heuristics the [D-20] probe measured). [D-23] open-Q4 also
coupled snapshot cadence `N` with the reserve count `R`, and the [D-15] turtle risk needed re-checking
on a self-similar snapshot field. B5 answers all three.

**Tooling.** NEW `npm run ppo:league-probe` (`scripts/ppo-league-probe.mjs` + `scripts/lib/ppo-league-probe-core.mjs`

- `-worker.mjs`, 23 tests) drives the **real** `makeLeague` sampler (`refresh → draw →
runSelfPlayEpisode → recordResult → stats`) — the genuine "first live exercise of the sampler" ([D-23]),
  unlike the [D-20] probe which ran a fixed field and could not exercise the league. Snapshots are injected
  without the Python producer via **re-export shims** ( `export { BC_POLICY } from '…ppoPolicyWeights.js'`)
  so `refresh()` `makeBC`-wraps the same ~2 MB module per snapshot. **Two decisive-rates, never conflated**
  (the scope-verify's central correction): **PASS A** learner-relative (`terminateOnElimination:true`, the
  trainer's exact regime → `league.stats().decisiveRate`, the budget basis) and **PASS B** global/[D-15]
  turtle (`terminateOnElimination:false`, `winner!=null`). Driven by a greedy PPO-policy learner.

**Result (shodan, 16-core, Node v22, D-23 standard field, count=6; full numbers in RESULTS.md).**

- **env-sim is NOT the bottleneck.** GREEN at EVERY reserve count: **50.7M (R=0, all 6 seats snapshots)
  → 89.9M (R=4) env-steps/12h** at 14 workers — ~25–45× the ≳2M GREEN bar. This **refutes the [D-19]
  worry** that in-process net-policy opponents could make env-steps prohibitive. The real binding rate
  is the SB3/PPO learner loop (task-A's 1M run was GPU/`DummyVecEnv`-bound at ~17 eff steps/s, NOT
  env-sim-bound), which task C/E's `SubprocVecEnv` lifts. So the [D-22] env-sim gate is **PASSED**, and
  the long-run env-step budget is set by the learner side, not by env simulation.
- **R = 3 LOCKED** (the [D-23] default, confirmed not deviated). All R are GREEN and turtle-healthy
  (PASS B global decisive 85–95%, ≫ the 60% floor Ivan set); warm-book learner-relative decisiveRate
  95.3% at R=3. Nothing forces R lower (throughput is GREEN everywhere) or higher (no turtle), so keep
  the full [D-15] defense — 3 distinct aggressive baselines every game + 3 PFSP snapshot seats. Even
  R=0 (all-snapshot) is 90.5% global-decisive: **the PPO/BC snapshot field does not turtle.**
- **MAX_EDGES = 64 holds:** numEdges p100 ≤ 27, 0 overflow on the snapshot-heavy field.
- **Cadence `N` (open-Q4) resolved:** per-move cost is **pool-size-invariant** and per-snapshot memory
  is ~2 MB resident in Node's ESM registry, so on 128 GB shodan memory is unconstrained at realistic
  `N`. `N` is **decoupled from throughput** — pick it for pool freshness (fill to `poolCap=40` within
  the first budget unit), a task-C/E tuning knob, not a budget constraint.
- **Snapshot per-move cost** ~1.2 ms single-thread / ~2.2 ms under 14-worker contention on 16 cores
  (vs [D-20]'s ~0.8 ms on a lighter box) — still GREEN by a wide margin.

**Kill threshold (unchanged, [D-19] pt4 / [D-22]).** After one budget unit of the long run, `npm run
ppo:gate` paired Δ vs `ai_lookahead@596f781`; if the 95% CI lower bound is not > 0 → declare plateau,
fall back to the shipped BC / Track-A bot rather than pour in more compute. Pre-launch turtle floor =
global decisiveRate ≥ 60% on the snapshot-heavy field — passed (92% at R=3).

**Decisions made with Ivan.** (1) drive the shodan run directly over `ssh`; (2) probe + lock against the
**D-23 standard field**; (3) let the sweep decide R with R=3 as the default → it confirmed R=3; (4) turtle
floor **~60%**.

**Caveat.** The probe measures the **env-sim** rate only (the [D-19] assumed bottleneck); the real trainer
rate is `min(env-sim, GPU/learner-consume)`. B5 establishes that env-sim has ~25–45× headroom, so the
learner loop is the lever — sized in task C/E.

**Grounding.** Two multi-agent workflows: a 7-agent scope (4 code-readers → 2 design takes → verify+
synthesize, which caught the two-decisive-rates conflation, the no-`addSnapshot`/manifest-seeding path,
and the unverified reserve-CSV assumption) and a 5-agent adversarial review (correctness / fidelity-
silent-failure / tests / verify → synthesize) whose one must-fix — cold start polluting the throughput
denominator — was fixed before the run (throughput now = `learnerDecisions / max(steady-state shard
elapsedMs)`, cold start excluded).

---

## D-25 — B6: league persistence (`toJSON`/`restore`) + pluggable `SharedDiskStore`, as a standalone Node PR · Accepted (2026-06-27) · closes [D-23](#d-23--task-b-build-scope-the-pfsp-opponent-league-node-resident--proposed-2026-06-27--follows-d-22--hard-prerequisite-pr-62) step B6 · feeds Task E

**Context.** [D-23] step B6 = the league-side checkpoint/resume primitive Task E's idempotent resume will
drive, plus the pluggable win-rate `store` ([D-22] leans shared-disk-global once `SubprocVecEnv` makes
per-worker books noisy). D-23 worded it "lands WITH Task E"; most of it is Node-side and testable with no
GPU, so **two forks were put to Ivan and both confirmed: (1) ship B6 as a STANDALONE Node PR** (Python
forwarding + `SubprocVecEnv` + live cross-worker validation ride Task E); \*\*(2) implement `SharedDiskStore`

- unit-test it single-process, but gate its live multi-worker path until Task E.\*\* Mirrors the B3→B4
  "plumbing before consumer" precedent.

**Decision.**

- **Pluggable store seam** (NEW `scripts/lib/ppo-league-store.mjs`). `makeInMemoryStore()` (default,
  per-process `Map`, byte-identical to the B2–B5 inline book) + `makeSharedDiskStore({dir,workerId})`
  (own book in memory; `flush()` writes a full `book-shard-<workerId>.json` atomically; `refreshGlobal()`
  recomputes the PEER merge from scratch — own shard excluded — so the fold is idempotent + order-
  independent and a worker never double-counts itself). `winRate = (own+peers)/(own+peers games)`.
  **`workerId` = the env `seed_base`** (disjoint, restart-stable — NEVER a PID, which would orphan a shard
  on resume). The store is injected into `makeLeague` (`opts.store`); the league's three book touchpoints
  route through `record`/`winRate`/`size`. `flush`/`refreshGlobal` are the only syscalls and are driven by
  the env-server at the episode boundary, never on the decision hot path; both are no-ops for the in-memory
  store. **The snapshot pool stays convergent for free** — every worker polls the same producer manifest;
  only the win-rate book is the cross-worker-shared part.
- **`toJSON()`/`restore()` on `makeLeague`.** `toJSON` is plain JSON (no `fn`/`Map`/`Set`): counters, the
  book (`store.toJSON()` → entry copies for memory, `null` for disk since it lives in shards), `storeKind`,
  the pool as `{id,step,weightsPath}` in CURRENT array order (NOT re-sorted — `draw()`'s PFSP weighting is
  pool-index-parallel), and `loadedIds`. `restore()` gates BEFORE any mutation/import — **version,
  `encodingVersion`, fingerprint, `storeKind`** — then rebuilds the pool into a LOCAL (atomic: a bad
  snapshot leaves the league unmutated) by re-importing each `weightsPath` via `makeBC`, and resets
  `manifestMtimeMs=-1` (force a fresh manifest re-poll, picking up snapshots published between checkpoint
  and crash). An evicted/unlinked weights file → WARN+skip+KEEP id in `loadedIds` (so a later `refresh()`
  never re-imports the deleted file; the book record is preserved); any OTHER import error throws.
  **`fingerprint` covers every draw/eviction-determining arg** (`count`/`learnerSeat`/`poolCap`/
  `reserveBaselines`/`pfspEpsilon`/`pfspK`/ordered baseline ids), so a resume under drifted CLI args fails
  loud rather than diverging.
- **Env-server wiring (opt-in, no-op when absent).** New flags `--snapshot-store=memory|disk` /
  `--league-state-dir=<dir>` / `--league-dump-every=50` + an exported `resolveLeaguePersistence`
  (store selection + per-worker `league-state-<seedBase>.json` path). Restore-on-startup;
  `store.refreshGlobal()` at the episode boundary; periodic dump after `recordResult` and **before** the
  zero-decision `continue` (so a zero-decision storm still flushes on cadence); final + best-effort SIGTERM
  dumps. **Persistence is OPT-IN** (enabled only by `--league-state-dir` OR `--snapshot-store=disk`); with
  none of the three flags the run is byte-identical to B5 — the 91-case B1–B5 league suite passes unchanged.

**Review-hardening (5-agent adversarial review → SHIP-AFTER-FIXES, no blockers, zero phantom findings).**
Folded all worthwhile findings into this PR: **S1** mkdir the state dir at launch (fail loud, not silent
zero-checkpoints); **S2** dump-failure tracking → `dumpFailures=` on the DONE line + fail loud after 10
consecutive (silent non-durability is worse than aborting); **S3** `storeKind` gate (a backend switch on
resume would zero the book); **S4** reject a pooled module with no `BC_POLICY` export in BOTH `restore()`
and `refresh()` — `makeBC`'s default param would otherwise silently load the SHIPPED BC as a corrupt
snapshot (empirically confirmed); **S5** `refreshGlobal` distinguishes benign skips from real FS errors;
**S6** the disk store recovers its own shard at CONSTRUCTION (own-book recovery independent of the state
file); plus atomic `restore()` and `--league-dump-every≥1` validation.

**Deferred to Task E** (with `SubprocVecEnv`, its sole live consumer): Python forwarding of the new flags
through `env_server.py`/`train_tracer.py`; the `refresh()` **multi-worker snapshot-GC race** (a peer
`unlinkSync` racing a late worker's backfill import — kept out to keep the B5-locked `refresh()` byte-
identical; a hard E precondition); the env-server `main()` persistence-wiring integration test; and live
cross-worker `SharedDiskStore` validation. None block B6 (single-process B6 can't spawn a second league).

**Status: MERGED 2026-06-27** (PR #69, squash `d637a06` on master). `tests/ml/` 190 green, full suite
1141 green, eslint + build clean. **Task B (PFSP league) is now feature-complete (B0–B6); the remaining
Phase-3 work is task C/E (cross-core + training-ops) → the long BEAT run.**

**Grounding.** Two multi-agent workflows: a 12-agent design (4 code-readers → 3 design takes → synthesize
→ 3 adversarial-verify lenses → finalize) producing the vetted blueprint, and a 5-agent review
(correctness / silent-failure / tests / grounding → verify-and-synthesize against ground truth).

---

## D-26 — Task C/E design: SubprocVecEnv + shodan training-ops; DROP VecNormalize; idempotent two-half resume · Accepted (2026-06-27) · closes Phase-3 tasks C/E design · follows [D-25](#d-25--b6-league-persistence-tojsonrestore--pluggable-shareddiskstore-as-a-standalone-node-pr--accepted-2026-06-27--closes-d-23-step-b6--feeds-task-e)

**Context.** Tasks B0–B6 (the PFSP league) are feature-complete; the remaining Phase-3 work before the
long BEAT run is task C (scale envs across cores + a from-scratch control) and task E (shodan
training-ops: schtasks launch, idempotent checkpoint/resume, TensorBoard+CSV, `DummyVecEnv`→
`SubprocVecEnv`). A 13-agent design workflow (4 code-readers → 3 design takes → synthesize → 4
adversarial-verify lenses → finalize) produced a vetted, code-anchored blueprint, then Ivan confirmed
the two genuine forks.

**Decisions (Q1–Q6).**

- **Q1 — new `ml/dicewars_ppo/train.py` + extract a torch-free `_train_common.py`** (shared env-thunk /
  arg parser). Do NOT fork the tracer; one shared definition keeps the green CI tracer byte-identical.
  `_train_common.py` must NOT import torch/sb3 at module top (SubprocVecEnv children import it).
- **Q2 — DROP VecNormalize entirely** (`norm_obs=False, norm_reward=False`; don't wrap). _This reverses
  the PLAN's literal "checkpoint/resume of policy + optimizer + VecNormalize + RNG" wording_ — the
  adversarial verifier (grounded in `env.py:103-113`/`238-261`, `policy.py:108-136`, `model.py:113-161`,
  `constants.py:30-68`, and the SB3 2.9.0 `VecNormalize` source) showed obs-normalization would
  **corrupt the encoding contract**: it standardizes the int edge-index keys (`edge_from`/`edge_to`
  → garbage after `.long()`), hard-`ValueError`s on the `edge_mask` `MultiBinary`, and breaks the
  `present`-column masked-mean pool the warm-started trunk depends on. Reward-normalization only
  manufactures a drifting scale on a clean `{0,1}` / `gamma=0.999` terminal return that PPO's own
  advantage-normalization already handles. So there is **nothing VecNormalize-shaped to checkpoint**;
  the resume state is policy + optimizer + `num_timesteps` + RNG + league pool/book only.
- **Q3 — resume is TWO independent idempotent halves, no two-phase commit.** Python owns
  policy/optimizer/`num_timesteps`/RNG/manifest/callback state; each Node worker owns its
  `league-state-<seedBase>.json` + `book-shard-<seedBase>.json`. Atomic `latest.json` written LAST is
  the Python crash-safety hinge. Resume is **"statistically consistent, bounded-skew," not bit-exact**
  (Node can't replay trajectories; the RNG sidecar de-randomizes only the Python half) — documented, not
  hidden.
- **Q4 — `SubprocVecEnv(start_method="forkserver")` + `VecMonitor` in the PARENT.** forkserver because
  CUDA inits at `MaskablePPO` construction (after the fork) so "venv built before CUDA" is not safe to
  rely on; VecMonitor in the parent keeps children importing only the torch-free `dicewars_ppo.env` yet
  still logs `rollout/ep_rew_mean`.
- **Q5 — consumer ENOENT-tolerance FIRST (the required floor), then producer-single-writer GC.** A
  lagging worker tolerates a peer-evicted snapshot file; the single Python producer owns disk deletion.
- **Q6 — `--from-scratch` flag** (mutually exclusive with `--freeze-trunk`): skip warm-start, still load
  the BC `cfg`, relax LR/ent-coef, stamp provenance. A SHORT control run before the long run proves the
  gate win is real PPO learning, not fixed-field BC exploitation ([D-19] control).

**Verifier-found resume bugs folded into the build (each with a regression test):** **HOLE-A** the
env-server replayed seeds from 0 on resume and re-booked them (double-count) → persist an `episodeCount`
seed-cursor; **HOLE-B** the league dump flushed the disk shard BEFORE the state file (a crash double-counts
the book) → write state first, flush shard second (turns double-count into bounded loss); **HOLE-C** a
resumed snapshot producer republished ids ahead of the resumed step → rehydrate the manifest filtered to
`step <= num_timesteps`; **HOLE-D** `reset_num_timesteps=False` makes a fixed `--timesteps` additive (a
crash-loop trains unbounded) → `remaining = max(timesteps − num_timesteps, 0)` (task-E).

**Build sequence (PR slices).** PR-1 Node crash-safety + GC-race floor + resume hardening (DONE) · PR-2
`EnvServerProcess` B6-flag forwarding (DONE) · PR-3 SnapshotCallback rehydration + single-writer producer
GC, consumer `unlinkSync` removed (DONE) · PR-4 `_train_common.py` + `train.py` (SubprocVecEnv + VecMonitor

- TB/CSV + `--from-scratch`) · PR-5 idempotent checkpoint/resume core · PR-6 committed shodan launcher +
  schtasks runbook · PR-7 deferred test-hardening (env-server `main()` persistence integration test; live
  cross-worker `SharedDiskStore`).

**Status: IN PROGRESS — foundation PR-1→PR-3 landed locally (branch `ml-bot/task-ce-foundation`).** PR-1:
`episodeCount` resume-cursor, `dumpLeagueState` state-then-flush order, `refresh()` ENOENT-tolerance +
id-dedup + `refreshSkips` health counter (stderr DONE mirror), schema v1→v2. PR-2: `snapshot_store` /
`league_state_dir` / `league_dump_every` forwarded by `EnvServerProcess` on their own gate (manifest-
independent), byte-identical when unset. PR-3: NEW torch-free `snapshot_manifest.py` (`rehydrate_snapshots`

- `gc_partition`); `SnapshotCallback` rehydrates on resume + GCs as the single disk writer; the consumer
  no longer unlinks. Local verification: `tests/ml/` 196 green, the torch-free Python tiers green
  (`test_snapshot_manifest.py` 12, `test_env_server_argv.py` 6), eslint + ruff clean. The torch-gated
  callback tests + the live SubprocVecEnv/shodan paths are verified on shodan (PR-4+).
