# ML / Self-Play Bot Initiative

> **Status:** Active — `ai_expectimax` is at **parity with `ai_lookahead`** (D-9: win% dead-heat, significantly out-places it, ELO co-leader, 1v1 tie). The eval-rework spike (Phase 0.5) was **killed at 2/4 swings** — no structural eval term beat the baseline ([D-11]) — confirming Track-A search is tapped out at parity. The Phase 0 headline gate (a _significant win% edge_ over Lookahead) stays **open**. Track B (learned policy) — Phase 1 (self-play harness hardening) is ✅ DONE ([D-12]). **Now: Phase 2 — imitation baseline (clone `ai_lookahead` to a small in-browser ONNX net) is 🟨 IN PROGRESS. Kicked off 2026-06-23: D-Encoding finalized (Proposed → Accepted, code-grounded + information-completeness verified against the teacher), a tracer teacher shard generated (2000 clean games, round-trips, teacher labels + win-prob edge feature validated), and duplicate-seat support added to `selfplay.mjs`. Corpus field validated ([D-15]): the full 7-bot arena field (imitate Lookahead's seat) — 85% decisive, 55%-attack balanced labels; a pure `N×Lookahead` mirror was a turtle equilibrium. Tensor-expansion pass landed: `src/arena/encodeObservation.js` (pure D-Encoding encoder) + `npm run encode-corpus` (lean corpus → NumPy-loadable packed tensors; CSR edges). Mask-matches-`getValidMoves` and binary round-trip both regression-tested (885 green). BC trainer now scaffolded in-repo at `ml/` ([D-16]): a runnable PyTorch package (masked per-edge MLP + aux value head, segmented CE, game-level split) reading the packed tensors → ONNX (logits-only single-step graph, ORT parity ≈5e-7). Verified on the 300-game sample (val move-match 33%→47% in 8 untuned CPU epochs; 27-test pytest suite). Next: the parity run on the GPU box (100k–1M-game corpus + tuning) and the in-browser ONNX-Runtime-Web bot slice.**
>
> **Last updated:** 2026-06-23
>
> **Owners:** Ivan (+ Claude)

A tracked, multi-session effort to produce a DiceWars bot whose play is shaped by
machine learning / self-play. This folder is the persistent home for the plan,
decisions, running log, and empirical results so progress survives across days
and Claude Code sessions.

---

## Goal

Produce a DiceWars bot that:

1. Runs **in-browser as just another bot** — same contract as every other bot:
   `(BotState) → { from, to } | null`.
2. Is **measurably stronger than `ai_lookahead`** (the current strongest bot —
   re-baselined from `ai_strategist` per [D-7](./DECISIONS.md); Strategist had been
   assumed strongest but Lookahead beats it decisively), judged by the gate below.

## Verdict (from the 2026-06-21 feasibility analysis)

**Large-but-doable — not too big.** The engine is an excellent RL environment:
pure, immutable, seedable, ~150 games/s/core headless, with a free legal-action
mask (`getValidMoves`) and an exact dice-odds table (`WIN_TABLE`). The plumbing is
mostly already in place.

The **hard, uncertain** part is not the plumbing — it's that from-scratch
self-play RL has a real chance of **never beating the strong heuristic bar** (the
2026-06-21 analysis said `ai_strategist`; it is now `ai_lookahead`, which is even
stronger — see [D-7](./DECISIONS.md)). The most
relevant prior art (a KTH Risk AlphaZero/ExIt thesis; Moy & Shekh's hex-grid
wargaming) shows naive self-play nets _losing_ to good heuristics until they're
bootstrapped with heuristic/supervised data. `ai_strategist` is a strong,
exact-odds baseline — not a strawman.

**Strategy: search first, learning second.** Bank a likely win with a pure-JS
search bot before spending GPU-weeks on RL, and gate every step on the same
empirical bar.

## The bar — evaluation gate (used at EVERY phase)

A candidate is only "better" if it beats **`ai_lookahead`** — the current
field-strongest bot, pinned at `596f781` (re-baselined from `ai_strategist` per
[D-7](./DECISIONS.md)) — on **`npm run arena:sweep`** (multi-seed, mean win%/ELO
with 95% confidence intervals), controlling for seat/turn-order so we measure skill
not first-mover luck. The edge must be **statistically significant**, not a
single-seed fluke. `ai_strategist` is kept as a secondary reference. Every run gets
a row in [`RESULTS.md`](./RESULTS.md).

---

## Two-track strategy

- **Track A — pure-JS search (no ML).** Chance-node expectimax reusing
  `ai_strategist`'s evaluation as the leaf heuristic and `WIN_TABLE` for exact
  chance-node expectation. Days of work, likely beats the baseline, and validates
  the arena as the evaluation gate. (Phases 0–1 also serve Track B.)
- **Track B — learned bot.** Keep the JS engine as the single source of truth;
  bridge to Python for **training only** (PettingZoo + MaskablePPO self-play),
  export the small policy net to ONNX, and run it in-browser via ONNX Runtime
  Web. (Phases 2–4.)

---

## Status dashboard

| Phase | Title                                 | Status                      | Go/No-Go gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----: | ------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     0 | Quick-win search bot                  | 🟨 Shipped; gate open (tie) | **Press-mechanism landed (D-9):** posture-adaptive threshold + elimination term + low-odds risk floor. `ai_expectimax` now **ties `ai_lookahead`** (16,800 seat-fair games: win% 22–23% vs 22.5–23.9%; **significantly out-places it**, paired 51.2%, p≈0.002; ELO co-leader; 1v1 tie). Beats Strategist (13–14%). Rank 6/7 → **joint-strongest**. Headline gate (sig. **win%** edge over Lookahead) still **open** — it's a tie. Eval rework (Phase 0.5) tried & killed ([D-11]). **Next: Track B.**                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|   0.5 | Eval-rework spike (Track A)           | ❌ Killed 2/4 swings        | **No structural eval term beat the D-9 baseline** ([D-11]): `mergePotential` / `fieldRivalIncome` / `trappedDice` all neutral-at-best, harmful when grown, across 2 seeds × 2 power levels. Same parity ceiling as D-8/D-9 → Track-A search tapped out; pivot to Track B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|     1 | Harness hardening for self-play       | ✅ Done (2026-06-23)        | **Gate met.** Reproducible + instrumented + parallel committed harness (`scripts/selfplay.mjs`), and the per-move alloc trims landed — **≈1.9× pure-engine throughput** (drop the redundant per-end-turn `areas` double-clone + gate `findLargestConnectedGroup` to the 0–2 players an action changes), byte-identical games, near-linear scaling (1→4 workers 3.04×). Numbers in `RESULTS.md` ([D-12]). **Next: Phase 2.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|     2 | Imitation baseline (de-risk learning) | 🟨 In progress              | Can a net clone the strongest heuristic (`ai_lookahead`) to ~parity, in-browser via ONNX? **2026-06-23:** D-Encoding finalized (Accepted); tracer shard (2000 clean games, round-trips); duplicate-seat support added to `selfplay.mjs`. **Corpus field validated ([D-15], RESULTS):** the **full 7-bot arena field** (imitate Lookahead's seat) — 85% decisive, 55%-attack balanced labels, ~81 teacher steps/game; a pure mirror was a turtle equilibrium. **Tensor-expansion pass landed:** `encodeObservation.js` + `npm run encode-corpus` (lean → packed NumPy tensors, CSR edges); mask-match + binary round-trip tested. **BC trainer scaffolded ([D-16]):** in-repo `ml/` PyTorch package (masked per-edge MLP, segmented CE, game-level split) → ONNX (logits-only, ORT parity ≈5e-7); verified on the 300-game sample (val move-match 33%→47%, 8 epochs; 27-test suite). Next: GPU-box parity run (100k–1M games + tuning) + in-browser ONNX-RT-Web bot. |
|     3 | Self-play RL (PPO)                    | ⬜ Not started              | Does PPO beat `ai_lookahead` (the bar, per D-7) with significance?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|     4 | Ship the strongest bot                | ⬜ Not started              | Winner wired as in-browser bot + in tournament pool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Legend:** ⬜ Not started · 🟨 In progress · ✅ Done · ⛔ Blocked · ❌ Killed (gate failed)

