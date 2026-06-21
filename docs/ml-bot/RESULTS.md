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
candidate's win% (with CI), ELO, whether it **beats `ai_strategist` significantly**
(✅/❌/~tie), the **`ai_strategist` commit SHA** it was measured against, and a
notes/commit ref. Control seat/turn-order across seeds.

> **`ai_strategist` is a moving target — pin it.** It is the baseline _and_ an
> evolving bot (e.g. PR #35 changes its endgame behavior). Every row MUST record
> the strategist commit SHA in the "Strategist @" column, so results measured
> against different strategist versions are never compared apples-to-oranges. When
> strategist changes, re-baseline before trusting a new candidate's edge.

> **First baseline waits on PR #35.** The endgame-turtle fix (`fix/strategist-
endgame-turtle`, PR #35) changes `ai_strategist`. Run the Phase 0 baseline sweep
> **only after #35 has merged to master**, so the baseline is the canonical
> strategist, not an in-flight version.

> **Baseline to beat:** `ai_strategist` (post-#35). Fill its head-to-head numbers
> on the first sweep so every later candidate has a reference.

---

## Headline: best bot vs `ai_strategist` over time

| Date         | Candidate    | Phase | Field | Seeds/Games | Win% (95% CI) | ELO | Beats strategist? | Strategist @ | Notes / commit                                            |
| ------------ | ------------ | ----: | ----- | ----------- | ------------- | --- | ----------------- | ------------ | --------------------------------------------------------- |
| _2026-06-21_ | _(none yet)_ |     — | —     | —           | —             | —   | —                 | _(pin SHA)_  | Plan created; no runs yet — baseline pending PR #35 merge |

---

## Throughput / training-cost measurements

Self-play and training throughput, so we can size compute. (Phase 1 fills the
training-mode numbers.)

| Date       | What                          | Config          | Throughput                               | Notes                                |
| ---------- | ----------------------------- | --------------- | ---------------------------------------- | ------------------------------------ |
| 2026-06-21 | Pure engine, random policy    | 7p, single core | ~150 games/s (~6.6 ms/game, ~12 µs/step) | From feasibility probe               |
| 2026-06-21 | Engine + Strategist heuristic | 7p, single core | ~77 games/s                              | From feasibility probe               |
| 2026-06-21 | Engine, parallel              | 7p, 4 procs     | ~266 games/s aggregate (~3.4×)           | Near-linear scaling                  |
| 2026-06-21 | Engine + Lookahead bot        | 7p, single core | ~4 games/s (~243 ms/game)                | Search-heavy bot = "too slow" marker |

---

## Run detail (optional longer notes)

Use this section for anything that doesn't fit a table cell — config files, seed
lists, anomalies, links to replay files.

_(none yet)_
