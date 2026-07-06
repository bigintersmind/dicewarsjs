# Press-to-Close Turtle Fix (Issue #115) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a clearly-winning bot press to close instead of passing, for the four turtling bots (`ai_lookahead`, `ai_expectimax`, `ai_adaptive`, `ai_strategist`), so AI-vs-AI games rarely reach the #114 turn-cap draw.

**Architecture:** Each bot gets a bot-specific "press-to-close" override at the exact injection point mapped in issue #115: Lookahead bypasses its EV gate when clearly winning; Expectimax gains a fourth (highest-precedence) posture with a new `closeoutThreshold` tunable; Adaptive keeps max-stack near-even attacks in its candidate list regardless of its self-nerfed aggression dial; Strategist unlocks its existing bank-refill refund for a dominant leader outside the ≤3-player endgame. No engine code, no encoding contract, no persona/net changes.

**Tech Stack:** Plain ES modules in `src/ai/`, Vitest (node env, globals on), the deterministic eval harness (`npm run behavior:turtle`, `npm run arena:sweep`, `npm run benchmark-bot`).

**Source of truth:** Issue #115 (`gh issue view 115 --repo bigintersmind/dicewarsjs`). All line numbers below are against `master @ 54ace73` and were re-verified on 2026-07-05. Anchor every edit on the quoted snippet, not the line number.

## Global Constraints

- Base commit: `54ace73` (`master`). Verify with `git log --oneline -1` before starting; `git pull --ff-only` if behind.
- **Scope:** only `src/ai/ai_lookahead.js`, `src/ai/ai_expectimax.js`, `src/ai/ai_adaptive.js`, `src/ai/ai_strategist.js` and their four test files. **No changes** to `src/engine/*`, `src/arena/encodeObservation.js`, personas (Conqueror/Blitz/Survivor), `ai_default`, `ai_defensive`, or any `*PolicyWeights.js`.
- **Determinism:** no `Math.random()` anywhere in the changes. Adaptive's existing RNG stays confined to `selectBestMove` — do not touch that function. Lookahead/Expectimax/Strategist stay fully deterministic (ties break toward lowest area index; keep strict `>` comparisons).
- Lookahead's module exports are pinned by a test to exactly `['ai_lookahead', 'evaluateLookaheadTurn', 'winProbability']` — add **no new exports** to that file.
- Expectimax's `makeExpectimax` throws on params not in `DEFAULT_PARAMS` and on non-finite values — any new tunable must be added to `DEFAULT_PARAMS` with a **finite** default.
- Do not mutate boards read by Lookahead's WeakMap caches (`computeStats` is read-only); do not recompute Expectimax's posture per search node (root-only, threaded); do not inject logic between Adaptive's simulate-mutate/restore pairs; do not build anything on `game.dominantPlayer` inside Adaptive's `generateMoves` (it is `undefined` — a known latent dead field).
- Tests: run only the relevant file with `npx vitest run tests/ai/<file>` during tasks. **Do not run full `npm test` inside bot tasks** (CLAUDE.md rule — the main agent runs it once in Task 5).
- Lint: `npx eslint --no-ignore src/ai/<file> tests/ai/<file>` (the `--no-ignore` is required inside `.claude/worktrees/` checkouts; harmless elsewhere).
- Commits: conventional format, e.g. `feat(ai): …`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Husky pre-commit runs eslint --fix + prettier on staged files.
- GitHub: this repo's `gh` default may resolve to the upstream fork. Run `gh repo set-default bigintersmind/dicewarsjs` once per checkout, or pass `--repo bigintersmind/dicewarsjs` to every `gh` command.
- One branch + one PR per bot: `fix/115-press-lookahead`, `fix/115-press-expectimax`, `fix/115-press-adaptive`, `fix/115-press-strategist`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Tasks 1–4 are **independent** (disjoint files) and may run in parallel worktrees. Task 5 runs only after all four PRs are merged.

## Shared background (read once)

**The mechanism being fixed.** From a maxed winning position every legal move is an ~8v8 coinflip (`winProbability(8,8) ≈ 0.471`) that also drops the attacking cell to 1 die on **both** outcomes. Every one of the four bots double-punishes exactly that move (a low-odds penalty below a ~0.76–0.78 floor, plus the burned-dice/exposure cost), pushing its score below even the bot's existing "I'm winning" bar — so the leader passes every turn. The fix in every case keys on a **"clearly winning" predicate** and then makes the near-even full-stack swing admissible; each bot's predicate reuses that bot's existing census values.

**Validation harness.** `scripts/turtle-probe.mjs` (via `npm run behavior:turtle`) is fully deterministic: seeds are derived as `g * 100003 + rot * 7 + 17`, so two runs with identical `--bots/--field/--games/--seats/--maxTurns` flags replay identical games — before/after comparisons are true A/Bs. Exception: **Adaptive calls `Math.random()`** in `selectBestMove`, so its games are not replay-identical; compare its rates directionally, not exactly. Key metrics per bot: `leadPassRate` (pass while strict territory leader — primary), `dominantPassRate` (pass at ≥40% territory share), `endgameLeadPassRate` (leader pass with ≤3 alive), `stalemateRate` (games ending `winner === null` at the cap).

**In-task mini-probe protocol** (used by every bot task): run the probe **before touching code** and again **after**, with identical flags, and require the turtle metrics to drop:

```bash
# BEFORE any code edit (from the task's clean checkout):
npm run behavior:turtle -- --bots <Bot> --field self --games 15 --json > /tmp/claude-115/<bot>-before.json 2>/dev/null
# AFTER implementation:
npm run behavior:turtle -- --bots <Bot> --field self --games 15 --json > /tmp/claude-115/<bot>-after.json 2>/dev/null
# Compare (works for any bot name):
node -e '
const [b, a] = ["before", "after"].map(w => JSON.parse(require("fs").readFileSync(`/tmp/claude-115/${process.argv[1]}-${w}.json`)));
for (const w of [["BEFORE", b], ["AFTER", a]]) {
  const r = w[1].fields.self[0];
  console.log(w[0], JSON.stringify({ leadPass: r.leadPassRate, domPass: r.dominantPassRate, endgLeadPass: r.endgameLeadPassRate, stalemate: r.stalemateRate }));
}' <bot-lowercase>
```

Use `mkdir -p /tmp/claude-115` first (or substitute your scratchpad directory). The self-mirror is the harshest stress: per DECISIONS.md D-15, 7×Lookahead ≈ 100% stalemate pre-fix. Expect `leadPassRate`, `dominantPassRate`, and `stalemateRate` to drop clearly. If they don't move, the override is not wired — stop and debug before proceeding.

---

### Task 1: Lookahead — bypass the EV gate when clearly winning

**Files:**