> Update this table whenever a phase changes state. Full phase detail —
> tasks, acceptance criteria, kill-gates — lives in [`PLAN.md`](./PLAN.md).

---

## How to use this folder (future sessions — read this first)

- **[`PLAN.md`](./PLAN.md)** — the phases in detail: tasks (checkboxes),
  acceptance criteria, and the go/no-go gate per phase. The source of truth for
  "what's next."
- **[`LOG.md`](./LOG.md)** — append-only session journal. **At the end of each
  working session, add an entry** (what changed, what we learned, dead ends).
  This is how context survives across days and sessions.
- **[`RESULTS.md`](./RESULTS.md)** — the empirical scoreboard. Every
  `arena:sweep` run gets a row. This is how we decide "better."
- **[`DECISIONS.md`](./DECISIONS.md)** — why we chose what we chose (PPO over
  AlphaZero, JS-engine-as-source-of-truth, etc.). Add an entry at each real
  fork-in-the-road.

---

## Key grounded facts (so future sessions don't re-derive them)

Verified against the code during the 2026-06-21 analysis:

- **Bot contract:** `(BotState) → { from, to } | null`; `null` ends the turn.
  Deploy via `adaptModernBot` + an entry in `src/arena/builtInBots.js` (or a
  community-bot registry entry).
