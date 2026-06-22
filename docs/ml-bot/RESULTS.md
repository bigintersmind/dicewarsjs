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

| Date       | What                          | Config          | Throughput                                            | Notes                                                                                                                                                                                                         |
| ---------- | ----------------------------- | --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-21 | Pure engine, random policy    | 7p, single core | ~150 games/s (~6.6 ms/game, ~12 µs/step)              | From feasibility probe                                                                                                                                                                                        |
| 2026-06-21 | Engine + Strategist heuristic | 7p, single core | ~77 games/s                                           | From feasibility probe                                                                                                                                                                                        |
| 2026-06-21 | Engine + Strategist, parallel | 7p, 4 procs     | ~266 games/s aggregate (~3.4× the 77 g/s single core) | Near-linear scaling                                                                                                                                                                                           |
| 2026-06-21 | Engine + Lookahead bot        | 7p, single core | ~4 games/s (~243 ms/game)                             | Search-heavy bot = "too slow" marker                                                                                                                                                                          |
| 2026-06-21 | Phase 0 baseline sweep        | 7-bot FFA field | ~21 games/s single core (6000 games in 283 s)         | Full field incl. 2 search bots (Lookahead + depth-2 Expectimax). Expectimax depth-2 is comfortably in-browser-playable — far from the Lookahead "too slow" marker, which was a solo-bot-per-seat measurement. |

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
