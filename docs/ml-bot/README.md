# ML / Self-Play Bot Initiative

> **Status:** Active — Phase 0 not started
> **Last updated:** 2026-06-21
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
2. Is **measurably stronger than `ai_strategist`** (the current strongest bot),
   judged by the evaluation gate below.

## Verdict (from the 2026-06-21 feasibility analysis)

**Large-but-doable — not too big.** The engine is an excellent RL environment:
pure, immutable, seedable, ~150 games/s/core headless, with a free legal-action
mask (`getValidMoves`) and an exact dice-odds table (`WIN_TABLE`). The plumbing is
mostly already in place.

The **hard, uncertain** part is not the plumbing — it's that from-scratch
self-play RL has a real chance of **never beating `ai_strategist`**. The most
relevant prior art (a KTH Risk AlphaZero/ExIt thesis; Moy & Shekh's hex-grid
wargaming) shows naive self-play nets _losing_ to good heuristics until they're
bootstrapped with heuristic/supervised data. `ai_strategist` is a strong,
exact-odds baseline — not a strawman.

**Strategy: search first, learning second.** Bank a likely win with a pure-JS
search bot before spending GPU-weeks on RL, and gate every step on the same
empirical bar.

## The bar — evaluation gate (used at EVERY phase)

A candidate is only "better" if it beats `ai_strategist` on
**`npm run arena:sweep`** (multi-seed, mean win%/ELO with 95% confidence
intervals), controlling for seat/turn-order so we measure skill not first-mover
luck. The edge must be **statistically significant**, not a single-seed fluke.
Every run gets a row in [`RESULTS.md`](./RESULTS.md).

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

| Phase | Title                                 | Status         | Go/No-Go gate                                                    |
| ----: | ------------------------------------- | -------------- | ---------------------------------------------------------------- |
|     0 | Quick-win search bot                  | ⬜ Not started | Does expectimax beat `ai_strategist` on sweep?                   |
|     1 | Harness hardening for self-play       | ⬜ Not started | Reproducible, fast, instrumented self-play loop?                 |
|     2 | Imitation baseline (de-risk learning) | ⬜ Not started | Can a net clone `ai_strategist` to ~parity, in-browser via ONNX? |
|     3 | Self-play RL (PPO)                    | ⬜ Not started | Does PPO beat `ai_strategist` with significance?                 |
|     4 | Ship the strongest bot                | ⬜ Not started | Winner wired as in-browser bot + in tournament pool              |

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
- **Training-mode perf fixes:** disable the O(n²) `history` append
  (`StateManager.js:199,244`); per-move `cloneAreas`/`recalcPlayerStats`
  trimmable later if needed.
- **A turn is a _sequence_ of single attacks** ended by STOP (returning `null`) —
  model an explicit STOP action, not one batched move per turn.
- **Reward:** terminal win/placement; free dense shaping available =
  Δlargest-connected-group income, territory/dice deltas, eliminations (the same
  quantities `ai_strategist` optimizes).
- **Board:** up to 31 real territories (index 0 unused), MAX_DICE 8, default 7
  players, maps vary in size — pad/mask, don't assume a fixed node count.