- **Legal-action mask:** `getValidMoves(state)` — `src/engine/StateManager.js:254`.
  Enumerates exactly the legal `(from, to)` attacks each step. Use it to mask.
- **Exact dice odds:** `WIN_TABLE[a][d] = P(a dice beat d dice)` —
  `src/ai/diceOdds.js`. Don't make the model learn dice math; feed win-prob as a
  feature.
- **Determinism:** Mulberry32 RNG state lives inside `GameState`, threaded
  through every `applyAction`; same seed → identical game. Pass an explicit
  `config.seed`, and the policy must avoid `Math.random`. (Note: `ai_default`,
  `ai_example`, `ai_adaptive` call `Math.random` and are non-reproducible
  opponents.)
- **Measured throughput:** ~150 games/s/core pure engine (~6.6 ms/game, ~12
  µs/`applyAction`), ~77 g/s with the Strategist heuristic, near-linear across
  cores (the Strategist run hit ~266 g/s on 4 procs ≈ 3.4× its 77 g/s single
  core). 1M engine-bound games ≈ 14–28 min on 8 cores. **Inference, not the
  engine, will be the bottleneck.**
- **Training-mode perf (landed in Phase 1):** the O(n²) `history` append is skipped
  under `config.recordHistory:false` (the `appendHistory` guard in `StateManager.js`) —
  though [D-12] found that append was never the real throughput bottleneck. The actual
  lever, the per-move `cloneAreas`/`recalcPlayerStats` cost, was trimmed in Phase-1 task 3
  (≈1.9× engine-only; see `RESULTS.md`).
- **A turn is a _sequence_ of single attacks** ended by STOP (returning `null`) —
  model an explicit STOP action, not one batched move per turn.
- **Reward:** terminal win/placement; free dense shaping available =
  Δlargest-connected-group income, territory/dice deltas, eliminations (the same
  quantities `ai_strategist` optimizes).
- **Board:** up to 31 real territories (index 0 unused), MAX_DICE 8, default 7
  players, maps vary in size — pad/mask, don't assume a fixed node count.
