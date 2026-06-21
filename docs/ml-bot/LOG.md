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
