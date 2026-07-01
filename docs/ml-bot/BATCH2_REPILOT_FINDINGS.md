# Batch-2 Dense-Persona Re-Pilot — Findings

**Date:** 2026-07-01 · **Author:** Claude Opus 4.8 (self-play persona track) · **Status:** complete — **resolved by [D-30]** (Batch-2B wave; §5's fix list is partly superseded — see the §7 Addendum)

> **TL;DR — the coef sweep overshot.** Neither the Expansionist nor the Predator dense-reward
> coef produced a shippable style+strength combination, but the run is decisive about _why_, and
> the fix is a **reward-design change**, not another coef guess.
>
> - **Expansionist is a cliff, not a dial.** `territory-reward-coef` 0.08 keeps full strength
>   (BEAT Lookahead Δ+13.1) but barely moves the territory axis; 0.15 finally clears the axis
>   (avgTerritory Δ+3.23) **but only by turtling** — it stops attacking, hoards dice, drags games
>   out +52 turns, and win% collapses to 15.9%. The dense territory reward's optimum is
>   "hold territory by stalling."
> - **Predator's bounty backfires.** Raising `elim-bounty` **monotonically reduced kills**
>   (1.61 → 1.47 → 1.38) and strength. The bounty makes it over-commit, thin out, and die ~80
>   turns early — so it never survives long enough to eliminate players. Higher = strictly worse.

---

## 1. Background

The reward-**persona** track trains PPO nets with different reward objectives to produce distinct
_play-styles_, all warm-started from `ppo-long` (the shipped `ai_ppo`/Conqueror weights) and
measured by the behavioral-eval harness. Batch 1 (Conqueror / Blitz / Survivor — flag-only reward
knobs) shipped. **Batch 2** is the two _dense-reward_ personas that ride the opt-in shaped
obs-frame HEADER ("bite G" wire, [D-28]):

| Persona          | Reward knob                                                 | Intended signature                     | MDE (placeholder) |
| ---------------- | ----------------------------------------------------------- | -------------------------------------- | ----------------- |
| **Expansionist** | `--territory-reward-coef` (dense net-territory-gain reward) | `avgTerritory` **higher** than control | 3.0               |
| **Predator**     | `--elim-bounty` (per-player-elimination bounty)             | `kills`/game **higher** than control   | 0.5               |

Reward-only signals ride the frame HEADER and deliberately do **not** bump `ENCODING_VERSION` (the
net never sees them; they only shape the reward).

### Pilot-1 recap (the reason for this re-pilot)

The first calibration pilots at the **default** coefs (Expansionist 0.02 / Predator 0.1) held
strength but the target signatures were far below MDE:

| Pilot-1      | coef | gate Δ vs Lookahead     | target-axis Δ vs control                | verdict  |
| ------------ | ---- | ----------------------- | --------------------------------------- | -------- |
| Expansionist | 0.02 | +16.2 [13.4, 19.0] BEAT | avgTerritory +0.32 [-0.49, 1.13] **ns** | too weak |
| Predator     | 0.1  | +18.1 [14.5, 21.6] BEAT | kills +0.06 [-0.17, 0.29] **ns**        | too weak |

Directional shifts appeared (both more aggressive, thinner dice-per-territory), so the wire worked
— the dense reward was just swamped by the terminal win signal. The pilot-1 recommendation was to
**push the coefs ~4–7×** and watch for over-commitment. This document reports that sweep.

---

## 2. Experiment design

Four 1M-step runs, one per (persona × coef), warm-started from `ppo-long/ppo.pt`:

| Run name               | Persona      | Coef                           | Wave |
| ---------------------- | ------------ | ------------------------------ | ---- |
| `ppo-expansionist-c08` | Expansionist | `--territory-reward-coef 0.08` | A    |
| `ppo-predator-b04`     | Predator     | `--elim-bounty 0.4`            | A    |
| `ppo-expansionist-c15` | Expansionist | `--territory-reward-coef 0.15` | B    |
| `ppo-predator-b07`     | Predator     | `--elim-bounty 0.7`            | B    |

**Shared hyperparameters (held constant, = pilot-1):** `--reward-mode win`, `--gamma 0.999`,
`--lr 1e-4`, `--ent-coef 0.01`, `--n-envs 4`, `--reward-shaping` (auto-engaged because coef > 0),
warm-start actor from `ppo-long`. Only the dense coef varied — reward XOR opponent-field, never
both (PERSONAS §3).

**Infra / hygiene.** Runs executed on the GPU box `shodan` in an **isolated git worktree**
(`~/dicewarsjs-personas` @ `1c40853`) so they never touched the concurrent 20M `ppo-scratch-long`
run (pinned to an older commit `c0d1441` that lacks the dense wire). Launched via a
disconnect-surviving `schtasks` supervisor, **staggered 2+2** so concurrent training never exceeded
3 processes (scratch@12-env + 2 pilots@4-env = 20 env-servers, the proven pilot-1 footprint) — the
20M scratch run kept full throughput and was verified undisturbed at every checkpoint. Wave A ran
07:15→11:26 CDT, Wave B 11:26→15:35 CDT; all four exited cleanly (exit 0).

**Evaluation.**

- **Style — `behavior:profile`** 6 runs × 30 games × 6 rotations = **1080 matches/bot**
  (5400 total). Field of 6 seats = [profiled] + Default, Adaptive, Example, Expectimax, Lookahead.
  **Control = Conqueror** (= `ppo-long`, the net all four fine-tune from), so deltas isolate the
  reward-shaping effect. Weight parity vs the Python net: 2.6e-5 – 3.7e-5.
- **Strength — `ppo:gate`** 8 runs × 80 games vs the **Lookahead** bar in the 9-bot gate field,
  judged on seat-fair paired **win%** (never ELO). Run on the two strength-anchor candidates
  (Exp-c08, Pred-b04); the collapsed/regressed runs (c15, b07) were not gated — the field win% in
  the profile is already decisive for them.

---

## 3. Results

### 3.1 Headline — behavior profile (vs Conqueror control, 1080 matches/bot)

Absolute metrics (± = 95% CI). `avgTerritory` is not a printed column; its Δ-vs-control is in §3.2.

| Bot                     | coef | winPct           | aggression | avgDiceReserve | kills    | turnsToWin | avgPlacement |
| ----------------------- | ---- | ---------------- | ---------- | -------------- | -------- | ---------- | ------------ |
| **Conqueror** (control) | —    | 53.24 ± 2.29     | 1.60       | 71.42          | 1.61     | 134.24     | 2.04         |
| Expansionist-c08        | 0.08 | **51.39 ± 3.47** | 1.99       | 67.06          | 1.61     | 138.23     | 2.34         |
| Expansionist-c15        | 0.15 | **15.93 ± 1.76** | 1.28       | 98.34          | 1.16     | 186.49     | 2.44         |
| Predator-b04            | 0.4  | 45.19 ± 3.79     | 2.32       | 59.26          | **1.47** | 121.72     | 2.50         |
| Predator-b07            | 0.7  | 42.96 ± 3.29     | 2.41       | 57.56          | **1.38** | 127.35     | 2.84         |

### 3.2 Target-axis movement (Δ vs Conqueror control)

| Bot              | coef | target axis  | Δ vs control                        | MDE | cleared?          |
| ---------------- | ---- | ------------ | ----------------------------------- | --- | ----------------- |
| Expansionist-c08 | 0.08 | avgTerritory | not significant (< print threshold) | 3.0 | ❌                |
| Expansionist-c15 | 0.15 | avgTerritory | **+3.23**                           | 3.0 | ✅ (but see §4.1) |
| Predator-b04     | 0.4  | kills        | **−0.41** (wrong direction)         | 0.5 | ❌                |
| Predator-b07     | 0.7  | kills        | **−0.73** (wrong direction)         | 0.5 | ❌                |

### 3.3 Strength — ppo:gate 8×80 vs Lookahead

| Candidate | coef | cand win%           | Lookahead win% | paired Δ (cand − bar)       | verdict | pilot-1 Δ |
| --------- | ---- | ------------------- | -------------- | --------------------------- | ------- | --------- |
| Exp-c08   | 0.08 | 22.7 ± 4.8          | 9.6 ± 2.0      | **+13.1 ± 5.7 [7.4, 18.8]** | ✅ BEAT | +16.2     |
| Pred-b04  | 0.4  | 21.9 ± 3.1          | 10.2 ± 2.7     | **+11.7 ± 5.0 [6.7, 16.7]** | ✅ BEAT | +18.1     |
| Exp-c15   | 0.15 | — (field win% 15.9) | —              | not gated (collapsed)       | ✗       | —         |
| Pred-b07  | 0.7  | — (field win% 43.0) | —              | not gated (regressed)       | ✗       | —         |

Both gated candidates still BEAT Lookahead, but **below their pilot-1 counterparts** — Pred-b04 is
~6pp weaker than Predator@0.1, corroborating that the bounty erodes strength.

---

## 4. Analysis

### 4.1 Expansionist — a cliff between "too weak" and "degenerate turtle"

The territory axis responds to the coef **non-linearly**, with a phase transition somewhere between
0.08 and 0.15:

- **0.02 (pilot-1):** avgTerritory Δ +0.32 (ns) — reward ignored.
- **0.08 (c08):** avgTerritory still ns; strength fully intact (winPct 51.4 ≈ control 53.2, gate
  BEAT +13.1). Mild directional shifts (aggression +0.38, thinner dice-per-territory) but no
  meaningful territory gain.
- **0.15 (c15):** avgTerritory Δ **+3.23** — clears MDE — **but via the degenerate optimum of a
  dense territory-_held_ reward.** Every symptom points to _stalling_, not conquering:

  | signal         | c15 vs control      | reading                              |
  | -------------- | ------------------- | ------------------------------------ |
  | aggression     | 1.99 → **1.28** (↓) | attacks _less_                       |
  | avgDiceReserve | +26.93              | hoards dice instead of spending them |
  | turnsToWin     | +52.25              | games drag on far longer             |
  | survivalTurn   | +71.23              | stays alive by not committing        |
  | winPct         | **15.9%**           | loses almost everything              |

  It maximizes "territory held × time-alive" by refusing to finish games. This is the classic
  reward-hacking failure of a dense _stock_ reward (reward the level of a quantity → the agent
  learns to _preserve_ it, not to win).

**Implication:** a plain coef in the 0.10–0.12 gap is not safe — it risks landing in the same
turtle basin, just with a softer collapse. The reward needs a structural guard against stalling.

### 4.2 Predator — the elimination bounty backfires

This is the clean negative result. Raising the bounty made kills **worse, monotonically**:

| bounty        | kills/game | vs control (1.61) | field winPct | gate Δ      |
| ------------- | ---------- | ----------------- | ------------ | ----------- |
| 0.1 (pilot-1) | ~1.67      | +0.06 (ns)        | ~52          | +18.1       |
| 0.4 (b04)     | 1.47       | **−0.41**         | 45.2         | +11.7       |
| 0.7 (b07)     | 1.38       | **−0.73**         | 43.0         | (regressed) |

The mechanism is over-commitment suicide. The bounty _does_ make the bot more aggressive
(aggression +0.71 / +0.80 vs control), but that aggression is undisciplined: it spreads thin,
loses defensive depth, and **dies ~80 turns earlier** (survivalTurn −76 / −81). A bot that dies
early gets _fewer_ chances to actually eliminate opponents, so the per-kill bounty perversely
lowers total kills. Chasing the bounty trades away the survival that eliminations require.

**Implication:** "more bounty → more predatory" is false for this warm-start. The direction to
explore is _lower_ bounty plus a term that preserves survival/patience — or a differently-shaped
signal.

---

## 5. Recommendations

**No coef in this sweep is shippable.** Both fixes are **reward-design changes** (edits to the
shaping wire), not launcher-flag sweeps.

### Expansionist

1. **Re-pilot the narrow band 0.10–0.12**, but only **with an anti-stall guard**, e.g.:
   - a small per-turn or per-idle-turn penalty (discourage hoarding / passing), and/or
   - reward territory _gained this turn_ (a flow/delta reward) rather than territory _held_ (a
     stock reward), which removes the incentive to stall, and/or
   - lower γ so an indefinitely-prolonged game can't accumulate reward.
2. If, after guarding, the only way to raise territory is still a slower/weaker bot, decide whether
   a genuinely slower "map-painter" persona (accepting a strength hit) is the desired product —
   that's a design call, not a bug.

### Predator

1. **Abandon the raise-bounty direction.** Go back to ≤ 0.1 (pilot-1's level, already ns) **paired
   with a survival/patience term** so the bot can't cash the bounty by suiciding.
2. Alternatively **redesign the signal**: reward net eliminations _conditioned on not losing
   territory_ (bounty only counts if the bot's own footprint is preserved), so predation can't come
   at the cost of the survival that predation depends on.

### Process note

Both candidates that held strength (Exp-c08, Pred-b04) still BEAT Lookahead, so **strength headroom
is not the constraint** — the constraint is getting the _style_ axis to move without the reward
collapsing into a degenerate optimum. The next iteration should validate the reward change on a
short (≤1M) pilot with the anti-stall / survival guard **before** committing a full 3M run, and
re-calibrate the placeholder MDEs (avgTerritory 3.0, kills 0.5) to the observed effect once a stable
signal lands (the way Blitz's aggression MDE was recalibrated 1.0 → 0.3).

---

## 6. What's next (decision needed)

The export/ship plumbing (`expansionist:export` / `predator:export` npm scripts,
`ai_expansionist.js` / `ai_predator.js`, `builtInBots` entries) is **correctly still unbuilt** —
there's no shippable checkpoint to wire up yet.

**Open question for review:** do we (a) implement the anti-stall guard (Expansionist) and
survival-conditioned bounty (Predator) in the shaping wire and re-pilot, or (b) reconsider whether
these two dense personas are worth the reward-engineering vs. focusing the roster on the three
shipped Batch-1 personas? The reward-design change in (a) is a modest edit to the shaping code but
should be designed deliberately, not guessed.

> **RESOLVED (2026-07-01) → [D-30].** Answer: (a), but as **one pre-registered flag-only wave**
> needing zero wire/trainer code — and with this doc's diagnosis partly corrected first. See the
> §7 Addendum below for the corrections and DECISIONS.md [D-30] for the accepted design (arms,
> tripwires, comparators, ship bars, pre-committed kill criteria). Launch mechanics:
> `scripts/shodan/RUNBOOK.md` §8d.

---

## 7. Addendum (2026-07-01) — corrected diagnosis (supersedes parts of §4/§5)

A code-grounded review (multi-agent design panel + red-team, plus an independent algebraic check)
found that §4.1's "stock reward" framing misreads the implementation, and that three of §5's
recommendations don't survive contact with the code. Corrections, so the next reader doesn't
re-chase them:

1. **The reward was already a flow.** `step_reward` pays `coef × Δterritory` per decision frame
   (`ml/dicewars_ppo/env.py:145`) and the env-server measures the delta NET
   (`scripts/lib/ppo-reward-shaping.mjs`). §5's "reward territory _gained_ (flow) rather than
   _held_ (stock)" therefore recommends the code that already failed.
2. **Why it still behaves like a stock reward** (§4.1's behavioral read was right, its mechanism
   wrong): `coef·ΔΦ = coef·[γΦ′ − Φ] + coef·(1−γ)·Φ′`. The first bracket is potential-based
   shaping — policy-invariant, no personality. The only style-relevant residual is a **stock**
   reward `coef·(1−γ)·territory-held` per step, whose optimum is turtling. That makes the cliff
   **structural**: no coef on this shape produces land-grabbing, and §5's "re-pilot 0.10–0.12"
   band is unsafe by construction. Three amplifiers finished c15 off: stalling postpones (and so
   discounts away) the inevitable negative deltas; the elimination wipe pays `coef × (−T)` ≈
   −1.5…−2.25 vs the +1 win; and dense reward accrued before a `maxTurns` truncation keeps while
   the terminal OUTCOME reward pays 0 — stalling to the cap banks the stock risk-free.
3. **Predator, corrected emphasis:** §4.2's over-commitment read stands, but the root cause is
   that `win` mode prices death at exactly **0** (and these runs had `territory_coef=0`, so no
   wipe either) while the bounty pays immediately. The fix is pricing survival (a `placement`
   backbone — legal to compose with `--elim-bounty`), not tuning the bounty.
4. **§5 recommendations falsified/rejected in review:** the per-idle-turn penalty is the additive
   suicide form PERSONAS §5/§6 warn about (γ applies the same pressure multiplicatively-safe);
   the footprint-conditioned bounty (`pay iff Δterritory ≥ 0`) is dead on arrival against the
   frame schedule — kills fold at turn boundaries (`recordTurn`/`onTurn`), so a non-terminal kill
   only ever rides the first decision frame after the opponent round, whose Δterritory ≤ 0 by
   construction (masked); the one payout that survives is the game-ending kill on the win
   terminal frame (Δ > 0), degenerating the bounty into a redundant win-only bonus.

The accepted Batch-2B design (γ=0.99-transformed Expansionist, placement-backbone Predator, four
1M arms, symmetric tripwires, matched-backbone comparators, pre-committed kill criteria) is
recorded as **[D-30]** in [DECISIONS.md](./DECISIONS.md).

---

## Appendix

### A. Artifact locations

- **Checkpoints + exports (shodan):**
  `~/dicewarsjs-personas/ml/runs/ppo-{expansionist-c08,predator-b04,expansionist-c15,predator-b07}/`
  each containing `ppo.pt`, `<name>.weights.js`, `<name>.fixture.json` (102,787 params, `--no-packed`).
- **Worktree** `~/dicewarsjs-personas` (@ `1c40853`) is **kept** for the next re-pilot.
- Supervisor `/home/ilay/persona_b2b_launch.sh`; one-shot schtasks task `dicewars-persona-b2b`
  was **deleted** post-run. (Named before "Batch-2B" came to mean the [D-30] wave — these are the
  Batch-2 sweep's artifacts; give any new Batch-2B supervisor a different name, e.g. `b2c`.)
- The 20M `ppo-scratch-long` control run (separate experiment) was untouched throughout.

### B. Reproduction (evaluation)

```bash
# behavior:profile — 4 sweep bots vs Conqueror control, 6×30
node scripts/behavior-profile.mjs \
  --bots "Expansionist-c08=<c08>.weights.js,Predator-b04=<b04>.weights.js,\
Expansionist-c15=<c15>.weights.js,Predator-b07=<b07>.weights.js" \
  --control Conqueror --runs 6 --games 30

# ppo:gate — strength vs Lookahead, per candidate, 8×80
node scripts/ppo-gate.mjs --weights <c08>.weights.js --fixture <c08>.fixture.json \
  --name Exp-c08 --bar Lookahead --runs 8 --games 80
```

Each `<name>.weights.js` must have its sibling `<name>.fixture.json` alongside (the loader resolves
`*.weights.js` → `*.fixture.json` by convention).

### C. Raw "vs Conqueror" delta lines (behavior:profile)

```
Expansionist-c08 vs Conqueror: aggression HIGHER (Δ0.38), avgDiceReserve LOWER (Δ-4.36),
  dicePerTerritory LOWER (Δ-0.85), survivalTurn LOWER (Δ-52.46), zeroAttackTurnFrac LOWER (Δ-0.17),
  avgPlacement HIGHER (Δ0.30)          [avgTerritory not listed → ns]
Predator-b04 vs Conqueror: winPct LOWER (Δ-8.06), aggression HIGHER (Δ0.71),
  avgDiceReserve LOWER (Δ-12.16), avgTerritory LOWER (Δ-0.41), dicePerTerritory LOWER (Δ-1.34),
  largestGroup LOWER (Δ-0.45), turnsToWin LOWER (Δ-12.52), survivalTurn LOWER (Δ-76.41),
  zeroAttackTurnFrac LOWER (Δ-0.18), avgPlacement HIGHER (Δ0.46)
Expansionist-c15 vs Conqueror: winPct LOWER (Δ-37.31), aggression LOWER (Δ-0.33),
  captureEfficiency LOWER (Δ-0.02), avgDiceReserve HIGHER (Δ26.93), avgTerritory HIGHER (Δ3.23),
  dicePerTerritory LOWER (Δ-0.46), largestGroup HIGHER (Δ3.17), kills LOWER (Δ-0.45),
  turnsToWin HIGHER (Δ52.25), survivalTurn HIGHER (Δ71.23), zeroAttackTurnFrac HIGHER (Δ0.11),
  avgPlacement HIGHER (Δ0.40)
Predator-b07 vs Conqueror: winPct LOWER (Δ-10.28), aggression HIGHER (Δ0.80),
  captureEfficiency LOWER (Δ-0.03), avgDiceReserve LOWER (Δ-13.85), avgTerritory LOWER (Δ-0.73),
  dicePerTerritory LOWER (Δ-1.53), largestGroup LOWER (Δ-0.91), kills LOWER (Δ-0.23),
  survivalTurn LOWER (Δ-81.10), zeroAttackTurnFrac LOWER (Δ-0.23), avgPlacement HIGHER (Δ0.80)
```

### D. Related docs

- `docs/ml-bot/PERSONAS.md` — persona roster & reward-design principles
- `docs/ml-bot/EVAL_HARNESS.md` — `behavior:profile` / `ppo:gate` methodology
- `docs/ml-bot/RESULTS.md` — scoreboard (this result to be distilled in)
- `docs/ml-bot/DECISIONS.md` — [D-28] dense-reward "bite G" wire
