# Behavioral-Eval Harness — spec (parked)

> **Status:** Parked design spec — drafted 2026-06-28 alongside [PERSONAS.md](./PERSONAS.md) while
> `ppo-long` trains. This is the measurement half of the persona-roster plan: the win%-vs-Lookahead
> gate (`ppo:gate`) answers _"is it stronger?"_ — it is **blind to play-style**. This harness answers
> _"is it DIFFERENT, and how?"_ by profiling any bot across a seed sweep on a set of behavioral axes
> and doing a **paired comparison against a control**.
>
> **Grounded:** the file:line citations below were verified against the source by a parallel
> code-map + two adversarial reviews (feasibility skeptic + completeness critic). Line numbers are a
> point-in-time anchor and **drift as files change** — the **symbol name** in each citation is the
> durable reference; if a line looks off, grep the symbol. (The `matchRunner.js` numbers here were
> re-synced after this PR's own `onTurn` JSDoc expansion shifted them.)
>
> **Scope honesty (the load-bearing caveat):** the five persona bots
> (Conqueror/Blitz/Expansionist/Predator/Survivor) **do not exist in the repo yet** — `BUILT_IN_BOTS`
> has exactly one generic `PPO` bot (`src/arena/builtInBots.js:44`). So this splits into two phases:
>
> - **Phase 1 — ✅ BUILT (2026-06-28):** the harness + its tests, validated on _existing built-ins_.
>   Shipped: the §6 engine signal (`onTurn(…, actingPlayerId)` in `matchRunner.js`),
>   `scripts/lib/behavior-core.mjs` (pure logic, 17 unit tests), `scripts/behavior-profile.mjs`
>   (`npm run behavior:profile`), `tests/behaviorCore.test.js`. Acceptance check (a **manual pilot**,
>   not an automated assertion — the exact Δ depends on field & budget): `Strategist` vs `Defensive`
>   separate on aggression / zero-attack-turn fraction with a CI excluding 0 at a small pilot budget.
>   Adversarially reviewed (kill-attribution timing, seat mapping, null-alignment) — clean.
> - **Phase 2 (after the personas are trained):** point it at the persona weight files and produce the
>   signature table. The persona rows in §8 are **aspirational** until those bots exist; the
>   `PERSONA_SIGNATURES` / `DEFAULT_MDE` stubs in `behavior-core.mjs` already encode the pre-registered
>   hypotheses so the multiplicity story is fixed in advance.

---

## 1. Key finding

The harness needs **one small, backward-compatible `matchRunner` signal** — the §6 `onTurn` actor arg,
**shipped in this PR** — and beyond that only wires up two **opt-in, zero-cost-when-omitted** callbacks
that it accumulates itself. (The draft's "no instrumentation required" was an overclaim; corrected here.)

- `onTurn(turnNumber, state, actingPlayerId)` — defined `src/arena/matchRunner.js:213`, fired after
  every player-turn at `:330`. Source of the territory/dice/board-shape curves; the third arg
  (`actingPlayerId`, §6) attributes the turn.
- `onStep(step)` — defined `:219`, fired per attack at `:145-159` and at turn-end (STOP) at `:175-190`.
  Source of per-turn attack/pass counts.

Both callbacks are genuinely free when unset: the per-step hot path only builds steps when a handler
exists (`stepHandler` is `undefined` unless `recorder || onStep`, `:266-272`; the attack-path
`buildStep` is gated `if (onStep)` at `:145` and reuses the already-computed observation), and `onTurn`
is guarded at `:330`. `runArena` does **not** forward `onTurn` (`src/arena/arenaRunner.js:102-109`), so
the harness drives `runMatch` directly.

**The §6 engine change (shipped):** `onTurn` now passes `actingPlayerId` — the `currentPlayerId`
already computed at `matchRunner.js:281`. It is backward-compatible (absent/old 2-arg callers ignore
the extra arg) and resolves **three** problems at once — the aggression bias (§2a), kill-attribution
without a second replay pass (§2c), and clean active-turn counting. Both reviews recommended it; it is
now in the engine (see §6).

---

## 2. Metrics

Each metric is computed **per profiled bot, per game**, reduced to **one scalar per run** (a seed
block), then aggregated to **mean ± 95% CI across runs** via `meanCi` (`scripts/lib/stats.mjs:60-66`).
`pi` = the profiled bot's seat index. Feasibility tags use the reviewed taxonomy: _yes-from-existing_
(a stored signal), _harness-capture_ (wire an existing callback + accumulate — no engine change),
_derive-from-replay_ (re-simulate).

### 2.1 Core axes

| #   | Axis                  | Definition (per game)                                                     | Source            | Key file:line                                                              |
| --- | --------------------- | ------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| a   | **Aggression**        | attacks per _active turn_ = `attacksMade / activeTurns(pi)`               | harness-capture   | `attacksMade` `matchRunner.js:347`; `activeTurns` from `onTurn` actor (§6) |
| b   | **Territory curve**   | `state.players[pi].territoryCount` sampled each `onTurn`, indexed by turn | harness-capture   | `onTurn` `:330`; `recalcPlayerStats` `StateManager.js:108-116`             |
| c   | **Kills / game**      | opponents whose _last_ territory `pi` captured                            | harness-capture\* | elim flip `StateManager.js:122-128`; actor via `onTurn` (§6)               |
| d   | **Turns-to-win**      | `turnCount` over games `pi` won (unit = **player-turns**, not rounds)     | yes-from-existing | `winner` `:355`, `turnCount` `:357`                                        |
| e   | **Placement dist.**   | histogram of 1-based `placement`; + `avgPlacement`, `top1/top3`           | yes-from-existing | `placement` `:346`, `calculatePlacements` `:375-395`                       |
| f   | **Win% vs reference** | FFA win-rate with the reference bot (default `Lookahead`) in the field    | yes-from-existing | `winner` `:355`; CI via `meanCi`; paired via `pairedDelta`                 |

\* `c` becomes a pure `onTurn` computation with the §6 actor arg; without it, it is _derive-from-replay_
(a full second simulation per game via `trajectoryFromReplay` `trajectoryExport.js:246`).

**Corrections folded in (do not re-introduce):**

- **(a) aggression bias — the subtle one.** `runBotTurn` emits the turn-end STOP step only when
  `phase !== GAME_OVER`; a _winning_ turn returns early at `matchRunner.js:99` and emits **no STOP**.
  So counting active turns as "# STOP steps" undercounts by exactly 1 on every game the bot wins, while
  the winning attacks _are_ counted — inflating aggression **in proportion to win rate**, which differs
  across personas and would contaminate the comparison. **Fix (shipped):** count active turns from
  `onTurn` firings attributed to `pi` (§6 actor arg), which include the victory turn. (The pre-§6
  alternative, had the engine been left untouched, was `activeTurns = stopCount + (result.winner === pi ? 1 : 0)`
  — no longer needed.) Documented in the metric, not silent.
- **(b) k=0 gap.** `onTurn` first fires _after_ turn 1, so there is no initial-board sample. Seed index
  0 from the `createGame` initial state (`GameRunner.js:37-68`) before the loop, or document the curve
  starts at k=1. The JSON example's `t0` is the seeded initial state, not an `onTurn` sample.
- **(d) unit.** `turnCount` increments once per _player-turn_ (`matchRunner.js:329`), **not** per full
  round (`state.turnNumber`). A valid, consistent cross-bot axis — but label the unit so "turns" is not
  misread as rounds.

### 2.2 Style / "turtle" axes — added by review (the personality discriminators)

The original six axes **cannot reveal a bot that wins by sitting on a dice pile** — exactly the turtle
behavior observed in playtesting. These are all cheap from existing signals and are first-class, not
diagnostics:

| #   | Axis                        | Why it discriminates                                                 | Source            | Key file:line                                                   |
| --- | --------------------------- | -------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------- |
| g   | **Avg dice reserve**        | the turtle's signature — sits on a big pile                          | harness-capture   | `diceCount` `StateManager.js:112-117`; `finalDice` `:345`       |
| h   | **Dice per territory**      | turtle (dense, high) vs expansionist (thin, low)                     | harness-capture   | same as (g) ÷ (b)                                               |
| i   | **Capture efficiency**      | `attacksWon/attacksMade` — cautious (high) vs reckless (low)         | yes-from-existing | `attacksWon` `:348`                                             |
| j   | **Zero-attack-turn frac.**  | clearest pass-turn / turtle signal                                   | harness-capture   | `onStep` STOP with 0 attacks since last STOP (`:175-190`)       |
| k   | **Border exposure**         | turtle clusters to shrink frontier vs aggressor                      | harness-capture   | `isBorder` `botState.js:50`, or recompute from `onTurn` state   |
| l   | **Largest connected group** | "connectivity economics" the Expansionist reward targets             | yes-from-existing | `connectedTerritories` `botState.js:74` / player `largestGroup` |
| m   | **Survival time / length**  | Survivor survives long _even when losing_ (all games, not just wins) | harness-capture   | `eliminated` flip in `onTurn` (`StateManager.js:122-128`)       |
| n   | **Territory AUC**           | **scalar** reduction of (b) so it flows through `pairedDelta`        | harness-capture   | integrate the (b) curve (mean or normalized AUC)                |

**(n) is not optional — it fixes an internal contradiction:** the persona table assigns Expansionist
the signature "territory HIGHER," but a curve cannot go through `pairedDelta`/`classifyGate`. Reducing
the captured curve to a scalar AUC (or net-territory mean) makes Expansionist's (and Survivor's
territory aspect) `signaturePass` actually computable.

**Dropped as redundant:** `attacksPerGame` as a separate paired axis — it is ≈ aggression × mean active
turns and adds nothing over the turn-normalized axis. Derive on demand if ever needed.

> **Shipped in Phase 1 (vs this design list):** `behavior-core.mjs`'s `AXES` implements g
> (`avgDiceReserve`), h (`dicePerTerritory`), i (`captureEfficiency`), j (`zeroAttackTurnFrac`), l
> (`largestGroup`), m (`survivalTurn`), plus the core a/c/d/e/f (incl. c `kills`) and `avgTerritory` (the scalar reduction
> of (b) that stands in for the territory AUC (n)). **Not yet implemented:** the full territory _curve_,
> a separate `territoryAuc`, and **(k) border exposure** — these are Phase-2 / future axes, not part of
> the shipped profiler.

---

## 3. Statistical design — the part that makes "distinct" mean something

This section is new (the draft had none) and is where both reviews put their highest-severity findings.

### 3.1 Aggregation & the unit of replication

Per axis: collect one scalar per **run** (a seed block of `games` matches), then `meanCi(perRun[])`.
**Critically, `meanCi`'s `n` is the RUN count, not the game count** — CI half-width is driven by
_between-run_ variance / √runs. More games per run shrinks within-run noise; only more _runs_ tightens
the CI. Budget both deliberately.

### 3.2 Minimum detectable effect (MDE) — no "trivially significant" passes

`signaturePass = "the expected-direction CI excludes 0"` will fire on a behaviorally meaningless
difference (e.g. aggression Δ 0.1 with CI [0.05, 0.15]) once games are plentiful — defeating the whole
point. **Require both:**

```
signaturePass(axis) := |delta| >= MDE(axis)  AND  CI excludes 0  (in the expected direction)
```

Pre-register a practical MDE per axis (e.g. aggression ≥ ~1 extra attack/turn; kills ≥ ~0.5/game;
turns-to-win ≥ ~15%). These are placeholders to **calibrate from a pilot**: run a few runs on the
trained personas, estimate between-run SD per axis, then solve `runs` (and `games`/run) for a CI
half-width comfortably under the MDE. State the resulting budget in the run log; do not hard-code
20×150 without that check.

### 3.3 Multiplicity — one hypothesis per persona

5 personas × ~12 axes ≈ 60 CIs at per-axis 95% inflates family-wise error badly. **Pre-register exactly
one confirmatory signature hypothesis per persona** (a named axis, or an explicit AND-conjunction like
Blitz's "aggression HIGHER **and** turns-to-win LOWER") _before_ running. That bounds the confirmatory
family to ~5 tests; apply **Holm** across those 5. **All other axes are descriptive** (reported, not
pass/fail). `PERSONA_SIGNATURES` encodes the one hypothesis + AND/OR rule per persona.

### 3.4 Null-run policy (winners-only axes)

Turns-to-win is `null` for any run where the bot never won — and `pairedDelta`
(`ppo-gate-core.mjs:31-41`) throws on length mismatch and silently mis-pairs if one side drops a run.
**Policy:** when _either_ persona or control yields `null` at run `i`, drop index `i` from **both**
arrays before pairing (preserves alignment); emit the reduced `n`. Or require a minimum win count per
block. Applies to any winners-only axis.

### 3.5 Pairing — honest about its strength

The draft claimed "the same paired logic `ppo:gate` uses." **It is weaker than that** and the spec must
not overclaim: `ppo:gate` pairs candidate and bar _within one game_; profiling each persona in its
**own** field shares only the map **seed** with the control, not the same opponents/interactions.

**Recommended design — fixed standard opponent field, honest seed-level pairing.** Profile each persona
(and the control) in an **identical** opponent field (same opponents, same reference, same seeds, full
seat rotation). Every persona then faces the _same_ opponents → clean, comparable signatures; pairing is
**seed/map-level** (documented as such), and §3.2's power sizing accounts for the extra variance. This
is preferred over co-seating because co-seating changes _what opponents each persona faces_ (a Predator
seated among 4 aggressive personas has a different kill rate than vs standard opponents) — contaminating
the very signatures we measure.

**Secondary "melee" mode for persona×persona separation.** To answer "are the five distinct from _each
other_" (not just from Conqueror), add an optional mode that co-seats all personas + control in one
shared field and emits a persona×persona `pairedDelta` matrix (judged by paired-diff CI excluding 0 with
MDE — _not_ marginal-CI overlap, which is the weaker test). This mode accepts interaction by design and,
as a bonus, is ~N× cheaper than N separate sweeps — but it is for the separation matrix, not the clean
signatures.

### 3.6 Determinism

Pairing, reproducibility, and the byte-identical-JSON test all assume bot decisions are a pure function
of state. The engine RNG is seeded, but a PPO policy in **sampling** mode (or any bot using
`Math.random` for tie-breaks) breaks this. **Require profiled bots to run in greedy/argmax inference**
and assert no internal RNG — enforce in the persona loader, not just the smoke test.

### 3.7 Quarantine — don't bias the metric you're measuring

Dropping games where the profiled bot hit `maxMovesHit` removes its _most aggressive_ turns (100 attacks
in one turn) → biases aggression **down**; and an opponent's forced-end distorts the game but isn't
caught if you only check the profiled seat. **Policy:** quarantine on **any** seat's forced-end counters
(`errors|invalidMoves|maxMovesHit > 0`, D-14, `matchRunner.js:349-351`), **report the quarantine rate
per persona** (shipped: `config.quarantine.ratePerBot` + a per-bot terminal warning when a bot's sample
is reduced or fully gutted). **Phase 2 / TODO:** emit profiles **both with and without** quarantine in
one run so a systematic shift is visible; today use the `--no-quarantine` flag for the unfiltered pass.

### 3.8 Training-field match (fixed-field-exploitation guard)

Per the task-A caveat, a persona trained at a given `playerCount`/`maxAreas`/`dicePerArea` can look
artificially strong or distinct if profiled at a _different_ field size. **Record those three with each
persona's weights and have the harness ASSERT the profiling field equals the training field — hard error
on mismatch**, not an open question. (Field-size model, as shipped: the **reference is one of the
`--opponents`**, not a separate seat — `fieldSize = opponents.length + 1` (the +1 is the profiled seat).
So a 7-seat field = `DEFAULT_PLAYER_COUNT` means **6 opponents (the reference among them) + 1 profiled**.
The shipped _default_ `--opponents` list has 5 entries → a 6-seat field; pass 6 opponents to profile at
the full 7.)

---

## 4. Architecture

Two files, mirroring the `ppo-gate.mjs` (CLI) / `ppo-gate-core.mjs` (pure, unit-testable) split:

- **`scripts/behavior-profile.mjs`** — CLI: arg parse, bot enumeration, the seed×rotation sweep driving
  `runMatch`, output (JSON/CSV/table).
- **`scripts/lib/behavior-core.mjs`** — pure logic (no arena, no I/O): per-game extraction, per-run
  aggregation, MDE/multiplicity decision, persona-vs-control + persona×persona comparison. Unit-testable
  like `ppo-gate-core.mjs`.

Lives under `scripts/` (offline analysis CLI like `arena-sweep.mjs`), not `src/`.

### Public API (`behavior-core.mjs`) — as shipped

```
// Build the per-game accumulator + the onTurn/onStep handlers to wire into runMatch.
makeCapture(playerIndex) -> { capture, onTurn, onStep }

// Per-game extraction. `capture` carries the onTurn/onStep-accumulated arrays for THIS game.
profileGameFromCapture(result, playerIndex, capture) -> GameProfile   // throws on a misaligned capture
//   GameProfile: { won, placement, turnsToWin|null, attacksMade, aggression|null,
//                  captureEfficiency|null, avgDiceReserve|null, avgTerritory|null,
//                  dicePerTerritory|null, largestGroup|null, kills, survivalTurn,
//                  zeroAttackTurnFrac|null }   // null = no qualifying turn/attack this game (≠ 0)

reduceRun(profiles[]) -> Record<axis, number|null>      // one scalar per AXES key per run
summarizeAxis(perRunValues[]) -> { mean, ci, n } | null // mean ± 95% CI; n = RUN count (§3.1)
alignDropNull(a[], b[]) -> { a[], b[], n }              // drop indices null on either side (§3.4)
compareAxis(personaRuns[], controlRuns[]) -> { delta, ci, lo, hi, verdict, n } | null  // paired Δ
compareToControl(personaRuns[], controlRuns[]) -> Record<axis, compareAxis-result | null>
signaturePass(signature, vsControl, mde) -> boolean     // §3.2 MDE AND CI-excludes-0; THROWS w/o MDE

AXES                // the canonical axis-key list (single source of truth)
PERSONA_SIGNATURES  // persona -> { axes: [{ axis, direction }], rule: 'AND'|'single' }   (Phase-2 stub)
DEFAULT_MDE         // partial Record<axis, number>; a signature axis MUST have an entry (else throws)
```

> **Not yet built (Phase 2 / future):** `aggregateCurves` (territory _curve_ alignment/padding),
> `separationMatrix` (§3.5 persona×persona melee), Holm adjustment across the 5 confirmatory tests, and
> the `--melee`/`--csv` CLI modes. The shipped `summarizeAxis` is the `aggregateRuns` thin-`meanCi`
> wrapper the draft named. The terminal-stat math (`avgPlacement`, win%, capture-efficiency) is computed
> in `behavior-core.mjs` directly; extracting a shared helper from `arenaRunner.js:130-168` remains a
> **TODO** (the one duplication the review flagged).

### CLI

```
node scripts/behavior-profile.mjs \
  --bots PPO,Blitz,Expansionist,Predator,Survivor \   # profiled seats (Phase 2)
  --opponents Default,Defensive,Strategist,Adaptive,Expectimax,Lookahead \  # fixed FFA filler; MUST include the reference
  --reference Lookahead \                              # win%-vs-ref; one of --opponents (fills a seat in every field)
  --control Conqueror \                               # auto-injected into the profiled set if absent
  --runs 20 --games 150 \                             # CALIBRATE via §3.2 pilot, don't hard-code
  --no-quarantine \                                   # run a second, unfiltered pass (§3.7)
  --json                                              # JSON->stdout, human table->stderr
  # --melee (§3.5 persona×persona) is NOT yet implemented — Phase 2.
```

Above is a 7-seat field (6 opponents incl. the reference + 1 profiled seat). The reference **must** be
one of `--opponents` or the CLI exits with an error.

The **control is always profiled** with identical run/game/rotation config (auto-injected if not in
`--bots`); assert `controlRuns.length === personaRuns.length` before `pairedDelta`.

### Sweep execution (per profiled bot, fixed field)

1. Field = `rotatedField([bot, ...opponents], r)` (`ppo-gate-core.mjs:127-132`) — the profiled bot is
   field[0] and rotation `r` seats it at `r`; the reference is one of `--opponents`. The CLI's own
   validation enforces the reference-in-field + name-collision invariants up front (the `buildGateField`
   guardrails at `:103-112` are the equivalent for `ppo:gate`).
2. `STRIDE = Math.max(1_000_000, games*1000)` (`arena-sweep.mjs:45`); run `r` uses seeds
   `r*STRIDE+1 … +games`, each replayed through all N seat rotations (the `ppo-gate.mjs` seat-fair
   architecture).
3. `runMatch({ bots, seed, onTurn, onStep })` with a fresh per-game capture from `makeCapture(pi)`:
   ```
   const { capture, onTurn, onStep } = makeCapture(pi);  // see behavior-core.mjs for the real impl
   // onTurn(t, s, actor): on the profiled bot's own turns push s.players[pi]'s scalars
   //   (territoryCount/diceCount/largestGroup) and bump activeTurns; diff the eliminated set and, if
   //   actor === pi, credit a kill. Copy scalars per turn — don't retain `s` across turns (each turn
   //   is a fresh cloned state, so retaining N of them just pins memory; the engine never mutates a
   //   prior turn's state in place).
   // onStep(step): for the profiled seat, count a zero-attack (pass) turn when a STOP arrives with no
   //   intervening attack.
   ```
4. `profileGameFromCapture(result, pi, capture)`; quarantine per §3.7.
5. Reduce the block to per-run scalars; push to `perRun[bot][axis]`.

---

## 5. Reused utilities (exact)

| Function                                 | File:line                                             | Use                                                                                     |
| ---------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `runMatch` + `onTurn`/`onStep`           | `matchRunner.js:229-366` (cb `:213/:219`)             | run each game, stream board + step signals                                              |
| `botStats`                               | `matchRunner.js:341-352`                              | (a num),(d),(e),(g),(i), quarantine                                                     |
| `MatchResult` winner/turnCount           | `matchRunner.js:355/:357`                             | (d),(f)                                                                                 |
| `calculatePlacements`                    | `matchRunner.js:375-395`                              | placement ranks (already applied)                                                       |
| `recalcPlayerStats`                      | `StateManager.js:108-117`                             | territoryCount (b), diceCount (g)                                                       |
| `applyAction`                            | `StateManager.js:161-173`                             | replay re-sim (kills fallback)                                                          |
| `trajectoryFromReplay` / `replayToState` | `trajectoryExport.js:246` / `replayFormat.js:198-208` | kill-attribution fallback (no §6)                                                       |
| `isStopMove` / `buildStep`               | `trajectoryExport.js:61` / `:129-140`                 | ATTACK vs STOP in `onStep`                                                              |
| `botState` isBorder/connected            | `botState.js:50` / `:74`                              | (k) border, (l) largest group                                                           |
| `meanCi` / `tCrit` / `mean`              | `stats.mjs:60-66 / :50 / :53`                         | mean ± 95% CI — **CI math reused**                                                      |
| `pairedDelta` / `classifyGate`           | `ppo-gate-core.mjs:31-41 / :53-57`                    | paired Δ + HIGHER/SAME/LOWER                                                            |
| `rotatedField` / `buildGateField`        | `ppo-gate-core.mjs:127-132 / :103-112`                | seat fairness, field guardrails                                                         |
| arenaRunner accumulators                 | `arenaRunner.js:130-168`                              | **extract** shared terminal-stat helper                                                 |
| `BUILT_IN_BOTS`                          | `builtInBots.js:21`                                   | built-in enumeration (`ai_ppo` `:44`)                                                   |
| `resolveBot`/`loadBot`/`getArg`          | `cli-utils.mjs:49/:37`, `cli-args.mjs:25`             | arg parsing (`getArg`/`hasFlag`) now; `resolveBot`/`loadBot` = Phase-2 weight-file bots |
| JSON-stdout / table-stderr               | `_tune.mjs:130-142`                                   | dual output                                                                             |

---

## 6. The engine change (backward-compatible) — SHIPPED in this PR

`onTurn`'s firing at `matchRunner.js:330` now passes the acting player:

```
if (onTurn) onTurn(turnCount, state, currentPlayerId);   // currentPlayerId already computed at :281
```

Old/absent 2-arg callers ignore the third arg; `runArena` passes no `onTurn`, and the only other
`runMatch` `onTurn` consumer (`scripts/lib/ppo-env.mjs`) is 2-arg — so nothing else changes. This:

1. **Fixes the aggression bias (§2a)** — active turns counted from `onTurn` firings where
   `actor === pi`, which include the victory turn.
2. **Removes the second replay pass for kills (§2c)** — diff the eliminated set across consecutive
   `onTurn` firings and credit the acting player; O(1) live instead of a full re-simulation at
   runs×games×N×rotations scale.
3. Makes both O(1) and live.

Both reviews recommended it; it is now in the engine. (A replay-based kill cross-check remains a
worthwhile future test.)

---

## 7. Output format

`--json` → stdout (machine), human table → stderr. Shape below is the **full Phase-2 target**
(abbreviated); the **shipped Phase-1 JSON** carries only the `AXES` metrics + per-axis `vsControl`
(each `{ delta, ci, lo, hi, verdict, n }`), `config.quarantine.ratePerBot`, and a per-bot `liveRuns`
count — it does **not** yet emit `territoryCurve`, `territoryAuc`, `borderExposure`, `placementHist`, or
the `separationMatrix`/`signature` blocks. (`winPctVsRef` ships as the `winPct` axis.)

```jsonc
{
  "config": {
    "runs": 20,
    "games": 150,
    "stride": 1000000,
    "reference": "Lookahead",
    "control": "Conqueror",
    "opponents": ["Default", "..."],
    "fieldSize": 7,
    "trainingFieldAsserted": true,
    "quarantine": { "on": true, "ratePerBot": { "Blitz": 0.004 } },
    "mde": { "aggression": 1.0, "kills": 0.5, "turnsToWin": 0.15 },
  },
  "bots": [
    {
      "name": "Blitz",
      "metrics": {
        "aggression": { "mean": 4.8, "ci": 0.3 },
        "turnsToWin": { "mean": 22.4, "ci": 1.9, "n": 142 }, // null mean if n==0
        "kills": { "mean": 1.7, "ci": 0.2 },
        "avgDiceReserve": { "mean": 9.1, "ci": 0.6 },
        "dicePerTerritory": { "mean": 1.3, "ci": 0.1 },
        "captureEfficiency": { "mean": 0.71, "ci": 0.03 },
        "zeroAttackTurnFrac": { "mean": 0.06, "ci": 0.02 },
        "borderExposure": { "mean": 0.55, "ci": 0.03 },
        "largestGroup": { "mean": 11.0, "ci": 0.7 },
        "survivalTurn": { "mean": 38.0, "ci": 2.4 },
        "winPctVsRef": { "mean": 41.0, "ci": 3.2 },
        "avgPlacement": { "mean": 2.6, "ci": 0.1 },
        "placementHist": { "1": 0.41, "2": 0.18 },
        "territoryCurve": { "turns": [0, 1, 2], "mean": [7.0, 8.1, 9.4], "ci": [0.0, 0.4, 0.6] },
        "territoryAuc": { "mean": 412.0, "ci": 18.0 },
      },
      "vsControl": {
        // paired Δ (persona − Conqueror), §3.4 aligned
        "aggression": { "delta": 2.1, "ci": 0.4, "lo": 1.7, "hi": 2.5, "verdict": "HIGHER" },
        "turnsToWin": {
          "delta": -9.8,
          "ci": 2.0,
          "lo": -11.8,
          "hi": -7.8,
          "verdict": "LOWER",
          "n": 138,
        },
        "signature": {
          "axes": ["aggression", "turnsToWin"],
          "rule": "AND",
          "mdeMet": true,
          "holmAdjusted": true,
          "signaturePass": true,
        },
      },
    },
  ],
  "separationMatrix": {
    /* §3.5 melee mode, optional */
  },
}
```

CSV (optional `--csv <dir>`): `summary.csv`, `territory.csv` (tidy long form for plotting),
`vs_control.csv`, `separation.csv`. Console table prints the headline axes + the per-persona signature
verdict.

---

## 8. Persona signatures (aspirational — Phase 2)

One **pre-registered** confirmatory hypothesis per persona (§3.3); everything else is descriptive.

| Persona      | Reward              | Pre-registered signature vs Conqueror                           | Rule   |
| ------------ | ------------------- | --------------------------------------------------------------- | ------ |
| Conqueror    | win (control)       | — baseline                                                      | —      |
| Blitz/Tempo  | low γ / fast        | aggression **HIGHER** AND turns-to-win **LOWER**                | AND    |
| Expansionist | dense net-territory | territory AUC (n) **HIGHER**                                    | single |
| Predator     | elimination bounty  | kills/game **HIGHER**                                           | single |
| Survivor     | placement reward    | avg placement **LOWER/better** (survivalTurn HIGHER as support) | single |

Turtle-detection axes (g–l) are the descriptive backbone: they're how we'd _show_ that Blitz stopped
hoarding (avgDiceReserve LOWER, zeroAttackTurnFrac LOWER) relative to the Conqueror turtle observed in
play — even though aggression+tempo is Blitz's confirmatory signature.

---

## 9. Integration

- **npm:** `"behavior:profile": "node scripts/behavior-profile.mjs"`. Optional preset
  `"behavior:personas"` wiring the 5 personas + Conqueror control + Lookahead reference.
- **vs `arena:sweep`:** shares STRIDE/seed-block/`meanCi`; adds behavioral axes + paired control.
- **vs `ppo:gate`:** complementary — `ppo:gate` = _"stronger?"_ (paired Δwin% vs Lookahead),
  `behavior:profile` = _"different?"_ (paired Δ on behavioral axes vs Conqueror), reusing the very same
  `pairedDelta`/`classifyGate`. Pipeline: train personas → (optional) `ppo:gate` for strength →
  `behavior:profile` for distinct style. A persona "ships as a persona" when `signaturePass === true`
  (MDE + Holm) — strength is _not_ required of a personality bot (PERSONAS §9 open question).

---

## 10. Test plan

Scoped runs only (`npx vitest run tests/behaviorCore.test.js`), never the full suite from a subagent
(CLAUDE.md). Node env — no DOM.

**Unit (`behavior-core.mjs`, deterministic, no arena):**

1. `profileGameFromCapture` on a hand-built `MatchResult` + capture: correct
   `aggression = attacks/activeTurns` **including the victory-turn correction**; `turnsToWin` only on
   wins (`null` otherwise); placement from `botStats`; dice/efficiency/zero-turn/border/largest-group.
2. **Kill attribution:** synthetic 3-player game where X delivers Y's last-territory capture →
   `kills(X)===1`, others 0; a capture that does _not_ zero the defender → no kill. Test **both** the §6
   `onTurn`-actor path and the replay path agree.
3. `aggregateRuns` ≡ `meanCi`; `aggregateCurves` aligns/pads variable-length curves; `territoryAuc`
   reduction correct.
4. `compareToControl`: crafted per-run arrays → exact `pairedDelta` + verdicts; **`signaturePass` true
   only when |Δ| ≥ MDE AND CI excludes 0 in the expected direction** (assert it is FALSE for a
   significant-but-sub-MDE Δ); Holm adjustment across the 5.
5. **Null-run policy:** a `null` turns-to-win run on either side drops index `i` from both, preserving
   alignment; `pairedDelta` never sees mismatched lengths.
6. Edge cases: never-wins (`turnsToWin {n:0, mean:null}`), 0 kills, quarantined game excluded,
   single-win block.

**Integration smoke (`behavior-profile.mjs`):**

7. Two built-ins, `--runs 2 --games 5`, fixed seeds → JSON parses, all axes present, paired arrays
   length === runs, no `NaN`/unexpected `null`.
8. **Determinism:** identical args twice → byte-identical JSON (requires argmax inference, §3.6).
9. **Zero-cost guard:** `runMatch` with no `onStep`/`onTurn` builds zero steps (spy on `buildStep` /
   assert `stepHandler` undefined) — protects the "callbacks off ⇒ free" invariant for arena/gate.
10. **Discrimination sanity (Phase 1 acceptance):** profiling two deliberately different built-ins
    (`Defensive` vs `Strategist`) yields ≥1 axis with non-overlapping paired-Δ CI _exceeding MDE_ —
    proves the harness can actually detect a style difference before any persona exists.

---

## 11. Open decisions for Ivan

Most review findings are settled above. These are the genuine judgment calls:

1. **Pairing mode (§3.5):** ship the fixed-standard-field design (clean signatures, honest seed-level
   pairing) as primary — agreed? And is the co-seated "melee" persona×persona matrix worth building in
   v1, or defer it?
2. **MDE values (§3.2):** the per-axis "behaviorally meaningful" thresholds are a product call, not a
   code one. Placeholders are in §3.2; we calibrate against a pilot once a persona exists — but the
   _direction_ (e.g. "1 extra attack/turn is meaningful, 0.1 isn't") is yours.
3. **~~§6 engine one-liner~~ — RESOLVED:** adopted and shipped in this PR (`onTurn` now passes
   `actingPlayerId`); the bias + kill attribution are handled live, no replay pass needed.
4. **Budget:** runs vs games split is driven by the pilot's between-run SD (§3.1). No fixed number until
   then — flagging so 20×150 isn't mistaken for a decision.
