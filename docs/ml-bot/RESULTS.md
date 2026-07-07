# Results Scoreboard — ML / Self-Play Bot

The empirical record. **Every `arena:sweep` (or tournament) run that informs a
go/no-go gets a row.** This is how we judge "better than `ai_strategist`."

How to produce a row:

```bash
npm run arena:sweep      # multi-seed mean win%/ELO with 95% CIs
# or, for the full field:
npm run tournament       # built-in + community bots, persisted ELO/leaderboard
```

Record: date, the candidate bot, opponents/field, number of seeds/games, the
candidate's win% (with CI), ELO, whether it **beats the bar significantly**
(✅/❌/~tie), the pinned **opponent commit SHA(s)** it was measured against, and a
notes/commit ref. Control seat/turn-order across seeds.

> **🎯 BAR RE-BASELINED (2026-06-21, [D-7](./DECISIONS.md)): the bar is now
> `ai_lookahead`, pinned `596f781`** — not `ai_strategist`. Lookahead is the actual
> field-strongest bot (~25–32% vs Strategist's ~14–18%). A candidate "passes" only
> by beating **Lookahead** with a significant win-rate/ELO edge; pin Lookahead's SHA
> in a "Lookahead @" column. `ai_strategist` (`f5fedb2`) stays as a **secondary
> reference** reported alongside. Like Strategist, Lookahead is an evolving bot —
> re-baseline if it changes. _(Rows dated before 2026-06-21's re-baseline measured
> vs Strategist; that's accurate history — read them in that light.)_

> **`ai_strategist` is a moving target — pin it.** It is the baseline _and_ an
> evolving bot (e.g. PR #35 changed its endgame behavior). Every row MUST record
> the strategist commit SHA in the "Strategist @" column, so results measured
> against different strategist versions are never compared apples-to-oranges. When
> strategist changes, re-baseline before trusting a new candidate's edge.

> **First baseline: pin post-#35 strategist.** The endgame-turtle fix
> (`fix/strategist-endgame-turtle`, PR #35) changed `ai_strategist` and **merged
> to master on 2026-06-21 as `f5fedb2`**. Measure the Phase 0 baseline against
> that commit (the canonical strategist) and record `f5fedb2` in the
> "Strategist @" column.

> **Baseline to beat:** ~~`ai_strategist` (post-#35)~~ → **superseded by D-7: the
> bar is now `ai_lookahead` (`596f781`)**. Strategist's head-to-head numbers are
> filled in the rows below and kept as a secondary reference.

---

## Headline: best bot vs the bar over time

_Bar = `ai_lookahead` (`596f781`) since 2026-06-21 ([D-7]); earlier rows used
`ai_strategist` (`f5fedb2`). The "Beats strategist?" column header is kept for the
historical rows; new rows judge against Lookahead (noted inline)._

| Date       | Candidate                                                            | Phase | Field     | Seeds/Games                | Win% (95% CI) | ELO       | Beats strategist?                               | Strategist @               | Notes / commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------- | ----: | --------- | -------------------------- | ------------- | --------- | ----------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-21 | **Strategist** (baseline reference)                                  |     — | 7-bot FFA | 30 × 200 (6000)            | 17.5 ± 1.0    | 1250 ± 12 | _baseline_                                      | `f5fedb2`                  | Rank 2/7. `Lookahead` (also a search bot) **leads the field at 32.1 ± 1.2** (ELO 1358) — i.e. search _already_ beats Strategist decisively; the search-viability question is settled.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-06-21 | Expectimax (depth-2, default weights)                                |     0 | 7-bot FFA | 30 × 200 (6000)            | 7.1 ± 0.8     | 1140 ± 11 | ❌ **loses decisively**                         | `f5fedb2`                  | Rank 6/7 (barely above the dumb bots). Paired per-game test z = −19.7, **p ≈ 0**. Seat-counterbalanced sweep agrees (7.1%). **1v1 deterministic = statistical tie** (49.5%, p = 0.67) → the eval isn't broken; it over-extends in the 7-player crowd. Tuning underway (Phase 0, step 3).                                                                                                                                                                                                                                                                                                      |
| 2026-06-21 | **Expectimax (tuned: `attackThreshold 0.3`, `threat 2.0`)** — LANDED |     0 | 7-bot FFA | 30 × 200 (6000)            | 13.8 ± 1.0    | 1305 ± 13 | **ELO ✅ sig · win% ~tie**                      | `f5fedb2`                  | Tuned defaults landed. Canonical: Expectimax ELO **1305 ± 13 vs Strat 1229 ± 13** (non-overlapping → significant), win% 13.8 vs 14.5 (overlapping → tie). Seat-fair (5600 games): Ex **15.7 ± 1.2 / ELO 1349** vs Strat 14.0 ± 0.9 / 1256, paired **62.4% (z = 18.6, p ≈ 0)**, outright wins 880 vs 783. Now **rank 1–2 by ELO** (up from 6/7). Still trails `Lookahead` on win% (~25%). Per [D-8](./DECISIONS.md): the win% ceiling is structural (fixed threshold can't press).                                                                                                             |
| 2026-06-21 | Expectimax (tuned) **vs the new bar `Lookahead`**                    |     0 | 7-bot FFA | 30×200 + 5600 seat-fair    | 13.8–15.7     | 1305–1349 | ❌ **loses to bar (win%)** · ~ELO co-leader     | `596f781`                  | **Gate re-baselined to `Lookahead` ([D-7]).** Lookahead leads on win% (canonical 26.2%, seat-fair 24.0%; ELO 1330/1307); tuned Expectimax ~15% win but co-leading ELO (1305/1349). **Phase 0 headline gate (beat Lookahead) is OPEN** — needs the structural press-mechanism ([D-8]) or Track B.                                                                                                                                                                                                                                                                                              |
| 2026-06-22 | **Expectimax + press-mechanism (D-9)** — LANDED                      |     0 | 7-bot FFA | 3 × 5600 seat-fair (16800) | 22–23 (≈ tie) | 1332–1339 | **vs Look: win% ~tie · placement ✅ (p≈0.002)** | `f5fedb2` (Look `596f781`) | **Press-mechanism: posture-adaptive threshold + elimination term + low-odds risk floor.** Across 3 disjoint-seed seat-fair runs Expectimax **ties Lookahead on win%** (Look 22.5–23.9; Look a hair ahead on raw wins, −0.84% pooled), **significantly out-places it** (pooled paired **51.2%, z=3.09, p≈0.002**), is **ELO co-leader** (ahead 2/3 runs), and **ties the 1v1 duel** (49.5%, vs the pre-press default's losing 45.3% p=0.007). Beats Strategist (13–14%). Rank 6/7 → **joint-strongest**. Headline gate (sig. win% edge over Lookahead) **still open** — it's a tie; see [D-9]. |

---

## Throughput / training-cost measurements

Self-play and training throughput, so we can size compute. (Phase 1 fills the
training-mode numbers.)

| Date       | What                                                                           | Config                                                                                                                                                                                                                                                                                                                                                                                  | Throughput                                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-21 | Pure engine, random policy                                                     | 7p, single core                                                                                                                                                                                                                                                                                                                                                                         | ~150 games/s (~6.6 ms/game, ~12 µs/step)                                                                                                         | From feasibility probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-06-21 | Engine + Strategist heuristic                                                  | 7p, single core                                                                                                                                                                                                                                                                                                                                                                         | ~77 games/s                                                                                                                                      | From feasibility probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-06-21 | Engine + Strategist, parallel                                                  | 7p, 4 procs                                                                                                                                                                                                                                                                                                                                                                             | ~266 games/s aggregate (~3.4× the 77 g/s single core)                                                                                            | Near-linear scaling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-06-21 | Engine + Lookahead bot                                                         | 7p, single core                                                                                                                                                                                                                                                                                                                                                                         | ~4 games/s (~243 ms/game)                                                                                                                        | Search-heavy bot = "too slow" marker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-06-21 | Phase 0 baseline sweep                                                         | 7-bot FFA field                                                                                                                                                                                                                                                                                                                                                                         | ~21 games/s single core (6000 games in 283 s)                                                                                                    | Full field incl. 2 search bots (Lookahead + depth-2 Expectimax). Expectimax depth-2 is comfortably in-browser-playable — far from the Lookahead "too slow" marker, which was a solo-bot-per-seat measurement.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-06-23 | **Engine-only, per-move trims (Phase 1 task 3)**                               | 7p, single core, `recordHistory:false`, trivial seeded policy                                                                                                                                                                                                                                                                                                                           | **~215 → ~414 games/s (≈1.9×)**; ~82k → ~160k `applyAction`/s                                                                                    | Isolated pure-engine speed (no heuristic bot — i.e. the learner's engine→tensor data path). **Identical games before/after** (230,918 actions over 600 games, byte-for-byte). Trims: drop the redundant per-`END_TURN` `cloneAreas` (`distributeReinforcements` already clones) + gate `findLargestConnectedGroup` to the 0–2 players an action can change (was 7/action).                                                                                                                                                                                                                                                                                    |
| 2026-06-23 | **Self-play harness, committed (`npm run selfplay`)**                          | Strategist/Expectimax/Lookahead/Defensive, 1500 games (seeds 1..1500), 8-core box                                                                                                                                                                                                                                                                                                       | BEFORE→AFTER g/s: 1w 20.7→21.4 · 2w 38.5→40.3 · 4w 61.7→65.0                                                                                     | This field is **bot-search-dominated**, so the engine trim surfaces as only +3–5% here (the engine itself is ≈1.9×, row above). 100% clean; action-count p50 252 / mean 309 **identical** before/after. **Near-linear scaling preserved:** 1→4 workers 2.98× (before) / 3.04× (after); 4 workers = the 50%-of-cores policy (CLAUDE.md).                                                                                                                                                                                                                                                                                                                       |
| 2026-06-24 | **BC STOP-de-bias retrain (full 100k corpus)**                                 | EdgePolicyNet (102k params), CPU, `--num-workers 4 --batch-size 512`, Mac mini (M4, 16 GB)                                                                                                                                                                                                                                                                                              | **~27 min/epoch** (1582–1667 s/epoch)                                                                                                            | **Memory-bound, not compute-bound:** random-access memmap over the 8.3 GB corpus on a 16 GB box (swap ~6 GB, load ~3, stable across an 8-epoch unattended run). `shodan` (128 GB + GPU + 12 workers) does ~67 s/epoch (~30×) but was offline. `--num-workers > 4` swap-locks the mini — keep it at 4. Faster than the earlier ~34 min/epoch estimate.                                                                                                                                                                                                                                                                                                         |
| 2026-06-25 | **Phase-3 PPO throughput probe (`npm run ppo:throughput-probe`)**              | 8-FFA, learner = random stub terminating at elimination (the real PPO terminal), Mac (8-core). realistic = Lookahead/Strategist/Expectimax/4×BC; worst = 7×Lookahead                                                                                                                                                                                                                    | realistic **644 steps/s 1w · 1,933 steps/s 4w (~483/core)**; worst 1,140 / 3,496                                                                 | **GREEN ([D-20]):** ~28M env-steps/12h single-thread, **~84M/12h @4w** → ~40–80× the ≳1–2M bar; PPO step budget reachable, in-process opponents are not a blocker. numEdges p100 ≈ 26 (p99 15, mean ~5, **0 overflow** over ~100k decisions) → **MAX_EDGES 64**. Per-move avg: BC 0.8 ms, Lookahead 0.3–0.4 ms, Expectimax 0.16 ms, Strategist 0.02 ms. **NB:** measures the real PPO model (episode ends at learner elimination); the current step-1 env-server plays to game-over (~2× slower) — adopt early termination. Local — re-confirm on shodan before locking the budget.                                                                           |
| 2026-06-27 | **B5 PPO league probe — snapshot-heavy re-probe (`npm run ppo:league-probe`)** | 7-FFA (count=6) on **shodan** (16-core, Node v22), driving the **real** PFSP `makeLeague` sampler (first live exercise — [D-23]). D-23 standard field; pool=8 (4 ppo+4 bc) snapshots; **greedy PPO-policy learner**, `terminateOnElim:true` (PASS A = trainer regime/budget) + full-game PASS B (turtle). steady-state per-shard throughput (cold start excluded). R-sweep R∈{0,2,3,4}. | **R=3:** 1,770 steps/s 14w (~126/core); R=0→4: 1,173 / 1,523 / 1,770 / 2,081 steps/s 14w. random-learner R=3 = 2,245 (learner-mode-insensitive). | **GREEN at EVERY R ([D-24]):** env-steps/12h **50.7M (R0) → 89.9M (R4)**, ~25–45× the ≳2M bar → **env-sim is NOT the bottleneck on a snapshot-heavy field** (the [D-19] in-process-opponent worry is refuted; the binding rate is the SB3 learner loop, task C/E). **R=3 LOCKED** (D-23 default): turtle (global, PASS B) **92.0%** ≫ the 60% floor; warm-book learner-relative decisiveRate **95.3%** (single-worker). Snapshot per-move ~1.2 ms 1w / ~2.2 ms under 14w contention (vs [D-20]'s 0.8 ms on a lighter box). numEdges **p100 ≤ 27, 0 overflow** → MAX_EDGES 64 holds. All 4 R turtle-healthy (85–95% global), so no turtle pressure to raise R. |

---

## Run detail (optional longer notes)

Use this section for anything that doesn't fit a table cell — config files, seed
lists, anomalies, links to replay files.

### 2026-06-21 — Phase 0 baseline: Expectimax (default weights) vs Strategist `f5fedb2`

**Working-tree note.** At measurement time `git diff f5fedb2 -- src/ai/ai_strategist.js` was empty — the working-tree Strategist _is_ `f5fedb2`, so the sweep was run directly against the working tree.

**Three independent measurements, all agreeing Expectimax loses the FFA:**

1. **Canonical `npm run arena:sweep -- --runs 30 --games 200`** (6000 games, full 7-bot field, fixed seat binding) — the literal gate command. Full ranking:

   | Rank | Bot        | Win% (95% CI) | ELO (95% CI) |
   | ---: | ---------- | ------------- | ------------ |
   |    1 | Lookahead  | 32.1 ± 1.2    | 1358 ± 9     |
   |    2 | Strategist | 17.5 ± 1.0    | 1250 ± 12    |
   |    3 | Defensive  | 17.2 ± 1.0    | 1244 ± 12    |
   |    4 | Example    | 6.5 ± 0.8     | 1165 ± 12    |
   |    5 | Adaptive   | 6.8 ± 0.7     | 1160 ± 11    |
   |    6 | Expectimax | 7.1 ± 0.8     | 1140 ± 11    |
   |    7 | Default    | 3.8 ± 0.6     | 1083 ± 12    |

2. **Seat-counterbalanced sweep** (`scripts/_baseline.mjs`, 20 runs × 40 seeds × 7 cyclic seat rotations = 5600 games) — each bot occupies every seat equally often, removing the residual round-robin seat-count bias (D-5). Result is essentially identical to the fixed-seat sweep: Expectimax **7.1 ± 0.7%** (rank 6), Strategist 18.9 ± 1.0% (rank 2), Lookahead 31.6 ± 1.3% (rank 1). **Seat bias was negligible for this comparison** — independently confirmed by a 400-game all-Strategist probe where seat-4 (Strategist's slot) and seat-6 (Expectimax's slot) won 13.5% vs 13.8% (fair share 14.3%, no monotonic seat pattern).

3. **Paired per-game head-to-head** (both bots present in every game; compare placements — cancels map/seed variance, very high power): Expectimax placed higher in **2063 of 5600** games (36.8%), Strategist higher in 3537, 0 ties. **z = −19.70, p ≈ 0.** Outright game wins: Expectimax 395 vs Strategist 1056.

**The diagnostic split — competitive 1v1, collapses in the crowd:**

- **2-player deterministic head-to-head** (2000 games, seat-counterbalanced, fully reproducible — neither bot uses `Math.random`): Expectimax 49.5% vs Strategist 50.4%, 1 draw. **z = −0.42, p = 0.67 → a statistical tie.** So Expectimax's evaluation is roughly as good as Strategist's _in isolation_.
- **Behavior diagnostic (500 FFA games):** Expectimax has the **worst average placement of all 7 bots (4.67)** and the **lowest attack win-rate among the strong bots (78.5%** vs Strategist/Lookahead ~82.8%). It dies earliest.

**Verdict & mechanism.** The tie-in-a-duel + collapse-in-a-crowd signature is textbook **over-extension in a free-for-all**: a duel barely punishes exposed borders, but six rivals dismantle an over-extended board. The likely levers (all existing scalar params): `ATTACK_THRESHOLD = 0.05` (essentially "attack on any non-negative-EV move" — no patience), `THREAT_WEIGHT = 0.45` (under-weights exposure), and the absence of a low-odds floor. **Search itself is clearly viable here** — `Lookahead` (a depth-1 searcher with a posture-adaptive threshold, a high border-threat weight, and a low-odds penalty) tops the field at ~32%. This is a _tuning_ problem, not a search-doesn't-work problem.

**Repro:** `node scripts/_baseline.mjs --runs 20 --seeds 40 --h2h 2000` (retained ml-bot gate harness). Canonical: `npm run arena:sweep -- --runs 30 --games 200`. Seeds: run `r` uses base seed `r*1_000_000 + 1` (seat-fair) / consecutive blocks (canonical). Non-deterministic opponents (Default, Example, Adaptive use `Math.random`) add field noise captured by the CIs; the paired and 1v1 tests are unaffected (1v1 involves only the two deterministic bots).

### 2026-06-21 — Phase 0, step 3: tuned & landed (`attackThreshold 0.3`, `threat 2.0`)

**Tuning method.** Refactored `ai_expectimax` to a `makeExpectimax(params)` factory
(same search/eval code, injectable params; default export unchanged — verified by
reproducing the baseline 2p head-to-head 990/1009/1 exactly). Ran a parallel
arena-sweep search: a coarse `attackThreshold × threat` grid (20 configs, 900
games each), a refine grid around the best region + single-axis weight
perturbations (`income`/`dice`/`rivalIncome`/`activeRival`), then verification of
finalists on **holdout seeds disjoint from the tuning seeds** (3000 games), plus a
clean cross-seed re-check (4000 games, base 3,000,001).

**What tuning found (robust across all seed ranges):** raising `attackThreshold`
0.05 → ~0.3–0.6 (patience) and `threat` 0.45 → ~2.0 (exposure-aversion) is the
whole story; `searchDepth`, `topK`, and the other weights barely moved the needle.
Every viable config showed the **same signature**: a large, significant **ELO and
head-to-head-placement** edge over Strategist, but a **win% tie** — and none
approached `Lookahead`. The win% sign flips with the seed sample (Expectimax
13.5–15.7% vs Strategist 14.0–15.3%), i.e. genuinely tied. See [D-8](./DECISIONS.md)
for why this ceiling is structural (a single fixed threshold can't both stay
patient and press to close out).

**Landed config = `{ attackThreshold: 0.3, threat: 2.0 }`** (best all-around: top
ELO, paired ~60%, win% competitive). Official measurements vs Strategist `f5fedb2`:

- **Canonical `npm run arena:sweep` (6000 games):** Expectimax rank-2-by-ELO
  **1305 ± 13** vs Strategist 1229 ± 13 (non-overlapping → significant); win%
  13.8 ± 1.0 vs 14.5 ± 0.9 (overlapping → tie). _NB: Strategist's win% reads
  lower than the 17.5% baseline only because the field changed — a strong
  Expectimax now takes wins from everyone (Lookahead 32→26%, Strat 17.5→14.5%).
  Same bot (`f5fedb2`); compare Ex-vs-Strat **within** this field, not across rows._
- **Seat-counterbalanced (5600 games, all 7 seats rotated):** Expectimax
  **15.7 ± 1.2 / ELO 1349** (highest ELO in the field, above Lookahead's 1307)
  vs Strategist 14.0 ± 0.9 / ELO 1256; paired **62.4% (z = 18.6, p ≈ 0)**;
  outright game wins **880 vs 783**.
- **1v1 deterministic (2000 games):** Expectimax 47.3% vs Strategist 48.5%, 84
  draws → decided 49.3%, p = 0.55, still a **tie** (more draws than the
  pre-tuning 1, as the more patient bot stalemates more in a duel). Confirms tuning
  fixed _crowd_ play, not 1v1 strength.

**Net:** Expectimax went from rank 6/7 (loses everything) to **rank 1–2 by ELO**,
significantly out-placing Strategist, with win% a tie. Gate treated as **partially
met** (ELO/placement ✅, win% tie) per Ivan's call. Shipped as the new default.

### 2026-06-22 — Phase 0, step 4: press-mechanism (D-9) → parity with Lookahead

**What was built.** The structural press-mechanism [D-8] named, plus a third
ingredient: (1) a **posture-adaptive attack threshold** (`postureThreshold`:
PRESS/WEAK/BASE U-shape), (2) a **strengthened elimination term** (`activeRival`,
win-prob-weighted through the search), and (3) a **low-odds risk floor**
(`lowOddsFloor`/`lowOddsPenalty`, mirrors Lookahead's `LOW_ODDS_PENALTY`). The floor
proved necessary: pure expectimax under-penalizes coin-flips in a 7-way elimination
game, so the posture+elimination terms alone left a ~4–5 pt win% gap that the floor
closed most of.

**Tuning.** A parallel arena-sweep workflow (coarse 36-config grid over
base×press×elimination → auto-refine, 90 configs total) found the region; a focused
two-seed low-odds + search-depth sweep then showed **depth-2 is essential**
(depth-1 win% collapses to ~10%) and that `activeRival` wants to be **low** (1–2),
not strong — over-chasing eliminations hurts. Finalists were verified on a **holdout
seed** (the seed-1 coarse winners were overfit — they led on seed 1 but trailed on
fresh maps), then the two best at the full seat-fair gate.

**Landed config = `{ baseThreshold: 1.2, pressThreshold: -2.5, weakThreshold: 0.15,
pressDiceShare: 0.38, weakDiceShare: 0.15, activeRival: 2.0, lowOddsFloor: 0.78,
lowOddsPenalty: 5.0, searchDepth: 2, topK: 6 }`** (press −2.5 beat press −1.5: same
ELO, better win% conversion).

**Authoritative result — 3 disjoint-seed seat-fair runs (seedbase 1 / 100 / 200,
each 20 runs × 40 seeds × 7 rotations = 5600 games; 16,800 total), vs Lookahead
`596f781`:**

| Run (seedbase) | Ex win% | Look win% | Ex ELO | Look ELO | Paired (Ex higher)          |
| -------------- | ------- | --------- | ------ | -------- | --------------------------- |
| 1              | 23.0    | 22.5      | 1335   | 1291     | 51.4% (p=0.037)             |
| 100            | 22.0    | 23.1      | 1339   | 1271     | 51.1% (p=0.115)             |
| 200            | 22.0    | 23.9      | 1332   | 1372     | 51.1% (p=0.092)             |
| **pooled**     | ~22.3   | ~23.2     | —      | —        | **51.2% (z=3.09, p≈0.002)** |

- **Win%: a statistical tie** — overlapping CIs in all three runs; Lookahead a hair
  ahead on raw outright wins (3891 vs 3750 pooled, −0.84%).
- **Placement: Expectimax significantly out-places Lookahead** (pooled 51.2%,
  z=3.09, p≈0.002) — the more consistent bot.
- **1v1 deterministic (2000 games):** Expectimax 49.5%, p=0.69 → **tie** (the
  pre-press shipped default _lost_ this duel, 45.3%, p=0.007 — the press-mechanism
  fixed the head-to-head deficit too).
- Beats `ai_strategist` decisively (13–14% in this field).

**Verdict.** The press-mechanism brought Expectimax to **parity with Lookahead** —
joint-strongest, with a significant placement edge and a win% dead-heat. The
**headline gate (a significant win% edge over Lookahead) is NOT met — it's a tie**
([D-9]). Same "places better, win% ties" ceiling as D-8, one tier up. Crossing it
likely needs a better board evaluation or deeper search (Track B), not more posture
tuning.

**Repro:** `node scripts/_baseline.mjs --vs Lookahead --runs 20 --seeds 40 --h2h 2000
--cand '{"baseThreshold":1.2,"pressThreshold":-2.5,"activeRival":2,"searchDepth":2,"lowOddsFloor":0.78,"lowOddsPenalty":5}'`
(omit `--cand` once landed; add `--seedbase 100`/`200` for the disjoint runs). The
`--cand` and `--seedbase` flags were added to the retained `_baseline.mjs` gate
harness this session; `_tune.mjs` now also reports the paired edge vs Lookahead.

---

### 2026-06-22 — Phase 0.5 eval-rework spike (Track A, capped at 4 swings) · in progress

**Question.** Is an outright-win% edge over Lookahead hiding in a better board
**evaluation** (not weights)? Three new `evaluateBoard` terms, each a `DEFAULT_PARAMS`
weight defaulting to 0 (so `makeExpectimax()` = the D-9 bot until swept):
`mergePotential` (latent unifying-capture income), `fieldRivalIncome` (suppress the
trailing field, not just the leader), `trappedDice` (idle interior strike dice).
Screened with `_tune.mjs` (cand = Expectimax slot vs the real 7-bot FFA). Win% noise
≈ ±2.5% at 1000 games, ±1.4% at 3000 — these screens judge **direction**; the kill
verdict / any finalist goes to the full seat-fair `_baseline.mjs` gate.

**Swing 1 — single-term magnitude screen (1000 games/config, seed 1).** Baseline
`{}`: cand 20.5% / look 22.9% / paired-vsLook 48.6% (the D-9 parity, reproduced).

| Term · magnitudes                   | cand win%          | note                                                      |
| ----------------------------------- | ------------------ | --------------------------------------------------------- |
| `mergePotential` 0.3 / 0.6 / 1.0    | 20.2 / 20.7 / 18.0 | neutral → **harmful** (1.0: paired 45.0%, p=0.0016 worse) |
| `fieldRivalIncome` 0.05 / 0.1 / 0.2 | 19.5 / 19.3 / 21.4 | noisy; only 0.2 edged baseline (+0.9%, within noise)      |
| `trappedDice` 0.1 / 0.2 / 0.35      | 20.0 / 18.9 / 13.2 | neutral → **harmful** as it grows                         |

Read: the only statistically real effect is a _degradation_ (`mergePotential 1.0`).
`mergePotential` and `trappedDice` are neutral-when-tiny, harmful-when-grown — no
upside. `fieldRivalIncome 0.2` is the lone (noisy, non-monotonic) positive → earns
one higher-power look. Consistent with the D-9 ceiling: the eval sits near a local
optimum; single structural terms perturb rather than break it.

**Swing 2 — focused high-power screen (3000 games/config, seed 2; `fieldRivalIncome`
finer + pairwise).** Baseline `{}` at seed 2: cand 20.5% / look 23.4% / paired 48.2%.

| Config                                        | cand win% (Δ vs base) | paired-vsLook          | note                        |
| --------------------------------------------- | --------------------- | ---------------------- | --------------------------- |
| `fieldRivalIncome` 0.15                       | 19.9 (−0.6)           | 47.5% (p=0.007 worse)  | below baseline              |
| `fieldRivalIncome` 0.25                       | 20.4 (−0.1)           | 48.6%                  | ≈ baseline (best candidate) |
| `fieldRivalIncome` 0.35                       | 18.8 (−1.7)           | 45.2% (p=1.5e-7 worse) | **harmful**                 |
| `fieldRivalIncome` 0.2 + `mergePotential` 0.4 | 19.2 (−1.3)           | 47.0% (p=0.001 worse)  | below baseline              |
| `fieldRivalIncome` 0.2 + `trappedDice` 0.1    | 19.8 (−0.7)           | 48.0% (p=0.031 worse)  | below baseline              |

Read: **the Swing-1 `fieldRivalIncome 0.2` bump did not replicate.** At higher power
on fresh maps, no config beats the D-9 baseline — the best (0.25) is dead-even, higher
magnitudes are significantly worse, and both pairwise combos underperform. None show
even a _trend_ above baseline on win% or the paired placement metric.

**Verdict — basket is a dud; spike stopped at 2 of 4 swings.** All three structural
terms are confirmed neutral-at-best, harmful-when-grown, across two independent seeds
at two power levels. `supportedBorder` (gated on "the first three show life") is moot.
This is the same ceiling D-8/D-9 hit: the eval sits at a local optimum and bolt-on
structural terms perturb rather than break it. Stopping early (the 4-swing cap was a
ceiling, not a quota) — the answer is clear and reconfirming a dead pattern wastes
budget. **Earned signal: search valuation is tapped out at this structure → pivot to
Track B (Phase 1).** Code reverted (the 3 dud params are not shipped); finding kept
here + in DECISIONS.

---

### 2026-06-23 — Phase 1 task 3: per-move allocation trims (closes the Phase-1 gate)

**What changed (engine only, `src/engine/StateManager.js`).** Two behavior-preserving
trims to the per-action hot path:

1. **No double-clone per `END_TURN`.** `applyEndTurn` used to `cloneAreas(state.areas)`
   and then hand that copy to `distributeReinforcements`, which deep-clones the areas
   array _again_ internally — so every end-turn deep-cloned the whole board twice. It
   now passes `state.areas` straight through (`distributeReinforcements` is pure and
   already clones), eliminating one full `areas` deep-clone per end-turn.
2. **`findLargestConnectedGroup` gated to the players that can change.** `recalcPlayerStats`
   ran the union-find pass for **all 7 players on every action**. A player's
   largest-connected-group depends only on which territories they own (adjacency is
   fixed), and a single action changes ownership for at most one territory — so it now
   recomputes only `[attacker, former-owner]` on a successful attack and **nobody** on a
   failed attack or an end-turn (territory/dice/eliminated counts are still refreshed by
   the cheap O(areas) scan). Was 7 union-find passes/action → 0–2.

**Correctness.** A new 5-seed fuzz test (`StateManager.test.js`,
"player-stat invariants under the per-move trims") plays full games and asserts, after
**every single action**, that the incrementally-maintained `territoryCount` / `diceCount`
/ `largestGroup` / `eliminated` equal a from-scratch recompute — across captures, failed
attacks, eliminations and end-turns. Self-play emits **byte-identical games** before vs
after (identical action-count distribution + 230,918 actions over the 600-game engine
bench). Full suite **850 passing**, lint + build green.

**Numbers.** Engine-only (no heuristic bot — the learner's engine→tensor data path):
**≈215 → ≈414 games/s (≈1.9×)**, ~82k → ~160k `applyAction`/s, two runs each, same games.
On the committed `npm run selfplay` harness with the decisive seed-pure field the gain is
only +3–5% — that field's wall-clock is dominated by the bots' own depth-2 search, not by
`applyAction` — but near-linear worker scaling is preserved (1→4 workers 2.98× before /
3.04× after, 100% clean, identical action distribution).

**Why this closes the gate, not a single g/s number ([D-12]).** Phase-2 data-gen of the
`ai_lookahead` teacher is **parallelism-bound** (~4 g/s/core regardless of engine
micro-opts), so the gate is "near-linear scaling confirmed from committed code +
before/after recorded" — both now satisfied. The ≈1.9× engine win is what the bot-free
learner rollout path gets directly.

**Repro.** Field-level + scaling:
`npm run selfplay -- --no-write --seed-count 1500 --seed-start 1 --workers {1,2,4}`
(default decisive field). Engine-only isolation: a pure-engine loop driving full
`createInitialState`→`applyAction` games under a trivial seeded policy with
`recordHistory:false`, timed before/after the trims via `git stash` (scratch
microbenchmark; the committed harness number is the gate deliverable).

---

### 2026-06-23 — Phase 2 corpus-field validation ([D-15])

**Question.** Which self-play field generates the best `ai_lookahead` imitation corpus?
[D-15] killed the pure-mirror recipe (turtle equilibrium); the corpus must be a
heterogeneous decisive field, imitating Lookahead's seat. Measured **decisive rate**
(non-stalemate games — stalemates are low-value, all-turtle, no terminal winner) and
**teacher-seat label density** (Lookahead steps/game, attack/STOP balance) across
candidates.

**Decisive-rate screen (80 games/field, `--no-write`):**

| Field (player count)                                                        | Decisive (Σwins/clean) |
| --------------------------------------------------------------------------- | ---------------------- |
| **Full 7-bot arena field** (Look,Strat,Expect,Def,Default,Example,Adaptive) | **85%**                |
| 2×Look,2×Strat,2×Expect,Defensive (7p, seed-pure)                           | 65%                    |
| 3×Lookahead (3p)                                                            | 51%                    |
| 3×Lookahead,Default,Example,Adaptive (6p)                                   | 48%                    |
| 4×Lookahead,Default,Example,Adaptive (7p)                                   | 39%                    |
| 4×Lookahead (4p)                                                            | 18%                    |
| 7×Lookahead (7p)                                                            | ~0–3% (turtle, [D-15]) |

The symmetry-breaker is field _diversity_; piling on patient Lookahead seats — even with
the `Math.random` bots mixed in — stays turtle-prone.

**Label density (300-game shards, fat steps re-derived via `trajectoryFromReplay`):**

| Field                       | Decisive | Teacher seats/game | Teacher steps/game  | Attack% of teacher steps | Throughput (4w) |
| --------------------------- | -------- | ------------------ | ------------------- | ------------------------ | --------------- |
| **Full 7-bot arena**        | 85.3%    | 1                  | 80.8 (18.7% of all) | **55.2%** (balanced)     | 63 g/s          |
| 2×Look,2×Strat,2×Expect,Def | 63.7%    | 2                  | 156.3 (31.7%)       | 39.6% (STOP-heavy)       | 43 g/s          |

**Decision — the full 7-bot arena field is the corpus generator.** It wins on every axis
that matters: highest decisive rate (85%, fewest stalemates), the **exact eval
distribution** (the clone is gated on this 7-bot FFA), and a **balanced 55%-attack label
split** (Lookahead plays actively here, not turtling). The 2× seed-pure field's extra
steps are disproportionately turtling STOPs. Ample volume: 80.8 teacher steps/game →
~8M `(obs, move)` pairs from 100k games (≈26 min at 63 g/s on one 8-core box;
< 1 hour across the fleet). **Cost:** 3 `Math.random` bots make games non-reproducible
from seed (the cross-machine seed-merge _dedup_ is lost) — acceptable because (a) shards
use disjoint seed ranges (games are distinct anyway), (b) recorded moves are valid and
replayable (D-13), (c) we never need to regenerate an identical dataset. The seed-pure
2× field is the **reproducible fallback** if that ever matters. Stalemate games (~15%)
are kept — Lookahead's move is a valid label regardless of outcome, and `placements` is a
full ranking even when `winner` is null (so the aux value head still has a target).

**Repro.** `npm run selfplay -- --no-write --seed-count 80 --bots "<field>"` for the
decisive screen; `--seed-count 300 --out <shard>` then re-derive fat steps per record and
tally steps where `playerId` is a Lookahead seat (base name, `#n` stripped) for label
density.

---

## Phase 2 — imitation parity run (100k corpus, MLP clone) · 2026-06-23

> **⚠️ THE `BC` ROW IN THIS SECTION IS INVALID — it measured a broken registration,
> not the clone (discovered 2026-06-24).** BC was registered in `builtInBots.js` as
> `adaptModernBot(ai_bc)`, whose wrapper expects a `GameState`, but every
> `BUILT_IN_BOTS` consumer (CLI scripts, ArenaScreen, TournamentScreen) calls bots via
> `runMatch → runBotDirect` with a **`BotState`**. So BC **threw on every turn (0 attacks,
> all errors) and never ran its policy** — a do-nothing bot that force-ends every turn.
> Its "0.0% win / rank-3 ELO 1275" is the signature of a passive seat surviving to
> middling placement, _not_ the trained net. The "STOP ~68%" figure was a separate
> Python-validation number, not the arena. **For the real BC arena numbers, see the
> STOP-bias sweep section below (`stopBias 0` is the corrected control: 3.6% win).**
> The corpus / training / val-move-match numbers in this section are unaffected and stand.

**Corpus.** Full 7-bot arena field, `Lookahead` teacher, seeds 1–100,000 (generated on
`shodan`, foreground-sharded 4×25k). **100,000 games · 8,591,769 teacher steps · 59.4M
edges · 8.2 GB packed.** 100% clean (no forced-end quarantine).

**Training.** `EdgePolicyNet` (masked per-edge MLP + aux value head), **102,211 params**,
CUDA (RTX 4070 Ti), 15 epochs (~67 s/epoch, `--num-workers 12`, batch 4096). Best
**val move-match 57.6%** (by-game split). Plateaued ~57% by epoch 11.

**Eval — `npm run arena:sweep --runs 20 --games 150` (3000 games, seat-fair):**

| Rank | Bot        | Win% (95% CI) | ELO (95% CI) |
| ---: | ---------- | ------------- | ------------ |
|    1 | Lookahead  | 18.8 ± 1.2    | 1303 ± 16    |
|    2 | Expectimax | 17.0 ± 1.3    | 1301 ± 16    |
|    3 | **BC**     | **0.0 ± 0.0** | 1275 ± 8     |
|    4 | Strategist | 13.6 ± 1.4    | 1228 ± 10    |
|    5 | Defensive  | 14.6 ± 1.2    | 1190 ± 11    |
|    6 | Example    | 0.6 ± 0.4     | 1140 ± 15    |
|    7 | Adaptive   | 2.6 ± 0.8     | 1123 ± 16    |
|    8 | Default    | 3.4 ± 0.6     | 1039 ± 16    |

**Verdict — parity NOT reached (gate not met).** BC **never wins (0.0%)** yet holds
rank-3 ELO (1275): the clone is **STOP-biased** (predicts STOP ~68% vs ~45% true), so it
plays passively → survives for middling placement (ELO) but can't conquer a board to win.
**Move-match accuracy (57.6%) is a misleading proxy** — the misses are systematically
"STOP instead of attack," which is competitively fatal. Per [D-Encoding] the simple MLP
plateaus; the objective/encoding (not RL) is the gap. **Next levers:** STOP-class de-bias
(class-weighted / focal CE) on the same corpus → if it plateaus, a 1–2 layer GNN.

---

## Phase 2 — BC STOP-bias inference sweep (zero-retrain diagnostic) · 2026-06-24

**What & why.** Before paying for a class-weighted/focal-CE retrain on the GPU box, a
free oracle over the already-exported weights: sweep an **inference-time STOP-logit bias**
(`makeBC({stopBias})`, subtract a constant from the trailing STOP logit before argmax) and
watch BC's win% and realized STOP rate. If a bias lifts win% off the control while pushing
STOP from ~71% toward the teacher's ~45% → the failure is STOP-threshold miscalibration
(green-light the retrain, target that STOP rate). If win% stays flat while attacks climb
and attack-win% collapses → passivity just becomes suicide (skip the retrain, escalate).
**This run also produced the first VALID arena measurement of the trained policy** (the
parity section above measured a broken registration — see its banner).

**`npm run arena:bc-stopbias` — 6 biases × 20 runs × 150 games (18,000 games, seat-fair,
same 7-bot field as the parity run, Lookahead as yardstick; 95% Student-t CIs):**

| stopBias | BC win% (95% CI) | BC STOP% | BC ELO | BC place | BC atk/g | BC atk-win% | Lookahead win% (CI) |
| -------: | ---------------- | -------: | -----: | -------: | -------: | ----------: | ------------------- |
|        0 | 3.6 ± 0.6        |     70.8 |   1260 |     3.87 |     15.6 |        88.0 | 17.9 ± 1.3          |
|      0.5 | 4.9 ± 0.8        |     59.3 |   1225 |     4.21 |     21.6 |        86.3 | 18.7 ± 1.3          |
| **1** ◀ | **5.9 ± 0.8**    | **46.7** |   1184 |     4.68 |     27.4 |        84.8 | 21.2 ± 1.5          |
|        2 | 5.4 ± 0.9        |     34.5 |   1144 |     5.14 |     30.7 |        83.2 | 22.8 ± 1.6          |
|        3 | 5.0 ± 1.0        |     28.8 |   1125 |     5.24 |     31.8 |        80.5 | 23.1 ± 1.7          |
|        4 | 4.2 ± 0.6        |     28.0 |   1105 |     5.46 |     30.5 |        77.9 | 23.2 ± 1.5          |

**Verdict — GREEN-LIGHT the de-bias retrain (with a sharp caveat).**

- **The calibration hypothesis is confirmed with tight, non-overlapping CIs.** Win% is a
  clean inverted-U that **peaks exactly where STOP% hits the teacher's rate**: `stopBias 1`
  → STOP 46.7% (teacher ~45%) → win 5.9 ± 0.8, statistically clear of the 3.6 ± 0.6 control
  ([5.1, 6.7] vs [3.0, 4.2], no overlap). Past the peak it goes suicidal as predicted —
  STOP keeps falling, attack-win% collapses 85→78, placement/ELO degrade monotonically.
  **Retrain target STOP rate: ~45–47%.**
- **ELO is the trap, not the gate.** ELO _decreases_ monotonically with bias (1260→1105)
  even as win% _peaks_ at bias 1 — because ELO rewards survival/placement, and the passive
  bias-0 clone turtles to middling placement (3.87) without ever winning. **This is exactly
  the illusion the invalid parity row fell for** ("rank-3 ELO 1275"). Judge BC on **win%**.
- **Inference biasing alone does NOT reach parity.** Best BC 5.9% vs Lookahead 21.2% at the
  same bias (~¼ of the teacher). So the retrain is worth doing (cheap, loss-only, bakes the
  calibration into the weights honestly, right PPO warm-start) but will **not** close the
  full parity gap — the residual ~15 pts is the encoding/architecture ceiling ([D-Encoding]):
  the GNN/PPO escalation, not this retrain. (The teacher's own win% _rises_ with BC's bias,
  17.9→23.2, because a suicidal BC feeds territory to the survivors, Lookahead chief among
  them — a seat-interaction effect, not BC strength.)
- **Note vs. the early smoke read.** A tiny 4×40 pre-run had bias-1 at ~10% win; the real
  number is **5.9%**. STOP rates matched closely (calibration is stable) — the win lift was
  a small-sample fluctuation. The true lift is ~+2.3 pts absolute (~64% relative), real but
  modest.

**Retrain plumbing reminders** (for when it runs on `shodan`): the de-bias is loss-only in
`ml/dicewars_bc/losses.py` (weighted/focal segmented CE; teacher-STOP = `label == counts-1`),
reuse the fixed 100k corpus, re-export unchanged ([D-16]). **`train.py` MUST stop selecting
checkpoints on val move-match** (the misleading proxy that rewards the STOP bias) — select on
STOP-rate calibration (target ~45%) or an arena-win probe, or the retrain re-introduces the bias.

**Repro.** `npm run arena:bc-stopbias` (defaults: `--runs 20 --games 150 --bias 0,0.5,1,2,3,4`);
`--seedbase 100` for a disjoint replication. Run `r` for bias `b` uses base seed
`(seedbase + r) · STRIDE + 1` (STRIDE = max(1e6, games·1000)), independent of `b`, so every
bias sees identical maps (paired across the column). STOP% is the realized rate aggregated
over every BC decision in the config via the `onDecision` hook.

---

## Phase 2 — STOP-de-bias retrain (weighted segmented CE) · 2026-06-24

**What.** Executed the retrain the inference sweep green-lit. The fix is **loss-only +
selection-only** (no encoding/arch change): `segmented_cross_entropy` gained a `stop_weight`
that down-weights teacher-STOP steps (`label == count-1`), and `train.py` gained
`--select-by stop-cal`, which checkpoints the epoch whose **realized argmax STOP rate** is
closest to the teacher's — NOT val move-match, the proxy that rewards the STOP bias. Reused
the fixed 100k corpus, re-exported unchanged ([D-16]). Ran on the **Mac mini** (CPU,
`--num-workers 4`, ~27 min/epoch; `shodan` was offline — see throughput row + memory).

**Training scan** — `stop_weight ∈ {1.0, 0.5, 0.25, 0.125}`, 2 epochs each, `--select-by
stop-cal` (auto target = teacher val STOP ≈ 0.448):

| stop_weight | selected val STOP |   val acc | sel. epoch |
| ----------: | ----------------: | --------: | ---------: |
|  1.0 (ctrl) |             0.541 |     0.564 |          1 |
|  **0.5** ◀ |         **0.436** | **0.556** |          2 |
|        0.25 |             0.325 |     0.512 |          1 |
|       0.125 |             0.299 |     0.500 |          1 |

Clean monotonic curve; `w=0.5` lands STOP within 1.2 pp of the teacher at ≈baseline accuracy.
The **control's STOP rate _grew_ with training** (ep1 0.541 → ep2 0.603) — the overfit-toward-
STOP that move-match selection would have rewarded — and stop-cal correctly took ep1. Lower
weights overshoot (STOP below target) and shed accuracy. **Shipped `w=0.5`.**

**Arena validation of the de-biased weights** (`arena:bc-stopbias` sweeping the _residual_
inference bias over the NEW weights; 20×150, seedbase 0 — same protocol as the inference
sweep, so `stopBias 0` here is directly comparable to the 3.6% control there):

| stopBias | BC win% (95% CI) | BC STOP% | BC atk/g | BC atk-win% | Lookahead win% (CI) |
| -------: | ---------------- | -------: | -------: | ----------: | ------------------- |
|       −1 | 2.8 ± 0.6        |     74.8 |     13.4 |        90.0 | 18.2 ± 1.4          |
|     −0.5 | 4.8 ± 0.5        |     61.4 |     20.5 |        88.6 | 19.0 ± 1.4          |
| **0** ◀ | **6.4 ± 0.9**    | **48.6** |     26.7 |        86.4 | 19.7 ± 1.4          |
|      0.5 | 6.8 ± 1.0        |     39.9 |     30.5 |        84.8 | 20.8 ± 1.6          |
|        1 | 5.7 ± 0.8        |     35.8 |     30.5 |        83.9 | 20.8 ± 1.1          |
|        2 | 5.2 ± 1.0        |     31.7 |     32.3 |        82.7 | 23.9 ± 1.6          |

**Verdict — the de-bias worked; ship at native `stopBias 0`; the parity gap is unchanged
(Phase-3).**

- **STOP calibrated in-weights.** Native (`stopBias 0`) realized STOP fell **70.8% → 48.6%**
  (teacher ~45%), no inference crutch. The predicted val→arena shift held (val 0.436 → arena
  0.486).
- **Win% nearly doubled at the honest operating point.** Native win **3.6% → 6.4%** (CIs
  disjoint: [3.0, 4.2] → [5.5, 7.3]). The de-biased native model (6.4%) **beats the old
  model's _tuned_ peak** (5.9% at bias 1) — the inverted-U shifted left to center on bias
  0–0.5. Win% peaks marginally at bias 0.5 (6.8%, STOP ~40%, a hair more aggressive than the
  teacher) but within CI of bias 0; native bias 0 is the teacher-faithful, crutch-free pick.
- **Still NOT parity — as predicted.** Best BC ~6.8% vs Lookahead ~20% (~⅓). The residual
  ~13 pt gap is the per-edge-MLP **encoding/architecture ceiling** ([D-Encoding]), not STOP
  calibration; closing it is the GNN/PPO escalation. Pure BC's role stands as the **PPO
  warm-start**, now a _calibrated_ one.

**Shipped.** `src/ai/bcPolicyWeights.js` (+ JS↔Python parity fixture) regenerated from
`ml/checkpoints/focal-sweep/w0.5/bc_model.pt`; `ai_bc = makeBC()` (stopBias 0) is the deployed
de-biased bot; forward parity green (16/16). **Repro:** train with `--stop-weight 0.5
--select-by stop-cal`, then `python -m dicewars_bc.export_weights --ckpt <w0.5 ckpt>
--out ../src/ai/bcPolicyWeights.js --fixture ../tests/fixtures/bc/forwardCases.json`.

## Phase 3 — capacity ceiling probe (is the gap model-size?) · 2026-06-24

**Question.** Is the residual ~13 pt gap to Lookahead (BC ~6.4% vs ~20%) because the per-edge
MLP is too small? Localize before paying for a GNN or PPO fork ([D-17]). Zero-code sweep:
re-trained `EdgePolicyNet` at three widths on the same 100k corpus, same recipe
(`--epochs 6 --stop-weight 0.5 --select-by stop-cal`, seed 0), on `shodan` (CUDA).

**Step 1 — proxy (val move-match at matched STOP calibration). FLAT.**

| config   | node/player/ctx/edge | params    | best val acc | val STOP (teacher 0.448) |
| -------- | -------------------- | --------- | ------------ | ------------------------ |
| c0_base  | 64/32/128/128        | 102,211   | 0.5675       | 0.447                    |
| c1_wide  | 128/64/256/256       | 403,075   | 0.5719       | 0.457                    |
| c2_large | 256/96/384/384       | 1,005,443 | 0.5733       | 0.463                    |

10× the parameters → **+0.58 pt** val acc. Essentially flat.

**Step 2 — real metric (arena win% with 95% CIs). FLAT-TO-DECLINING.** Move-match is the
known-misleading proxy (Phase-2 STOP sweep), so each checkpoint was arena-evaluated via
`scripts/_probe-capacity-arena.mjs` (4 configs × bias {0,1,2} × 15 runs × 130 games = 23,400
games, paired seed blocks). **Compared at each width's _peak_ win%** (matched arena operating
point) — because `stop-cal` matched _val_ STOP but _arena_ STOP diverges more for the
6-epoch nets (all turtle harder in self-play than the deployed 2-epoch model), so a naive
bias-0 row would compare nets at different, degraded STOP rates. Each export passed a
JS↔Python parity pre-flight (max |Δlogit| ≤ 1e-4) before its win% was trusted.

| config              | params    | peak win% (95% CI) | @ bias | STOP% |
| ------------------- | --------- | ------------------ | ------ | ----- |
| _deployed (anchor)_ | 102,211   | _7.1 ± 1.6_        | 0      | 48.5  |
| c0_base             | 102,211   | **6.7 ± 0.8**      | 1      | 39.9  |
| c1_wide             | 403,075   | **6.6 ± 1.2**      | 1      | 37.2  |
| c2_large            | 1,005,443 | **5.1 ± 0.9**      | 1      | 38.6  |

Across a 10× param range, peak win% is **flat-to-declining (6.7 → 5.1)** — the 1M net is, if
anything, slightly _worse_ (mild overfit of the teacher's move distribution). The `deployed`
anchor reproduces its established ~6.4% (✓ harness validated against a known number).

**Verdict: NOT capacity-limited** — confirmed on both the proxy AND the gating metric. The gap
lives in the **encoding** (no board adjacency; only action-head edges) and/or the
**factorization** (per-edge-independent scoring + masked-mean pool, no message passing), not
model size. Next: encoding-v2 (adjacency + richer features) to split feature-limited vs
factorization-saturated ([D-17]) — and that enriched observation is reusable as the PPO
input. Checkpoints + exports on `shodan` (`~/dicewarsjs/ml/checkpoints/probe/`,
`~/probe-exports/`). **Repro:** `node scripts/_probe-capacity-arena.mjs --weights-dir <dir>`.

## Phase 3 — encoding-v2 retrain (feature-limited vs factorization-saturated?) · 2026-06-25

**Question.** Capacity is closed ([D-17]). Of the two remaining suspects — **features**
(the v1 encoding lacked local board context) vs **factorization** (per-edge MLP, no message
passing) — which caps the BC clone at ~6.4%? Test: add engineered local-neighbourhood
features (NOT a raw adjacency blob — the per-edge MLP can't message-pass over one, and PPO
builds its observation live), bump `ENCODING_VERSION 1→2`, re-encode the **same** 100k corpus,
retrain the **same** 102k MLP with the **same** recipe (`--epochs 6 --stop-weight 0.5
--select-by stop-cal`, seed 0), and arena-confirm. The v1 twin is the capacity-probe
`c0_base` (identical net + recipe; the _only_ variable is the encoding).

**v2 feature set.** Node 5→8 (`enemyNbrDiceMaxNorm`, `enemyNbrFrac`, `degreeNorm`); edge
4→7 (`tgtRetakeThreatNorm`, `srcVacateThreatNorm`, `tgtEnemyNbrFrac`) — attack-consequence
signals that mirror how the Lookahead teacher reasons. Re-encode on `shodan`: 8,591,769 steps
/ 59,353,397 edges, byte-identical step/edge counts to v1 (only the feature widths changed).

**Step 1 — proxy (val move-match). LARGE jump.** Same metric, same net, only the encoding
differs:

| encoding           | node/edge feats | best val acc | val STOP (teacher 0.448) |
| ------------------ | --------------- | ------------ | ------------------------ |
| v1 (`c0_base`)     | 5 / 4           | 0.5675       | 0.447                    |
| **v2 (`v2-base`)** | **8 / 7**       | **0.7328**   | 0.414 (sel. ep3 0.418)   |

**+16.5 pt** top-1 imitation accuracy from six engineered features — the teacher's moves
became far more predictable. (No epoch reached the STOP-cal band; the closest, epoch 3, was
saved. Irrelevant to deployment — see Step 2: arena STOP diverges from val STOP, and the bias
sweep is ground truth.)

**Step 2 — real metric (arena win% with 95% CIs). The proxy followed this time.**
`npm run arena:bc-stopbias -- --runs 15 --games 130 --bias 0,0.5,1,2,3` — same 8-bot field
and protocol as the `c0_base` baseline (only the deployed weights differ):

| stopBias | BC win% (95% CI) | STOP% | BC ELO | place | atk/g | atk-win% | Lookahead win% |
| -------- | ---------------- | ----- | ------ | ----- | ----- | -------- | -------------- |
| **0** ◀ | **12.5 ± 1.9**   | 53.0  | 1281   | 3.66  | 36.1  | 83.5     | 17.0 ± 2.1     |
| 0.5      | **12.5 ± 1.4**   | 47.7  | 1260   | 3.89  | 38.5  | 82.5     | 17.1 ± 1.7     |
| 1        | 11.3 ± 1.1       | 44.5  | 1244   | 4.16  | 38.3  | 81.9     | 17.2 ± 2.0     |
| 2        | 9.7 ± 1.6        | 37.7  | 1198   | 4.55  | 39.0  | 81.4     | 20.9 ± 1.9     |
| 3        | 7.7 ± 1.2        | 31.3  | 1166   | 4.83  | 37.0  | 79.9     | 21.3 ± 1.6     |

- **Win% nearly doubled.** Peak **6.7 ± 0.8 (v1 `c0_base`) → 12.5 ± 1.4/1.9 (v2)**, CIs fully
  disjoint ([5.9, 7.5] vs [11.1, 13.9]). The +16.5 pt proxy gain **carried through to the
  gate** — unlike the capacity sweep, where +0.58 pt proxy left win% flat. The per-edge MLP
  was **feature-starved, not factorization-saturated**: given richer local signal it scores
  edges far better with zero architecture change.
- **Halves the gap to Lookahead.** Lookahead ~17% in this field; BC's native gap shrank from
  ~13 pt (at 6.4%) to **~4.6 pt** (at 12.5%, still statistically below — BC has not _beaten_
  the gate, nor was it expected to: BC's ceiling is parity-not-beat, [D-15]).
- **v2 needs no STOP bias.** Peak is at **bias 0** (the deployed default): native STOP 53% vs
  v1's untuned ~71% turtle. Win% _declines monotonically_ as positive bias suppresses STOP —
  aggression now only hurts. Deploy at bias 0 (12.5%, no tuning). bias 0.5 ties on win% with
  STOP closest to the teacher (47.7% vs 45%) and the tightest CI, an equally valid default.

**Verdict: FEATURE-LIMITED.** Confirmed on both the proxy and the gating metric ([D-18]). The
residual ~4.6 pt gap to Lookahead is the **imitation ceiling** (BC clones; Lookahead searches)
— the lever PPO/RL pulls. The v2 observation is the durable artifact: it ships as the deployed
BC _and_ feeds the PPO input. v2 checkpoint on `shodan` (`~/dicewarsjs/ml/checkpoints/v2-base/`).
**Repro:** `npm run arena:bc-stopbias -- --runs 15 --games 130 --bias 0,0.5,1,2,3`.

---

## Phase 3 — PPO gate-harness baselines: BC anchor + tracer (apples-to-apples) · 2026-06-26

**Why.** Phase-3 scaling needs a clean, same-config baseline that any trained PPO policy must
beat. The `npm run ppo:gate` harness (#61) runs a seat-fair 8-bot FFA and reports the **paired
per-run Δwin% vs `ai_lookahead@596f781`** — the valid signal (absolute win% is field-relative;
chance baseline is 12.5% in an 8-way FFA, with Strategist + Expectimax also strong). Both rows:
default config, **3040 games** (20 runs × 19 seeds × 8 seat rotations), judged on **win%, not ELO**.

| Candidate (gate)                                     | Cand win% (95% CI) | Lookahead win% | Paired Δ (cand − bar)        | Verdict     |
| ---------------------------------------------------- | ------------------ | -------------- | ---------------------------- | ----------- |
| **BC v2 anchor** (`bcPolicyWeights.js`)              | 12.4 ± 1.4         | 16.1 ± 1.4     | **−3.7 ± 2.4 [−6.1, −1.3]**  | ❌ BEHIND   |
| **PPO tracer** (`ppo-tracer`, 2048 steps, #61)       | 11.5 ± 1.3         | 15.1 ± 1.1     | **−3.6 ± 1.7 [−5.3, −1.9]**  | ❌ BEHIND   |
| **PPO fixed-field 1M** (task A, `feat/…-1M-weights`) | 45.2 ± 2.0         | 11.8 ± 0.7     | **+33.4 ± 2.4 [31.0, 35.8]** | ✅ **BEAT** |

**Takeaway.** BC anchor (−3.7) ≈ PPO tracer (−3.6) — **statistically identical**. The 2048-step
tracer did **not** learn past the BC warm-start (exactly the loop-closer expectation). So the
clean Phase-3 baseline any real run must beat is **Δ ≈ −3.7 pp** (BC level). The earlier −8.8 in
the LOG was a noisier smaller validation run; −3.7 is the canonical-config number.

**Resolved 2026-06-27 — task A PASSED, the first real Phase-3 learning signal.** The fixed-field
scaling diagnostic ([D-22] task A: `train_tracer` warm-started from v2-BC, fixed heterogeneous
field `ai_lookahead,ai_strategist,ai_expectimax,ai_bc,ai_defensive`, learning-enabled HPs
`lr 2.5e-4`/`ent_coef 0.01`, 1M steps, `seed 0`) completed clean on `shodan` (`TRAIN_EXIT=0`,
489 iters / 1.001M steps, ~4 h, flat memory; launched via the teardown-immune **schtasks** `ppoff`
task — see LOG). Export (`ppo:export` recipe, `--ckpt checkpoints/ppo-fixedfield-1M.pt`) →
`npm run ppo:gate` (3040 seat-fair games, parity 1.2e-5): **PPO 45.2 ± 2.0%** vs Lookahead
**11.8 ± 0.7%**, **paired Δ +33.4 ± 2.4 [31.0, 35.8] → ✅ BEAT** (STOP 48.7%, atk-win 65.6%). A
~37-pt swing off the −3.7 BC-anchor baseline → **the D-7 headline BEAT gate is met**, and the binary
task-A question (does PPO move past the BC ceiling at all?) is answered emphatically-yes.

**Caveat — read this as "dominates the field it trained on," not yet "robustly general."** 4 of the
7 gate opponents (including all three strong ones — Lookahead/Strategist/Expectimax) were training
opponents, so the dominance is partly fixed-field _exploitation_; it also beats the 3 genuinely
held-out bots (Example/Default/Adaptive → partial generalization). That overfitting gap is exactly
what task B (PFSP league) is built to close. **Per [D-22]'s material-gain branch → green-light task
B.** Corroboration: training-log `explained_variance` held healthy (~0.68–0.88); there's no
`ep_rew_mean` (no SB3 Monitor wrapper), so the like-for-like gate Δ itself (same pipeline/gate,
tracer −3.7 → 1M +33.4) is the learning evidence. Weights on PR branch
`feat/ml-ppo-fixedfield-1M-weights` (off master, sha256-verified `1a754eef…`); checkpoint on shodan
`~/dicewarsjs/ml/checkpoints/ppo-fixedfield-1M.pt`.

**Repro:** on shodan, `cd ml && .venv/bin/python -m dicewars_bc.export_weights --ckpt
checkpoints/ppo-fixedfield-1M.pt --out ../src/ai/ppoPolicyWeights.js --fixture
../tests/fixtures/bc/ppoForwardCases.json`; then on the Mac `npm run ppo:gate` (default weights =
`ppoPolicyWeights.js`).

**Repro:** BC anchor — `npm run ppo:gate -- --weights src/ai/bcPolicyWeights.js --fixture tests/fixtures/bc/forwardCases.json --name BCanchor`; PPO — `npm run ppo:gate` (default weights = `ppoPolicyWeights.js`).

---

## Phase 3 — PPO long run: from-scratch control + the 20M BEAT (the headline) · 2026-06-29

The task-A **+33.4** above was partly **fixed-field exploitation** (4 of 7 gate opponents — incl. all
three strong ones — were training opponents). Two runs on `shodan` ([[infra_shodan_gpu_pc]], RTX 4070
Ti) close that gap and deliver the headline result of the whole initiative.

**Setup (both runs).** Pinned to the campaign commit `c0d1441` (PR-6 launcher), `ENCODING_VERSION 2`,
**R=3 PFSP league**, production HPs `lr 2.5e-4 / ent_coef 0.01`. Gated by `npm run ppo:gate` (3040
seat-fair games = 20 runs × 19 seeds × 8 seat rotations, 8-bot FFA, judged on **win%, not ELO**,
paired Δ vs `ai_lookahead@596f781`).

| Candidate (gate)                                   | Cand win% (95% CI) | Lookahead win% | Paired Δ (cand − bar)        | Verdict     |
| -------------------------------------------------- | ------------------ | -------------- | ---------------------------- | ----------- |
| **PPO from-scratch control** (1M, NO warm-start)   | 40.0               | 13.1           | **+26.9 ± 3.1 [23.8, 30.0]** | ✅ **BEAT** |
| **PPO long run** (20M, BC warm-start) — _headline_ | 40.4 ± 1.6         | 12.7 ± 1.4     | **+27.7 ± 2.7 [25.0, 30.4]** | ✅ **BEAT** |
| **PPO from-scratch LONG** (20M, NO warm-start)     | 46.7 ± 2.0         | 10.4 ± 1.2     | **+36.3 ± 2.6 [33.8, 38.9]** | ✅ **BEAT** |

**Control (1M, from scratch) — resolves the exploitation caveat.** A fresh-init run (`FROM_SCRATCH=1`,
no BC warm-start, 1M steps, ~85 min, clean `exit 0`, attempt #1) gated **+26.9 [23.8, 30.0] → BEAT**.
A bot that learned to beat Lookahead **from random weights** cannot be exploiting the task-A artifact —
this proves the pipeline produces genuine PPO learning, not a fixed-field memorization trick. That
green-lit the long run (Ivan's standing rule: "if it beats Lookahead, kick off the long run").

**Long run (20M, BC warm-start) — the headline.** Warm-started from the v2-BC clone (`v2-base`), 20.00M
env-steps to budget, **clean `exit 0`, attempt #1, ZERO auto-restarts / pointer halts**, ~29 h wall at
~190 env-steps/s (`n_envs=12`, `SubprocVecEnv`); `explained_variance` held ~0.86–0.91 throughout. The
launcher auto-repacked the SB3 actor → `ml/runs/ppo-long/ppo.pt` and self-verified it reloads into a
bare `EdgePolicyNet`. Exported (`export_weights --ckpt runs/ppo-long/ppo.pt`) with **JS↔Python forward
parity 1.9e-5**, then gated (440.5 s): **PPO 40.4 ± 1.6%** vs Lookahead **12.7 ± 1.4%**, **paired Δ
+27.7 ± 2.7 [25.0, 30.4] → ✅ BEAT** (PPO STOP 46.6%, attack-win 69.4%). The CI lower bound **25.0 ≫
0**; this clears the canonical BC-anchor (Δ ≈ −3.7) by ~31 pp and corroborates the from-scratch control
— **the D-7 headline BEAT gate is met at full budget with a held-out-general league, not just a fixed
field.**

The exported `src/ai/ppoPolicyWeights.js` (sha256 `f6be9b91…`, 102,787 params, `teacher=ppo`) **replaces
the committed task-A weights** (sha256 `1a754eef…`) — same file, same `ai_ppo` bot wiring (PR #74), no
code change. Run commit `c0d1441`; Lookahead pin `596f781`; checkpoint on shodan
`~/dicewarsjs/ml/runs/ppo-long/ppo.pt`.

**Repro:** on shodan, `cd ml && .venv/bin/python -m dicewars_bc.export_weights --ckpt
runs/ppo-long/ppo.pt --out ../src/ai/ppoPolicyWeights.js --fixture
../tests/fixtures/bc/ppoForwardCases.json`; then on the Mac `npm run ppo:gate` (default weights =
`ppoPolicyWeights.js`).

**Follow-up (2026-07-02) — from-scratch AT FULL BUDGET: the BC warm-start bought wall-clock, not
ceiling.** The 1M control above answered "is the BEAT real?" (yes). This run answers Ivan's next
question — _"could a bot with no BC/PPO warm-start actually compete at full budget, and how would it
turn out?"_ — by rerunning the 20M campaign with the **only** variable flipped: `FROM_SCRATCH=1`
(random init), everything else identical to the headline (same commit `c0d1441`, same R=3 PFSP
league, same `lr 2.5e-4 / ent_coef 0.01`, same 20.00M budget, same 8-bot gate, same Lookahead pin
`596f781`). It ran **clean `exit 0`, attempt #1, ZERO auto-restarts**, ~30 h wall at ~183 env-steps/s;
export parity **2.5e-5**; gated 460.0 s over the same 3040 seat-fair games. Result: **46.7 ± 2.0%** vs
Lookahead **10.4 ± 1.2%**, **paired Δ +36.3 ± 2.6 [33.8, 38.9] → ✅ BEAT**. The from-scratch net is
**+8.6 pp stronger than the BC-warm-started headline (+27.7)**, and the two runs' 95% CIs are
**disjoint** ([33.8, 38.9] vs [25.0, 30.4]) — a clean, significant separation, not noise. It also
plays **more aggressively**: STOP 42.3% (vs 46.6%) and attack-win 71.4% (vs 69.4%) — a distinct style
emerged from random weights. **Takeaway:** at this budget the BC warm-start is a _convergence-speed_
convenience (faster early learning), **not** a strength prior — pure self-play from nothing found the
better policy. **Caveat:** this is a single from-scratch seed vs a single warm-start seed; the gate CIs
are within-run (across seeds/rotations), so run-to-run variance between the two 20M campaigns is not
fully separable from the warm-start variable — but the direction is unambiguous and the gap is large
(and it rhymes with the 1M control already reaching +26.9 with no warm-start). Not shipped: `ai_ppo` /
Conqueror keep the headline `ppo-long` weights; these weights live on shodan at
`~/dicewarsjs/ml/runs/ppo-scratch-long/{ppo.pt,scratch.weights.js,scratch.fixture.json}` and
`gate.log`. Run commit `c0d1441`; Lookahead pin `596f781`.

---

## Phase 3 — reward-PERSONA pilot: 3 flag-only personas (Conqueror / Blitz / Survivor) · 2026-06-30

First batch of the reward-persona roster ([PERSONAS.md](./PERSONAS.md)): three PPO bots **warm-started
from the 20M `ppo-long` actor** and fine-tuned **3M steps each** at a gentle `lr 1e-4` (`ent_coef 0.01`,
R=3 PFSP league, `ENCODING_VERSION 2`), differing ONLY in the reward objective. Trained **concurrently**
on `shodan` ([[infra_shodan_gpu_pc]], ~175 fps each, ~4.7 h wall, all clean `exit 0`, attempt #1) via the
teardown-immune `dicewars-persona-pilot` schtasks job (deleted post-run). Run commit `71b9e82`; Lookahead
pin `596f781`.

- **Conqueror** = win reward, γ0.999 — the matched **control** (same objective as `ppo-long`).
- **Blitz** = win reward, **γ0.99** (short horizon → finish fast).
- **Survivor** = **placement** reward, γ0.999 (climb the FFA ranking).

### Strength — `ppo:gate` (is it STRONGER?)

9-bot seat-fair FFA (the 8-bot gate field **plus** a `PPO`=`ppo-long` seat), 20 runs × 17 seeds × 9 seat
rotations = **3060 games**, paired Δwin% vs `ai_lookahead@596f781`, judged on **win%, not ELO**. Each
export forward-parity-checked (≤ 2.1e-5).

| Persona (gate)          | Reward           | Cand win% (95% CI) | Lookahead win% | Paired Δ (cand − bar)        | Verdict     |
| ----------------------- | ---------------- | ------------------ | -------------- | ---------------------------- | ----------- |
| **Conqueror** (control) | win γ0.999       | 21.0 ± 1.6         | 8.0 ± 1.2      | **+13.0 ± 2.0 [11.0, 15.0]** | ✅ **BEAT** |
| **Blitz**               | win γ0.99        | 29.6 ± 1.8         | 9.3 ± 1.2      | **+20.3 ± 2.4 [17.8, 22.7]** | ✅ **BEAT** |
| **Survivor**            | placement γ0.999 | 37.0 ± 1.4         | 7.2 ± 0.9      | **+29.7 ± 2.0 [27.7, 31.7]** | ✅ **BEAT** |

**All three BEAT Lookahead** — the warm-start held; no collapse under 3M steps of reward-shaped
fine-tuning. Within this common field the three rank **Survivor > Blitz > Conqueror**, and the **same
ordering replicates** in the (different) behavior-profile field below — so it's a real ranking, not field
noise. **NB:** these Δ are NOT comparable to the `ppo-long` headline +27.7 — that gate had no sibling-PPO
seat; this 9-bot field adds one, depressing everyone's absolute win%. A clean persona-vs-`ppo-long`
head-to-head is an open follow-up.

**Surprise — the placement-reward bot is the STRONGEST and the win-reward control is the WEAKEST.**
Survivor (optimizing finishing position, not wins) out-wins Conqueror (optimizing wins) by ~16 pp on win%
in **both** fields. Likely the dense placement signal trains better than the sparse win/loss signal in only
3M steps — "don't die early, climb the ranking" correlates strongly with eventually winning an 8-way FFA.
Worth a follow-up: does a placement-shaped retrain beat the shipped `ppo-long` base head-to-head? If so
it's a lever for the main `ai_ppo`, not just a persona.

### Style — `behavior:profile` (is it DIFFERENT?)

Blitz + Survivor profiled against the **Conqueror control** (the matched baseline), fixed-standard 6-bot
field, 10 runs × 30 games × 6 rotations = **1800 matches/bot** (5400 total, 0 quarantined). The signature
gate uses the placeholder `DEFAULT_MDE`s — this pilot **is** the MDE calibration.

| Bot                     | winPct     | aggression  | avgDiceReserve | kills       | turnsToWin  | avgPlacement |
| ----------------------- | ---------- | ----------- | -------------- | ----------- | ----------- | ------------ |
| **Blitz**               | 48.6 ± 2.1 | 2.14 ± 0.03 | 63.1 ± 2.3     | 1.53 ± 0.06 | 126.3 ± 4.2 | 2.49 ± 0.10  |
| **Survivor**            | 64.5 ± 2.5 | 1.60 ± 0.05 | 77.1 ± 2.4     | 1.88 ± 0.07 | 146.4 ± 3.8 | 1.69 ± 0.09  |
| **Conqueror** (control) | 34.5 ± 2.6 | 1.72 ± 0.06 | 82.2 ± 3.1     | 1.41 ± 0.07 | 143.1 ± 6.7 | 2.51 ± 0.06  |

- **Survivor signature (avgPlacement↓): PASS ✓** — Δ−0.82 [−0.92, −0.72] (MDE 0.4). Best placement in the
  field (1.69) **and** the highest win% (64.5%): placement-optimization made it the best all-around, not a
  passive turtle. Clean ship candidate.
- **Blitz signature (aggression↑ AND turnsToWin↓): FAIL ✗ — on a technicality.** turnsToWin↓ **Δ−16.81**
  [−24.1, −9.5] clears easily (finishes ~17 turns sooner); aggression↑ Δ+0.42 [0.37, 0.47] is _significant
  in the right direction_ but below the **placeholder MDE of 1.0**, so the AND-gate fails. The style
  unmistakably moved: dice reserve Δ−19.1 (attacks instead of banking), survivalTurn Δ−59.8 (flames out
  fast when it loses). This is an **MDE-calibration miss, not a style miss** — the true persona effect on
  `aggression` is ≈0.4, far below the guessed 1.0.

**Cross-comparison: the reward knobs produced genuinely distinct styles.** Survivor = patient,
high-placement, longest games (146 t); Blitz = fast, aggressive, low dice reserve, shortest games (126 t);
Conqueror = balanced hoarder (highest dice reserve, 82). The pilot SUCCEEDS on the "are they different?"
axis (Survivor formally; Blitz substantively, pending MDE recalibration).

### Pilot verdict + MDE calibration (for batch 2)

- **Strength gate: 3/3 PASS.** Style gate: Survivor PASS, Blitz substantive-but-MDE-blocked, Conqueror =
  control (no signature).
- **Calibrated MDEs from this pilot** (to replace the placeholders in `behavior-core.mjs` `DEFAULT_MDE`):
  `aggression` 1.0 → **~0.3** (observed real effect 0.42), `turnsToWin` 5.0 ✓ (effect −16.8),
  `avgPlacement` 0.4 ✓ (effect −0.82). Under an aggression-MDE of 0.3, **Blitz PASSES**.
- **Ship call (D-27, still open) is Ivan's:** Survivor is the clear winner (strong + distinct + PASS);
  Blitz is a real faster/aggressive style worth shipping once the MDE is recalibrated; Conqueror is the
  control. Next: batch 2 (Expansionist + Predator, dense rewards, bite G) — and the placement-reward
  strength finding earns a `ppo-long` head-to-head.

**Repro:** export each — `cd ml && .venv/bin/python -m dicewars_bc.export_weights --ckpt
runs/ppo-<p>/ppo.pt --out runs/ppo-<p>/<p>.weights.js --fixture runs/ppo-<p>/<p>.fixture.json`; gate —
`npm run ppo:gate -- --weights ml/runs/ppo-<p>/<p>.weights.js --fixture ml/runs/ppo-<p>/<p>.fixture.json
--name <Name>`; profile — `npm run behavior:profile -- --bots
Blitz=ml/runs/ppo-blitz/blitz.weights.js,Survivor=ml/runs/ppo-survivor/survivor.weights.js --control
Conqueror=ml/runs/ppo-conqueror/conqueror.weights.js`. Checkpoints on shodan
`~/dicewarsjs/ml/runs/ppo-{conqueror,blitz,survivor}/ppo.pt`.

### Head-to-head vs `ppo-long` — the ship decision ([D-27])

Beating Lookahead is not the bar for replacing the shipped net; beating (or matching) `ppo-long` is. Same
9-bot gate field, `--bar PPO` (the live `ai_ppo` = `ppo-long`, sha `f6be9b91…`), 3060 seat-fair games each,
paired Δwin% (persona − ppo-long):

| Persona vs `ppo-long`   | Cand win% (95% CI) | ppo-long win% | Paired Δ (cand − bar)        | Verdict     |
| ----------------------- | ------------------ | ------------- | ---------------------------- | ----------- |
| **Conqueror** (control) | 20.9 ± 1.5         | 28.5 ± 1.9    | **−7.6 ± 2.5 [−10.1, −5.1]** | ❌ BEHIND   |
| **Blitz**               | 28.7 ± 1.7         | 29.1 ± 1.5    | **−0.4 ± 2.7 [−3.1, 2.3]**   | ~ TIE       |
| **Survivor**            | 38.0 ± 1.5         | 29.6 ± 1.1    | **+8.4 ± 2.1 [6.3, 10.5]**   | ✅ **BEAT** |

**Read:** 3M more steps of the SAME win objective off `ppo-long` _regressed_ the control (Conqueror −7.6) —
sparse-reward continuation drifts the policy — while CHANGING the reward helped: placement-shaped Survivor
is the strongest net the game ships (+8.4 over `ppo-long`), and short-horizon Blitz holds even (TIE).

**Ship outcome ([D-27]).** Conqueror's fine-tune fails the "≥ `ppo-long`" bar, so the player-facing
**Conqueror ships the `ppo-long` weights directly** (it _is_ the balanced win-objective net — no downgrade);
**Blitz/Survivor ship their own checkpoints**. All three are the player-facing roster (in-game picker +
arena/tournament); the internal `PPO`/`BC` nets are **hidden** (kept in `builtInBots.js` for the dev
harness, `PPO` still the gate baseline). The weaker `ppo-conqueror` checkpoint is a training artifact, not
shipped. **Repro:** `npm run ppo:gate -- --weights ml/runs/ppo-<p>/<p>.weights.js --fixture
ml/runs/ppo-<p>/<p>.fixture.json --name <Name> --bar PPO`.

## Persona field-sensitivity audit: seat-fair ML round-robin · 2026-06-30

**Motivation.** Two field observations looked contradictory: Survivor scores best against the coded bots,
but Conqueror looks best when the ML bots are played _against each other_ in-browser. Neither the fixed-seat
`arena:sweep` (seat/territory advantage confounds a small field — `MapGenerator` allocates by seat index)
nor `ppo:gate` (one candidate vs one bar) can rank the ML nets against each other cleanly. New harness
`scripts/ml-roundrobin.mjs` (`npm run arena:ml`) generalizes the gate's method — every seed replayed through
all N cyclic seat rotations, per-run paired stats — to a whole field: per-bot win% / avg-placement / top-2
each with a 95% CI, plus a full **pairwise paired-Δ win%** matrix. Built-in soundness probe: `PPO` and
`Conqueror` ship identical weights, so their paired Δ must span 0.

**19,472 seat-fair games across four fields. Calibration PASSED in every multi-bot run** (PPO−Conqueror Δ
spans 0: A +1.2±1.3, B +0.8±1.6, C −0.5±1.9) → the seat-fairness and harness are sound.

**Win% by field (seat-fair, 95% CI; 🥇 = field leader):**

| Bot           | Heads-up 1v1 (D)  | Pure-ML 5p (A)    | +Lookahead 6p (B) | Mixed-8 (C)       |
| ------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| **Blitz**     | —                 | **28.6 ± 1.2** 🥇 | **26.1 ± 1.5** 🥇 | 21.8 ± 1.3        |
| **PPO**       | —                 | 24.5 ± 1.0        | 23.3 ± 1.3        | 19.6 ± 1.1        |
| **Conqueror** | **56.1 ± 0.9** 🥇 | 23.3 ± 0.9        | 22.5 ± 1.2        | 20.2 ± 1.1        |
| **Survivor**  | 43.8 ± 0.9        | 20.1 ± 1.0        | 21.3 ± 1.1        | **23.3 ± 1.1** 🥇 |
| **BC**        | —                 | 2.4 ± 0.4         | 1.1 ± 0.3         | 2.5 ± 0.5         |
| _fair share_  | _50.0_            | _20.0_            | _16.7_            | _12.5_            |

(D = Conqueror-vs-Survivor only. B also fields Lookahead 2.2; C also fields Strategist 3.6 / Lookahead 3.4 /
Default 1.5 — the four self-play nets bury every heuristic + the search bot in FFA.)

**Avg placement, lower = better (Survivor wins this everywhere):**

| Bot       | A (5p)   | B (6p)   | C (8p)   |
| --------- | -------- | -------- | -------- |
| Survivor  | **2.75** | **3.00** | **3.56** |
| PPO       | 2.79     | 3.27     | 3.94     |
| Conqueror | 2.85     | 3.26     | 4.00     |
| Blitz     | 3.02     | 3.45     | 4.23     |
| BC        | 3.60     | 4.14     | 4.58     |

**Read: the win-rate ranking is field-dependent; placement is not.** As the field weakens/crowds, Survivor
climbs the win% table — heads-up it _loses_ to Conqueror by **−12.3 ± 1.7** (SIG), in pure-ML it is _last_
of the four nets (Conqueror−Survivor +3.2, PPO−Survivor +4.4, both SIG), yet in the weak mixed-8 field it is
_first_ (Survivor−Conqueror +3.1, Survivor−PPO +3.6, both SIG). This is the placement/survival reward
behaving as designed: more weak bots to outlast ⇒ more games where it is the last strong net standing. The
finishers invert it — **Blitz** wins the most outright in ML-heavy fields (+5.3 over Conqueror in pure-ML,
SIG) but has the _worst_ placement of the nets (win-or-bust, high variance), and **Conqueror**(=`ppo-long`)
is the strongest _pure head-to-head_ bot. **BC** is decisively the weakest ML net (~2% FFA), confirming its
hidden/dev-only status.

**Reconciliation.** Both field observations are correct and non-contradictory: Survivor best against coded
bots = its dominance in the weak/mixed field (C, #1 on _every_ metric); "Conqueror best among the ML bots" =
directionally right (Conqueror is top-tier, far above Survivor/BC in all-ML), with the refinement that
**Blitz** is technically the strongest all-ML _winner_ and **PPO ties Conqueror** (same weights). Contextual
note for the **+8.4 over `ppo-long`** BEAT above: that gate field is _weak-bot-heavy_ (8 heuristics/PPO +
candidate), i.e. a mixed field like C — so it is a real, reproducible result _in that field_, and the
"strongest net the game ships" claim holds for realistic play (which includes the coded bots) and on
placement, but **not** for all-ML or heads-up win rate, where the finishers lead.

**Repro:** `npm run arena:ml -- --bots BC,PPO,Conqueror,Blitz,Survivor --runs 30 --seeds 32` (Exp A); swap
`--bots` for the other fields (B adds `,Lookahead`; C adds `,Lookahead,Strategist,Default`; D is
`Survivor,Conqueror`). `--out <file>.json` dumps per-run vectors + the pairwise matrix.

---

## Phase 3 — dense-reward personas Batch-2B ([D-30]): strength held everywhere, no style bar cleared → Expansionist PARKED, Predator DROPPED · 2026-07-02

The [D-30] wave: four 1M flag-only arms warm-started from `ppo-long` (commit `20e5be5`, persona
worktree, staggered 2+2 around the 20M scratch run; supervisor `persona_b2c_launch.sh`, all four
clean `exit 0`, attempt #1, zero restarts). Wave A's 0.5M tripwire probes passed (LOG 2026-07-01
evening); Wave B ran overnight. 1M full eval per RUNBOOK §8d, off each arm's **fixtured final
eval-stream checkpoint** (`eval-001001472.*` — the #97 producer made the manual export step
unnecessary): `behavior:profile` 6×30×6 (3240 matches/arm; control Conqueror **+ the [D-30] dec. 4
matched-backbone comparator**) and `ppo:gate` 8×80 (640 games) vs Lookahead@`596f781`.

| Arm (1M)         | Gate Δ vs Lookahead         | Field win% | Target axis (pre-registered bar)  | vs matched comparator        | Verdict |
| ---------------- | --------------------------- | ---------- | --------------------------------- | ---------------------------- | ------- |
| Exp γ0.99 c0.04  | **+7.7** [3.2, 12.2] BEAT   | 43.4       | avgTerritory **Δ−0.68** (≥+1.5) ✗ | strictly worse than Blitz    | ✗ FAIL  |
| Exp γ0.99 c0.08  | **+21.3** [15.0, 27.6] BEAT | 53.7       | avgTerritory **ns** (≥+1.5) ✗     | ≈ Blitz-lite (aggr +0.32)    | ✗ FAIL  |
| Pred place b0.15 | **+17.3** [10.6, 23.9] BEAT | 48.7       | kills **Δ+0.07 ns** (≥+0.25) ✗    | kills 1.65 < Survivor's 1.92 | ✗ FAIL  |
| Pred place b0.25 | **+18.2** [13.1, 23.3] BEAT | 57.7       | kills **Δ+0.04 ns** (≥+0.25) ✗    | kills 1.73 < Survivor's 1.86 | ✗ FAIL  |

**The [D-30] mechanism fixes worked — both failure basins are gone.** The γ=0.99 Expansionist arms
show zero turtling (dice reserve, zero-attack fraction, and turnsToWin all moved DOWN vs control —
the Batch-2 c15 turtle collapsed exactly these axes upward), and the placement-backbone Predator
arms show zero bounty-suicide (b15 survivalTurn **+35** vs control, where Batch-2's b04/b07 died
~80 turns EARLY). The §7-Addendum diagnosis — the `(1−γ)` residual turtle optimum, and `win`-mode
pricing death at 0 — is confirmed by construction: change the shape, the basin disappears.

**But the style levers still don't move their target axes.** That's the real, twice-replicated
negative result of Batch 2:

- **Territory coef → tempo, not territory.** Under γ=0.99 the coef converts into aggression/speed
  (c04 aggr +0.60, c08 +0.32 vs control), landing in Blitz's corner of style space instead of the
  map-painter's. c04 is strictly worse than Blitz (field win 43.4 vs 50.9, fewer kills, worse
  placement) with the wave's weakest gate (+7.7). c08 is a genuinely healthy bot (gate +21.3,
  field 53.7) but stylistically a Blitz-lite — no roster slot it fills that Blitz doesn't.
- **The elim bounty does not buy kills — at any tested price.** The kills axis has now failed at
  bounty {0.1, 0.15, 0.25, 0.4, 0.7} across three waves and two backbones. Meanwhile plain
  placement (Survivor, bounty **0**) posts MORE kills (1.86–1.92) than every bounty arm — kill
  volume comes from being alive and ahead, not from pricing the kill. With credit for a
  non-terminal kill landing diluted on a turn-boundary frame ([D-30] rejected-designs analysis),
  the per-kill bounty is a dead lever on this wire.
- **Ironic capstone:** PredB15's avgTerritory Δ**+1.83** exceeds the _Expansionist_ bar (+1.5) —
  the placement backbone is a stronger hold-territory lever than the territory reward itself. Any
  future map-painter revival should start from the placement family, not territory deltas.

**Tripwire postscript (ship bar 3):** at 1M, c04 trips the overextension wire (survivalTurn −67.8
< −60 with the avgPlacement +0.61 co-signal) and b15 trips turtle-side dice-reserve (+16.7 > +10)
— both already dead on the target-axis bar, recorded for completeness. The dec. 5 E-only
early-game-territory readout turned out **not to exist in the profiler** (no turn-sliced territory
metric); immaterial here since the primary bars fail decisively, but it's a build-first item if
the map-painter is ever revived.

**Verdict — [D-30] dec. 6 executes as pre-committed: Expansionist PARKED** (revival is a product
call for a deliberately-weaker map-painter, not a fourth reward iteration), **Predator DROPPED**
(strike three on the kills axis). The shipped three-persona roster (Conqueror / Blitz / Survivor,
plus hidden PPO/BC) stands as the complete product. No 3M run, no fresh-seed confirmation, no
export/ship plumbing — correctly never built.

**Artifacts (shodan):** `~/dicewarsjs-personas/ml/runs/ppo-{exp-g99-c04,exp-g99-c08,pred-place-b15,pred-place-b25}/`
(checkpoints + fixtured eval streams), eval logs in `ml/runs/_b2c_eval/*.{profile,gate}.log`,
supervisor log `ml/runs/persona-b2c.supervisor.log`. Both schtasks tasks
(`dicewars-persona-b2c`, `dicewars-b2c-eval`) deleted post-run.

## Phase 3 — encoding-v3 scratch run COMPLETE: ALL [D-31] §4 bars PASS (primary A/B + ship) · 2026-07-05

`ppo-v3-scratch` — the [D-31] encoding A/B (fixed `turnClockNorm` encoder, `ENCODING_VERSION 3`,
pinned `464a2ee`; `FROM_SCRATCH=1`, 20M steps, R=3 PFSP league, `lr 2.5e-4 / ent_coef 0.01`,
`n_envs 12` — the `ppo-scratch-long` recipe with ONLY the observation changed) — **completed
cleanly 2026-07-04 20:53 CDT**: exit 0, attempt #1, **zero restarts**, ~31.6 h wall at ~175 fps,
final checkpoint 20,004,864 steps. Everything below is gated **locally on the Mac** off the run's
fixtured eval stream (the #97 producer): candidate = `eval-020004864.*` (the final fixtured
eval-stream checkpoint per PERSONAS §10.2 — and the curve's peak, see below; 103,779 params,
parity 3.0e-4).

### The [D-31] §4 bars — all PASS

Head-to-head bars were run with the PERSONAS §10.7 **Wave-0 item-4 loader built this session**:
`ppo:gate --bar Name=weights.js` parity-checks the bar export and seats it as an EXTRA field seat
(10 seats: 8 baselines + bar + candidate), so candidate and bar are measured **in the same games**
and judged on the paired Δ win% CI. Both v2 bars ran via slice-compat on the v3 encoder (parity:
ScratchLong 2.5e-5, Survivor 1.9e-5). **NB:** the extra seat depresses absolute win% — 10-seat
rows are not comparable to 9-seat rows; only the paired Δ is judged. Fresh-seed confirmations per
§10.2 (`--seedbase 20` ≥ run count, 2× runs = 6000 games) are **the reported strengths**.

| Bar ([D-31] §4)                                     | Field       | Initial (seedbase 0, 3000–3060 games)      | Fresh-seed (seedbase 20, 6000 games)     | Verdict     |
| --------------------------------------------------- | ----------- | ------------------------------------------ | ---------------------------------------- | ----------- |
| _floor_ — `Lookahead@596f781`                       | 9-seat gate | **+33.9 ± 1.6 [32.2, 35.5]** (39.8 vs 6.0) | —                                        | ✅ **BEAT** |
| **PRIMARY** — `ppo-scratch-long` (the encoding A/B) | 10-seat h2h | +7.0 ± 2.0 [5.0, 9.1] (32.2 vs 25.2)       | **+6.1 ± 2.2 [3.9, 8.4]** (31.5 vs 25.4) | ✅ **BEAT** |
| **SHIP** — `Survivor` (strongest shipped net)       | 10-seat h2h | +3.5 ± 2.3 [1.2, 5.8] (29.8 vs 26.4)       | **+5.5 ± 1.7 [3.8, 7.2]** (31.7 vs 26.2) | ✅ **BEAT** |

### Strength curve vs Lookahead (9-seat, 3060 games/point, all off the eval stream)

| Steps | Paired Δ vs Lookahead        | Cand win% | STOP% |
| ----: | ---------------------------- | --------- | ----- |
|    2M | +32.4 ± 1.9 [30.5, 34.3]     | 37.5      | 44.8  |
|    6M | +27.2 ± 2.2 [25.0, 29.4]     | 34.8      | 37.6  |
|   12M | +26.0 ± 1.9 [24.1, 27.9]     | 34.1      | 38.5  |
|   16M | +30.7 ± 2.3 [28.4, 33.0]     | 37.0      | 41.3  |
|   19M | +32.3 ± 2.2 [30.1, 34.5]     | 39.2      | 42.7  |
|   20M | **+33.9 ± 1.6 [32.2, 35.5]** | 39.8      | 45.0  |

The PFSP dip bottoms at ~12M and the tail **rises monotonically into the final checkpoint** — the
shipped candidate is the curve's peak, not a lucky endpoint (a [D-29] k=2 tail-regression check
would not fire). The late climb past the 2M exploit-the-weak-field peak is genuine strength (same
field throughout), and STOP% recovering 38.5 → 45.0 is the net re-learning patience as it
strengthens.

### Read

- **The [D-31] representational-gap thesis is validated at full budget.** With the training recipe
  held fixed, the v3 observation (owner identity, income economics, turn order, clock) is worth
  **+6.1 pp head-to-head at 20M** over the v2-encoding control — training could never have
  recovered what the encoding withheld.
- **The v3 base is now the strongest net, full stop:** it beats Survivor (+5.5), which had beaten
  `ppo-long` (+8.4), which had beaten the BC clone and every heuristic. The floor gate (+33.9 vs
  Lookahead) also exceeds the v2 warm-start headline (+27.7) on a comparable 9-seat field.
- **Consequence per [D-31] §5:** the v3 net ships as **Conqueror's** weights ([D-27] pattern —
  packed export into `src/ai/`; hidden `ai_ppo` keeps the v2 `ppo-long` weights as the gate
  baseline; the gate field keeps its v2 `PPO` seat for era comparability). Per PERSONAS §10.1,
  primary + ship PASS → the pre-registered v3 persona slate proceeds intact; Wave 1 unblocks once
  the remaining Wave-0 preconditions land (the [D-29] scorer Phase 1 is the hard one).

**Artifacts:** gate logs archived to shodan
`ml/runs/_eval_logs/v3-scratch.20M.{final-gate,primary-bar,ship-bar,primary-bar.freshseed,ship-bar.freshseed}.log`
and `v3-scratch.{16M,19M}.curve.log`; candidate/curve weights from
`ml/runs/ppo-v3-scratch/eval/`; bar weights `ml/runs/ppo-scratch-long/scratch.weights.js` and
`ml/runs/ppo-survivor/survivor.weights.js`. Run commit `464a2ee`; Lookahead pin `596f781`.

## Phase 3 — v3 Wave-1 persona retrain: Blitz-v3 SHIPS (upgrade), Survivor-v3 KILLED · 2026-07-06

The PERSONAS §10.2 Wave-1 slate: three concurrent 3M-step fine-tunes warm-started from the
encoding-v3 base `ppo-v3-scratch/ppo.pt` (= the shipped Conqueror), matched on every axis but the
reward (`LR 1e-4 / ent_coef 0.01`, R=3 PFSP league, `EVAL_EVERY=500000`; γ + reward-mode from each
PERSONA preset). Ran on shodan via the durable supervisor `launch-v3-wave.sh` under schtasks
`dicewars-ppo-v3-wave` (2026-07-05 23:02 → 2026-07-06 04:00 CDT, ~5 h wall, all three `exit 0`,
attempt #1, zero restarts, ~167 fps/arm, final step 3,004,416). Arms: `ppo-v3-conq-ctl`
(win/γ0.999 = matched control, never ships) · `ppo-v3-blitz` (win/**γ0.99**) · `ppo-v3-survivor`
(**placement**/γ0.999). Graded **locally on the Mac** off each arm's final fixtured eval checkpoint
`eval-003000024.*` (103,779 params; parity 1.0–3.4e-4).

### Strength — `ppo:gate` (paired Δ win%, seat-fair)

| Arm            | vs Lookahead@596f781 (9-seat floor) | vs v3 base Conqueror (10-seat h2h)      | vs v2 sibling (10-seat h2h)                      |
| -------------- | ----------------------------------- | --------------------------------------- | ------------------------------------------------ |
| ConqCtl (ctrl) | **+34.0 [32.0, 35.9]** ✅ BEAT      | +1.1 [−1.3, 3.5] ~TIE                   | —                                                |
| **Blitz-v3**   | **+29.6 [27.1, 32.1]** ✅ BEAT      | +1.8 [−0.8, 4.4] ~TIE (clears −8 floor) | **+11.6 [8.7, 14.4]** ✅ BEAT (vs v2 Blitz)      |
| Survivor-v3    | +21.5 [20.1, 22.9] ✅ BEAT          | **−20.8 [−23.0, −18.6]** ❌ BEHIND      | **−5.9 [−7.5, −4.2]** ❌ BEHIND (vs v2 Survivor) |

All three beat the Lookahead floor. **§10.8 control check:** the vs-base _profile_ showed ConqCtl
+5.5 pp winPct over base, but the paired _head-to-head gate_ is a TIE (+1.1) — a field-composition
artifact, not a real edge → the [D-27] drift lore holds (matched fine-tune ≈ wash on the stronger v3
base), no "halt & investigate." (Judge the control on head-to-head, never in-field winPct.)

### Style — `behavior:profile` 10×30×6, dual-control (§10.5) + §10.4 clock-hack

| Arm          | Signature vs base                              | Signature vs control arm                 | Dual-control | Clock-hack (§10.4) |
| ------------ | ---------------------------------------------- | ---------------------------------------- | ------------ | ------------------ |
| **Blitz-v3** | CONFIRMED (aggr +0.42, turnsToWin −30; Holm ✓) | FAIL (aggr +0.16, turns −3.7; both <MDE) | ⚠️ FLAGGED   | clear ✓            |
| Survivor-v3  | FAIL (avgPlacement −0.33 < 0.40 MDE)           | FAIL (−0.24 < 0.40)                      | ❌ FAIL both | clear ✓            |

- **Blitz-v3's signature is dual-control-FLAGGED.** Vs the base it clears both axes, but the control
  arm _itself_ drifted toward aggression/speed (ConqCtl aggr 1.86 / turns 148 vs base 1.64 / 169), so
  the reward-attributable (γ0.99) residual is sub-MDE — most of Blitz-v3's vs-base distinctiveness is
  generic continuation-training **drift**, not the tempo lever. Per §10.5 that flags the signature.
- **§10.4 clock-hack: ALL CLEAR.** The v3 hazard (a placement arm forcing an early decisive death
  near the now-visible cap to bank rank rather than truncate to 0) did **not** materialize —
  Survivor-v3 truncates _more_ (Δ+0.11) and is _less_ late-aggressive (Δ−0.26): a genuine turtle, not
  a reward-hacker. The drafted 50/0.05/0.3 thresholds never fired (no false-positive on a legit
  placement bot).
- **Separation matrix (`behavior:separation`):** all pairs distinct; Blitz × Survivor separate on all
  three registered axes (aggression, turnsToWin, avgPlacement).

### Roster outcome

- **Conqueror** — v3 base, unchanged.
- **Blitz → SHIP v3** ([PR #120](https://github.com/bigintersmind/dicewarsjs/pull/120)). A strict
  strength upgrade (+11.6 vs v2 Blitz, TIE base, BEAT Lookahead +29.6) and player-visibly distinct
  from Conqueror; the dual-control signature flag is accepted as an attribution caveat, not a product
  blocker (maintainer call — the §10.2 escalation was **not** taken). Shipped from the gated
  `eval-003000024`, repack verified **bit-identical** (103,779 floats, max diff 0).
- **Survivor → KEEP v2.** Survivor-v3 killed on three independent bars (BEHIND v2 −5.9, BEHIND base
  −20.8, signature fails both comparators). Fine-tuning placement from the stronger/more-aggressive v3
  base yielded a **weaker and less-distinctive** Survivor (placement shift −0.33 vs v2's −0.82) — the
  v3 aggression prior fights the placement reward.

**Artifacts:** each arm's `{ppo.pt, eval/, state}` backed up to `mini:~/dicewarsjs/ml/runs/`
(sha256-verified end-to-end, `fc9b8735…`); shodan cleanup done (schtasks `dicewars-ppo-v3-wave` +
supervisor `launch-v3-wave.sh` removed). Run commit `a10f405`; Lookahead pin `596f781`.

## §10.3 scavenge tripwire calibration — innocents clear, thresholds RATIFIED · 2026-07-06

**Setup** (#126 §3, minimally adapted): `behavior:profile` 10 runs × 30 games × 6-seat field,
`--bots Survivor,Lookahead --control Conqueror`. Because Lookahead is profiled, its default-field
seat went to Strategist: `--opponents Default,Adaptive,Example,Expectimax,Strategist
--reference Expectimax`. 5400 matches, 0 quarantined, 10/10 live runs per bot, exit 0. Report:
`ml/runs/behavior-calibration/scavenge-calibration-2026-07-06.profile.json` (local, gitignored;
copy on `mini:~/dicewarsjs/ml/runs/behavior-calibration/`; gitSha `6f91185`, clean).
**Wave-2 Predator grading must profile in this same field to pair** (`assertPairableReports`
hard-checks `opponents`/`opponentSpecs`).

**Innocent panels vs Conqueror (draft thresholds): both clear ✓, no false fire.**

| Axis (direction)                      | Survivor Δ [CI]         | Lookahead Δ [CI]        | Draft | Rule output | **Ratified** |
| ------------------------------------- | ----------------------- | ----------------------- | ----- | ----------- | ------------ |
| `killVictimOneTerrFrac` (↑, primary)  | −0.074 [−0.106, −0.042] | −0.274 [−0.306, −0.243] | 0.15  | 0.306       | **0.31**     |
| `killVictimOneTerrTurns` (↑, primary) | −2.311 [−3.144, −1.478] | −4.888 [−5.632, −4.145] | 2.0   | 5.632       | **5.64**     |
| `killVictimTerr` (↓, co-signal)       | +0.232 [+0.195, +0.268] | +0.825 [+0.744, +0.906] | 0.75  | 0.906       | **0.91**     |

Rule: per axis, max(draft, largest innocent |Δ| + that Δ's CI half-width), rounded up to 2
decimals (Ivan ratified 2026-07-06). Every binding extreme is Lookahead's, in the **opposite**
(innocent) direction — the ratified bars therefore kill only on unambiguous vulture behavior
(base ≈ 0.69 frac / 6.3-turn streaks / 1.9-terr victims ⇒ a fire needs ≈ all-snipe kills,
≈ 11.9-turn-doomed victims, or ≈ 1.0-terr victims). A weak-but-not-hacking Predator is still
screened by the Lookahead floor, the kills bar, and Survivor separation. Innocents re-verified
clear under the ratified table.

**Kills bar recomputed ([D-32]):** 15% × v2 Survivor's realized mean kills in this field
(1.725 ± 0.07) = **+0.26** (vs the void ≈+0.28 and [D-30]'s +0.25 interim). Context means:
Lookahead 1.40 ± 0.09, Conqueror 1.46 ± 0.10.
