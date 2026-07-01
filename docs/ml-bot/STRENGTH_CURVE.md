# Checkpoint strength-curve harness

> **Status:** Phase 0 (producer) ✅ SHIPPED (PR #97). Phase 1 (scorer) ⬜ **DESIGN — reviewed
> 2026-07-01** (multi-agent code-grounded review; every finding adversarially verified against
> the repo). Amendments applied; the five open questions are **resolved** (see
> [Resolved questions](#resolved-questions-2026-07-01-review)). Ready to build.
>
> **Last updated:** 2026-07-01 · **Owners:** Ivan (+ Claude)

## Why this exists

We train a PPO run to a fixed step budget, export the **final** checkpoint, and grade
only that one. That hid a real failure: taking `ppo-long` from 20M steps to 23M made it
**worse** — `ppo-conqueror` gated **−7.6 BEHIND** `ppo-long` — and we didn't find out until
after training, because we never measured the intermediate checkpoints. "Was 18M the magic
number?" was unanswerable: we had no strength-vs-steps record.

This harness makes strength a **curve**, not a single terminal read:

1. **Phase 0 — producer** (shipped): the trainer drops a durable, gradeable checkpoint
   every `--eval-every` steps (default 1M) into `--eval-dir`.
2. **Phase 1 — scorer** (this design): a Node script that walks that stream — **live, in
   `--watch` mode, while the run trains** — grades each checkpoint on the seat-fair gate,
   and emits a strength curve + plateau / regression analysis. Watch mode is what actually
   closes the motivating loop: a batch-only walker still only tells you _after_ training
   (for the 3M persona fine-tunes, ≈4.7 h, that's the same moment the real gate did).

> ⚠️ **Naming trap.** "Phase 0 / Phase 1" here are **local to this harness** and are unrelated
> to the [`PLAN.md`](./PLAN.md) phases (Phase 0 = search bot, Phase 1 = harness hardening) and
> the [`EVAL_HARNESS.md`](./EVAL_HARNESS.md) phases. Same words, different mini-project.

## What it can and can't tell us (read before over-trusting a wiggle)

Be honest about the statistics up front, because it governs the whole design:

- The headline gate at its default budget (`--runs 20 --games 150` = 3,060 seat-fair games on
  the 9-seat field) has produced paired-Δ 95% CI half-widths of **±1.7 to ±3.1 pp** across all
  recorded runs (tracer ±1.7, BC anchor ±2.4, control ±3.1, headline ±2.7, personas ±2.0–2.4);
  plan on **~±2.5 pp**. We have **zero within-trajectory adjacent-checkpoint data** — nobody has
  ever graded two checkpoints of one run — so whether adjacent 1M checkpoints differ by less
  than the CI is exactly what the first curve will measure. (The from-scratch 1M control at
  +26.9 vs the warm-started 20M headline at +27.7 is a _cross-run, cross-initialization_ pair —
  suggestive, but not evidence about one trajectory.) By CI arithmetic alone, "pick the single
  best checkpoint to 1M resolution" is **not** a promise this harness can keep.
- What it **can** do dependably, and why it's worth building:
  - **Regression detection** — with the run-paired k=2-consecutive rule below, a sustained
    ≥~5 pp drop (the 20M→23M `ppo-conqueror` failure was −7.6) is caught with ~99% power at
    ~5% family-wise false-positive rate, while it's a curve point instead of a shipped surprise.
  - **Plateau onset** — report the step region past which Δ stops improving beyond the paired
    test's resolution, so we can stop burning GPU-days on a flat tail. Honestly stated: at this
    budget "plateau" means _per-1M gains below ~2–3 pp_ — a coarse GPU-budget conclusion, not a
    1M-resolution knee. (A finer knee is a budget knob: 4× games near the suspected knee.)
  - **A durable, re-gradeable record** — every checkpoint keeps its `.weights.js`, parity
    fixture, and `.pt`, so any of them can be re-graded later or re-exported to ship.
    **Durability caveat:** `makeBC` rejects any policy whose `encodingVersion` ≠ the live
    `ENCODING_VERSION` (`src/ai/ai_bc.js`), so an encoding bump makes archived streams
    ungradeable at HEAD — another reason rows must record their grading conditions (see
    [Provenance](#provenance)).
- **Field scope.** The curve ranks checkpoints **in the canonical 9-seat gate field**; it is not
  a field-independent strength ordinal. The [field-sensitivity audit](./RESULTS.md) showed
  win-rate rankings _flip_ with the field (Survivor: last among nets in pure-ML fields, first in
  the mixed field) while placement rankings are field-stable. Ship decisions cross-check with
  `npm run arena:ml` (all-ML + heads-up fields). Also note the **era boundary**: since PR #74
  seated `PPO` in the base field (an arrangement [D-27] kept), curve Δ-vs-Lookahead values are comparable to the 9-seat
  persona-gate rows (Conqueror +13.0, Blitz +20.3, Survivor +29.7), **never** to the 8-seat-era
  history (the +27.7 headline, +26.9 control, etc.).
- **Winner's curse.** The argmax of ~15–20 noisy points (per-point SE ≈ 1.3 pp) is biased high
  by roughly **+2 pp** on the very seed set it was selected on — larger than any plausible true
  adjacent-checkpoint difference. The "best checkpoint" from a curve is a _selection_, not a
  measurement; the [confirmation protocol](#confirmation-protocol-mandatory-before-any-ship-decision)
  below is mandatory before any ship decision.
- Precision scales with the per-checkpoint game budget, but only √-slowly — halving the CI costs
  4× the games. Treat budget as a knob.

---

## Phase 0 — the producer (SHIPPED, for reference)

`EvalCheckpointCallback` (`ml/dicewars_ppo/eval_checkpoint_callback.py`), wired default-on in
`scripts/shodan/ppo-train.sh` (`--eval-dir $RUN_ROOT/eval --eval-every ${EVAL_EVERY:-1000000}`).
Every `eval_every` env steps it repacks the live PPO actor → BC-checkpoint format and publishes,
**atomically and non-GC'd**, into `eval_dir`:

```
eval_dir/
  index.jsonl                    # one JSON row per checkpoint, ascending by step
  eval-000001000000.weights.js   # self-contained (packed=false) — loads from any dir
  eval-000001000000.fixture.json # JS↔Python parity fixture (the gate pre-flight checks this)
  eval-000001000000.pt           # the ship / re-export source
  eval-000002000000.weights.js
  ...
```

`index.jsonl` row schema (the ledger the scorer walks):

```json
{
  "id": "eval-000001000000",
  "step": 1000000,
  "weights": "eval-000001000000.weights.js",
  "fixture": "eval-000001000000.fixture.json",
  "pt": "eval-000001000000.pt",
  "createdAt": "2026-…Z",
  "teacher": "ppo-eval"
}
```

Properties Phase 1 relies on: **non-GC'd** (every checkpoint retained — a 20M run is ~20 tiny
artifacts), **fixtured** (each checkpoint is independently gradeable), **atomic publish** (a
poller/scorer never reads a torn file; renames are ordered weights-last, and the index is only
rewritten after all three artifacts land), and **resume-safe** (checkpoints ahead of a resumed
step are dropped, the cadence re-anchors, and — because `CHECKPOINT_EVERY` ≪ `EVAL_EVERY` — a
step id is never re-emitted with different weights, so step-keyed incremental scoring is safe).
It's a pure producer — the arena scoring runs elsewhere and never stalls the GPU rollout.

**Trainer telemetry already exists — don't duplicate it here.** `ppo-train.sh` always passes
`--log-dir`, so SB3 writes `train/approx_kl`, `entropy_loss`, `value_loss`, `learning_rate` per
update to `$RUN_ROOT/tb/` and `progress-*.csv`, keyed by `total_timesteps`. A curve dip is
**diagnosed** (not just detected) by joining the dip's step range against those files; the
scorer's regression report should print that pointer rather than the producer re-recording a
one-update-stale snapshot per checkpoint.

---

## Phase 1 — the scorer (`scripts/ppo-strength-curve.mjs`) · DESIGN (amended 2026-07-01)

An out-of-band Node script. Read-only on the eval dir; touches nothing in the training loop;
runs on the mini (CPU) while shodan trains.

### Prerequisite refactor: extract `runGateSweep` (honest sizing)

The 2026-07-01 review found "a loop over checkpoints around the existing seam" understates the
work: the gate's primitives are importable, but the run/seed/rotation/tally **orchestration
loop lives inline in `scripts/ppo-gate.mjs`** with `process.exit` on failure — a scorer can't
call it, and copy-pasting ~50 lines would fork the gate's semantics. So Phase 1 starts with a
small refactor, valuable on its own:

- Extract **`runGateSweep({ field, runs, gamesPerRun, seedBase, tallyNames })`** into
  `scripts/lib/ppo-gate-core.mjs`: the existing seat-fair sweep, returning **per-run win% and
  placement arrays for every tallied name** plus failure counts, **throwing** instead of
  `process.exit` (callers decide fatality). `ppo-gate.mjs` becomes a thin CLI over it.
- The gate's default candidate name collision (`--name PPO` vs the `PPO` baseline seat — added
  by PR #74, kept by [D-27] — made bare `npm run ppo:gate` throw) is **already fixed** (2026-07-01): the default is
  `DEFAULT_CANDIDATE_NAME = 'Candidate'`, pinned against the real registry by
  `tests/scripts/ppoGateCore.test.js`. Curve checkpoints get unique names (`CP-<step>`).

### Reuse, don't reinvent

| Need                                                         | Reuse                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Load + **parity-check** a `.weights.js` against its fixture  | `loadExportedPolicy`, `siblingFixturePath` — `scripts/lib/load-bc-policy.mjs` (**throws** on failure — wrap per checkpoint, see [Failure policy](#failure-policy)) |
| Register as a bot the in-browser way                         | `makeBC({ policy })` — `src/ai/ai_bc.js` (throws on `encodingVersion` mismatch)                                                                                    |
| Build the seat-fair FFA field incl. the bar **and ppo-long** | `buildGateField`, `LOOKAHEAD_PIN` — `scripts/lib/ppo-gate-core.mjs` (base field already seats `PPO` = the shipped `ppoPolicyWeights.js`)                           |
| Seat-fair sweep + per-run arrays                             | **`runGateSweep`** (the extraction above), `rotatedField`, `runMatch`, `shouldAbort`                                                                               |
| Paired-Δ, CI, verdict                                        | `pairedDelta` (generic over any two per-run arrays — reused for cross-checkpoint tests too), `classifyGate`, `mean`, `meanCi`                                      |

Genuinely new code: index walking / `--watch`, `avgPlacement` aggregation for the gate pipeline
(per-game placement exists in `matchRunner` `botStats`; nothing in the **gate** path aggregates
it — `behavior-core.mjs`'s `reduceRun` already does for the profile harness, so reuse or mirror
that), `strength.jsonl`/CSV emission, provenance, and `analyzeCurve`.

### Algorithm

1. **Walk `index.jsonl`** → ordered checkpoint list. In `--watch` mode, poll it (the producer's
   atomic publish makes this safe), grade rows not yet in `strength.jsonl`, append, and **alert
   loudly on a regression verdict** — checkpoints arrive ~every 1.6 h (1M steps at ~175 fps)
   vs ~5–8 min to grade, so the curve lags training by at most one point. Drop any
   `strength.jsonl` rows whose steps vanish from the index (a trainer resume rolled them back).
   Optionally subsample (`--every-n`, budget escape hatch).
2. **Per checkpoint:**
   1. **Parity pre-flight** via `loadExportedPolicy({ weights, fixture })` in a try/catch —
      never grade a numerically broken export. See [Failure policy](#failure-policy) for the
      skip/abort split.
   2. **Grade ONE sweep, extract THREE tallies.** The field is the **standard gate field plus
      the checkpoint** (as `CP-<step>` — the 8 base seats + candidate = 9). Both references are
      **already in that field**: `Lookahead` (the D-7 absolute bar) and `PPO` (= the shipped
      `ppo-long` flagship, seated since PR #74). So the second reference is **free** — tally
      `winnerName === 'PPO'` per run from the same games; no second sweep, no field change.
      Compute `pairedDelta(cp, Look)` and `pairedDelta(cp, PPO)` with `classifyGate` verdicts.
      **Never load a reference as an extra seat**: growing the field 9→10 changes seeds-per-run,
      rotations, and every bot's absolute win%, invalidating comparability with every documented
      baseline (the field-sensitivity audit's exact trap). `--ref <in-field-name>` is repeatable
      for additional _in-field_ tallies only.
   3. **Hold `seedBase` CONSTANT across all checkpoints** (default 0). What this buys: every
      checkpoint is graded on the identical map set and seat rotations, so absolute levels are
      comparable across the curve and per-run samples are pairable _across checkpoints_. What it
      does **not** buy: noise-free attribution — three field seats (`Example`, `Default`,
      `Adaptive`) call unseeded `Math.random`, so even the same checkpoint re-graded on the same
      seeds plays different games, and FFA trajectories diverge from the first differing
      candidate decision anyway. The shared-map component is an estimated ~10% of run variance
      (back-solved from recorded gate CIs; the first curve should report the observed value).
      Curve wiggle at this budget is mostly game-outcome noise with a floor of ~±2.5 pp per
      point — which is why detection uses the paired rules below, not eyeballing.
3. **Emit `strength.jsonl` + `strength.csv`** — one row per checkpoint (including failed ones,
   with `status`), with summary fields (`step`, `winPct`, `winCi`, `deltaVsLook`, `ciVsLook`,
   `verdictVsLook`, `deltaVsPPO`, `ciVsPPO`, `verdictVsPPO`, `avgPlacement`, `parity`, `games`,
   `wallClockSec`) **plus the per-run win% arrays for the candidate and each reference, and the
   candidate's per-run placement array** (~60 numbers/row — the single highest-leverage schema
   item: every cross-checkpoint test below, and any future re-analysis, needs them; summary
   stats alone throw the pairing away).
4. **`analyzeCurve(rows)`** — the payoff, printed as a compact table + summary (see next
   section).

### analyzeCurve: the detection rules

All cross-checkpoint comparisons use **run-paired differences** (constant `seedBase` makes
per-run samples pairable by run index; `pairedDelta` is already generic over any two per-run
arrays). The naive "CIs disjoint" comparison is an accidental test — it needs a ~5.4 pp observed
gap (effective z ≈ 3), giving only ~88% power against the motivating −7.6 and ~50% at −5.4 —
and is kept only as a coarse fallback for comparing across curves graded on different seeds.

- **Regression** = checkpoint `i` tests **significantly below the reference** on a one-sided
  per-run paired t-test (α = 0.05, SE of the paired difference ≈ 1.8 pp at default budget), for
  **k = 2 consecutive checkpoints**. Reference = the running best's **lower CI bound** (or the
  median of the top-3) — not the raw argmax, which is selection-biased high. Expected behavior:
  family-wise false-positive ≈ 5% over a 20-point curve; ~99% power against a sustained −7.6.
  Emit it loudly (in `--watch` mode this is the alert), and print the `tb/` telemetry pointer
  for the dip's step range (diagnose, not just detect).
- **Plateau onset** = the earliest step `s*` such that for each of the next **k = 3**
  checkpoints, the run-paired `Δᵢ − Δ_s*` is not significantly > 0. Report it with the honest
  MDE framing: "no per-1M gain above ~2–3 pp detectable at this budget".
- **Best checkpoint** = argmax `deltaVsLook`, reported **with its CI and the selection-bias
  disclaimer** (ties-within-CI called out; the value is inflated ~+2 pp by winner's curse).
  `analyzeCurve` prints the confirmation protocol as its "next step" output — it is not
  optional.
- **Gaps break windows**: a missing/failed curve point interrupts any "k consecutive" window
  rather than bridging it.
- **Test-retest calibration** (first curve only, cheap): grade ONE checkpoint twice at identical
  settings and report the spread as the curve's empirical noise floor — meaningful precisely
  because the `Math.random` opponents make same-seed replays non-identical.

### Confirmation protocol (mandatory before any ship decision)

1. Re-grade the argmax (and any regression-flagged neighbor) at a **fresh `seedBase` offset
   ≥ the run count** — e.g. `--seedbase 100`. (Not `--seedbase 1`: seeds are
   `(seedBase + run) × STRIDE + …`, so offset 1 reuses 19 of 20 seed blocks.) Ideally at
   2× runs (40 → CI ≈ ±1.9 pp). **The fresh-seed number is the checkpoint's reported strength**;
   the constant-seed curve was selection.
2. Cross-check the top 1–2 checkpoints with `npm run arena:ml` (all-ML + heads-up fields —
   minutes of compute) — the audit proved gate-field rank alone can mislead a ship decision.

### Selection policy beyond argmax (experiment, after the first real curve)

The non-GC'd stream retains every `.pt`, which makes **checkpoint averaging** (LAWA-style: mean
of the last 3–5 adjacent checkpoints of one trajectory) nearly free to try — average in Python,
export via `dicewars_bc.export_weights`, grade as one more curve point. It's a well-established
late-training stability win that directly hedges the 20M→23M-style wobble. If `avg(last k)` beats
or ties the argmax with lower variance, make "ship the averaged tail" the default selection
policy. (Keep it to adjacent windows of one trajectory — naive averaging across distant
checkpoints or runs can fail.) Related training-side fix, tracked in [PERSONAS.md](./PERSONAS.md)
for Batch 2: fine-tunes should anneal LR (the Conqueror fine-tune ran constant `lr 1e-4` with no
anneal, no KL guard, and no intermediate measurement — the curve detects the wobble; the anneal
prevents it).

### Failure policy

`loadExportedPolicy` **throws** on parity failure (tol 1e-3) and `makeBC` **throws** on an
`encodingVersion` mismatch — the doc's old "flag and skip" needs a per-checkpoint try/catch with
a three-way split:

- **`encodingVersion` mismatch → abort the whole scorer** immediately, nonzero exit, print the
  re-export instruction. It's a property of the run (every checkpoint shares the encoding);
  skipping would grind through ~20 identical failures.
- **Parity/fixture failure → emit a `status: 'parity-failed'` row** (no win fields) so the curve
  records the gap explicitly, and continue — but **abort nonzero past a `shouldAbort`-style
  threshold** (>50% of attempted checkpoints, min 3) — a systematically broken producer/export
  must not produce an exit-0 empty curve.
- **Missing artifact files for an index row → "not yet synced, retry next poll"**, never an
  error (see Transport). Exit nonzero if a finished batch walk graded zero points.

### Provenance

Win% is field-relative and encoding-gated, so a "durable, re-gradeable record" must record its
grading conditions. A `strength.meta.json` sidecar (invariants) + per-row fields (variants):
repo **git SHA**, **`ENCODING_VERSION`**, **ordered field bot names + a short field hash**,
knobs (`runs`/`games`/`seedBase`/`every-n`), `LOOKAHEAD_PIN`, per-checkpoint **weights sha256**
and index `createdAt`, wall-clock per point. Cheap now; priceless when a Batch-2 curve is
compared against a `ppo-long` curve weeks later on a moved codebase.

### Transport: the eval dir is on shodan, the scorer is on the mini

`ppo-train.sh` writes `EVAL_DIR=$RUN_ROOT/eval` on **shodan**; nothing syncs it. The watch loop
on the mini **rsync-pulls** the eval dir (read-only on shodan — no interaction with training)
before each poll. A naive copy does _not_ preserve the producer's rename-ordering guarantees
(index can arrive before the weights it references) — the missing-artifact retry rule above is
what restores safety under any sync order; also parse `index.jsonl` line-by-line and warn-and-skip
unparsable lines. Never run the scorer ON shodan mid-training (the SB3 learner loop is the
binding rate per [D-24], and the scorer is CPU-hungry).

### Proposed CLI

```
node scripts/ppo-strength-curve.mjs \
  --eval-dir ml/runs/<run>/eval \
  --runs 20 --games 150 --seedbase 0 \  # gate knobs; seedbase held constant across checkpoints
  --ref PPO \                           # repeatable, IN-FIELD tallies only; Lookahead (the bar) is implicit
  --every-n 1 \                         # grade every checkpoint (escape hatch for very long runs)
  --watch \                             # poll + grade incrementally + alert on regression
  --out ml/runs/<run>/eval/strength.jsonl --csv
```

### Cost

Each checkpoint ≈ one gate run: **267.7 s and 440.5 s (~4.5–7.3 min) measured — both on shodan**;
no mini timing exists yet, so **calibrate on the first run** before trusting estimates. A 20M
run ≈ 20 checkpoints ≈ **~1.5–2.5 h serially** — trivial against ~29 h of GPU training, and in
watch mode the question evaporates (one ~7 min grade per ~1.6 h of training). Whatever is
dropped/subsampled gets `log()`'d, never silently skipped.

### Acceptance test (three tiers)

1. **Now, hermetic (the real Phase-1 gate):** a synthetic `index.jsonl` built from existing
   exports of _known_ relative strength (e.g. `ppoPolicyWeights.js` as an early "step",
   `bcPolicyWeights.js` — the −3.7 anchor — as a later one, reduced budget). Assert the scorer
   walks it, parity-checks, tallies both references, emits rows + provenance, the regression
   detector fires on the descending pair, and a deliberately corrupted fixture yields a
   `parity-failed` row, not a crash.
2. **Retroactive `ppo-conqueror` curve — feasible, via a thin adapter.** Verified on shodan
   2026-07-01: `ml/runs/ppo-conqueror/league/` retains the **full fine-tune snapshot stream —
   30 self-contained snapshots at ~100k-step cadence spanning 0→3M, with a `manifest.json`
   ledger** (encodingVersion 2), plus the final fixtured export at the run root. The adapter:
   map manifest→index rows, and a **fixture-optional retro mode** (league snapshots carry no
   parity fixtures; they were consumed live by `makeBC` during training, and `makeBC` still
   enforces the encoding guard — mark such rows `parityWaived: true` in provenance). This
   reproduces the motivating −7.6 as an actual curve, at 100k resolution, for zero GPU cost.
   **Parked until the live shodan runs finish** — do not disrupt them.
3. **First fresh producer-on run:** Batch 2 (Expansionist/Predator) gets `--eval-dir` by
   default and becomes the first end-to-end live-watch validation for free. (Note: the
   currently-running `ppo-scratch-long` was launched pre-#97 and has **no** eval dir.)

---

## Resolved questions (2026-07-01 review)

The five open questions, resolved by the code-grounded review (three independent lenses, all
answers unanimous):

1. **Second reference:** `ppo-long` only, via the `PPO` seat it **already occupies** in the gate
   field — a free per-run tally from the same games. Do **not** seat Survivor (field inflation
   invalidates every documented baseline, and the audit shows its edge is itself a field
   artifact). If a Survivor comparison ever matters, re-grade the few interesting checkpoints
   against it on demand, or use `arena:ml`.
2. **Win% vs placement:** verdicts on paired-Δ **win% only** (placement gating is the documented
   ELO/survival trap) — but carry `avgPlacement` + per-run placement arrays in every row and have
   `analyzeCurve` **flag divergence** between the two trends: the audit found placement rankings
   field-_stable_ while win% flips, so "win% flat, placement climbing" is a Survivor-style drift
   signal worth printing. Flagged, never gated.
3. **Budget default:** `--every-n 1` at the standard budget. ~2 h per 20M curve on an idle box is
   trivial vs the GPU-days it protects, and the k-consecutive rules want density. Spend extra
   games only on the test-retest calibration and the confirmation re-grades.
4. **Where it runs:** the mini, confirmed — with the rsync-pull transport specified above, and a
   one-time timing calibration (recorded gate timings are shodan's, not the mini's). Never on
   shodan mid-training.
5. **Acceptance test:** the three tiers above — synthetic stream now; the retroactive
   `ppo-conqueror` curve via the manifest adapter (feasible — verified 2026-07-01); the first
   fresh `--eval-dir` run as the live end-to-end.
