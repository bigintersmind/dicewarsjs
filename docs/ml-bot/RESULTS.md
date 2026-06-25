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

| Date       | What                                                  | Config                                                                                     | Throughput                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-21 | Pure engine, random policy                            | 7p, single core                                                                            | ~150 games/s (~6.6 ms/game, ~12 µs/step)                      | From feasibility probe                                                                                                                                                                                                                                                                                                                                                     |
| 2026-06-21 | Engine + Strategist heuristic                         | 7p, single core                                                                            | ~77 games/s                                                   | From feasibility probe                                                                                                                                                                                                                                                                                                                                                     |
| 2026-06-21 | Engine + Strategist, parallel                         | 7p, 4 procs                                                                                | ~266 games/s aggregate (~3.4× the 77 g/s single core)         | Near-linear scaling                                                                                                                                                                                                                                                                                                                                                        |
| 2026-06-21 | Engine + Lookahead bot                                | 7p, single core                                                                            | ~4 games/s (~243 ms/game)                                     | Search-heavy bot = "too slow" marker                                                                                                                                                                                                                                                                                                                                       |
| 2026-06-21 | Phase 0 baseline sweep                                | 7-bot FFA field                                                                            | ~21 games/s single core (6000 games in 283 s)                 | Full field incl. 2 search bots (Lookahead + depth-2 Expectimax). Expectimax depth-2 is comfortably in-browser-playable — far from the Lookahead "too slow" marker, which was a solo-bot-per-seat measurement.                                                                                                                                                              |
| 2026-06-23 | **Engine-only, per-move trims (Phase 1 task 3)**      | 7p, single core, `recordHistory:false`, trivial seeded policy                              | **~215 → ~414 games/s (≈1.9×)**; ~82k → ~160k `applyAction`/s | Isolated pure-engine speed (no heuristic bot — i.e. the learner's engine→tensor data path). **Identical games before/after** (230,918 actions over 600 games, byte-for-byte). Trims: drop the redundant per-`END_TURN` `cloneAreas` (`distributeReinforcements` already clones) + gate `findLargestConnectedGroup` to the 0–2 players an action can change (was 7/action). |
| 2026-06-23 | **Self-play harness, committed (`npm run selfplay`)** | Strategist/Expectimax/Lookahead/Defensive, 1500 games (seeds 1..1500), 8-core box          | BEFORE→AFTER g/s: 1w 20.7→21.4 · 2w 38.5→40.3 · 4w 61.7→65.0  | This field is **bot-search-dominated**, so the engine trim surfaces as only +3–5% here (the engine itself is ≈1.9×, row above). 100% clean; action-count p50 252 / mean 309 **identical** before/after. **Near-linear scaling preserved:** 1→4 workers 2.98× (before) / 3.04× (after); 4 workers = the 50%-of-cores policy (CLAUDE.md).                                    |
| 2026-06-24 | **BC STOP-de-bias retrain (full 100k corpus)**        | EdgePolicyNet (102k params), CPU, `--num-workers 4 --batch-size 512`, Mac mini (M4, 16 GB) | **~27 min/epoch** (1582–1667 s/epoch)                         | **Memory-bound, not compute-bound:** random-access memmap over the 8.3 GB corpus on a 16 GB box (swap ~6 GB, load ~3, stable across an 8-epoch unattended run). `shodan` (128 GB + GPU + 12 workers) does ~67 s/epoch (~30×) but was offline. `--num-workers > 4` swap-locks the mini — keep it at 4. Faster than the earlier ~34 min/epoch estimate.                      |

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
