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
