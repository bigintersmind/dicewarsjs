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

| Signal                                      | On the wire today?                   | Cost to use as reward                                                         |
| ------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `won` (1/0)                                 | ✅ (used)                            | —                                                                             |
| `winner` (seat/-1)                          | ✅                                   | free                                                                          |
| `placement` (1=1st…0=last, range-validated) | ✅                                   | **built** — `--reward-mode placement` (Survivor)                              |
| `truncated` (stalemate cap)                 | ✅ (used)                            | **built** — gates the terminal payout to 0 (bite D; avoids double-counting)   |
| `turn_number` (terminal frame)              | ✅                                   | **built** — `--terminal-speed-bonus`/`--speed-ref` (Blitz)                    |
| Δterritory / turn                           | ❌                                   | small: env-server emits a per-frame scalar → wire/header field + version bump |
| elimination event                           | ❌ (derivable from placement deltas) | small, same as above                                                          |

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
| **Expansionist**  | dense Δ(net territory)/turn                 | Grabs land now; overextends        | dense + net                             | small (wire field) | below bar                 |
| **Predator**      | bounty per player eliminated                | Hunts kills; takes risky finishers | dense + net                             | small (wire field) | below/near bar            |
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
scalar `value_net`** — `MaskableEdgePolicy._build` constructs it at random init, separate from the
BC value head, and the repacked actor (`repack_to_bc_checkpoint` → `bc_net.state_dict()`) carries
**only** the trunk + per-edge head, never a critic. So a warm-start (BC _or_ `ppo-long`) never
inherits a trained value function — the critic starts uncalibrated for **every** persona, Conqueror
included (this is unchanged from how `ppo-long` itself trained). For Survivor the practical wrinkle is
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
   Conqueror/Blitz/Survivor runnable with no wire change. **Still TODO (bite G):** add the per-frame
   territory/elim scalar to the env-server wire (Expansionist/Predator) behind a version bump, off by
   default (byte-identical to today when unset — the B5/B6 opt-in pattern).
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
