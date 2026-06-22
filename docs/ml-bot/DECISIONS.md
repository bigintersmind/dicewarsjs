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

## D-Encoding — MDP / state / action / reward shape · Proposed (2026-06-21)

**Proposed (finalize in Phase 2).**

- **State:** graph over ≤31 territory nodes (adjacency from `neighborAreaIds`);
  node features = owner, dice (1–8), is-mine, is-border, per-edge win-prob from
  `WIN_TABLE`; per-player globals dominated by largest-connected-group income.
- **Action:** policy head over legal `(from,to)` border edges **plus an explicit
  STOP**, masked by `getValidMoves` (a turn is a _sequence_ of single attacks, not
  one batched move). Edge/pointer head, not a flat 31×31 head.
- **Reward:** terminal win/placement + dense shaping (Δlargest-group income,
  territory/dice deltas, eliminations).
- **Self-play:** a single shared stateless policy over the per-player view; the
  engine handles whose-turn via `turnOrder`/`currentPlayerIndex`.

**Status:** to be validated empirically in Phase 2 (if a net can't _clone_
`ai_strategist` under this encoding, the encoding is wrong).
