# Plan — ML / Self-Play Bot

Detailed, trackable phases. Each phase has an **objective**, the **tasks** to do,
**acceptance criteria** (measurable "done"), and a **go/no-go gate** — the
decision we make before investing in the next phase. The gates are the whole
point: they let us find out _early and cheaply_ whether learning is worth the
GPU-weeks.

See [`README.md`](./README.md) for the high-level strategy and the status
dashboard. Record results in [`RESULTS.md`](./RESULTS.md), session notes in
[`LOG.md`](./LOG.md), and decisions in [`DECISIONS.md`](./DECISIONS.md).

> **Evaluation gate (applies to every phase that produces a bot):** beat
> **`ai_lookahead`** (the field-strongest bot, pinned `596f781` — re-baselined from
> `ai_strategist` per [D-7](./DECISIONS.md)) on `npm run arena:sweep` (multi-seed,
> 95% CIs), seat/turn-order controlled, edge statistically significant. Strategist
> stays as a secondary reference.

---

## Phase 0 — Quick-win search bot · ⬜ Not started · ~2–4 days

**Objective.** A pure-JS chance-node expectimax bot that needs no ML, no Python,
no GPU, and no engine changes — and very plausibly becomes the new strongest bot.

**Why first.** Bank a likely win, and _answer the critical question early_: does
**search alone** beat `ai_strategist`? If it doesn't, plain self-play RL almost
certainly won't either, and we've spent days, not weeks.

**Tasks.**

- [ ] New bot file (e.g. `src/ai/ai_expectimax.js`) using the modern contract.
- [ ] Depth-1: for each move in `getValidMoves`, compute the `WIN_TABLE`-weighted
      expectation of `ai_strategist`'s board evaluation over the two battle
      outcomes (win → captured territory gets `attackerDice-1`, source → 1; loss →
      source → 1). Pick the argmax; return `null` (STOP) when nothing beats
      holding.
- [ ] Reuse `ai_strategist`'s evaluation as the leaf heuristic (extract/share it
      rather than copy-pasting if practical).
