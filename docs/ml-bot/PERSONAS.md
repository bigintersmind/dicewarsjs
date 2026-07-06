# Reward-Shaped Personality Roster — design note (parked)

> **Status:** Parked design note — **not yet executable.** Drafted 2026-06-28 while the
> first true long run (`ppo-long`, 20M, BC-warm-start) is training on shodan. **Nothing here
> touches that job.** This is the queued payload for the concurrent-run scaffolding Ivan wants
> to build _after_ `ppo-long` finishes, exports, and gates.
>
> **Relationship to existing decisions:** [D-19](./DECISIONS.md#d-19) chose **sparse terminal-win
> reward first**, with _"shaping only if too slow; placement = the ELO trap."_ This note is the
> deferred shaping work — but reframed: not to make the gate bot stronger, to make a **roster of
> equally-trained bots with deliberately different play styles**, some of which are _supposed_ to
> sacrifice win% for character. New decisions this implies are flagged `D-27?` etc. (next free
> number after D-26) and should be promoted to `DECISIONS.md` if/when accepted.
>
> **Built since (2026-06-29, "bite D"):** the **wire-free reward knob** now exists. `train.py` gained
> `--reward-mode {win,placement}` plus `--terminal-speed-bonus B`/`--speed-ref T`, computed by
> `dicewars_ppo.env.terminal_reward`. This makes **Conqueror** (`win`, the default), **Survivor**
> (`placement`), and **Blitz** (lower `--gamma`, optionally `--terminal-speed-bonus`) runnable
> **with no wire change**. The dense **Expansionist**/**Predator** rewards still need the per-frame
> wire scalar ("bite G"). The eval-harness side ("bite E1") can already gate a persona's exported
> weights. So the §2 "the reward is one line" framing below is now historical — see that knob.
>
> **Built since (2026-06-29, "bite F" — the persona launcher):** the shodan launcher
> `scripts/shodan/ppo-train.sh` now has a **`PERSONA={conqueror,blitz,survivor}`** knob that wires the
> bite-D reward objective + a default `RUN_NAME` + a warm-start from `runs/ppo-long/ppo.pt` (the BEAT
> actor, **not** the BC net). All other HPs stay shared (set once for the batch) so the control is
> matched on every axis but the reward. An unset `PERSONA` is byte-identical to the BEAT-run launcher.
> Concurrency is collision-free (per-`RUN_NAME` dirs + OS-assigned ephemeral env-server ports), so the
> three flag-only personas run together for ≈ the cost of one — see the RUNBOOK "persona" section. So
> §8 steps 1–3 are now **executable**: the only thing left before a batch is the GPU time itself (plus
> "bite G" for the two dense personas).
>
> **Built since (2026-06-30, "bite G" — the dense-reward wire):** the two DENSE personas are now
> runnable. A new **opt-in shaped obs-frame** carries two RAW per-step measurements — `deltaTerritory`
> (f32) + `elimsByLearner` (i32) — emitted by the env-server only under `--reward-shaping` (the B5/B6
> opt-in pattern: **byte-identical wire when off**). The trainer applies the persona WEIGHTS Python-side
> via `--territory-reward-coef` (**Expansionist**) and `--elim-bounty` (**Predator**) in the pure
> `dicewars_ppo.env.step_reward`, with an optional `--shaping-clip` (§6 "cap per-turn"). Kills are
> ATTRIBUTED via the `onTurn` hook (eliminations during a turn where the learner is the acting seat),
> so the game-ending kill is credited; territory delta is NET (the env-server reads the count directly).
> Crucially this is **NOT an `ENCODING_VERSION` bump** — the observation tensor (the policy net's input)
> is unchanged, so the `ppo-long` warm-start + BC/PPO weight guards stay valid; only the binary
> frame-HEADER grows (`HEADER_STRUCT_SHAPED`, [D-28]). The launcher gained `PERSONA={expansionist,predator}`.
> So §8 step 2 is now **fully done** and all five personas are launchable — the only thing left before a
> batch is the GPU time.
>
> **SHIPPED (2026-06-30) — the 3 flag-only personas are in the game.** The pilot batch (Conqueror /
> Blitz / Survivor, 3M steps each off `ppo-long`) trained, gated, and profiled (see RESULTS.md). All
> three BEAT Lookahead; Survivor's signature PASSED (Blitz's after recalibrating the aggression MDE
> 1.0→0.3, which this pilot's data justified). The head-to-head vs `ppo-long` decided the roster:
> Conqueror's fine-tune came out **−7.6 pp WEAKER** than `ppo-long`, Blitz **TIED**, Survivor **BEAT
> (+8.4)**. Per **[D-27] (now resolved)**: the player-facing **Conqueror ships the `ppo-long` weights
> directly** (it _is_ the balanced win-objective net — no downgrade), while **Blitz/Survivor ship their
> own checkpoints**. The internal `PPO`/`BC` nets are **hidden from players** (kept in `builtInBots.js`
> for the dev harness). The weaker `ppo-conqueror` checkpoint stays in the repo as a training artifact,
> not shipped. **Batch 2 (Expansionist + Predator, dense rewards) is still queued.**
>
> _(Update 2026-07-05: Conqueror no longer aliases `ppo-long` — it ships the encoding-v3 net in its
> own `conquerorPolicyWeights.js` per [D-31] §5, after the §10.1 bars passed; the hidden `PPO` keeps
> the frozen v2 `ppo-long` weights as the gate baseline.)_
>
> **Field-sensitivity audit (2026-06-30, `arena:ml`).** A 19,472-game seat-fair round-robin among the ML
> nets found the win-rate ranking is **field-dependent**: Survivor's `+8.4` BEAT above is a weak-bot-heavy
> gate-field effect (it leads on placement everywhere and on win% in mixed fields), but **Blitz** wins the
> most outright in all-ML play and **Conqueror**(=`ppo-long`) wins the pure heads-up (Conqueror beats
> Survivor `56–44`). See RESULTS.md → "Persona field-sensitivity audit."
>
> **v3 slate pre-registered (2026-07-04) — see §10.** The full v3 persona wave (retrains of
> Blitz/Survivor on the v3 base, a scoped **Predator revival**, Expansionist still parked, plus the
> Wave-0 eval builds it depends on) is designed and pre-registered in §10 below, conditional on
> `ppo-v3-scratch` passing its [D-31] §4 bars. Predator's kill-gate finality is scoped **"closed
> under the current wire"** (Ivan, 2026-07-04) — a fail falsifies the representability hypothesis,
> not the persona under a fixed credit-assignment wire.

---

## 1. Thesis

Reward shaping produces behaviorally distinct policies — that is its entire purpose in RL. The
goal here is a **roster of bots that are all well-trained but play with different tendencies**:
an expansionist that grabs land, a predator that hunts eliminations, a blitzer that wins fast, a
survivor that plays for placement. Value to the project:

- **Playability / fun.** Ivan's playtesting observation: today's PPO bot **turtles early —
  builds a dice reserve, then attacks.** Probably win%-optimal; not exciting to play against. A
  personality roster gives humans varied, characterful opponents.
- **Exploration insurance.** A shaped reward is also a different _exploration prior_. One persona
  might escape a local optimum the sparse reward gets stuck in, then transfer — i.e. a personality
  could, surprisingly, **out-win** the pure-wins bot. Don't bet on it, but watch for it.
- **Cheap.** Established earlier this session: runs are **serial-PPO-latency-bound** with idle
  CPU/GPU/RAM on shodan. 3–5 personas run **concurrently for ≈ the cost of one** — the natural
  first use of the concurrent-run harness.

### The one non-obvious constraint

**In DiceWars, the win condition _is_ owning all territory.** So "maximize territory" and "win"
are nearly the same objective — a naive territory reward will converge to almost the same policy
as pure-wins and yield **no personality.** Personalities only emerge **where the reward diverges
from winning.** Every persona below is designed around a deliberate divergence; the lever is
almost always one of:

- **dense vs. terminal** — reward _during_ the game (each turn) vs. only at the end. Dense rewards
  buy myopia (act now), which is most of what "aggressive" means.
- **net vs. gross** — reward net change, never gross gains (gross invites ping-pong reward-hacking).
- **multiplicative-time vs. additive-penalty** — both create "win fast"; only one is safe (§6).

---

## 2. Where the reward lives (implementation surface)

> **Now built (bite D):** the terminal reward is no longer a single hard-coded line — it is
> `dicewars_ppo.env.terminal_reward(...)`, selected by `--reward-mode {win,placement}` and an
> optional win-gated `--terminal-speed-bonus B`/`--speed-ref T`. The default (`win`, bonus 0) is
> byte-identical to the line below. The rest of this section is the original analysis that motivated
> that knob.

Originally the reward was **one line**:

```python
# ml/dicewars_ppo/env.py (pre-bite-D)
reward = float(frame.won)   # +1 if learner won, else 0  (sparse terminal-win, D-19)
```

The wire protocol (`ml/dicewars_ppo/wire.py`, `src/arena/trajectoryExport.js`) **already carries
more terminal signal than the reward uses**:

| Signal                                      | On the wire today?         | Cost to use as reward                                                       |
| ------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `won` (1/0)                                 | ✅ (used)                  | —                                                                           |
| `winner` (seat/-1)                          | ✅                         | free                                                                        |
| `placement` (1=1st…0=last, range-validated) | ✅                         | **built** — `--reward-mode placement` (Survivor)                            |
| `truncated` (stalemate cap)                 | ✅ (used)                  | **built** — gates the terminal payout to 0 (bite D; avoids double-counting) |
| `turn_number` (terminal frame)              | ✅                         | **built** — `--terminal-speed-bonus`/`--speed-ref` (Blitz)                  |
| Δterritory / turn                           | ✅ (shaped opt-in, bite G) | **built** — `--territory-reward-coef` (Expansionist); env-server NET delta  |
| elimination event                           | ✅ (shaped opt-in, bite G) | **built** — `--elim-bounty` (Predator); attributed via the `onTurn` hook    |

So **placement-, tempo-, and turn-count-based personas are now runnable with no wire change** —
the signals were already plumbed and bite D added the trainer flags that consume them
(`--reward-mode`, `--terminal-speed-bonus`, plus the long-standing `--gamma`). Dense-territory and
elimination-bounty personas still need the **JS env-server to emit a per-frame scalar** — a
wire/header addition carrying the same discipline as the encoding contract (bump a version
constant; JS emitter and Python consumer change in one commit). That is "bite G".

---

## 3. Two independent design axes — do not co-vary

1. **Reward objective** (this note's focus): what the +signal rewards.
2. **Opponent field**: who the learner trains against.

Keep them orthogonal. **Phase-3 is _already_ self-play** — a PFSP league of past snapshots +
heterogeneous baselines (B0–B6, [D-19]+ task B). "Pure self-play" (only past selves, no
hand-coded baselines) is a _separate_ experiment on axis 2: it tends to produce
internally-consistent-but-exploitable strategies and can collapse without diversity — the league
exists precisely to prevent that. **Change reward XOR opponent field per run, never both**, or you
can't attribute the behavioral difference. This note holds axis 2 fixed at the current league.

---

## 4. The roster

| Persona           | Reward change                               | Expected tendency                  | Diverges from win via                   | Impl cost          | Gate expectation          |
| ----------------- | ------------------------------------------- | ---------------------------------- | --------------------------------------- | ------------------ | ------------------------- |
| **Conqueror**     | `frame.won` (today)                         | Balanced; turtle→strike            | — (control)                             | none               | the bar (pure-wins)       |
| **Blitz / Tempo** | lower `gamma` (+ opt. terminal speed-bonus) | Fast, aggressive, early pressure   | multiplicative-time                     | **built** (flags)  | likely **below** bar; fun |
| **Expansionist**  | dense Δ(net territory)/turn                 | Grabs land now; overextends        | dense + net                             | **built** (bite G) | below bar                 |
| **Predator**      | bounty per player eliminated                | Hunts kills; takes risky finishers | dense + net                             | **built** (bite G) | below/near bar            |
| **Survivor**      | `placement` instead of binary win           | Conservative; plays for 2nd/3rd    | rank ≠ win (the "ELO trap", repurposed) | **built** (flag)   | high ELO, lower win%      |

### Conqueror (control)

Today's reward, re-run from the same warm-start as the others. **Required** as the baseline the
behavioral metrics (§7) are measured _against_ — "the predator eliminates 1.8× more players than
the conqueror" only means something with a matched control.

### Blitz / Tempo — Ivan's idea, and the most promising "fun" bot

The intuition: scale the win reward _down_ by game length so a 1-turn win is worth far more than a
1000-turn win, coaxing aggression. **This is principled** — see §6 for the full treatment. Short
version: the current `gamma=0.999` is _why_ the bot turtles (a slow win is worth ~82% of a fast one
— almost no tempo pressure), so the cleanest first cut is **just lower gamma** (e.g. 0.99 → a
200-turn win worth ~13% of an instant win). Optional escalation: the explicit bounded terminal
speed-bonus, now `--terminal-speed-bonus B`/`--speed-ref T` (bite D), keyed on the terminal frame's
`turn_number`. Foregrounded because it directly targets the turtle Ivan saw and is now a flag, not
new code.

### Expansionist

Dense reward of **net** territory gained each turn (never gross — §5). Buys myopia: grab land
_now_, even when consolidating is the higher-win% play. The terminal-only version of this collapses
back into Conqueror (territory-at-end ≈ winning), so the **dense** framing is load-bearing.

### Predator

A bounty each time the learner removes a player from the board. Pushes the bot to **take the kill**
even when it's risk-suboptimal for winning — the "aggressive, eliminates more players" bot Ivan
described. Derivable from placement deltas without a new territory field.

### Survivor — the "ELO trap" as a feature

[D-19] explicitly avoided placement reward for the gate bot, calling it **"the ELO trap"**:
optimizing rank rather than the win produces a bot that plays for 2nd/3rd instead of going for 1st
— great ELO, mediocre win%. For a _personality_ bot that conservative, survive-don't-conquer style
**is the deliverable.** Now a one-flag run — `--reward-mode placement` (bite D); the `placement`
signal was already on the wire, so it cost no wire change.

**Truncation must pay 0 (a bite-D correctness point).** A `maxTurns` stalemate cap is a Gym
_truncation_, not a realized terminal: `step()` returns `truncated=True` so SB3 **bootstraps**
`V(s)`. `terminal_reward` therefore pays **0 on a truncation in every mode** — paying the non-zero
rank-at-cap `placement` there too would _double-count_ the survival signal (reward **plus** a
bootstrapped value that already estimates the eventual placement) and reward **stalling to the
cap** — precisely the passivity failure §6 warns about. `win` mode is 0 on a cap regardless (a cap
can't be a win), so this only disciplines the placement path. Survivor still gets a dense placement
signal from the decisive majority of games that end in a genuine `GAME_OVER`.

**Warm-start critic note (corrected by the bite-F grounding).** The PPO critic is **always a fresh
scalar `value_net`** — `MaskableEdgePolicy._build` constructs it at random init and
`warm_start_from_bc` intentionally leaves it there, separate from the BC value head. The repacked
actor (`repack_to_bc_checkpoint` → `bc_net.state_dict()`) carries the trunk, the per-edge head, **and
the BC value head** (the `EdgePolicyNet`'s own `[won, placement]` head, which loads but PPO never
trains or reads — no loss references it) — but it carries **no PPO critic**. So a warm-start (BC _or_
`ppo-long`) never inherits a trained value function: the surviving BC value head is inert under PPO,
and the PPO `value_net` starts uncalibrated for **every** persona, Conqueror included (this is
unchanged from how `ppo-long` itself trained). For Survivor the practical wrinkle is
just that `placement` is a denser target (mean ≈0.5 vs win's ~0.25 for 4p), so the fresh critic has
more to fit early; PPO's per-batch advantage normalization absorbs most of it, but expect a noisier
first stretch, and a short value-head warmup or a higher initial `value-coef` may speed convergence.
Reward scale is otherwise comparable (both objectives top out at 1.0 pre-bonus), so shared
`lr`/clip/`value-coef` stay reasonable — no normalization change is _required_. (The earlier draft of
this note wrongly assumed `ppo-long`'s win-trained value head carries over; it does not.)

---

## 5. The tempo lever in depth (Blitz)

Ivan's framing: _"win in 1 turn → 1000 points; win in 1000 turns → 1 point."_ That's a
**multiplicative terminal time-bonus**, and it's the sharper cousin of the discount factor `gamma`,
which the trainer already exposes as `--gamma` (default **0.999**, in `_train_common.build_parser`).

**Why gamma is the principled lever.** With sparse `+1` terminal-win and discount `γ`, the value of
a state that wins in `T` steps is `γ^T · P(win)`. So `γ` _is_ a smooth "win fast" multiplier:

| γ     | value of a 200-turn win (vs instant) | tempo pressure                        |
| ----- | ------------------------------------ | ------------------------------------- |
| 0.999 | 0.999²⁰⁰ ≈ **0.82**                  | almost none — **why the bot turtles** |
| 0.99  | 0.99²⁰⁰ ≈ **0.13**                   | strong                                |
| 0.97  | 0.97²⁰⁰ ≈ **0.002**                  | extreme (likely reckless)             |

Lowering `γ` is the textbook way to induce "reach the goal quickly," is **lower-variance** than a
big explicit multiplier (the discount is baked into every bootstrap step, not dumped on one terminal
frame), and is a **zero-code-change** starting point.

**The safety insight — multiplicative beats additive, and Ivan's intuition is the safe one.**
There are two ways to say "win fast":

- **Multiplicative** (gamma, or Ivan's decay-multiplier): a win is `positive × decay > 0`; a loss
  is `0`. **A win can never be worth less than a loss.** Induces "win FAST" but **never "lose
  fast."** ✅
- **Additive per-step penalty** (`−c` each turn): a long win is `1 − c·T`, which for large `c·T`
  drops **below** an immediate loss's `0`. A mistuned penalty makes the bot **throw games to end
  them** — suicidal. ⚠️

So Ivan's multiplicative framing is exactly the _safe_ formulation. **Recommended Blitz config:**
lower `gamma` first (0.99, maybe 0.97); if that isn't punchy enough, add a small **bounded**
terminal speed-bonus `reward = won × (1 + b·clip(1 − turns/T_ref, 0, 1))` with `b` modest (e.g.
0.5) so it never dominates the win/loss ordering — now `--terminal-speed-bonus 0.5 --speed-ref T`
(bite D; `terminal_reward` implements exactly this formula, win-gated). **Secondary knob:** `ent_coef` — the applicable
default for the **warm-started** personas is **0.0** (the `--ent-coef` default in
`_train_common.build_parser`; `0.01` is only the _from-scratch_ fallback in `resolve_from_scratch`).
More entropy = more exploration = less likely to settle into the
safe turtle; bump it (e.g. toward `0.01`) for Blitz, but it's a training-dynamics knob, not a reward,
so tune it second.

**The tradeoff to measure, not assume.** The turtle is (as Ivan said) probably win%-optimal. Tempo
pressure **trades win% for speed/aggression** — a Blitz might win 38% fast vs Conqueror 45% slow.
That's _fine for a personality bot_, but §7's `avg turns-to-win` and aggression index must
**quantify** the shift so we know we bought aggression and how much win% it cost.

---

## 6. Reward-hacking & failure modes (design against these up front)

- **Gross-territory ping-pong.** Rewarding _gross_ territory gained lets the agent farm the signal
  by capturing-then-losing a border tile repeatedly. **Mitigation:** reward **net** territory only.
  (Potential-based shaping à la Ng et al. 1999 removes hacking but _provably preserves the original
  optimum_ — i.e. it gives you Conqueror faster, not a new personality. We deliberately do **not**
  use it for the persona reward; we accept a moved optimum and guard the hack manually.)
- **Additive-penalty suicide.** See §5 — keep tempo pressure **multiplicative**, never a large
  additive step cost.
- **Predator over-commitment.** An elimination bounty too large makes the bot take losing fights for
  a kill. **Mitigation:** bounty small relative to the terminal win; cap per-turn.
- **Survivor passivity / kingmaking.** Placement reward can produce a do-nothing bot that coasts to
  a non-last finish, or one that hands the win to whoever it last attacked. **Mitigation:** accept
  it as the persona's character, but floor it (a turtle-floor analog) so it still plays.
- **Encoding/contract skew.** Any new per-frame reward scalar (territory, elims) rides the JS↔Python
  wire — JS emitter and Python consumer **must change in one commit** with a version bump, same rule
  as `ENCODING_VERSION` (CLAUDE.md gotcha). A silent mismatch poisons the replay buffer.

---

## 7. Evaluation — behavioral harness, not just the gate

The current gate is **one number**: win% vs `ai_lookahead`. That can't tell you a personality
_emerged_. We need a **behavioral profile** per bot — and the arena **already records the inputs**
(`attacksMade`, `placements`, `turnCount` in the match/bot stats):

- **Aggression index** — attacks attempted per turn (or per owned territory).
- **Territory-over-time curve** — mean owned-territory trajectory across a game.
- **Elimination count** — players removed by this bot per game.
- **Avg turns-to-win** — the tempo metric; the Blitz headline.
- **Placement distribution** — Survivor's signature (rarely 1st, rarely last).

Deliverable: a small harness that runs each persona across a seed sweep and emits this profile, so
claims are **measured** ("predator eliminates 1.8× the conqueror's rate"), not vibes. This is the
artifact that makes the roster credible. **The full grounded spec is now
[EVAL_HARNESS.md](./EVAL_HARNESS.md)** — it adds the metrics this short list omits (most importantly
**avg dice reserve / dice-per-territory**, the literal turtle signature; plus capture efficiency,
zero-attack-turn fraction, border exposure), the statistical rigor (MDE/power so "distinct" can't fire
on a trivial difference; one pre-registered signature per persona with Holm), and the build plan
(Phase 1 = harness + tests on existing built-ins; Phase 2 = profile the personas once trained). It
reuses the existing `meanCi`/`pairedDelta`/`rotatedField` machinery and needs only **one small,
backward-compatible engine signal** — the `onTurn` actor arg — which **shipped with the Phase-1
harness** (see EVAL_HARNESS §6).

**On "plays better / more fun against humans" — be honest about what's trainable.** Self-play
optimizes against _bots_; humans blunder differently, and we have **no human game logs at scale**
(BC imitates `ai_lookahead`, not people). So "fun vs humans" is **not a reward we can write** — it's
an **empirical playtest filter**: generate the diverse roster cheaply, Ivan plays them, we keep what's
fun. The roster makes that filter _possible_; it doesn't automate it.

---

## 8. Execution plan (post-`ppo-long`)

1. **Land the harness first** (§7) — measure today's Conqueror to set the baseline profile.
   _(Bite E1 — done: the harness can load a persona's exported weights and gate its signature.)_
2. **Wire the reward knobs:** ✅ _bite D_ — `--reward-mode {win,placement}` +
   `--terminal-speed-bonus`/`--speed-ref` (plus the long-standing `--gamma`/`--ent-coef`) make
   Conqueror/Blitz/Survivor runnable with no wire change. ✅ _bite G_ — the per-frame territory/elim
   scalar now rides an **opt-in shaped obs-frame** (env-server `--reward-shaping`, off by default →
   byte-identical wire; the B5/B6 pattern), consumed by `--territory-reward-coef` (Expansionist) /
   `--elim-bounty` (Predator) / `--shaping-clip` via the pure `step_reward`. It is a frame-HEADER
   variant, **not** an `ENCODING_VERSION` bump (the observation tensor is unchanged — see [D-28]).
3. **One persona = one reward config + one run**, all **warm-started from `ppo-long`'s final
   policy** (shared good initialization; reward shaping then specializes), running **concurrently**
   on shodan (latency-bound, idle hardware). Re-run Conqueror as the matched control. _(Bite F — done:
   the `PERSONA` knob in `scripts/shodan/ppo-train.sh` + the RUNBOOK "persona" batch recipe make this a
   one-line launch per persona; concurrency is collision-free.)_
4. **Profile + gate each** (behavioral harness + `ppo:gate`), write results to `RESULTS.md`, log
   the framework decision (`D-27?`) and any wire-contract change (`D-28?`) to `DECISIONS.md`.
5. **Ship the fun ones as selectable in-game bots** — the `ai_ppo` wiring (PR #74) generalizes:
   each persona is a weights file + a thin `ai_<persona>.js` alias + an `aiConfig`/`builtInBots`
   registration. The in-game dropdown gains a characterful roster.

## 9. Open questions for Ivan

- **Roster size for the first concurrent batch** — all 5, or start with Conqueror + Blitz +
  Predator (the clearest behavioral contrasts) and add the rest once the harness proves out?
- **Blitz aggression budget** — how much win% are we willing to trade for excitement? (Sets the
  `gamma` floor and the speed-bonus weight.)
- **Do personas need to clear any bar at all**, or is "plays legally + is fun + has a measurable
  distinct profile" the only requirement for a _personality_ bot (vs. the gate bot)?

---

## 10. v3 persona slate — pre-registration draft (2026-07-04)

> **Provenance:** designed 2026-07-04 via a 12-agent workflow — six extractors over this folder +
> the trainer code, three independent slate designs (player-experience / training-feasibility /
> evaluation-rigor lenses), each adversarially red-teamed. The three designs converged on the same
> core slate; the red-team catches are folded in below and flagged inline. **Predator closure
> scoping resolved by Ivan (2026-07-04): "closed under the current wire," not "closed
> permanently."** This section is the durable record — future sessions should pick up from here,
> not re-derive.

### 10.1 Premise and conditionality

> **RESOLVED 2026-07-05: both bars PASSED** (primary +6.1 pp fresh-seed h2h over
> `ppo-scratch-long`; ship +5.5 pp h2h over Survivor — see `RESULTS.md`), so the slate proceeds
> on the full-pass path: Conqueror ships the v3 base weights, and every retrain below
> warm-starts from `ml/runs/ppo-v3-scratch/ppo.pt`. Wave-0 item 4 (the head-to-head
> weights-loader, §10.7) also landed that session via `ppo:gate --bar Name=weights.js`.

Conditional on `ppo-v3-scratch` (20M, fixed `turnClockNorm`, `ENCODING_VERSION=3`, pinned
`464a2ee`) passing the [D-31] §4 bars: **primary** = beat `ppo-scratch-long` head-to-head;
**ship** = beat Survivor head-to-head (then its weights ship as Conqueror per the [D-27] pattern).
If primary passes but ship fails, the slate survives intact with one change: the shipped Conqueror
keeps the v2 `ppo-long` weights while the v3 net serves as **training base only** — every retrain
below still warm-starts from it (strongest base), and every retrain already has a keep-v2 fallback.
The 9-seat gate field keeps the v2 `ppo-long` as its `PPO` seat either way (era comparability — no
row boundary).

### 10.2 The slate

Four player-facing personas + one internal control arm. **Expansionist stays PARKED** — the
[D-30] §7 algebra is a _reward-shape_ defect (`coef·(1−γ)·territory-held` stock residual whose
optimum is turtling); no observation column fixes a reward shape, and Batch-2B showed the
placement family already paints maps better (Pred-b15 avgTerritory +1.83 > the Expansionist bar
+1.5). A "Berserker" γ0.97 entry-rung wildcard was considered (product lens) and **deferred**: its
bar package was incoherent as drafted (an "entry-rung" persona floored at Expectimax ≈ Lookahead
parity), and two rush fantasies separated by 0.3 aggression risk being one rush bot.

**Shared recipe (every arm):** warm-start `CHECKPOINT=ml/runs/ppo-v3-scratch/ppo.pt` — the v2
`runs/ppo-long/ppo.pt` is rejected as-is (`load_bc_checkpoint` hard-rejects non-v3 checkpoints;
the sanctioned workaround if the [D-31] fallback ever fires is `migrate_encoding` zero-widening,
and a migrated `v3-base` checkpoint already exists); `EXPECTED_ENCODING_VERSION=3`; `LR=1e-4`,
`ENT_COEF=0.01`; R=3 reserve baselines (LOCKED, [D-24]); PFSP league on with each run breeding
**only its own snapshots** (siblings never join a pool — §3's reward-XOR-field rule); fresh
`RUN_NAME` = fresh `--state-dir` per arm (MANDATORY — SB3 resume silently restores old γ);
`EVAL_EVERY=500000` **set explicitly at launch** (the launcher default is 1000000) so every arm
feeds the [D-29] strength-curve scorer. Critic is a fresh scalar `value_net` for every warm-start
(§4); placement arms get a noisier first ~0.5M — acceptable as-is (v2 Survivor converged fine).

| Arm               | RUN_NAME               | Reward flags                                                           |     γ | Steps   | Notes                                                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------- | ----: | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Conqueror (ships) | — (no run)             | v3 base weights as-is                                                  |     — | 0       | The −7.6 lesson ([D-27]): never ship a same-objective fine-tune of the flagship                                           |
| Conqueror-control | `ppo-v3-conq-ctl`      | `--reward-mode win`                                                    | 0.999 | 3M      | Never ships; matched control for signatures + re-measures continuation drift on the v3 base                               |
| Blitz-v3          | `ppo-v3-blitz`         | `--reward-mode win` (**no** speed bonus in the primary arm)            |  0.99 | 3M      | Plain γ0.99 is the proven one-knob recipe; speed bonus = pre-registered escalation only (see below)                       |
| Survivor-v3       | `ppo-v3-survivor`      | `--reward-mode placement`                                              | 0.999 | 3M      | Truncation pays 0 (unchanged, every mode)                                                                                 |
| Predator pilot ×2 | `ppo-v3-pred-b{15,25}` | `--reward-mode placement --elim-bounty {0.15,0.25} --shaping-clip 1.0` | 0.999 | 1M each | Bracket stays LOW — kills fell monotonically as bounty rose in v2; better input argues for less reward pressure, not more |
| Predator winner   | `ppo-v3-predator`      | winning coef                                                           | 0.999 | 3M      | Only on pilot pass; the confirmatory kills signature must **re-pass at 3M**                                               |

**Why v3 enables each:** Blitz — `turnClockNorm` is the first trainable _time input_ the policy
has ever had (v2 Blitz felt time only through the discount); `turnsUntilActsNorm` lets it time
strikes. Survivor — `ownerTerrFrac`/`ownerDiceFrac` (who is actually the threat),
`turnsUntilActsNorm`, cap awareness via the clock. Predator — see 10.3.

**Blitz escalation (pre-registered now, fired at most once):** if the 1M probe shows aggression
Δ < +0.3, relaunch with `--terminal-speed-bonus 0.5 --speed-ref <T>` where T = the control's
median terminal `turn_number`. Three caveats: (a) terminal `turn_number` is logged nowhere today —
but it already crosses the wire into Python (`env.py` `_info()` emits it per step), so the hook is
nearly free (e.g. `VecMonitor(venv, info_keywords=("turn_number",))`); (b) **unit mismatch** —
header `turn_number` is the ENGINE turn counter (≈ player-turns ÷ playerCount);
`turnClockNorm`/truncation count completed player-turns. Calibrate from the header distribution,
never from the clock column; (c) **`train.py`'s own `--speed-ref` help text says "player-turns" —
that is WRONG** (the formula consumes header `turn_number` = engine rounds; following the help
would set T ~7× too high, pinning the bonus at max). Fix the help string before the escalation
ever fires.

**Checkpoint selection (all arms):** the final fixtured eval-stream checkpoint ships _unless_ the
[D-29] k=2 regression detector fires on the tail — in which case the arm is **killed, not
argmax-rescued** (winner's-curse guard). Every ship verdict is confirmed at fresh `--seedbase`
(offset ≥ run count, 2× runs); the fresh-seed number is the reported strength.

### 10.3 Predator revival — scoped honestly

The revival case is [D-31]'s retro-diagnosis: v2 Predator was **unrepresentable** — the bounty was
correctly attributed at training time, but no input distinguished a killing blow from any
weak-neighbor attack. v3's per-edge **`eliminatesDefender`** puts the bountied event directly in
the action features; `ownerTerrFrac` exposes players on their last holdings. The two v2 fixes that
worked carry over unchanged: placement backbone (prices death; killed the bounty-suicide basin)
and low bounty + clip.

**Two live hypotheses, not one (red-team catch, all three critics independently).** The LOG
records a second root cause the encoder does not touch: **kill credit for non-terminal kills lands
diluted on turn-boundary frames** — a wire/credit-assignment property of `elimsByLearner`. This
wave therefore tests _representability given diluted credit_. **Per Ivan (2026-07-04): a failure
closes Predator "under the current wire"** — the representability hypothesis is falsified, but the
persona may be revisited if the frame-level kill attribution is ever fixed (a [D-28]-pattern
header/timing change). No coef re-sweeps under the current wire in either case. Optional
attribution aid: a small advantage-mass-near-kill-frames diagnostic on the pilot rollouts would
tell us which hypothesis actually bound.

**The vulture hack (new for v3, pre-registered guard).** With killing blows now legible, the
reward maximizer is last-hit _scavenging_: play Survivor, never soften anyone, snipe 1-territory
players others doomed — passes "kills higher" while being Survivor-with-kill-steals. Guard: a
descriptive **scavenge co-read** (victim's territory count / time-at-one-territory before the
killing blow) as a ship-blocking sanity check. Also noted: the aggregate bounty ceiling (6 kills ×
0.25 = 1.5) exceeds the placement range [0,1] — accepted explicitly rather than hidden.

**Threshold provenance (red-team catch).** The +0.25 kills bar was [D-30]'s _interim_ bar; the
pre-registered MDE was 0.5. On a closure-grade gate, don't silently keep the lower number:
**confirmatory bar = kills ≥ 15% of the realized comparator's kills** (≈ +0.28 vs Survivor-v3's
1.86–1.92), with +0.25 explicitly labeled the pilot bar. Comparator = whichever Survivor ships
(pre-registered fallback if Survivor-v3 fails its keep-v2 gate). _(Outcome 2026-07-06: the fallback
fired — Survivor-v3 was killed, so the comparator is **v2 Survivor** and the ≈+0.28 figure is void;
recompute the 15% bar from v2 Survivor's realized kills in the v3-era profile field before pilot
grading. [D-32].)_

### 10.4 New v3 hazard class — the clock cuts both ways (pre-register before Wave 1)

With `turnClockNorm` visible, truncation paying 0, and a decisive end paying rank, the
reward-optimal near-cap policy for **placement arms is not stalling — it is forcing _any_ decisive
end, including dying at rank 2–4 to bank ~0.5–0.83 (7-player scaling) rather than truncating to 0.** The existing
tripwires only watch the stall basin. New tripwire on Survivor-v3 and both Predator arms:
**truncation-rate + late-game-aggression-spike / learner-death-within-N-turns-of-cap monitor.**
(Magnitude is bounded by how rarely the 500-turn cap binds, but Survivor-style play lengthens
games toward the cap — exactly where the gradient lives.)

_(**As built — landed 2026-07-05; the 50/0.05/0.3 numbers are DRAFTED for Ivan's ratification.**
`behavior:profile` now measures three clock-hack axes per game vs the pinned comparator — added to
`AXES` in `behavior-core.mjs`, so they auto-carry the paired Δ machinery, but deliberately kept OUT
of `PERSONA_SIGNATURES`/`SIGNATURE_AXES`/Holm (a kill-gate, not a "distinct persona" PASS). Windows
are **player-turns**, the `runMatch` cap unit:_

- _**`nearCapDeathRate`** — fraction of the arm's games where it is eliminated within
  `NEAR_CAP_WINDOW = 50` turns of the 500-cap (the "dies at rank 2–4 to bank ~0.5 rather than
  truncate to 0" tell)._
- _**`lateGameAggressionSpike`** — mean attacks/turn in the arm's own turns within `LATE_WINDOW = 50`
  of the cap MINUS its whole-game per-turn mean (the "suddenly attacks to force a decisive end"
  tell); **null** on games that never reach the late window, so short games don't dilute it._
- _**`truncationRate`** — fraction of the arm's games that hit the cap (`winner === null`); the
  CO-SIGNAL, since a clock-hacker AVOIDS truncations (they pay 0) by forcing decisive ends._

_**Firing (`CLOCK_HACK_TRIPWIRES`):** a primary FIRES when its paired Δ vs the comparator clears the
magnitude AND its 95% CI excludes 0 in-direction — `nearCapDeathRate` HIGHER ≥ **0.05** (the
`zeroAttackTurnFrac` +0.05 style), `lateGameAggressionSpike` HIGHER ≥ **0.3** (the aggression MDE);
`truncationRate` LOWER ≥ **0.05** is the co-signal (corroborates, never kills alone). **KILL rule
(§10.8): any primary fires.** `evaluateClockHack(vsControl)` returns the panel + a `kill` boolean;
the CLI prints a "Clock-hack tripwire (§10.4)" panel and `--json` carries `bots[].clockHack`.
**Power caveat:** the late window only populates in games approaching the cap, so on short decisive
games the spike is `null` and the near-cap-death primary + truncation co-signal carry the monitor —
recalibrate the three numbers from the Wave-1 control's own 0.5M/1M near-cap probes (§10.5 pins the
comparator = raw v3 base) before enforcing them, exactly as the §10.5 winPct floor is recalibrated.)_

### 10.5 Evaluation methodology

- **Dual-control signatures (red-team catch).** The control arm is _expected_ to drift (the −7.6
  precedent), so a signature measured only against it conflates persona effect with control decay
  — and the contrast players feel is vs the shipped Conqueror (the untouched base). Profile every
  persona against **both** the control (training-recipe attribution) and the raw v3 base (product
  claim); a signature that passes against only one is flagged, not shipped. _(Outcome 2026-07-06:
  Blitz-v3 was exactly this case — CONFIRMED vs base, sub-MDE vs the control — and was **shipped
  anyway on strength grounds by explicit maintainer override**, the flag retained as an attribution
  caveat; see [D-32](./DECISIONS.md).)_
- **Signatures** (Holm-adjusted; family registered as **4, becoming 5 if the Blitz escalation
  fires** — registered now, not post-hoc): Blitz = aggression ≥ +0.3 AND turnsToWin ≤ −5;
  Survivor = avgPlacement ≥ 0.4 better; Predator = the 10.3 kills bar vs the matched Survivor
  comparator. All at `behavior:profile` ship-grade 10×30×6; pilots 6×30×6 (budgets provisional
  pending a first-arm SD check per EVAL_HARNESS §11.4).
- **Strength bars.** Hard floor for every shipped persona: BEAT Lookahead (paired Δ CI > 0,
  20×17×9). **Plus a bar vs the v3 base** (red-team catch — the v2 `PPO` seat is now far too weak
  an anchor; "not BEHIND `--bar PPO`" would tolerate a double-digit regression from warm-start):
  not BEHIND own warm-start by more than **8 pp** (paired Δ CI lower bound > −8; provenance: the
  −7.6 control-drift precedent defines the "pure drift, zero style gain" magnitude — a persona may
  not pay more than drift for its style). Measured via the sibling-candidate run-paired method at
  the same seedbase (the v3 base is graded as a Candidate, never seated in the field — [D-29]).
- **Retrain non-regression.** Blitz-v3/Survivor-v3 must not be BEHIND their v2 siblings,
  **re-gated fresh in the same session** (not compared to the archival 2026-06-30 arrays — three
  field bots are unseeded, cross-time "pairing" is not pairing). Fallback: keep shipping the v2
  checkpoints (slice-compat keeps them legal forever) — the roster is never worse than today; the
  whole wave is upside.
- **Distinctiveness without waiting for `--melee`:** all arms + control + base are profiled with
  identical field/seeds, so a small profile-pairing script yields the pairwise separation matrix
  directly. Requirement: **every shipped pair separates on ≥1 pre-registered axis at MDE**
  (pairwise MDEs = the calibrated per-axis values: aggression 0.3, turnsToWin 5.0, avgPlacement
  0.4, kills per 10.3). **If Predator cannot separate from Survivor, it has no roster slot
  regardless of its bars** (kill condition, pre-committed). `--melee` co-seating stays a Phase-2b
  deferral (answers a different question — behavior against each other). _(Landed 2026-07-05:
  `npm run behavior:separation` over `behavior:profile --json` reports — which now persist
  per-run arrays + opponent-weights specs + git/time provenance (dirty trees stamp `-dirty`);
  `--require-separated` enforces this bullet's requirement at exit-code level over the SHIPPED
  roster — the signature personas plus the Conqueror base, `--shipped` for versioned arm names,
  exit 1 when the gate would gate nothing; cross-report pairing hard-fails on config/SHA drift.
  See EVAL_HARNESS §3.5 "As built".)_
- **Negative controls (run before grading any persona):** (1) an **A/A profile** of the v3 base
  against itself — signature axes must return |Δ| < MDE/3 (numeric tolerance registered now;
  restrict the halt rule to signature axes so unseeded-field noise on descriptive axes can't halt
  the batch); (2) test-retest one checkpoint twice for the gate's empirical noise floor; (3) the
  control arm run through all four signatures **vs the base** (defined explicitly as control-vs-base)
  — if matched-objective fine-tuning alone passes any signature, that signature measures drift,
  not personality: fix before claiming anything.
  - _(Landed 2026-07-05, Wave-0 item 5: NC1 + NC2 + the #97 probe pre-flight ship as `npm run
behavior:preflight` — see EVAL_HARNESS §3.9. NC1 profiles the base against itself at the SAME
    seeds (the base is deterministic, so the paired Δ cancels map variance and isolates the
    unseeded-opponent noise). **Refinement to ratify:** the live n=8 A/A on the v3 base showed the
    registered raw "|Δ| < MDE/3" false-halts `turnsToWin` — a winners-only, high-variance axis whose
    per-run game length swings ≫ tol (Δ ≈ −4.7 ± 9.1) even though the true self-difference is 0. So
    NC1 CERTIFIES an axis only when its paired 95% CI ⊆ ±tol (equivalence). **BIASED** — the halt —
    additionally requires **Holm-significant** (family-wise α across the five signature axes) evidence
    the self-difference is beyond ±tol, because declaring bias from ONE stochastic A/A is a hypothesis
    test that per-axis false-fires ~1-in-11 across the family and degenerates to the raw point test
    when a small-n CI collapses (a zero paired SE is capped at the 2⁻ⁿ sign-agreement bound). So the
    family-wise false-HALT rate is ≤ α and → 0 as runs grow (measured: the pathological runs=3/games=4
    config fell from ~9% → 3% false-HALT; ≈0 at the operational n=8). A systematic harness bug's t
    grows with n and survives Holm; sampling noise does not. This tests the same "is the
    self-difference within the floor?" question but correctly separates a bias from sampling noise.
    On the shipped v3 base it CLEARs (no bias; the noisy axes flag INCONCLUSIVE). NC2 = `ppo:curve
    --test-retest` (already built). NC3 (control-vs-base) waits for the Wave-1 control arm.)_
- **Ladder honesty.** The v2 audit proved win-rate rank flips with field composition, and the
  premise itself says the base beat Survivor-v2 head-to-head — so no pre-written ladder. Label
  picker rungs from **fresh-seed measured placement in the mixed field** (the one field-stable
  statistic), and write picker copy _after_ Wave 1 from the v3-era `arena:ml` matrix.
- **Tripwire panel** (unchanged [D-30] thresholds + the 10.4 addition), probed at 0.5M/1M from
  fixtured eval checkpoints: turtle basin ΔavgDiceReserve > +10, ΔzeroAttackTurnFrac > +0.05,
  ΔturnsToWin > +20; overextension basin ΔsurvivalTurn < −60 with co-signal (winPct < 40 or
  ΔavgPlacement > +0.3); tiering warn-at-0.5M-on-1 / kill-on-2+-or-2× / kill-at-1M-on-any.
  **Caveat (red-team catch):** the absolute winPct < 35 floor was calibrated on arms running
  43–58%, but the v2 control itself profiled 34.5 ± 2.6 — recalibrate the floor from the Wave-1
  control's own 0.5M/1M probes before enforcing it on Wave 2. Wave-1 probes diff against the raw
  v3 base weights (the control is still training concurrently — comparator pinned now).

### 10.6 Fine-tune vs. more scratch runs

Fine-tune the batch; don't scratch-train personas. 3M @ lr 1e-4 produced full style
differentiation _and_ a strength gain in v2 at ~1/6th the cost of a base run, while a style reward
from step one on a scratch net has no competence prior and a real turtle-equilibrium risk. The one
registered scratch trigger: **if Survivor-v3 beats the v3 base head-to-head again, the parked
[D-27] follow-up ("placement as the flagship objective") becomes its own pre-registered question —
a 20M placement scratch run as a v4 candidate.** No automatic reship this wave.

### 10.7 Sequencing

- **Wave 0 (now, zero GPU, Mac/mini — can start before `ppo-v3-scratch` finishes):**
  1. [D-29] strength-curve scorer Phase 1 (+ `runGateSweep` extraction) — **hard Wave-1 launch
     precondition: one real checkpoint scored end-to-end on the mini** (it is the substitute for
     the missing KL/anneal drift control); _(landed 2026-07-05: `npm run ppo:curve` —
     `scripts/ppo-strength-curve.mjs` + STRENGTH_CURVE.md "As built" notes)_;
  2. Holm adjustment in `behavior-core.mjs` _(landed 2026-07-05: `holmSignatures` +
     `--holm-family`, exact-t p-values via `stats.mjs` `tSf`/`holmAdjust`; family registered at the
     `PERSONA_SIGNATURES` count per §10.5, CONFIRMED = registered single-test gate AND Holm — see
     EVAL_HARNESS §3.3 "As built")_;
  3. the profile-pairing separation script (10.5) _(landed 2026-07-05: `behavior:separation` —
     `separationPair`/`killsPairMde`/`assertPairableReports` in `behavior-core.mjs`, per-run
     arrays + provenance in the profile report, the §10.3 relative kills bar, and
     `--require-separated` for the ship requirement/kill condition — see EVAL_HARNESS §3.5
     "As built")_;
  4. a **weights-loader for head-to-head bars** — `arena:ml --bots` accepts built-in names only
     and `buildGateField` throws on non-field bar names (verified), so the "beat v2 sibling" and
     "vs v3 base" bars are unrunnable without a `Name=weights.js` spec port;
  5. pre-flight the #97 probe path; run negative controls 1–2; _(landed 2026-07-05:
     `behavior:preflight` — loads a fixtured eval checkpoint end-to-end + asserts the fixture-less
     guard, the A/A signature noise floor `signatureNoiseFloor` (CI-equivalence CERTIFY + a
     Holm-corrected, family-wise BIASED halt that de-cry-wolfs a stochastic A/A), and reads NC2's
     `ppo:curve --test-retest` spread; EVAL_HARNESS §3.9)_;
  6. a **3-arm throughput probe** before committing Wave 1's `N_ENVS` — batch-1's ~175 fps figure
     and the ≤20-env-server proven footprint don't obviously support 3×12 envs, and the v3
     encoder costs ~5–9%. _(landed 2026-07-05: `npm run ppo:arm-throughput` —
     `scripts/ppo-arm-throughput-probe.mjs` + `lib/ppo-arm-probe-core.mjs`; two TIMED passes over
     the real `runSelfPlayEpisode` path (v3 encoder cost captured natively), one arm alone vs all
     3 at once, reporting the per-arm contention penalty + a one-sided go/no-go: it measures the
     env-sim CEILING (upper bound on trainer fps), so **RED = ceiling below the 175 fps/arm target
     with zero GPU cost is conclusive** — reduce `N_ENVS` or arms; GREEN = env-sim isn't the limiter
     (GPU/latency then decide). **Run it on shodan** (contention scales with core count); zero-GPU,
     ~a minute. RUNBOOK §8e.)_
- **Wave 1:** Conqueror-control + Blitz-v3 + Survivor-v3, 3 concurrent × 3M, ~5 h wall (v2
  precedent 4.7 h). Survivor first-wave because it is the strongest lever, answers the flagship
  question, and is Predator's mandatory comparator.
- **Wave 2:** both Predator pilots (needs Survivor-v3), 2 × 1M, ~4 h; 0.5M tripwire probes.
- **Wave 3 (contingent):** Predator winner at 3M (~5 h), plus the Blitz escalation arm if
  triggered (+3M).
- **Envelope:** ~14M steps / ~13–16 h GPU core, ~17M / ~18–20 h with contingencies fired; 2–3
  calendar days end-to-end given Ivan-gated schtasks launches.
- **Ship plumbing per winner:** packed export into `src/ai/` (never bare `npm run ppo:export`
  from a run dir), export-parity check, thin `ai_<persona>.js`, `builtInBots.js` entry tagged
  `persona: true` (stays out of the gate field), picker copy per 10.5.

### 10.8 Kill-gates (pre-committed)

- **Conqueror-control:** cannot be killed (instrumentation). If it _beats_ the base head-to-head,
  halt slate ship decisions and investigate (contradicts the drift lore).
- **Blitz-v3:** killed by the tripwire panel; or BEHIND v2 Blitz at 3M (fresh re-gate); or
  Holm-adjusted signature fail including the one escalation. Consequence: ship v2 Blitz unchanged.
  _(Outcome 2026-07-06: no kill condition fired — SHIPPED v3 (#120), BEAT v2 +11.6, with the §10.5
  dual-control flag accepted as an attribution caveat. [D-32].)_
- **Survivor-v3:** killed by the tripwire panel; or BEHIND v2 Survivor; or signature fail; or the
  §10.4 clock-hack monitor firing — now operational: `evaluateClockHack()` returns `kill=true` when
  either primary tripwire fires (`nearCapDeathRate` +0.05 or `lateGameAggressionSpike` +0.3, each
  CI-excludes-0 vs the raw v3 base). A Survivor that games the now-visible clock is a reward hack —
  keep v2, and log the finding as a v3-encoding hazard note. _(Outcome 2026-07-06: KILLED, but by
  the strength/signature gates, not the clock monitor — BEHIND v2 −5.9, BEHIND base −20.8, signature
  fails both comparators; §10.4 stayed clean (a genuine turtle). Keep v2. The control arm's §10.8
  check also resolved: paired h2h TIE +1.1 — its +5.5 in-field winPct was a field artifact; judge
  controls on head-to-head. [D-32].)_
- **Predator:** killed by the tripwire panel; or failing the Lookahead floor; or neither pilot
  clearing the 10.3 confirmatory bar; or passing kills but failing to separate from Survivor on
  the matrix; or the scavenge co-read showing vulture behavior. Consequence per Ivan's ruling:
  **closed under the current wire** (revisitable only with a frame-level kill-attribution fix;
  no coef re-sweeps under this wire).
- **Slate-level:** the shipped trio (Conqueror + Blitz + Survivor, v3 or retained v2 checkpoints)
  is a complete product regardless — every conditional arm is upside, not gap-fill. If a negative
  control fails, grading halts for the whole batch until the harness issue is fixed.
