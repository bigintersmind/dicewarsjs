# Scavenge co-read (PERSONAS §10.3 vulture-hack guard) — design

**Date:** 2026-07-06 · **Approved:** Ivan (descriptive panel, no auto-tripwire) · **Target:**
`scripts/lib/behavior-core.mjs` + `scripts/behavior-profile.mjs` + docs

## Problem

PERSONAS §10.3 pre-registers a "descriptive **scavenge co-read** (victim's territory count /
time-at-one-territory before the killing blow) as a ship-blocking sanity check" for the Wave-2
Predator pilots, and §10.8 lists "the scavenge co-read showing vulture behavior" as a pre-committed
Predator kill condition. No implementation exists. Without it, a reward-hacked Predator that plays
Survivor-with-kill-steals (snipes 1-territory players others doomed) would pass the "kills higher"
signature undetected. Must exist before Wave-2 pilot grading.

## Decision (Ivan, 2026-07-06)

**Descriptive panel only** — paired Δ vs the comparator on two new axes, printed + carried in
`--json`; the operator judges vulture-ness at pilot grading. No drafted auto-kill thresholds
(§10.4's numbers borrowed calibrated MDEs; scavenge thresholds would be pure guesses pre-pilot).
Thresholds can be ratified later from real pilot data if wanted.

## Design

Follows the §10.4 clock-hack pattern end-to-end: capture → per-game scalars → descriptive axes →
CLI panel + JSON, deliberately OUT of `PERSONA_SIGNATURES` / `SIGNATURE_AXES` / `SEPARATION_AXES`
/ Holm.

### Capture layer (`makeCapture`)

`onTurn(turnNumber, state, actingPlayerId)` fires after **every** player-turn with post-turn
state. Add two per-player trackers (plain objects/Maps keyed by player id, updated every firing,
all seats):

- `_lastSeenTerr[id]` — the player's `territoryCount` as of the last observed post-turn state.
- `_oneTerrStreak[id]` — consecutive observed player-turns with `territoryCount === 1`
  (increment when exactly 1; reset to 0 when > 1; stop updating once eliminated).

At the existing kill-detection point (an opponent's `eliminated` flips during the profiled seat's
turn), push `{ victimTerr, victimOneTerrTurns }` onto a new `capture.killVictims` array, read from
the trackers **before** they are updated with the current (post-kill) state — i.e. the values as
of the end of the immediately-preceding player-turn.

Semantics this buys (and tests pin):

- The last observation is always the state right before the killing turn began. A bot that softens
  a 3-territory victim itself during the killing turn reads `victimTerr: 3` (hunter), not 1 —
  exactly the §10.3 distinction vs a vulture sniping an already-1-territory player.
- Update order inside `onTurn`: kill detection reads trackers first, then trackers ingest the
  current state. (The victim's post-kill `territoryCount` of 0 must never be what's recorded.)
- **First-turn kill edge case:** a kill during the game's first observed player-turn has no prior
  observation → record `{ victimTerr: null, victimOneTerrTurns: null }`; nulls are excluded from
  the per-game means. Practically unreachable on real maps; documented, not asserted away.

### Per-game scalars (`profileGameFromCapture`)

- `killVictimTerr` — mean over `killVictims` of `victimTerr` (nulls excluded); `null` when the bot
  made no kills or no victim was observed.
- `killVictimOneTerrTurns` — same for `victimOneTerrTurns`. Units: player-turns (the harness-wide
  unit — same as `turnCount` / `survivalTurn` / `NEAR_CAP_WINDOW`).

Null handling mirrors `turnsToWin` (winners-only sparsity): a no-kill game contributes nothing
rather than a diluting 0.

### Aggregation

- Append both to `AXES` as a "§10.3 scavenge co-read cluster" with a comment mirroring the §10.4
  cluster note (descriptive, not signature/separation/Holm).
- `reduceRun`: `defined('killVictimTerr')` / `defined('killVictimOneTerrTurns')` — the existing
  null-safe reducer.
- They ride `compareToControl` automatically once in `AXES`. Existing consumers are unaffected:
  `SIGNATURE_AXES`/`SEPARATION_AXES` are independent lists; `reduceShape`-style test helpers
  key off `AXES` dynamically.

### CLI (`behavior-profile.mjs`)

- `--json`: no new block needed beyond the axes riding `metrics` / `vsControl` / `perRun` — but add
  `bots[].scavenge = { kills, killVictimTerr, killVictimOneTerrTurns }` rows (own mean + Δ vs
  control) so the co-read is directly addressable, mirroring `bots[].clockHack`.
- Printed: a "Scavenge co-read (§10.3)" panel for every non-control bot, formatted like the
  clock-hack panel — own mean, paired Δ [CI] vs control per axis, plus the bot's `kills` mean for
  context. **No verdict boolean** — a trailing "operator-judged (descriptive, §10.3)" note.

### Docs

- PERSONAS.md §10.3: an italic "As built (2026-07-06)" note after the vulture-hack paragraph
  (field names, units, the first-turn null caveat, descriptive-only per Ivan's call).
- EVAL_HARNESS.md: a short "As built" subsection alongside the §10.4 clock-hack one.

## Tests (TDD, extend existing suites)

`tests/behaviorCore.test.js` (synthetic-callback style, no arena):

1. Vulture kill: victim at 1 territory for N observed turns before the killing blow →
   `{ victimTerr: 1, victimOneTerrTurns: N }`.
2. Hunter kill: victim observed at 3 territories on the immediately-preceding turn, killed on the
   bot's turn → `victimTerr: 3`, streak 0 (pre-turn state wins over post-kill 0).
3. Streak reset: victim dips to 1, recovers to 2+, later killed → streak reflects only the final
   consecutive run at 1.
4. Multi-kill turn: two victims in one sweep → two `killVictims` entries, each from its own tracker.
5. Kills by other seats / of the profiled seat: no `killVictims` entry.
6. First-turn kill: null entry, excluded from the per-game mean.
7. `profileGameFromCapture`: means over observed victims; null when no kills.
8. `reduceRun`: no-kill games dropped from the run mean; all-null run → null axis.
9. `AXES` contains both new axes; `SIGNATURE_AXES`/`SEPARATION_AXES` do NOT.

`tests/scripts/behaviorProfile.test.js`: extend the small real-sweep e2e to assert the JSON report
carries the two axes in `metrics`/`perRun` and the `scavenge` block exists for non-control bots.

## Out of scope

- Auto-kill thresholds (Ivan's call — descriptive only; revisit post-pilot).
- `oneTerrKillFrac` third axis (redundant with `killVictimTerr`; add later if pilot reading wants).
- The optional §10.3 advantage-mass-near-kill-frames trainer diagnostic (Python side, separate).

## Deviation from this spec (post-review, 2026-07-06)

An 8-angle review of the implementation branch dropped the `bots[].scavenge` JSON block: unlike
`clockHack` (which computes fired/kill verdicts), it computed nothing — a pure re-projection of
`metrics`/`vsControl` whose second serialized copy could only drift, and whose nested `compareAxis`
objects smuggled `verdict` fields into a block specified as verdict-free. The axes remain fully
addressable via `bots[].metrics`/`vsControl`/`perRun`; the printed panel reads those directly.
Also added beyond spec: `assertPairableReports` fails loud on perRun axis-set drift across reports
(a pre-§10.3 report can no longer pair as silent "no data" under `--allow-sha-drift`), the
`killVictims` capture field is required (no `?? []` leniency), and two operator reading caveats
(third-party softening → low streak; streak unit scales with field size) are documented in
PERSONAS §10.3 / EVAL_HARNESS §2.2.