- [ ] Register in `src/arena/builtInBots.js`.
- [ ] Extend to depth-2 (expand the best-K moves one ply deeper) and compare.
- [ ] Benchmark with `npm run benchmark-bot`; record timing (must stay playable
      in-browser — see the Lookahead bot's ~243 ms/game as the "too slow" marker).

**Acceptance criteria.**

- Passes `npm run validate-bot` (syntax, compile, runtime) and is deterministic
  given a seed (no `Math.random`).
- Runs a full `arena:sweep` vs `ai_strategist` and the result is recorded in
  `RESULTS.md`.

> **Baseline timing.** PR #35 (`fix/strategist-endgame-turtle`) changed
> `ai_strategist` and **merged to master on 2026-06-21 as `f5fedb2`** — the
> blocker is cleared. Pin that strategist SHA in the `RESULTS.md` row so the
> baseline isn't measured against an in-flight version. See `RESULTS.md` for the
> convention.

**Go/No-Go gate.** _(Outcome recorded 2026-06-21 — see `RESULTS.md` / `LOG.md`.)_

- Default-weight Expectimax **lost** the FFA; weight-tuning (`attackThreshold 0.3`,
  `threat 2.0`) made it **rank 1–2 by ELO** and beat Strategist on ELO/placement
  significantly, but only **tied on win%** — and it **does not beat the real bar,
  `ai_lookahead`** (~25% vs ~15%). Shipped as a net improvement; the headline gate
  (beat Lookahead) is **open**.
- Search viability is **proven** (Lookahead is a search bot and the field leader),
  so this is not a Track-B-kill signal. The win% ceiling is structural ([D-8]): a
  fixed attack threshold can't both stay patient and press to close out.
- **Next:** either add the structural **press-mechanism** (posture-adaptive
  threshold + elimination term) to chase Lookahead with search, or carry this
  finding into Track B's learned policy. Decide before sinking more effort here.

---

## Phase 1 — Harness hardening for self-play · ⬜ Not started · ~3–5 days

**Objective.** Turn the headless arena into a fast, reproducible, _instrumented_
self-play environment. No learning yet.

**Tasks.**

- [ ] Add a self-play/training mode flag that **disables the O(n²) `history`
      append** (`StateManager.js:199,244`) — pure overhead for training.
- [ ] Force explicit seeds end-to-end; add a determinism regression test
      (same seed → identical winner/turns/placements).
- [ ] (Optional, only if profiling says so) trim per-move allocation in
      `cloneAreas`/`clonePlayers`/`recalcPlayerStats`.
- [ ] Add a thin **trajectory export**: one game emits
      `(BotState, legal-mask, chosen-move, outcome)` tuples, plus terminal
      win/placement. This is the training-data and replay substrate.
- [ ] Confirm parallel self-play across Node workers/processes (the engine is
      pure — near-linear scaling already measured).

**Acceptance criteria.**

- Determinism test green.
- Measured self-play throughput recorded in `RESULTS.md` (games/s with the
  history fix vs without).
- A sample exported trajectory file exists and round-trips (can replay a game
  from its recorded actions).

**Go/No-Go gate.** Reproducible + instrumented + fast enough (target: ≥100 g/s/core
heuristic self-play) → proceed to Phase 2.

---

## Phase 2 — Imitation baseline (de-risk learning before RL) · ⬜ Not started · ~1–2 weeks

**Objective.** Prove the **entire** JS → train → ONNX → in-browser pipeline on an
_easy_ objective: clone `ai_strategist` with a small neural net. This de-risks
everything technical before we gamble on RL.

**Tasks.**

- [ ] Generate ~100k–1M self-play games of the **strongest heuristic to imitate —
      `ai_lookahead`** (per [D-7]; cloning the field leader both de-risks the
      pipeline and yields a stronger starting policy than cloning Strategist would);
      export trajectories (minutes-to-hours on 8 cores).
- [ ] Decide the encoding (see `DECISIONS.md` D-Encoding): graph over ≤31
      territory nodes (features: owner, dice, is-mine, is-border, per-edge
      win-prob from `WIN_TABLE`); policy head over legal `(from,to)` edges + an
      explicit STOP; masked by `getValidMoves`.
- [ ] Train a small masked policy/value net (GNN or per-edge MLP) by behavioral
      cloning to predict `ai_lookahead`'s move.
- [ ] Export to ONNX; load in-browser via ONNX Runtime Web; wrap as a normal bot.
- [ ] Evaluate the in-browser net on `arena:sweep` vs `ai_strategist`.

**Acceptance criteria.**

- The cloned net **matches `ai_lookahead`'s strength** (within CI) on
  `arena:sweep` — it's imitating it, so parity is the bar.
- The same ONNX model runs in Node and in-browser with identical action choices
  on fixed seeds (cross-bridge action-encoding test passes).

**Go/No-Go gate.**

- **Reaches ~parity** → the pipeline works; proceed to Phase 3 (RL).
- **Can't reach parity** → the encoding (not RL) is the problem. Fix encoding
  before any RL. Do **not** proceed until a net can at least clone the heuristic.

---

## Phase 3 — Self-play RL (PPO) · ⬜ Not started · ~3–6 weeks (real plateau risk)

**Objective.** Train a self-play policy that is _genuinely stronger_ than
`ai_strategist` — the ambitious, uncertain part.

**Tasks.**

- [ ] Stand up a **PettingZoo AEC** env (turn-based, per-agent obs + action mask)
      wrapping the headless arena via subprocess/socket. Keep the JS engine as the
      source of truth (no Python re-port).
- [ ] Train **MaskablePPO** (SB3 + sb3-contrib) with parameter sharing across
      seats.
- [ ] Use an **opponent league**: snapshots of past policies + `ai_strategist` as
      a fixed baseline (naive simultaneous self-play collapses/cycles).
- [ ] Add reward shaping (Δlargest-group income, territory/dice deltas,
      eliminations) and/or value bootstrapping for the sparse, long-horizon
      terminal reward.
- [ ] Curriculum: start at **3–4 players**, move to **8-player FFA last** (8-FFA
      self-play at scale is a research frontier).
- [ ] Warm-start from the Phase-2 imitation weights (prior art: from-scratch
      stalls; bootstrapped wins).

**Acceptance criteria.**

- Training is reproducible (seeded) and logged.
- Gated on `arena:sweep` ELO vs `ai_strategist` with CIs at each checkpoint.

**Go/No-Go gate (and kill criterion).**

- **Statistically significant win-rate edge over `ai_lookahead`** (the bar, per
  [D-7]) → proceed to Phase 4 with the RL bot as the candidate.
- **No significant edge after a few training iterations** → treat as a **plateau
  signal** (exactly what the Risk thesis hit). Don't pour unbounded compute in.
  Record in `DECISIONS.md`; fall back to shipping the best of Track A / Phase 2.

---

## Phase 4 — Ship the strongest bot · ⬜ Not started · ~2–4 days on top of the winner

**Objective.** Wire whichever candidate won `arena:sweep` most decisively (Track A
search bot, the imitation net, or the RL net) as a real shipped bot.

**Tasks.**

- [ ] Finalize as a built-in or community bot running **purely in-browser** (ONNX
      Runtime Web for a learned net; nothing extra for the JS search bot).
- [ ] Add to the tournament pool (`npm run tournament`).
- [ ] Document the bot in `docs/BOT_GUIDE.md` and update `README.md`.
- [ ] Final `arena:sweep` + tournament numbers recorded in `RESULTS.md`.

**Acceptance criteria.** The bot is selectable in-game, runs in-browser, and its
strength vs the field is recorded.

**Done = the dashboard in `README.md` shows the winner shipped.**

---

## Effort summary

| Track / milestone                              | Effort             | Compute               |
| ---------------------------------------------- | ------------------ | --------------------- |
| Track A search bot (Phase 0)                   | 2–4 days           | none, no GPU          |
| End-to-end pipeline via imitation (Phases 1–2) | ~1.5–3 weeks       | CPU only              |
| Self-play PPO that _plausibly_ wins (Phase 3)  | 1–2 months focused | single-GPU days–weeks |

**Likely win in days (search); uncertain win in weeks-to-months (learned RL).**