- Modify: `src/ai/ai_lookahead.js` (constant block ~L48; new helper after `attackThreshold` ~L374; gate + return in `evaluateLookaheadTurn` ~L455–480; JSDoc ~L437–450)
- Test: `tests/ai/ai_lookahead.test.js` (append a new `describe` before the file's closing `});`)

**Interfaces:**

- Consumes: existing `computeStats(board)` (WeakMap-cached census: `{id, territories, dice, largestGroup, stock}[]`), existing `DOMINANCE_SHARE = 0.4`.
- Produces: `evaluateLookaheadTurn(game)` now returns `{ player, bestMove, bestScore, threshold, pressToClose: boolean, chosenMove }` — one **added** field, everything else unchanged. New private helper `pressToClose(board, player): boolean`. New private constant `PRESS_CLOSE_PLAYERS = 3`. **No new exports.**

- [ ] **Step 1: Baseline mini-probe (before any edit)**

```bash
mkdir -p /tmp/claude-115
npm run behavior:turtle -- --bots Lookahead --field self --games 15 --json > /tmp/claude-115/lookahead-before.json 2>/dev/null
```

Expected: completes in a few minutes; the JSON's `fields.self[0].stalemateRate` should be near `1.0` (D-15).

- [ ] **Step 2: Write the failing tests**

Append inside the top-level `describe('Lookahead AI', …)` block of `tests/ai/ai_lookahead.test.js`, just before its final `});` (after the "proposes only legal moves across many random boards" test):

```js
/*
 * Press-to-close override (issue #115): a clear winner must keep attacking
 * even when every remaining move is a penalized near-even coinflip, or
 * AI-vs-AI games freeze into turn-cap stalemates. "Clearly winning" =
 * strict territory lead AND (dominant dice share OR ≤3 players alive).
 */
describe('press-to-close override (issue #115)', () => {
  test('plays the searched best move from a clearly-winning maxed position even below the EV bar', () => {
    /*
     * me (player 1): 4 territories vs 2 and 1 (strict lead) and 32/56 dice
     * (dominant share). The only legal attack is an 8v8 border coinflip
     * whose score (~-2, driven by the low-odds penalty) sits far below even
     * the PRESS threshold — pre-#115 the bot passed here forever.
     */
    territory(1, 1, 8);
    territory(2, 1, 8);
    territory(3, 1, 8);
    territory(4, 1, 8);
    territory(5, 2, 8);
    territory(6, 2, 8);
    territory(7, 3, 8);
    link(1, 2);
    link(2, 3);
    link(3, 4);
    link(4, 5); // my only enemy border: the 8v8
    link(5, 6);
    link(6, 7);

    const decision = evaluateLookaheadTurn(mockGame);

    expect(decision.pressToClose).toBe(true);
    expect(decision.bestMove).toEqual({ from: 4, to: 5 });
    expect(decision.bestScore).toBeLessThan(decision.threshold); // the plain EV gate would decline
    expect(decision.chosenMove).toEqual(decision.bestMove); // the override presses anyway

    ai_lookahead(mockGame);
    expect(mockGame.area_from).toBe(4);
    expect(mockGame.area_to).toBe(5);
  });

  test('does not fire without a strict territory lead (all-8s parity stays patient)', () => {
    // Same maxed frontier but tied 3-vs-3 territories: not "clearly winning",
    // so the normal EV gate applies and the bot still declines the coinflip.
    territory(1, 1, 8);
    territory(2, 1, 8);
    territory(3, 1, 8);
    territory(4, 2, 8);
    territory(5, 2, 8);
    territory(6, 2, 8);
    link(1, 2);
    link(2, 3);
    link(3, 4); // the 8v8 border
    link(4, 5);
    link(5, 6);

    const decision = evaluateLookaheadTurn(mockGame);

    expect(decision.pressToClose).toBe(false);
    expect(decision.chosenMove).toBeNull();
    expect(ai_lookahead(mockGame)).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify the first fails**

Run: `npx vitest run tests/ai/ai_lookahead.test.js`
Expected: the new "plays the searched best move…" test FAILS (`decision.pressToClose` is `undefined`, `chosenMove` is `null`); the "does not fire…" test may already pass except for the `pressToClose` field assertion (also failing on `undefined`). All pre-existing tests PASS. If the first test fails differently (e.g. `bestMove` is not `{from:4,to:5}`), fix the board wiring before proceeding.

- [ ] **Step 4: Implement the override**

4a. In `src/ai/ai_lookahead.js`, find the constant (currently L48):

```js
const DOMINANCE_SHARE = 0.4;
```

and add directly below it:

```js
/*
 * Press-to-close override (issue #115): a bot that clearly holds a winning
 * position must keep attacking even when every remaining move is a penalized
 * near-even coinflip (a maxed 8v8 frontier scores ~-2, below even
 * PRESS_THRESHOLD), or AI-vs-AI games freeze into turn-cap stalemates.
 * "Clearly winning" = strict territory lead AND (dominant dice share OR the
 * field has narrowed to PRESS_CLOSE_PLAYERS or fewer). The override bypasses
 * the EV bar entirely; the searched best move is still the move played.
 */
const PRESS_CLOSE_PLAYERS = 3;
```

4b. Add the helper directly after the closing brace of `attackThreshold` (currently L374) and before `strategicAdjustment`:

```js
function pressToClose(board, player) {
  const stats = computeStats(board);
  const me = stats[player];
  if (!me || me.territories === 0) return false;

  const rivals = stats.filter(candidate => candidate.id !== player && candidate.territories > 0);
  if (rivals.length === 0) return false;

  const bestRivalTerritories = Math.max(...rivals.map(rival => rival.territories));
  if (me.territories <= bestRivalTerritories) return false;

  const totalDice = stats.reduce((sum, candidate) => sum + candidate.dice, 0);
  const dominantDice = totalDice > 0 && me.dice > totalDice * DOMINANCE_SHARE;
  return dominantDice || rivals.length + 1 <= PRESS_CLOSE_PLAYERS;
}
```

4c. In `evaluateLookaheadTurn`, extend the no-move shape (currently L455–461):

```js
const noMove = {
  player,
  bestMove: null,
  bestScore: -Infinity,
  threshold: BASE_THRESHOLD,
  pressToClose: false,
  chosenMove: null,
};
```

4d. Replace the gate + return (currently L477–480):

```js
const threshold = attackThreshold(board, player);
const chosenMove = bestMove && bestScore > threshold ? bestMove : null;

return { player, bestMove, bestScore, threshold, chosenMove };
```

with:

```js
const threshold = attackThreshold(board, player);
const press = pressToClose(board, player);
const chosenMove = bestMove && (bestScore > threshold || press) ? bestMove : null;

return { player, bestMove, bestScore, threshold, pressToClose: press, chosenMove };
```

4e. Update the JSDoc `@returns` of `evaluateLookaheadTurn` (currently L446–449) from:

```js
 * @returns {{
 *   player: number, bestMove: ?{from:number,to:number}, bestScore: number,
 *   threshold: number, chosenMove: ?{from:number,to:number}
 * }}
```

to:

```js
 * @returns {{
 *   player: number, bestMove: ?{from:number,to:number}, bestScore: number,
 *   threshold: number, pressToClose: boolean, chosenMove: ?{from:number,to:number}
 * }}
```

Also extend the prose sentence above it — after "otherwise null)." add: `pressToClose reports the issue-#115 clearly-winning override that lets the best move through regardless of the threshold.`

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run tests/ai/ai_lookahead.test.js`
Expected: PASS (all tests, old and new). The pinned-exports test must still pass — if it fails you exported something; make the helper/constant private.

- [ ] **Step 6: After mini-probe + lint**

```bash
npm run behavior:turtle -- --bots Lookahead --field self --games 15 --json > /tmp/claude-115/lookahead-after.json 2>/dev/null
node -e '
const [b, a] = ["before", "after"].map(w => JSON.parse(require("fs").readFileSync(`/tmp/claude-115/lookahead-${w}.json`)));
for (const w of [["BEFORE", b], ["AFTER", a]]) { const r = w[1].fields.self[0]; console.log(w[0], JSON.stringify({ leadPass: r.leadPassRate, domPass: r.dominantPassRate, stalemate: r.stalemateRate })); }'
npx eslint --no-ignore src/ai/ai_lookahead.js tests/ai/ai_lookahead.test.js
```

Expected: `leadPass`, `domPass`, `stalemate` all drop sharply vs before (stalemate from ~1.0 toward ~0). Lint clean.

- [ ] **Step 7: Commit, push, PR**

```bash
git checkout -b fix/115-press-lookahead
git add src/ai/ai_lookahead.js tests/ai/ai_lookahead.test.js
git commit -m "feat(ai): press-to-close override for Lookahead (issue #115)

A clearly-winning Lookahead (strict territory lead + dominant dice share
or <=3 alive) now plays its searched best move even when the risk-penalized
8v8 EV sits below the posture threshold, instead of passing a maxed
frontier into a turn-cap stalemate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin fix/115-press-lookahead
gh pr create --repo bigintersmind/dicewarsjs --base master \
  --title "feat(ai): press-to-close override for Lookahead (issue #115, 1/4)" \
  --body "$(cat <<'EOF'
Part 1/4 of issue #115 (worst offender: ~43% lead-pass). Adds a clearly-winning override to `evaluateLookaheadTurn`: strict territory lead AND (dice share > DOMINANCE_SHARE OR ≤3 players alive) lets the searched best move through regardless of the EV threshold. `threshold` semantics and the exported surface are unchanged; the result object gains a `pressToClose` field.

Self-mirror probe (15 seeds, deterministic A/B): paste the Step 6 BEFORE/AFTER lines here.

Strength gate: consolidated `arena:sweep` before/after runs in the issue-#115 validation pass prior to closing the issue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace the placeholder sentence with the actual BEFORE/AFTER numbers from Step 6.

---

### Task 2: Expectimax — a fourth "closeout" posture above PRESS

**Files:**

- Modify: `src/ai/ai_expectimax.js` (`DEFAULT_PARAMS` ~L60–95; `postureThreshold` ~L122–144 and its JSDoc)
- Test: `tests/ai/ai_expectimax.test.js` (edit two shared board builders; add one new test block)

**Interfaces:**

- Consumes: `postureThreshold(diceByPlayer, areasByPlayer, me, pmax, P)` — all signals (territory census included) already flow in; no signature change.
- Produces: new tunable `DEFAULT_PARAMS.closeoutThreshold = -8.0` (finite; participates automatically in the factory's unknown-param/finite guards). Posture precedence becomes: **closeout → press → weak → base**.

**⚠ Test-churn warning (read first):** the closeout branch is selected by _strict territory lead_, and two existing posture-test boards happen to contain a strict lead (`dominantBoard`: 3-vs-2-vs-2 cells; `duelBoard(iLead=true)`: 3-vs-1 cells). Without the Step-2 board edits those tests would be shadowed by the new posture and fail (or silently stop testing their lever). The edits below keep each test's original lever meaningful by leveling territory counts — dice shares and every existing assertion stay valid.

- [ ] **Step 1: Baseline mini-probe (before any edit)**

```bash
mkdir -p /tmp/claude-115
npm run behavior:turtle -- --bots Expectimax --field self --games 15 --json > /tmp/claude-115/expectimax-before.json 2>/dev/null
```

- [ ] **Step 2: Adjust the two shared test boards (existing levers, unchanged meaning)**

2a. In `tests/ai/ai_expectimax.test.js`, replace the `dominantBoard` builder and its comment (currently ~L355–373):

```js
/*
 * Dominant board: my dice share ≈ 0.70 → PRESS posture. Two rivals on purpose,
 * so the heads-up-duel press shortcut (activeRivals === 1) does NOT fire and the
 * press posture is selected by dice share alone — which the pressDiceShare-gating
 * test below relies on to isolate the share cutoff.
 */
const dominantBoard = () => {
  territory(1, 1, 3); // my attacker (a 3v3 coin-flip, marginal EV)
  territory(2, 1, 8);
  territory(3, 1, 8); // lots of my dice → dominant
  territory(4, 2, 3);
  territory(5, 2, 2);
  territory(6, 3, 2);
  territory(7, 3, 1);
  link(1, 4);
  link(4, 5);
  link(5, 6);
  link(6, 7);
};
```

with:

```js
/*
 * Dominant board: my dice share ≈ 0.68 → PRESS posture. Two rivals on purpose,
 * so the heads-up-duel press shortcut (activeRivals === 1) does NOT fire and the
 * press posture is selected by dice share alone — which the pressDiceShare-gating
 * test below relies on to isolate the share cutoff. Player 2 holds a third
 * (isolated, 1-die) cell so territories tie 3–3: the strict-lead CLOSEOUT
 * posture (issue #115) outranks PRESS and would otherwise shadow it here.
 */
const dominantBoard = () => {
  territory(1, 1, 3); // my attacker (a 3v3 coin-flip, marginal EV)
  territory(2, 1, 8);
  territory(3, 1, 8); // lots of my dice → dominant
  territory(4, 2, 3);
  territory(5, 2, 2);
  territory(6, 3, 2);
  territory(7, 3, 1);
  territory(8, 2, 1); // levels territories 3–3 so CLOSEOUT (strict lead) can't fire
  link(1, 4);
  link(4, 5);
  link(5, 6);
  link(6, 7);
};
```

(Territory 8 is deliberately unlinked: rival dice totals don't enter `evaluateBoard` for `me`, a 1-die cell adds no threat, and player 2's largest group is unchanged — so every EV and assertion in the five tests using this board is numerically identical; only the posture _selection_ is protected.)

2b. Replace the `duelBoard` builder (currently ~L567–573):

```js
const duelBoard = iLead => () => {
  territory(1, 1, 3); // my attacker — a marginal 3v3 coin flip vs the rival
  territory(2, 2, 3); // rival defender
  territory(3, 1, 8); // my dice elsewhere
  territory(4, iLead ? 1 : 2, 8); // mine ⇒ I lead the duel 19–3; rival's ⇒ totals tie 11–11
  link(1, 2);
};
```

with:

```js
const duelBoard = iLead => () => {
  territory(1, 1, 3); // my attacker — a marginal 3v3 coin flip vs the rival
  territory(2, 2, 3); // rival defender
  territory(3, 1, 8); // my dice elsewhere
  territory(4, iLead ? 1 : 2, iLead ? 8 : 6); // mine ⇒ I lead 19–5; rival's ⇒ totals tie 11–11
  territory(5, 2, 1); // rival filler (isolated 1-die cells): keeps territory counts
  territory(6, 2, 1); // level (3–3 / 2–4) so CLOSEOUT (strict lead) can never fire here
  link(1, 2);
};
```

2c. In the comment block above `duelBoard` (currently ~L558–566), change `above my ~0.86 share` to `above my ~0.79 share`. In the "PRESS shortcut" test body, change the inline comment `// Leading the duel (19 vs 3 dice) → shortcut fires → PRESS takes the marginal capture.` to `// Leading the duel (19 vs 5 dice) → shortcut fires → PRESS takes the marginal capture.`

- [ ] **Step 3: Run the suite to prove the board edits are behavior-neutral**

Run: `npx vitest run tests/ai/ai_expectimax.test.js`
Expected: ALL existing tests PASS, unchanged. If any posture test now fails, the board edit broke its lever — stop and fix before adding anything new.

- [ ] **Step 4: Write the failing closeout tests**

Append after the "PRESS shortcut: leading a heads-up duel…" test (before the `attackThreshold override` test):

```js
/*
 * CLOSEOUT posture (issue #115) — strict territory lead AND (dominant dice
 * share OR ≤3 players alive) selects closeoutThreshold, ABOVE press in
 * precedence. PRESS is not enough on a maxed frontier: a risk-penalized 8v8
 * scores ≈ -3 vs stopping, below even pressThreshold (-2.5), which froze won
 * games into turn-cap stalemates.
 */
const closeoutBoard = () => {
  // me: 3 cells vs 2 and 1 (strict lead), share 0.5 > pressDiceShare; the
  // only attacks are 8v8 coinflips out of my border cell 3.
  territory(1, 1, 8);
  territory(2, 1, 8);
  territory(3, 1, 8);
  territory(4, 2, 8);
  territory(5, 2, 8);
  territory(6, 3, 8);
  link(1, 2);
  link(2, 3);
  link(3, 4); // 8v8 border
  link(3, 5); // second 8v8 border (deepens the loss branch: clearly below press)
  link(4, 5);
  link(5, 6);
};

test('CLOSEOUT posture: a clear territory leader presses the maxed frontier (issue #115)', () => {
  // press/base/weak pinned high: only the closeout bar can admit the 8v8.
  closeoutBoard();
  expect(
    makeExpectimax({
      closeoutThreshold: -8,
      pressThreshold: 50,
      baseThreshold: 50,
      weakThreshold: 50,
    })(mockGame)
  ).not.toBe(0);
  expect(mockGame.area_from).toBe(3);
  expect([4, 5]).toContain(mockGame.area_to);

  // Same board, closeout pinned high too → every posture declines → pass.
  mockGame.area_from = 0;
  mockGame.area_to = 0;
  closeoutBoard();
  expect(
    makeExpectimax({
      closeoutThreshold: 50,
      pressThreshold: 50,
      baseThreshold: 50,
      weakThreshold: 50,
    })(mockGame)
  ).toBe(0);
});

test('CLOSEOUT requires the strict territory lead (tied leader falls through to PRESS)', () => {
  /*
   * Identical maxed frontier but tied 3–3 territories: closeout must not
   * fire. Share 0.5 > pressDiceShare still selects PRESS, pinned high here,
   * so the bot declines — proving the territory lead is the closeout selector.
   */
  territory(1, 1, 8);
  territory(2, 1, 8);
  territory(3, 1, 8);
  territory(4, 2, 8);
  territory(5, 2, 8);
  territory(6, 2, 8);
  link(1, 2);
  link(2, 3);
  link(3, 4);
  link(4, 5);
  link(5, 6);
  expect(
    makeExpectimax({
      closeoutThreshold: -50,
      pressThreshold: 50,
      baseThreshold: 50,
      weakThreshold: 50,
    })(mockGame)
  ).toBe(0);
  expect(mockGame.area_from).toBe(0);
});

test('shipped defaults press the clearly-winning maxed frontier instead of passing (issue #115)', () => {
  // The end-to-end #115 acceptance at unit scale: no overrides, real weights.
  closeoutBoard();
  expect(ai_expectimax(mockGame)).not.toBe(0);
  expect(mockGame.area_from).toBe(3);
});
```

- [ ] **Step 5: Run tests to verify the new ones fail correctly**

Run: `npx vitest run tests/ai/ai_expectimax.test.js`
Expected: the first CLOSEOUT test FAILS at construction (`makeExpectimax: unknown param "closeoutThreshold"`); the strict-lead test FAILS the same way; the shipped-defaults test FAILS with `expect(0).not.toBe(0)` — pinning the pre-fix turtle. All pre-existing tests still PASS.

- [ ] **Step 6: Implement the closeout posture**

6a. In `src/ai/ai_expectimax.js`, inside `DEFAULT_PARAMS`, after the line:

```js
  pressThreshold: -2.5, // dominant / winning duel: spend the advantage hard to close the game out (D-9 tuned)
```

insert:

```js
  closeoutThreshold: -8.0, // clearly winning (strict territory lead + dominant share or ≤3 alive): admit the maxed frontier's near-even full-stack swings that even pressThreshold rejects (a risk-penalized 8v8 ≈ -3) — issue #115. Finite on purpose: a truly suicidal only-move is still declined.
```

6b. Replace the body of `postureThreshold` (currently L122–144):

```js
function postureThreshold(diceByPlayer, areasByPlayer, me, pmax, P) {
  let totalDice = 0;
  let activeRivals = 0;
  let bestRivalDice = 0;
  for (let pl = 0; pl < pmax; pl++) {
    totalDice += diceByPlayer[pl];
    if (pl === me) continue;
    if (areasByPlayer[pl] > 0) activeRivals += 1;
    if (diceByPlayer[pl] > bestRivalDice) bestRivalDice = diceByPlayer[pl];
  }
  const myShare = totalDice > 0 ? diceByPlayer[me] / totalDice : 0;

  // Dominant, or ahead in a heads-up endgame → press to finish.
  if (myShare > P.pressDiceShare || (activeRivals === 1 && diceByPlayer[me] > bestRivalDice)) {
    return P.pressThreshold;
  }
  // Weak in a crowd → low bar to claw back.
  if (myShare < P.weakDiceShare && activeRivals > 1) {
    return P.weakThreshold;
  }
  // Balanced → patient.
  return P.baseThreshold;
}
```

with:

```js
function postureThreshold(diceByPlayer, areasByPlayer, me, pmax, P) {
  let totalDice = 0;
  let activeRivals = 0;
  let bestRivalDice = 0;
  let bestRivalAreas = 0;
  for (let pl = 0; pl < pmax; pl++) {
    totalDice += diceByPlayer[pl];
    if (pl === me) continue;
    if (areasByPlayer[pl] > 0) activeRivals += 1;
    if (diceByPlayer[pl] > bestRivalDice) bestRivalDice = diceByPlayer[pl];
    if (areasByPlayer[pl] > bestRivalAreas) bestRivalAreas = areasByPlayer[pl];
  }
  const myShare = totalDice > 0 ? diceByPlayer[me] / totalDice : 0;

  /*
   * Clearly winning — strict territory lead AND (dominant dice share OR the
   * field narrowed to ≤3 alive) → the closeout bar, ABOVE press in precedence.
   * PRESS is not enough here: on a maxed frontier every candidate is a
   * risk-penalized ~8v8 (≈ -3 vs stopping), which even pressThreshold rejects,
   * freezing won games into turn-cap stalemates (issue #115).
   */
  if (areasByPlayer[me] > bestRivalAreas && (myShare > P.pressDiceShare || activeRivals <= 2)) {
    return P.closeoutThreshold;
  }
  // Dominant, or ahead in a heads-up endgame → press to finish.
  if (myShare > P.pressDiceShare || (activeRivals === 1 && diceByPlayer[me] > bestRivalDice)) {
    return P.pressThreshold;
  }
  // Weak in a crowd → low bar to claw back.
  if (myShare < P.weakDiceShare && activeRivals > 1) {
    return P.weakThreshold;
  }
  // Balanced → patient.
  return P.baseThreshold;
}
```

6c. In the JSDoc above `postureThreshold` (currently L99–121), after the sentence ending `…the mechanism that makes it the field leader.` add:

```
 * A fourth CLOSEOUT tier (issue #115) sits above PRESS: a strict territory
 * lead plus dominant share (or a ≤3-player field) drops the bar to
 * closeoutThreshold, admitting the near-even full-stack swings a maxed
 * winning frontier offers — the case PRESS's -2.5 still rejected.
```

- [ ] **Step 7: Run tests to verify all pass**

Run: `npx vitest run tests/ai/ai_expectimax.test.js`
Expected: PASS — every pre-existing posture/guard/depth test plus the three new ones. Pay attention to `makeExpectimax config guard` (must still throw on unknown/NaN) and `makeExpectimax() with no overrides reproduces the shipped default bot`.

- [ ] **Step 8: After mini-probe + lint**

```bash
npm run behavior:turtle -- --bots Expectimax --field self --games 15 --json > /tmp/claude-115/expectimax-after.json 2>/dev/null
node -e '
const [b, a] = ["before", "after"].map(w => JSON.parse(require("fs").readFileSync(`/tmp/claude-115/expectimax-${w}.json`)));
for (const w of [["BEFORE", b], ["AFTER", a]]) { const r = w[1].fields.self[0]; console.log(w[0], JSON.stringify({ leadPass: r.leadPassRate, domPass: r.dominantPassRate, stalemate: r.stalemateRate })); }'
npx eslint --no-ignore src/ai/ai_expectimax.js tests/ai/ai_expectimax.test.js
```

Expected: turtle metrics drop; lint clean.

- [ ] **Step 9: Commit, push, PR**

```bash
git checkout -b fix/115-press-expectimax
git add src/ai/ai_expectimax.js tests/ai/ai_expectimax.test.js
git commit -m "feat(ai): closeout posture for Expectimax (issue #115)

Adds a fourth posture above PRESS: a strict territory lead plus dominant
dice share (or a <=3-player field) selects the new closeoutThreshold
(-8.0), admitting the near-even full-stack swings of a maxed winning
frontier that pressThreshold still rejected. Posture stays root-computed
and threaded; the factory's config guards cover the new tunable.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin fix/115-press-expectimax
gh pr create --repo bigintersmind/dicewarsjs --base master \
  --title "feat(ai): closeout posture for Expectimax (issue #115, 2/4)" \
  --body "$(cat <<'EOF'
Part 2/4 of issue #115 (~30% lead-pass). `postureThreshold` gains a highest-precedence "clearly winning" branch keyed on the previously present-but-unused territory census; new finite tunable `closeoutThreshold: -8.0` in `DEFAULT_PARAMS`. Two shared posture-test boards (`dominantBoard`, `duelBoard`) gained isolated 1-die rival filler cells to level territory counts so their original PRESS levers stay meaningfully tested (dice shares and all assertions unchanged).

Self-mirror probe (15 seeds, deterministic A/B): paste the Step 8 BEFORE/AFTER lines here.

Strength gate: consolidated `arena:sweep` before/after runs in the issue-#115 validation pass prior to closing the issue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 3: Adaptive — keep max-stack attacks in the candidate list when clearly winning

**Files:**

- Modify: `src/ai/ai_adaptive.js` (new constants after the import ~L13; hoisted census + press signal at the top of `generateMoves` ~L399–404; the skip gate ~L425–444)
- Test: `tests/ai/ai_adaptive.test.js` (append a new `describe` before the file's closing `});`)

**Interfaces:**

- Consumes: `game.player[i].area_c` / `.dice_c` (maintained by both `src/engine/AIAdapter.js` and `tests/mocks/gameMock.js`); existing helpers untouched.
- Produces: private constants `PRESS_PLAYER_COUNT = 3`, `PRESS_DICE_SHARE = 0.35`; a hoisted `pressToClose` boolean inside `generateMoves`; a new leading branch in the `diceAdvantage <= 0` gate. `generateMoves(game, strategy, pn)` signature unchanged.

**⚠ Bot-specific gotchas:** (1) `selectBestMove` uses `Math.random()` — the press edit lives entirely in the pure `generateMoves` filter; do not touch `selectBestMove`. (2) `const { adat, AREA_MAX, dominantPlayer } = game;` destructures a `dominantPlayer` that is **`undefined`** — recompute dominance from `game.player`, never from that field. (3) The `simulate*` helpers mutate `adat[*].arm` and restore — add no early returns near them.

- [ ] **Step 1: Baseline mini-probe (before any edit)**

```bash
mkdir -p /tmp/claude-115
npm run behavior:turtle -- --bots Adaptive --field self --games 20 --json > /tmp/claude-115/adaptive-before.json 2>/dev/null
```

(20 games, not 15: Adaptive's RNG makes rates noisier.)

- [ ] **Step 2: Write the failing tests**

Append inside the top-level `describe('Adaptive AI', …)` block of `tests/ai/ai_adaptive.test.js`, before its final `});`:

```js
describe('Press-to-close (issue #115)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('attacks 8v8 as the clear leader of a 3-player field instead of passing', () => {
    /*
     * The measured worst case (~69% endgame-lead pass): me (player 1) is the
     * strict territory leader of a 3-player field with a maxed frontier.
     * determineStrategy hands the dominant leader aggression ≈ 0.5, and the
     * old move filter required aggression > 0.7 for an even 8v8 outside the
     * 2-player endgame — so generateMoves returned [] and the bot passed.
     */
    mockGame.createTerritory(1, 1, 8, { 4: 1 });
    mockGame.createTerritory(2, 1, 8);
    mockGame.createTerritory(3, 1, 8);
    mockGame.createTerritory(4, 2, 8, { 1: 1 });
    mockGame.createTerritory(5, 2, 8);
    mockGame.createTerritory(6, 3, 8);
    mockGame.recalculatePlayerStats();
    mockGame.setPlayerRankings();

    // Pin selectBestMove's RNG onto its deterministic moves[0] path.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const result = ai_adaptive(mockGame);

    expect(result).not.toBe(0);
    expect(mockGame.area_from).toBe(1);
    expect(mockGame.area_to).toBe(4);
  });

  test('still passes the same frontier when not clearly winning (4 players, tied lead)', () => {
    // Tied territories, dice share ≤ 0.35, four players alive: the press
    // gate must NOT fire, pinning pre-#115 patience outside the winning case.
    mockGame.createTerritory(1, 1, 8, { 4: 1 });
    mockGame.createTerritory(2, 1, 8);
    mockGame.createTerritory(3, 1, 8);
    mockGame.createTerritory(4, 2, 8, { 1: 1 });
    mockGame.createTerritory(5, 2, 8);
    mockGame.createTerritory(6, 2, 8);
    mockGame.createTerritory(7, 3, 8);
    mockGame.createTerritory(8, 3, 8);
    mockGame.createTerritory(9, 4, 8);
    mockGame.recalculatePlayerStats();
    mockGame.setPlayerRankings();

    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    expect(ai_adaptive(mockGame)).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify the first fails**

Run: `npx vitest run tests/ai/ai_adaptive.test.js`
Expected: "attacks 8v8 as the clear leader…" FAILS with `expect(0).not.toBe(0)` (the pre-fix pass). "still passes…" PASSES (it pins existing behavior). All pre-existing tests PASS.

- [ ] **Step 4: Implement the press gate**

4a. In `src/ai/ai_adaptive.js`, after the import (currently L13):

```js
import { getPlayerCount } from './playerCount.js';
```

add:

```js
/*
 * Press-to-close gate (issue #115): once the field has narrowed to this many
 * active players, a clear leader — a strict territory lead, or holding more
 * than PRESS_DICE_SHARE of all dice on the board — keeps its max-stack
 * near-even attacks in the candidate list regardless of the aggression dial.
 * 0.35 mirrors the dominant-player share analyzeGameState uses.
 */
const PRESS_PLAYER_COUNT = 3;
const PRESS_DICE_SHARE = 0.35;
```

4b. In `generateMoves`, directly after (currently L400–402):

```js
// Pre-calculate territory information to avoid redundant calculations
const areaInfo = calculateAreaInfo(game);
const { adat, AREA_MAX, dominantPlayer } = game;
```

insert:

```js
/*
 * Press-to-close (issue #115). determineStrategy caps a dominant leader's
 * aggression at ~0.6, which the max-dice filter below (aggression > 0.7)
 * never admits — so a winning bot generated zero even-odds moves and passed
 * every turn, freezing all-8s boards into turn-cap stalemates. The signal is
 * loop-invariant, so it is computed once here. (Dominance is recomputed from
 * the live player census — the destructured game.dominantPlayer above is a
 * legacy field that is undefined on this view.)
 */
const activePlayersCount = Object.values(game.player).filter(p => p.area_c > 0).length;
const isEndgame = activePlayersCount <= 2;
let bestRivalTerritories = 0;
let totalDiceCount = 0;
for (let i = 0; i < game.player.length; i++) {
  const p = game.player[i];
  if (!p) continue;
  totalDiceCount += p.dice_c || 0;
  if (i !== pn && (p.area_c || 0) > bestRivalTerritories) {
    bestRivalTerritories = p.area_c;
  }
}
const myDiceShare = totalDiceCount > 0 ? (game.player[pn].dice_c || 0) / totalDiceCount : 0;
const pressToClose =
  activePlayersCount <= PRESS_PLAYER_COUNT &&
  ((game.player[pn].area_c || 0) > bestRivalTerritories || myDiceShare > PRESS_DICE_SHARE);
```

4c. Replace the per-target census + gate (currently L425–444):

```js
/*
 * Skip if we don't have an advantage, with special handling for endgame scenarios
 * Count active players to determine if we're in endgame
 * The remainingPlayers is stored in the analysis result rather than directly passed
 */
const activePlayersCount = Object.values(game.player).filter(p => p.area_c > 0).length;
const isEndgame = activePlayersCount <= 2;
const hasMaxDice = attackerDice === 8;

// In endgame with 2 players, be more aggressive with max dice territories
if (diceAdvantage <= 0) {
  // Allow attacking equal or slightly stronger territories in endgame if we have max dice
  if (isEndgame && hasMaxDice && (diceAdvantage >= -1 || strategy.aggression > 0.6)) {
    // Continue with attack evaluation in endgame
  } else if (hasMaxDice && strategy.aggression > 0.7) {
    // Continue with attack for non-endgame but highly aggressive with max dice
  } else {
    return; // Skip this attack - not favorable enough
  }
}
```

with:

```js
/*
 * Skip if we don't have an advantage, with special handling for the
 * press-to-close, endgame, and high-aggression max-dice scenarios.
 * (activePlayersCount / isEndgame / pressToClose are hoisted above the
 * loop — the player census does not change while generating this list.)
 */
const hasMaxDice = attackerDice === 8;

if (diceAdvantage <= 0) {
  if (pressToClose && hasMaxDice && diceAdvantage >= -1) {
    // Press to close (issue #115): a clear leader in a narrowed field keeps
    // its near-even max-stack attacks no matter how low the aggression dial sits
  } else if (isEndgame && hasMaxDice && (diceAdvantage >= -1 || strategy.aggression > 0.6)) {
    // Continue with attack evaluation in endgame
  } else if (hasMaxDice && strategy.aggression > 0.7) {
    // Continue with attack for non-endgame but highly aggressive with max dice
  } else {
    return; // Skip this attack - not favorable enough
  }
}
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run tests/ai/ai_adaptive.test.js`
Expected: PASS (both new tests and all pre-existing ones — the phase/strategy/choke-point tests exercise `generateMoves` heavily; a failure there means the hoist changed loop behavior: re-check that only `activePlayersCount`/`isEndgame` moved and `hasMaxDice` stayed per-target).

- [ ] **Step 6: After mini-probe + lint**

```bash
npm run behavior:turtle -- --bots Adaptive --field self --games 20 --json > /tmp/claude-115/adaptive-after.json 2>/dev/null
node -e '
const [b, a] = ["before", "after"].map(w => JSON.parse(require("fs").readFileSync(`/tmp/claude-115/adaptive-${w}.json`)));
for (const w of [["BEFORE", b], ["AFTER", a]]) { const r = w[1].fields.self[0]; console.log(w[0], JSON.stringify({ leadPass: r.leadPassRate, domPass: r.dominantPassRate, endgLeadPass: r.endgameLeadPassRate, stalemate: r.stalemateRate })); }'
npx eslint --no-ignore src/ai/ai_adaptive.js tests/ai/ai_adaptive.test.js
```

Expected: `endgLeadPass` (the ~69% headline) and `stalemate` drop clearly. Adaptive is RNG-noisy — judge direction, not exact deltas. Lint clean.

- [ ] **Step 7: Commit, push, PR**

```bash
git checkout -b fix/115-press-adaptive
git add src/ai/ai_adaptive.js tests/ai/ai_adaptive.test.js
git commit -m "feat(ai): press-to-close move filter for Adaptive (issue #115)

The dominant-leader aggression handicap (0.8 -> 0.6) fell below the 0.7
bar the move filter demanded for even-odds max-dice attacks outside the
2-player endgame, so a winning Adaptive generated zero moves and passed
forever. A clear leader in a <=3-player field (strict territory lead or
>35% dice share) now keeps near-even max-stack attacks in the candidate
list regardless of aggression. Census hoisted out of the per-target loop;
selectBestMove's existing RNG is untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin fix/115-press-adaptive
gh pr create --repo bigintersmind/dicewarsjs --base master \
  --title "feat(ai): press-to-close move filter for Adaptive (issue #115, 3/4)" \
  --body "$(cat <<'EOF'
Part 3/4 of issue #115 (worst endgame-lead pass, ~69%). Adds a leading `pressToClose` branch to the `diceAdvantage <= 0` gate in `generateMoves`, keyed on a hoisted live census (`game.player[].area_c/dice_c`) — not on the undefined legacy `game.dominantPlayer`. RNG stays confined to `selectBestMove`.

Self-mirror probe (20 seeds; Adaptive is RNG-noisy, judge direction): paste the Step 6 BEFORE/AFTER lines here.

Strength gate: consolidated `arena:sweep` before/after runs in the issue-#115 validation pass prior to closing the issue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 4: Strategist — dominance unlocks the bank refill outside the endgame

**Files:**

- Modify: `src/ai/ai_strategist.js` (file header ~L28–36; posture comment ~L256–262; new predicate after `disruptActive` ~L263–265; the refill gate ~L315–318)
- Test: `tests/ai/ai_strategist.test.js` (append a new `describe` before the file's closing `});`)

**Interfaces:**

- Consumes: already-computed census locals `diceByPlayer`, `bestRivalDice`, `myShare`, `endgame`, `refillPool`, `myVacancy`; existing constants `DOMINANCE_SHARE = 0.4`, `ENDGAME_PLAYERS = 3`.
- Produces: locals `pressToClose` and `allowRefill`; the refill gate reads `allowRefill` instead of `endgame`. `disruptActive` stays keyed on the true ≤3-player `endgame`. No export/threshold changes.

- [ ] **Step 1: Baseline mini-probe (before any edit)**

```bash
mkdir -p /tmp/claude-115
npm run behavior:turtle -- --bots Strategist --field self --games 15 --json > /tmp/claude-115/strategist-before.json 2>/dev/null
```

- [ ] **Step 2: Write the failing tests**

Append inside the top-level `describe('Strategist AI', …)` block of `tests/ai/ai_strategist.test.js`, before its final `});` (after the "only proposes legal attacks on a mixed board" test):

```js
describe('press-to-close refill for a dominant wide-field leader (issue #115)', () => {
  /*
   * All-8s frontier with FIVE players alive — the ≤3-player endgame gate
   * (PR #35) is closed. Me (player 1): strict dice lead, ≥40% share, full
   * reserve; my only legal attack is an 8v8 whose target is backed by two
   * rival 8-stacks. Without the dominance refund the burned-dice cost prices
   * that swing below PRESS_THRESHOLD and the leader turtles; with the
   * refund, the reserve makes it affordable.
   */
  const buildDominantStalemate = () => {
    // My chain: 5 cells, all 8s (40 dice) — vacancy 0, so the refill covers a swing fully.
    territory(4, 1, 8);
    territory(5, 1, 8);
    territory(10, 1, 8);
    territory(11, 1, 8);
    territory(12, 1, 8);
    link(4, 5);
    link(5, 10);
    link(10, 11);
    link(11, 12);
    // Best rival (player 0): a triangle of 8s (24 dice); cells 2 and 3 back cell 1.
    territory(1, 0, 8);
    territory(2, 0, 8);
    territory(3, 0, 8);
    link(1, 2);
    link(2, 3);
    link(1, 3);
    // Filler rivals away from my border → 5 active players, endgame gate closed.
    territory(6, 2, 8);
    territory(7, 2, 8);
    link(6, 7);
    link(6, 3);
    territory(8, 3, 8);
    link(8, 3);
    territory(9, 4, 8);
    link(9, 3);
    // My single enemy border: the 8v8 into the rival triangle.
    link(4, 1);
    mockGame.player[1].stock = 16; // a full reserve to spend
  };

  test('spends the reserve to press an 8v8 when dominant, even in a wide field', () => {
    buildDominantStalemate();
    // Census: me 40 dice (share ≈ 0.417 ≥ DOMINANCE_SHARE), best rival 24.

    const result = ai_strategist(mockGame);

    expect(result).not.toBe(0);
    expect(mockGame.area_from).toBe(4);
    expect(mockGame.area_to).toBe(1);
  });

  test('stays patient on the same board without the dominant share', () => {
    buildDominantStalemate();
    // Two extra far-rival stacks drop my share to 40/112 ≈ 0.357 < 0.4 while
    // I still hold the strict dice lead (40 > 32) → the refund must stay off.
    territory(13, 2, 8);
    territory(14, 2, 8);
    link(13, 14);
    link(13, 6);

    expect(ai_strategist(mockGame)).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify the first fails**

Run: `npx vitest run tests/ai/ai_strategist.test.js`
Expected: "spends the reserve to press an 8v8 when dominant…" FAILS with `expect(0).not.toBe(0)` (pre-fix turtle). "stays patient…" PASSES. Both existing `bank-aware endgame aggression` tests PASS. If the first test unexpectedly passes pre-fix, the 8v8 is scoring above `PRESS_THRESHOLD` — re-check that `link(1, 3)` exists (the second backer drives the recapture discount that keeps the pre-fix score below −0.6).

- [ ] **Step 4: Implement the dominance refill**

4a. In `src/ai/ai_strategist.js`, in the file-header comment, replace (currently L35–36):

```
 * than turtling into a slow loss. (Kept to the endgame on purpose: with many
 * players alive, patient play measured stronger in arena sweeps.)
```

with:

```
 * than turtling into a slow loss. (Kept to the endgame on purpose — with many
 * level players alive, patient play measured stronger in arena sweeps — with
 * one exception, issue #115: a dominant leader, holding a strict dice lead and
 * at least DOMINANCE_SHARE of the board's dice, gets the refund at any player
 * count, so a clearly-winning bot presses its maxed frontier instead of
 * handing the game to the turn cap.)
```

4b. Replace the posture comment (currently L256–262):

```js
/*
 * Only relax into bank-aware aggression in the endgame. With many players
 * still alive, patient play is genuinely strong — let rivals spend themselves
 * fighting. Once the field narrows, turtling at all-8s just hands a slow win to
 * the leader, so this is where spending the reserve to break the stalemate (and
 * to chip the leader) pays off. ENDGAME_PLAYERS gates both behaviors.
 */
```

with:

```js
/*
 * Relax into bank-aware aggression in the endgame — or, per issue #115, at
 * any player count once I am the dominant leader (strict dice lead plus at
 * least DOMINANCE_SHARE of the board's dice): a dominant leader that turtles
 * at all-8s hands the game to the turn cap, not to patience. With many LEVEL
 * players alive patient play is genuinely strong — let rivals spend
 * themselves fighting — so the wide-field refund stays gated on dominance,
 * and the refund self-limits (refillPool <= 0 still zeroes it).
 * ENDGAME_PLAYERS still gates the trailing-leader disruption below.
 */
```

4c. After (currently L263–265):

```js
const endgame = activePlayers <= ENDGAME_PLAYERS;
const iAmTrailing = leader >= 0 && leaderDice > diceByPlayer[pn];
const disruptActive = endgame && iAmTrailing && stock >= DISRUPT_MIN_BANK;
```

add:

```js
const pressToClose = diceByPlayer[pn] > bestRivalDice && myShare >= DOMINANCE_SHARE;
const allowRefill = endgame || pressToClose;
```

4d. In the refill computation (currently L315–318), replace:

```js
const refillFactor =
  !endgame || refillPool <= 0 ? 0 : Math.min(1, refillPool / Math.max(1, myVacancy + (a - 1)));
```

with:

```js
const refillFactor =
  !allowRefill || refillPool <= 0 ? 0 : Math.min(1, refillPool / Math.max(1, myVacancy + (a - 1)));
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run tests/ai/ai_strategist.test.js`
Expected: PASS — the two new tests plus all existing ones. The two pre-existing bank-aware tests are the regression canaries: "stays patient at the same all-8s board while many players are alive" must still pass (its bot has share 0.286 and no dice lead, so `pressToClose` stays false).

- [ ] **Step 6: After mini-probe + lint**

```bash
npm run behavior:turtle -- --bots Strategist --field self --games 15 --json > /tmp/claude-115/strategist-after.json 2>/dev/null
node -e '
const [b, a] = ["before", "after"].map(w => JSON.parse(require("fs").readFileSync(`/tmp/claude-115/strategist-${w}.json`)));
for (const w of [["BEFORE", b], ["AFTER", a]]) { const r = w[1].fields.self[0]; console.log(w[0], JSON.stringify({ leadPass: r.leadPassRate, domPass: r.dominantPassRate, stalemate: r.stalemateRate })); }'
npx eslint --no-ignore src/ai/ai_strategist.js tests/ai/ai_strategist.test.js
```

Expected: turtle metrics drop (Strategist's remaining turtle is specifically the 7-player free-for-all, which the self-mirror exercises). Lint clean.

- [ ] **Step 7: Commit, push, PR**

```bash
git checkout -b fix/115-press-strategist
git add src/ai/ai_strategist.js tests/ai/ai_strategist.test.js
git commit -m "feat(ai): dominance unlocks Strategist's bank refill outside the endgame (issue #115)

PR #35's bank-aware aggression made full-stack swings affordable but was
gated to <=3 players, so Strategist still turtled a winning maxed board
in the 7-player free-for-all. A dominant leader (strict dice lead +
>= DOMINANCE_SHARE of all dice) now gets the refill refund at any player
count. The accept threshold and the trailing-leader disruption keep their
existing gates; the refund still self-limits via refillPool.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin fix/115-press-strategist
gh pr create --repo bigintersmind/dicewarsjs --base master \
  --title "feat(ai): dominance-gated wide-field bank refill for Strategist (issue #115, 4/4)" \
  --body "$(cat <<'EOF'
Part 4/4 of issue #115. Decouples the PR-#35 refill refund from raw player count via `allowRefill = endgame || pressToClose`, where `pressToClose = strict dice lead && myShare >= DOMINANCE_SHARE` — reusing the already-computed census. `disruptActive` stays on the true ≤3-player endgame.

Self-mirror probe (15 seeds, deterministic A/B): paste the Step 6 BEFORE/AFTER lines here.

Strength gate: consolidated `arena:sweep` before/after runs in the issue-#115 validation pass prior to closing the issue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 5: Consolidated validation gate and issue close-out

**Precondition:** all four PRs merged to `master`. Run from the main checkout, updated with `git pull --ff-only`. This task is compute-heavy (roughly 2–4 hours wall-clock, mostly unattended); run the long commands with generous timeouts or in the background, sequentially (they are CPU-bound).

**Files:**

- No source changes. Produces: a before/after evidence comment on issue #115; closes the issue if all acceptance criteria hold.

- [ ] **Step 1: Repo quality gates (CLAUDE.md)**

```bash
npm test          # full suite — main agent only, once
npm run lint
npm run build
```

Expected: all pass. If a test outside the four bot files fails, one of the merges broke something unrelated — stop and report.

- [ ] **Step 2: Probe — before (merge-base) vs after (merged master), identical flags**

```bash
mkdir -p /tmp/claude-115
# AFTER (current master):
npm run behavior:turtle -- --bots Lookahead,Expectimax,Adaptive,Strategist --field both --games 60 --json > /tmp/claude-115/probe-after.json 2>/dev/null
# BEFORE (pre-fix master in a throwaway worktree — the probe is seed-deterministic, so this is an exact A/B):
git worktree add /tmp/claude-115/before-checkout 54ace73
cd /tmp/claude-115/before-checkout && npm ci --no-audit --no-fund 2>/dev/null || npm install
npm run behavior:turtle -- --bots Lookahead,Expectimax,Adaptive,Strategist --field both --games 60 --json > /tmp/claude-115/probe-before.json 2>/dev/null
cd - && git worktree remove --force /tmp/claude-115/before-checkout
```

- [ ] **Step 3: Compare probe metrics with 95% CIs on the deltas**

```bash
node -e '
const fs = require("fs");
const before = JSON.parse(fs.readFileSync("/tmp/claude-115/probe-before.json"));
const after = JSON.parse(fs.readFileSync("/tmp/claude-115/probe-after.json"));
// Two-proportion z CI on (after - before) for each rate, from the raw counts the probe emits.
const ci = (kb, nb, ka, na) => {
  if (!nb || !na) return null;
  const pb = kb / nb, pa = ka / na;
  const se = Math.sqrt((pb * (1 - pb)) / nb + (pa * (1 - pa)) / na);
  const d = pa - pb, h = 1.96 * se;
  return { d, lo: d - h, hi: d + h, excludesZero: d + h < 0 || d - h > 0 };
};
const fmt = x => x == null ? "n/a" : `${(x.d * 100).toFixed(1)}pp [${(x.lo * 100).toFixed(1)}, ${(x.hi * 100).toFixed(1)}]${x.excludesZero ? " *" : ""}`;
for (const field of ["mixed", "self"]) {
  console.log(`\n=== ${field} field (Δ after−before, 95% CI, * = excludes 0) ===`);
  for (const b of before.fields[field]) {
    const a = after.fields[field].find(r => r.name === b.name);
    const rb = b.raw, ra = a.raw;
    console.log(b.name.padEnd(12),
      "leadPass", fmt(ci(rb.leaderPassTurns, rb.leaderTurns, ra.leaderPassTurns, ra.leaderTurns)),
      "| domPass", fmt(ci(rb.dominantPassTurns, rb.dominantTurns, ra.dominantPassTurns, ra.dominantTurns)),
      "| endgLeadPass", fmt(ci(rb.endgameLeadPassTurns, rb.endgameLeadTurns, ra.endgameLeadPassTurns, ra.endgameLeadTurns)),
      "| stalemate", fmt(ci(rb.stalemates, rb.games, ra.stalemates, ra.games)),
      "| meanTurns", b.meanTurns.toFixed(0), "→", a.meanTurns.toFixed(0));
  }
}'
```

Expected (the issue's acceptance criteria): for each of the four bots, `leadPass` and `endgLeadPass` deltas negative with CI excluding 0 (`*`); `domPass` near 0 after; `stalemate` down on mixed and sharply down on self; `meanTurns` decreasing. Adaptive's numbers carry RNG noise — its CI does the work.

- [ ] **Step 4: Strength gate — arena sweep, before vs after, identical field and flags**

The comparison field: the four changed bots + two closers + a persona anchor.

```bash
# AFTER (current master) — this is the long one (~20×150 games):
npm run arena:sweep -- --bots Lookahead,Expectimax,Adaptive,Strategist,Default,Defensive,Conqueror --runs 20 --games 150 > /tmp/claude-115/sweep-after.txt 2>&1
# BEFORE (merge-base):
git worktree add /tmp/claude-115/before-checkout 54ace73
cd /tmp/claude-115/before-checkout && npm ci --no-audit --no-fund 2>/dev/null || npm install
npm run arena:sweep -- --bots Lookahead,Expectimax,Adaptive,Strategist,Default,Defensive,Conqueror --runs 20 --games 150 > /tmp/claude-115/sweep-before.txt 2>&1
cd - && git worktree remove --force /tmp/claude-115/before-checkout
diff <(grep -A20 "Win" /tmp/claude-115/sweep-before.txt) <(grep -A20 "Win" /tmp/claude-115/sweep-after.txt) || true
```

Gate: for each changed bot, the AFTER mean Win% / ELO must not sit below BEFORE by more than the reported 95% CI half-width. Flat or up = pass. If wall-clock forces it, `--runs 12 --games 100` is acceptable **only if used for both runs**. If one bot regresses beyond its CI: report it in the issue comment, propose the per-bot tune (Lookahead/Adaptive: tighten the predicate to require the dominant dice share unconditionally; Expectimax: raise `closeoutThreshold` toward −5; Strategist: raise `DOMINANCE_SHARE` use to ≥0.45 in `pressToClose`), and do **not** close the issue.

- [ ] **Step 5: Health gate — zero forced ends**

```bash
for b in Lookahead Expectimax Adaptive Strategist; do
  npm run benchmark-bot -- $b --games 200 | tee /tmp/claude-115/bench-$b.txt
done
grep -iE "error|invalid|forced" /tmp/claude-115/bench-*.txt
```

Expected: every run completes; zero errors / invalid moves / forced ends reported.

- [ ] **Step 6: Post evidence and close**

Compose `/tmp/claude-115/issue-comment.md` containing: the Step 3 delta table, the Step 4 before/after Win%/ELO lines for the four bots, the Step 5 zero-forced-ends confirmation, and links to the four PRs. Then:

```bash
gh issue comment 115 --repo bigintersmind/dicewarsjs --body-file /tmp/claude-115/issue-comment.md
# Only if every acceptance criterion passed:
gh issue close 115 --repo bigintersmind/dicewarsjs --comment "All four press-to-close overrides landed and validated: turtle metrics down with CIs excluding 0, strength flat-or-up within CIs, zero forced ends."
```

If any criterion failed, leave the issue open and end the comment with the specific follow-up needed.

---

## Dispatch notes (for the orchestrating session)

- Tasks 1–4: one Opus agent each, parallel, isolated worktrees, branched from `master @ 54ace73`. Give each agent its single task section **plus the Global Constraints and Shared background sections**; they need nothing else from this file.
- Task 5: a single agent (or the main session) after all four PRs merge. Ivan controls merge timing; PR merge is not part of Tasks 1–4.
- Worktree PR cleanup gotcha (CLAUDE.md): if merging via `gh pr merge --delete-branch` while the branch is checked out in a worktree, the merge lands but local cleanup errors — finish with `git push origin --delete <branch>`, `git worktree remove <path>`, `git branch -D <branch>`, `git pull --prune`.
- Sizing: Tasks 1 & 4 ≈ S (30–90 min each incl. probes); Tasks 2 & 3 ≈ M (test-churn care / legacy-file care); Task 5 ≈ S effort but 2–4 h compute.

## Verified-anchor appendix (what "done" must not disturb)

- `ai_lookahead` exports stay exactly `['ai_lookahead', 'evaluateLookaheadTurn', 'winProbability']` (pinned test).
- `evaluateLookaheadTurn().threshold` still reports `attackThreshold`'s value — the posture-ordering test (`PRESS < WEAK < BASE`) reads it.
- Lookahead's existing "declines a sub-floor-odds attack" test board has tied territories (2–2) → `pressToClose` false there by design.
- Expectimax posture stays computed **once at the root** and threaded; `makeExpectimax` guard still throws on unknown/non-finite params (new param included automatically).
- Strategist's existing "stays patient … while many players are alive" test: share 0.286, no dice lead → new predicate false; must keep passing.
- Adaptive: `Math.random` appears only in `selectBestMove` before and after (verify with `grep -n "Math.random" src/ai/ai_adaptive.js`).
- All four bots: `winProbability` re-exports (Lookahead L17–19, Strategist L45–48) are load-bearing for tests/tooling — untouched.
