/**
 * Behavioral-eval harness — Phase 1 core tests.
 *
 * Covers the pure metric extraction / aggregation / control-comparison logic of
 * `scripts/lib/behavior-core.mjs`, plus a real-engine smoke that pins the §6 engine
 * signal (`onTurn(turnNumber, state, actingPlayerId)`) the harness depends on. See
 * docs/ml-bot/EVAL_HARNESS.md.
 *
 * Node env is fine (no DOM). Run scoped: `npx vitest run tests/behaviorCore.test.js`.
 */
import {
  makeCapture,
  profileGameFromCapture,
  reduceRun,
  summarizeAxis,
  alignDropNull,
  compareAxis,
  compareToControl,
  signaturePass,
  signatureDetail,
  holmSignatures,
  parseBotSpec,
  parseMdeOverrides,
  killsPairMde,
  separationPair,
  assertPairableReports,
  SHIPPED_BASE,
  AXES,
  PERSONA_SIGNATURES,
  SIGNATURE_FAMILY_SIZE,
  SEPARATION_AXES,
  KILLS_MDE_FRACTION,
  DEFAULT_MDE,
} from '../scripts/lib/behavior-core.mjs';
import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { isStopMove } from '../src/arena/trajectoryExport.js';

const STOP = { type: 'END_TURN' };
const attack = (from = 1, to = 2) => ({ from, to });
const player = (
  id,
  over = { territoryCount: 4, diceCount: 8, largestGroup: 3, eliminated: false }
) => ({
  id,
  ...over,
});

/** A synthetic post-turn state: 3 players with given (territory/dice/largest/eliminated). */
const stateOf = specs => ({ players: specs.map((s, i) => player(i, s)) });

/** A full per-run reduced record (every AXES key finite); override specific axes per test. */
const reduceShape = (over = {}) => ({ ...Object.fromEntries(AXES.map(a => [a, 1])), ...over });

describe('makeCapture — onTurn/onStep accumulation', () => {
  it('counts the victory turn as an active turn (the aggression-bias fix)', () => {
    const { capture, onTurn, onStep } = makeCapture(0);

    // Turn 1: bot 0 attacks twice then STOPs (a normal, non-winning turn).
    onStep({ playerId: 0, chosenMove: attack() });
    onStep({ playerId: 0, chosenMove: attack() });
    onStep({ playerId: 0, chosenMove: STOP });
    onTurn(
      1,
      stateOf([{ territoryCount: 5, diceCount: 10, largestGroup: 4, eliminated: false }, {}, {}]),
      0
    );

    // Turn 2: opponent 1 eliminates opponent 2 — NOT the profiled bot's kill.
    onTurn(
      2,
      stateOf([{}, {}, { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true }]),
      1
    );

    // Turn 3: bot 0 makes the winning capture (eliminates 1). A victory turn emits NO STOP step.
    onStep({ playerId: 0, chosenMove: attack() });
    onTurn(
      3,
      stateOf([
        { territoryCount: 9, diceCount: 15, largestGroup: 7, eliminated: false },
        { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true },
        {},
      ]),
      0
    );

    expect(capture.activeTurns).toBe(2); // turns 1 and 3 — the win is counted (no STOP undercount)
    expect(capture.kills).toBe(1); // only player 1 (player 2 was opponent-1's kill)
    expect(capture.zeroAttackTurns).toBe(0);
    expect(capture.eliminatedAtTurn).toBeNull(); // the bot itself was never eliminated
    expect(capture.territory).toEqual([5, 9]);
    expect(capture.dice).toEqual([10, 15]);
    expect(capture.largestGroup).toEqual([4, 7]);
  });

  it('records the bot being eliminated and a zero-attack (pass) turn', () => {
    const { capture, onTurn, onStep } = makeCapture(0);

    // Bot 0 passes its turn (STOP with no attacks).
    onStep({ playerId: 0, chosenMove: STOP });
    onTurn(
      1,
      stateOf([{ territoryCount: 2, diceCount: 3, largestGroup: 1, eliminated: false }, {}, {}]),
      0
    );

    // Opponent 1's turn eliminates bot 0.
    onTurn(
      2,
      stateOf([{ territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true }, {}, {}]),
      1
    );

    expect(capture.activeTurns).toBe(1);
    expect(capture.zeroAttackTurns).toBe(1);
    expect(capture.eliminatedAtTurn).toBe(2);
    expect(capture.kills).toBe(0);
  });

  it('ignores steps and turns for other seats', () => {
    const { capture, onTurn, onStep } = makeCapture(0);
    onStep({ playerId: 1, chosenMove: attack() });
    onTurn(1, stateOf([{}, {}, {}]), 1);
    expect(capture.activeTurns).toBe(0);
    expect(capture.territory).toEqual([]);
  });

  it('credits multiple eliminations in one turn, and never double-counts (the _seenEliminated dedup)', () => {
    const { capture, onTurn } = makeCapture(0);

    // Bot 0's turn eliminates BOTH opponents 1 and 2 in a single sweep (a late-game finish).
    onTurn(
      1,
      stateOf([
        { territoryCount: 9, diceCount: 15, largestGroup: 8, eliminated: false },
        { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true },
        { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true },
      ]),
      0
    );
    expect(capture.kills).toBe(2); // both kills credited to the acting bot

    // A later turn that re-presents the same eliminated players must NOT re-credit them.
    onTurn(
      2,
      stateOf([
        { territoryCount: 9, diceCount: 15, largestGroup: 8, eliminated: false },
        { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true },
        { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true },
      ]),
      0
    );
    expect(capture.kills).toBe(2); // unchanged — dedup holds
  });
});

describe('profileGameFromCapture', () => {
  const baseResult = (overrides = {}) => ({
    winner: 0,
    turnCount: 3,
    botStats: [
      {
        playerIndex: 0,
        placement: 1,
        attacksMade: 3,
        attacksWon: 3,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      },
      {
        playerIndex: 1,
        placement: 2,
        attacksMade: 1,
        attacksWon: 0,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      },
    ],
    ...overrides,
  });

  it('derives per-game scalars; aggression uses the actor-counted active turns', () => {
    const capture = {
      playerIndex: 0,
      activeTurns: 2,
      territory: [5, 9],
      dice: [10, 16],
      largestGroup: [4, 7],
      kills: 1,
      eliminatedAtTurn: null,
      zeroAttackTurns: 0,
    };
    const p = profileGameFromCapture(baseResult(), 0, capture);
    expect(p.won).toBe(true);
    expect(p.turnsToWin).toBe(3);
    expect(p.aggression).toBeCloseTo(3 / 2); // 1.5, NOT 3 (which a STOP-count denominator would give)
    expect(p.captureEfficiency).toBe(1);
    expect(p.avgDiceReserve).toBe(13);
    expect(p.avgTerritory).toBe(7);
    expect(p.dicePerTerritory).toBeCloseTo((10 / 5 + 16 / 9) / 2);
    expect(p.largestGroup).toBe(5.5);
    expect(p.kills).toBe(1);
    expect(p.survivalTurn).toBe(3); // survived ⇒ full game length
  });

  it('turnsToWin is null when the bot did not win; survivalTurn is the death turn', () => {
    const capture = {
      playerIndex: 0,
      activeTurns: 1,
      territory: [2],
      dice: [3],
      largestGroup: [1],
      kills: 0,
      eliminatedAtTurn: 2,
      zeroAttackTurns: 1,
    };
    const result = baseResult({
      winner: 1,
      turnCount: 5,
      botStats: [
        {
          playerIndex: 0,
          placement: 3,
          attacksMade: 0,
          attacksWon: 0,
          errors: 0,
          invalidMoves: 0,
          maxMovesHit: 0,
        },
      ],
    });
    const p = profileGameFromCapture(result, 0, capture);
    expect(p.won).toBe(false);
    expect(p.turnsToWin).toBeNull();
    expect(p.captureEfficiency).toBeNull(); // 0 attacks ⇒ undefined, not 0/0
    expect(p.aggression).toBe(0); // 0 attacks over 1 active turn
    expect(p.zeroAttackTurnFrac).toBe(1);
    expect(p.survivalTurn).toBe(2);
  });

  it('a bot that never acted (0 active turns) degrades every rate axis to null, not garbage', () => {
    const capture = {
      playerIndex: 0,
      activeTurns: 0,
      territory: [],
      dice: [],
      largestGroup: [],
      kills: 0,
      eliminatedAtTurn: 1,
      zeroAttackTurns: 0,
    };
    const result = baseResult({
      winner: 1,
      turnCount: 4,
      botStats: [
        {
          playerIndex: 0,
          placement: 3,
          attacksMade: 0,
          attacksWon: 0,
          errors: 0,
          invalidMoves: 0,
          maxMovesHit: 0,
        },
      ],
    });
    const p = profileGameFromCapture(result, 0, capture);
    expect(p.aggression).toBeNull();
    expect(p.zeroAttackTurnFrac).toBeNull();
    expect(p.avgTerritory).toBeNull();
    expect(p.avgDiceReserve).toBeNull();
    expect(p.survivalTurn).toBe(1); // death turn still valid
    expect(p.placement).toBe(3);
  });

  it('throws on a missing botStats entry, a seat mismatch, and misaligned capture arrays (fail loud)', () => {
    const aligned = {
      playerIndex: 0,
      activeTurns: 1,
      territory: [5],
      dice: [10],
      largestGroup: [4],
      kills: 0,
      eliminatedAtTurn: null,
      zeroAttackTurns: 0,
    };
    // No botStats for seat 5.
    expect(() => profileGameFromCapture(baseResult(), 5, aligned)).toThrow(
      /no botStats for seat 5/
    );
    // Capture built for a different seat than requested.
    expect(() => profileGameFromCapture(baseResult(), 1, aligned)).toThrow(/capture seat 0 != 1/);
    // territory/dice/largestGroup lengths disagree with activeTurns ⇒ would index past end → NaN.
    const misaligned = { ...aligned, dice: [10, 99] }; // length 2 vs activeTurns 1
    expect(() => profileGameFromCapture(baseResult(), 0, misaligned)).toThrow(/misaligned capture/);
  });
});

describe('reduceRun', () => {
  const won = {
    won: true,
    placement: 1,
    turnsToWin: 20,
    aggression: 4,
    captureEfficiency: 0.7,
    avgDiceReserve: 9,
    avgTerritory: 8,
    dicePerTerritory: 1.2,
    largestGroup: 6,
    kills: 2,
    survivalTurn: 20,
    zeroAttackTurnFrac: 0.1,
  };
  const lost = {
    won: false,
    placement: 3,
    turnsToWin: null,
    aggression: 2,
    captureEfficiency: 0.5,
    avgDiceReserve: 5,
    avgTerritory: 4,
    dicePerTerritory: 1.0,
    largestGroup: 3,
    kills: 0,
    survivalTurn: 12,
    zeroAttackTurnFrac: 0.3,
  };

  it('reduces to per-run scalars; winners-only axis ignores losses', () => {
    const r = reduceRun([won, lost, lost, won]);
    expect(r.winPct).toBe(50);
    expect(r.aggression).toBe(3); // mean(4,2,2,4)
    expect(r.turnsToWin).toBe(20); // only the two wins (both 20)
    expect(r.avgPlacement).toBe(2); // mean(1,3,3,1)
  });

  it('turnsToWin is null for a run with no wins (the null-run case)', () => {
    expect(reduceRun([lost, lost]).turnsToWin).toBeNull();
  });
});

describe('alignDropNull + compareAxis (paired control comparison)', () => {
  it('drops run indices where either side is null, preserving alignment', () => {
    const { a, b, n } = alignDropNull([1, null, 3, 4], [10, 20, null, 40]);
    expect(a).toEqual([1, 4]);
    expect(b).toEqual([10, 40]);
    expect(n).toBe(2);
  });

  it('classifies a real positive paired delta as HIGHER', () => {
    const cmp = compareAxis([5, 6, 7, 5, 6], [2, 3, 2, 3, 2]);
    expect(cmp.verdict).toBe('HIGHER');
    expect(cmp.lo).toBeGreaterThan(0);
    expect(cmp.n).toBe(5);
  });

  it('classifies a negative paired delta as LOWER and an overlapping one as SAME', () => {
    expect(compareAxis([1, 2, 1, 2, 1], [5, 6, 5, 6, 5]).verdict).toBe('LOWER');
    expect(compareAxis([5, 1, 6, 2, 5], [4, 2, 5, 3, 4]).verdict).toBe('SAME');
  });

  it('returns null when fewer than 2 paired runs survive null-alignment', () => {
    expect(compareAxis([1, null, null], [null, 2, null])).toBeNull();
  });

  it('treats a non-finite (NaN/Infinity) run as dropped data, not a paired value', () => {
    // A NaN must never reach pairedDelta: it would yield a NaN CI that classifyGate reads as a
    // bogus SAME at full n — the "failed measurement masquerading as no-difference" the harness
    // exists to prevent. alignDropNull drops the index from BOTH sides.
    expect(alignDropNull([1, NaN, 3, 4], [10, 20, 30, 40])).toEqual({
      a: [1, 3, 4],
      b: [10, 30, 40],
      n: 3,
    });
    expect(alignDropNull([1, Infinity, 3], [10, 20, 30]).n).toBe(2);
    // One NaN among otherwise-significant runs degrades to a clean comparison on the rest, never NaN.
    const cmp = compareAxis([5, NaN, 7, 5, 6], [2, 3, 2, 3, 2]);
    expect(Number.isFinite(cmp.delta)).toBe(true);
    expect(cmp.n).toBe(4);
    // Too few finite runs after dropping NaNs ⇒ null (no comparison), not a NaN verdict.
    expect(compareAxis([5, NaN, NaN], [2, 3, 2])).toBeNull();
  });
});

describe('signaturePass — MDE gate prevents trivial-but-significant passes', () => {
  const vsControl = { aggression: compareAxis([5, 6, 7, 5, 6], [2, 3, 2, 3, 2]) }; // Δ ≈ +3.4, CI > 0
  const sig = { axes: [{ axis: 'aggression', direction: 'HIGHER' }], rule: 'single' };

  it('passes when |Δ| >= MDE AND the CI excludes 0 in the expected direction', () => {
    expect(signaturePass(sig, vsControl, { aggression: 1.0 })).toBe(true);
  });

  it('fails a statistically-significant but behaviorally-trivial (sub-MDE) difference', () => {
    expect(signaturePass(sig, vsControl, { aggression: 10.0 })).toBe(false);
  });

  it('fails when the significant difference is in the wrong direction', () => {
    const wrongDir = { axes: [{ axis: 'aggression', direction: 'LOWER' }], rule: 'single' };
    expect(signaturePass(wrongDir, vsControl, { aggression: 1.0 })).toBe(false);
  });

  it('AND rule requires every listed axis', () => {
    const both = {
      aggression: compareAxis([5, 6, 7, 5, 6], [2, 3, 2, 3, 2]), // HIGHER, big
      turnsToWin: compareAxis([20, 21, 20, 21, 20], [19, 20, 19, 20, 19]), // HIGHER, tiny — fails LOWER
    };
    const blitz = {
      axes: [
        { axis: 'aggression', direction: 'HIGHER' },
        { axis: 'turnsToWin', direction: 'LOWER' },
      ],
      rule: 'AND',
    };
    expect(signaturePass(blitz, both, { aggression: 1, turnsToWin: 1 })).toBe(false);
  });

  it('throws when a signature axis has no registered MDE (never silently disables the guard)', () => {
    // An empty MDE map would have let `?? 0` make |Δ| ≥ 0 always true — the bug this guards.
    expect(() => signaturePass(sig, vsControl, {})).toThrow(
      /no MDE registered for axis "aggression"/
    );
  });

  it('fails closed when a required axis has no comparison (compareAxis returned null)', () => {
    // e.g. a rarely-winning persona yields mostly-null turnsToWin runs → compareAxis null.
    const blitz = {
      axes: [
        { axis: 'aggression', direction: 'HIGHER' },
        { axis: 'turnsToWin', direction: 'LOWER' },
      ],
      rule: 'AND',
    };
    const partial = { aggression: vsControl.aggression, turnsToWin: null };
    expect(() => signaturePass(blitz, partial, { aggression: 1, turnsToWin: 5 })).not.toThrow();
    expect(signaturePass(blitz, partial, { aggression: 1, turnsToWin: 5 })).toBe(false);
  });
});

describe('signatureDetail — per-axis breakdown behind signaturePass', () => {
  const vsControl = {
    aggression: compareAxis([5, 6, 7, 5, 6], [2, 3, 2, 3, 2]), // Δ ≈ +3.4, CI > 0
    turnsToWin: compareAxis([20, 21, 20, 21, 20], [19, 20, 19, 20, 19]), // HIGHER, tiny
  };
  const blitz = PERSONA_SIGNATURES.Blitz; // aggression HIGHER AND turnsToWin LOWER

  it('returns pass plus an ok/why breakdown per axis, and pass agrees with signaturePass', () => {
    const sig = { axes: [{ axis: 'aggression', direction: 'HIGHER' }], rule: 'single' };
    const d = signatureDetail(sig, vsControl, { aggression: 1.0 });
    expect(d.pass).toBe(true);
    expect(d.rule).toBe('single');
    expect(d.axes).toHaveLength(1);
    expect(d.axes[0]).toMatchObject({
      axis: 'aggression',
      meetsMde: true,
      sigInDir: true,
      ok: true,
    });
    expect(Number.isFinite(d.axes[0].delta)).toBe(true);
    // The boolean wrapper must equal detail.pass (single decision path).
    expect(signaturePass(sig, vsControl, { aggression: 1.0 })).toBe(d.pass);
  });

  it('marks a sub-MDE axis meetsMde:false and fails the gate', () => {
    const sig = { axes: [{ axis: 'aggression', direction: 'HIGHER' }], rule: 'single' };
    const d = signatureDetail(sig, vsControl, { aggression: 10.0 });
    expect(d.axes[0].meetsMde).toBe(false);
    expect(d.axes[0].ok).toBe(false);
    expect(d.pass).toBe(false);
  });

  it('AND rule: the wrong-direction turnsToWin axis fails the whole signature', () => {
    const d = signatureDetail(blitz, vsControl, { aggression: 1, turnsToWin: 1 });
    expect(d.pass).toBe(false);
    const ttw = d.axes.find(a => a.axis === 'turnsToWin');
    expect(ttw.direction).toBe('LOWER');
    expect(ttw.sigInDir).toBe(false); // CI is on the HIGHER side, so the LOWER hypothesis is unmet
  });

  it('AND rule: PASSES when BOTH axes clear MDE in the right direction (the headline happy path)', () => {
    const passingBlitz = {
      aggression: compareAxis([5, 6, 7, 5, 6], [2, 3, 2, 3, 2]), // Δ ≈ +3.4, CI > 0 (HIGHER ✓)
      turnsToWin: compareAxis([10, 11, 10, 11, 10], [20, 21, 20, 21, 20]), // Δ ≈ -10, CI < 0 (LOWER ✓)
    };
    const mde = { aggression: 1, turnsToWin: 5 };
    const d = signatureDetail(blitz, passingBlitz, mde);
    expect(d.pass).toBe(true);
    expect(d.axes.every(a => a.ok)).toBe(true); // every required axis cleared
    expect(signaturePass(blitz, passingBlitz, mde)).toBe(true);
  });

  it('fails closed (no throw) on a null comparison, even when that axis has no MDE', () => {
    const partial = { aggression: vsControl.aggression, turnsToWin: null };
    let d;
    expect(() => {
      d = signatureDetail(blitz, partial, { aggression: 1 }); // turnsToWin MDE intentionally absent
    }).not.toThrow();
    expect(d.pass).toBe(false);
    const ttw = d.axes.find(a => a.axis === 'turnsToWin');
    expect(ttw).toMatchObject({ delta: null, ok: false });
  });

  it('throws when a present-comparison axis has no MDE (the guard signaturePass relies on)', () => {
    const sig = { axes: [{ axis: 'aggression', direction: 'HIGHER' }], rule: 'single' };
    expect(() => signatureDetail(sig, vsControl, {})).toThrow(/no MDE registered for axis/);
  });
});

describe('compareAxis — paired standard error (the t-statistic input for the Holm family)', () => {
  it('exposes the Bessel-corrected paired SE of the run diffs', () => {
    // diffs [2,3,3,4]: sd = √(2/3), se = sd/√4 = 0.4082482905 (scipy-checked).
    const cmp = compareAxis([12, 14, 13, 15], [10, 11, 10, 11]);
    expect(cmp.se).toBeCloseTo(0.4082482905, 9);
    expect(cmp.delta).toBeCloseTo(3, 12);
    // Internal consistency: the CI half-width is tCrit(n−1) × se of the SAME diffs.
    expect(cmp.ci).toBeCloseTo(3.182 * cmp.se, 9);
  });
});

describe('signatureDetail — one-sided p-values for the Holm family (§3.3)', () => {
  // Scipy 1.13.1 references (see the PR notes):
  //   diffs [1,2,3,4,5]      → t = 4.2426, df 4, P(T ≥ t)  = 0.0066177998  (HIGHER direction)
  //   diffs [-8,-6,-7,-9]    → t = −11.619, df 3, P(T ≤ t) = 0.0006846656  (LOWER direction)
  const higherCmp = compareAxis([6, 8, 10, 12, 14], [5, 6, 7, 8, 9]); // diffs 1..5
  const lowerCmp = compareAxis([2, 3, 2, 1], [10, 9, 9, 10]); // diffs -8,-6,-7,-9

  it('computes the one-sided p in the registered direction (scipy-pinned)', () => {
    const sig = { axes: [{ axis: 'aggression', direction: 'HIGHER' }], rule: 'single' };
    const d = signatureDetail(sig, { aggression: higherCmp }, { aggression: 0.3 });
    expect(d.axes[0].p).toBeCloseTo(0.0066177998, 8);
    expect(d.p).toBeCloseTo(0.0066177998, 8); // single rule: signature p = the axis p

    const sigLower = { axes: [{ axis: 'avgPlacement', direction: 'LOWER' }], rule: 'single' };
    const dl = signatureDetail(sigLower, { avgPlacement: lowerCmp }, { avgPlacement: 0.4 });
    expect(dl.axes[0].p).toBeCloseTo(0.0006846656, 8);
  });

  it('an in-direction effect tested AGAINST its direction gets the complementary p', () => {
    // The same diffs 1..5 under a LOWER hypothesis: p = 1 − 0.00662 = 0.99338.
    const sig = { axes: [{ axis: 'aggression', direction: 'LOWER' }], rule: 'single' };
    const d = signatureDetail(sig, { aggression: higherCmp }, { aggression: 0.3 });
    expect(d.axes[0].p).toBeCloseTo(1 - 0.0066177998, 8);
  });

  it('AND rule: the signature p is the MAX of the axis p-values (intersection–union test)', () => {
    const blitz = PERSONA_SIGNATURES.Blitz;
    const vs = { aggression: higherCmp, turnsToWin: lowerCmp };
    const d = signatureDetail(blitz, vs, { aggression: 0.3, turnsToWin: 5 });
    // max(0.0066177998, 0.0006846656) — the weaker axis carries the conjunction.
    expect(d.p).toBeCloseTo(0.0066177998, 8);
    expect(d.pass).toBe(true);
  });

  it('zero paired SE: in-direction floors at the sign-flip bound 2⁻ⁿ, else p=1', () => {
    // n identical in-direction diffs carry at most P(all n signs agree | null) = 2⁻ⁿ of
    // evidence — never p = 0, which would clear every Holm threshold even at n = 2 where
    // the attainable bound (0.25) clears none.
    const constUp = compareAxis([5, 6, 7], [3, 4, 5]); // diffs all exactly +2 → se 0, n 3
    const constZero = compareAxis([5, 6, 7], [5, 6, 7]); // diffs all exactly 0 → se 0
    const up = { axes: [{ axis: 'aggression', direction: 'HIGHER' }], rule: 'single' };
    const down = { axes: [{ axis: 'aggression', direction: 'LOWER' }], rule: 'single' };
    expect(signatureDetail(up, { aggression: constUp }, { aggression: 0.3 }).p).toBe(2 ** -3);
    expect(signatureDetail(down, { aggression: constUp }, { aggression: 0.3 }).p).toBe(1);
    expect(signatureDetail(up, { aggression: constZero }, { aggression: 0.3 }).p).toBe(1);
    // At a 2-run tie the bound (0.25) correctly fails even the loosest Holm threshold (α=0.05).
    const twoRuns = compareAxis([5, 6], [3, 4]);
    expect(signatureDetail(up, { aggression: twoRuns }, { aggression: 0.3 }).p).toBe(0.25);
  });

  it('a null comparison on any required axis nulls the signature p (fail closed)', () => {
    const blitz = PERSONA_SIGNATURES.Blitz;
    const vs = { aggression: higherCmp, turnsToWin: null };
    const d = signatureDetail(blitz, vs, { aggression: 0.3, turnsToWin: 5 });
    expect(d.p).toBeNull();
    expect(d.axes.find(a => a.axis === 'turnsToWin').p).toBeNull();
  });
});

describe('holmSignatures — the family-wise confirmatory verdict (§3.3)', () => {
  const detail = (p, pass) => ({ p, pass });

  it('registers the family as the PERSONA_SIGNATURES count', () => {
    expect(SIGNATURE_FAMILY_SIZE).toBe(Object.keys(PERSONA_SIGNATURES).length);
    expect(SIGNATURE_FAMILY_SIZE).toBe(4); // §10.5: registered as 4 (5 if the Blitz escalation fires)
  });

  it('defaults m to the REGISTERED family even when fewer personas are graded', () => {
    // One graded persona of the 4-family: threshold α/4, so p=0.02 does NOT reject —
    // grading personas one-per-session must not quietly un-adjust the family.
    const out = holmSignatures([{ persona: 'Blitz', detail: detail(0.02, true) }]);
    expect(out.familySize).toBe(4);
    expect(out.results[0].holmReject).toBe(false);
    expect(out.results[0].confirmatoryPass).toBe(false);
    expect(out.results[0].unadjustedPass).toBe(true); // visible as "passed only un-adjusted"
  });

  it('CONFIRMED requires the registered single-test gate AND the Holm rejection', () => {
    const out = holmSignatures([
      { persona: 'Blitz', detail: detail(0.001, true) }, // both → CONFIRMED
      { persona: 'Survivor', detail: detail(0.4, true) }, // gate ✓, Holm ✗
      { persona: 'Predator', detail: detail(0.002, false) }, // Holm ✓, gate ✗ (e.g. sub-MDE)
    ]);
    const byPersona = Object.fromEntries(out.results.map(r => [r.persona, r]));
    expect(byPersona.Blitz.confirmatoryPass).toBe(true);
    expect(byPersona.Survivor).toMatchObject({ holmReject: false, confirmatoryPass: false });
    expect(byPersona.Predator).toMatchObject({ holmReject: true, confirmatoryPass: false });
  });

  it('Holm alone can be LOOSER than the registered gate at the last rank — the AND catches it', () => {
    // A lone p = 0.04 at explicit familySize 1 clears Holm (α = 0.05 one-sided) but the
    // registered CI-excludes-0 gate (one-sided 0.025) already failed it → NOT confirmed.
    // This pins the composition rationale: Holm only ever tightens the registered gate.
    const out = holmSignatures([{ persona: 'Blitz', detail: detail(0.04, false) }], {
      familySize: 1,
    });
    expect(out.results[0].holmReject).toBe(true);
    expect(out.results[0].confirmatoryPass).toBe(false);
  });

  it('a null signature p stays in the family and can never confirm', () => {
    const out = holmSignatures([
      { persona: 'Blitz', detail: detail(null, false) },
      { persona: 'Survivor', detail: detail(0.001, true) },
    ]);
    const byPersona = Object.fromEntries(out.results.map(r => [r.persona, r]));
    expect(byPersona.Blitz).toMatchObject({ p: null, holmReject: false, confirmatoryPass: false });
    expect(byPersona.Survivor.confirmatoryPass).toBe(true);
  });

  it('throws when familySize is set below the graded entries (family shrink guard)', () => {
    const entries = [
      { persona: 'Blitz', detail: detail(0.01, true) },
      { persona: 'Survivor', detail: detail(0.02, true) },
    ];
    expect(() => holmSignatures(entries, { familySize: 1 })).toThrow(/never the reverse/);
  });

  it('throws on a detail object missing the signatureDetail contract (no silent NOT CONFIRMED)', () => {
    // holmAdjust reads a MISSING p as "no comparable data" (undefined == null), so a reshaped
    // report object would otherwise quietly grade every persona NOT CONFIRMED with exit 0.
    expect(() => holmSignatures([{ persona: 'Blitz', detail: { pass: true } }])).toThrow(
      /no signatureDetail-shaped detail/
    );
    expect(() => holmSignatures([{ persona: 'Blitz', detail: { p: 0.01 } }])).toThrow(
      /no signatureDetail-shaped detail/
    );
    expect(() => holmSignatures([{ persona: 'Blitz' }])).toThrow(
      /no signatureDetail-shaped detail/
    );
  });

  it('end-to-end: real comparisons through signatureDetail into the family verdict', () => {
    // Blitz: both axes strongly in-direction (p ≈ 0.0066 via the IUT max) and both clear MDE.
    const blitzDetail = signatureDetail(
      PERSONA_SIGNATURES.Blitz,
      {
        aggression: compareAxis([6, 8, 10, 12, 14], [5, 6, 7, 8, 9]), // diffs 1..5
        turnsToWin: compareAxis([2, 3, 2, 1], [10, 9, 9, 10]), // diffs -8,-6,-7,-9
      },
      DEFAULT_MDE
    );
    // Survivor: borderline diffs [-4.5,-3,-2,-1,0.5] → mean −2, one-sided p ≈ 0.039. The
    // registered gate fails it (the two-sided CI includes 0) and so does Holm at m = 4
    // (rank-2 threshold 0.0167) — NOT confirmed on both grounds.
    const survivorDetail = signatureDetail(
      PERSONA_SIGNATURES.Survivor,
      { avgPlacement: compareAxis([1, 2, 3, 4, 5.5], [5.5, 5, 5, 5, 5]) },
      DEFAULT_MDE
    );
    expect(survivorDetail.p).toBeCloseTo(0.0393056995, 8); // scipy-pinned
    const out = holmSignatures([
      { persona: 'Blitz', detail: blitzDetail },
      { persona: 'Survivor', detail: survivorDetail },
    ]);
    expect(out.familySize).toBe(4);
    const byPersona = Object.fromEntries(out.results.map(r => [r.persona, r]));
    expect(byPersona.Blitz.confirmatoryPass).toBe(true);
    expect(byPersona.Survivor.confirmatoryPass).toBe(false);
  });
});

describe('parseBotSpec — built-in name vs Name=weights.js', () => {
  it('treats a bare name as a built-in lookup (weightsPath null)', () => {
    expect(parseBotSpec('Lookahead')).toEqual({ name: 'Lookahead', weightsPath: null });
  });

  it('splits a Name=path spec into name + weightsPath, trimming whitespace', () => {
    expect(parseBotSpec(' Blitz = ml/runs/ppo-blitz/blitz.weights.js ')).toEqual({
      name: 'Blitz',
      weightsPath: 'ml/runs/ppo-blitz/blitz.weights.js',
    });
  });

  it('splits on the FIRST = only, so a path may contain =', () => {
    expect(parseBotSpec('X=a/b=c.weights.js')).toEqual({
      name: 'X',
      weightsPath: 'a/b=c.weights.js',
    });
  });

  // The null (bare name) vs '' (has '=' but empty path) distinction is load-bearing: resolveSpec
  // routes weightsPath==null to the built-in registry and an empty-but-non-null path to its
  // "empty path" error. Pin both, plus the empty-name case its first guard catches.
  it('distinguishes a bare name (weightsPath null) from an empty path (weightsPath "")', () => {
    expect(parseBotSpec('Blitz=')).toEqual({ name: 'Blitz', weightsPath: '' });
    expect(parseBotSpec('Blitz').weightsPath).toBeNull();
  });

  it('yields an empty name for "" or "=foo" (resolveSpec rejects these loudly)', () => {
    expect(parseBotSpec('')).toEqual({ name: '', weightsPath: null });
    expect(parseBotSpec('=foo.weights.js')).toEqual({ name: '', weightsPath: 'foo.weights.js' });
  });
});

describe('parseMdeOverrides — calibrate signature thresholds without a code edit', () => {
  it('returns a copy of the base when the string is empty/whitespace (base not mutated)', () => {
    const base = { ...DEFAULT_MDE };
    const out = parseMdeOverrides('', base);
    expect(out).toEqual(DEFAULT_MDE);
    expect(out).not.toBe(base); // fresh object
    out.aggression = 999;
    expect(base.aggression).toBe(DEFAULT_MDE.aggression); // base untouched
  });

  it('merges overrides over the base, leaving other axes at their default', () => {
    const out = parseMdeOverrides('aggression:1.5, turnsToWin:8', DEFAULT_MDE);
    expect(out.aggression).toBe(1.5);
    expect(out.turnsToWin).toBe(8);
    expect(out.kills).toBe(DEFAULT_MDE.kills); // untouched
  });

  it('throws on a malformed entry, an unknown axis, or a non-positive/non-finite value', () => {
    expect(() => parseMdeOverrides('aggression', DEFAULT_MDE)).toThrow(
      /not of the form axis:value/
    );
    expect(() => parseMdeOverrides('bogus:1', DEFAULT_MDE)).toThrow(/not a known axis/);
    expect(() => parseMdeOverrides('aggression:-1', DEFAULT_MDE)).toThrow(/positive number/);
    expect(() => parseMdeOverrides('aggression:abc', DEFAULT_MDE)).toThrow(/positive number/);
  });

  it('rejects an explicit 0 — it would collapse the |Δ|≥MDE gate to a bare significance test', () => {
    // A 0 MDE makes Math.abs(delta) >= 0 always true; this is the exact silent gate-disable the
    // missing-MDE throw guards against, so the calibration path must refuse it too (not just `<0`).
    expect(() => parseMdeOverrides('aggression:0', DEFAULT_MDE)).toThrow(/positive number/);
  });
});

describe('§6 engine signal — runMatch passes actingPlayerId to onTurn', () => {
  const field = BUILT_IN_BOTS.slice(0, 3).map(b => ({ name: b.name, fn: b.fn }));

  it('every onTurn firing carries the acting player (in seat range)', () => {
    const actors = [];
    runMatch({
      bots: field,
      seed: 42,
      onTurn: (_t, _s, actingPlayerId) => actors.push(actingPlayerId),
    });
    expect(actors.length).toBeGreaterThan(0);
    for (const a of actors) {
      expect(Number.isInteger(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(field.length);
    }
  });

  it('the onTurn actor is exactly the player who acted that turn — cross-checked vs onStep.playerId', () => {
    // onStep.playerId is set in buildStep (turnOrder[currentPlayerIndex], DURING the turn); the
    // onTurn actor is currentPlayerId captured in runMatch's loop — two INDEPENDENT call sites.
    // A seat-index-vs-id swap or a next-player off-by-one in the onTurn arg desyncs them. A
    // single-source check like `seat0Firings === capture.activeTurns` cannot catch that: both
    // counters read the SAME actor arg, so they stay equal for any actor stream (correct OR wrong).
    const mismatches = [];
    const seenActors = new Set();
    let turnsChecked = 0;
    let stepIds = new Set();
    runMatch({
      bots: field,
      seed: 11,
      onStep: step => stepIds.add(step.playerId),
      onTurn: (_t, _s, actor) => {
        turnsChecked += 1;
        seenActors.add(actor);
        // Every step this turn is by the acting player → exactly one distinct id, equal to `actor`.
        const ids = [...stepIds];
        if (ids.length !== 1 || ids[0] !== actor) {
          mismatches.push({ turn: turnsChecked, actor, ids });
        }
        stepIds = new Set();
      },
    });
    expect(mismatches).toEqual([]);
    expect(turnsChecked).toBeGreaterThan(field.length); // drove a real multi-turn game, not a no-op
    for (let seat = 0; seat < field.length; seat++) expect(seenActors.has(seat)).toBe(true);
  });

  it('onStep populates from the real engine: seat-0 non-STOP steps reconcile with attacksMade', () => {
    // Pins the real TrajectoryStep shape (step.playerId + step.chosenMove) end-to-end and exercises
    // the _sinceStop/zeroAttackTurns wiring against the engine — the synthetic makeCapture tests
    // fabricate steps, so without this a renamed/reshaped step field would silently early-return in
    // onStep (leaving zeroAttackTurns at 0) with no test noticing.
    const { capture, onTurn, onStep } = makeCapture(0);
    let nonStopSteps = 0;
    const result = runMatch({
      bots: field,
      seed: 11,
      onTurn,
      onStep: step => {
        onStep(step);
        if (step.playerId === 0 && !isStopMove(step.chosenMove)) nonStopSteps += 1;
      },
    });
    expect(nonStopSteps).toBe(result.botStats[0].attacksMade);
    // Each zero-attack turn is one of the bot's own turns, so it can't exceed the active-turn count.
    expect(capture.zeroAttackTurns).toBeLessThanOrEqual(capture.activeTurns);
  });

  it('drives a real game and produces populated, finite capture metrics (not a no-op)', () => {
    const { capture, onTurn, onStep } = makeCapture(0);
    const result = runMatch({ bots: field, seed: 7, onTurn, onStep });
    const p = profileGameFromCapture(result, 0, capture);
    expect(p.placement).toBeGreaterThanOrEqual(1);
    expect(p.placement).toBeLessThanOrEqual(field.length);
    expect(typeof p.kills).toBe('number');
    expect(p.survivalTurn).toBeGreaterThan(0);
    // The capture must actually populate from the real engine — guards against a wrong-actor
    // regression that would leave activeTurns at 0 and every board axis null while still "passing".
    expect(capture.activeTurns).toBeGreaterThan(0);
    expect(Number.isFinite(p.aggression)).toBe(true);
    expect(Number.isFinite(p.avgTerritory)).toBe(true);
    expect(Number.isFinite(p.avgDiceReserve)).toBe(true);
    // summarizeAxis tolerates a single run (ci null, n 1).
    const s = summarizeAxis([reduceRun([p]).avgPlacement]);
    expect(s.n).toBe(1);
    expect(s.ci).toBeNull();
  });
});

describe('summarizeAxis', () => {
  it('summarizes ≥2 finite runs to mean ± CI with the run count', () => {
    const s = summarizeAxis([4, 6, 5]);
    expect(s.mean).toBe(5);
    expect(s.n).toBe(3);
    expect(s.ci).toBeGreaterThan(0);
  });

  it('ignores null runs in the count, and returns null when nothing is finite', () => {
    expect(summarizeAxis([3, null, 5]).n).toBe(2);
    expect(summarizeAxis([null, null])).toBeNull();
    expect(summarizeAxis([])).toBeNull();
  });

  it('ignores non-finite runs (NaN/Infinity) so a stray value never poisons the mean/CI', () => {
    const s = summarizeAxis([4, NaN, 6, Infinity, 5]);
    expect(s.n).toBe(3); // only the three finite runs
    expect(s.mean).toBe(5);
    expect(Number.isFinite(s.ci)).toBe(true);
    expect(summarizeAxis([NaN, Infinity])).toBeNull();
  });
});

describe('compareToControl', () => {
  // Three runs each; persona is clearly higher on aggression, identical-ish elsewhere, and has a
  // winners-only axis (turnsToWin) that is all-null for the persona → that axis must compare null.
  const personaRuns = [
    { ...reduceShape(), aggression: 5, turnsToWin: null },
    { ...reduceShape(), aggression: 6, turnsToWin: null },
    { ...reduceShape(), aggression: 7, turnsToWin: null },
  ];
  const controlRuns = [
    { ...reduceShape(), aggression: 2, turnsToWin: 30 },
    { ...reduceShape(), aggression: 3, turnsToWin: 31 },
    { ...reduceShape(), aggression: 2, turnsToWin: 30 },
  ];

  it('keys every output by AXES, reports HIGHER on the moved axis, and null on an all-null axis', () => {
    const out = compareToControl(personaRuns, controlRuns);
    expect(Object.keys(out).sort()).toEqual([...AXES].sort());
    expect(out.aggression.verdict).toBe('HIGHER');
    expect(out.aggression.lo).toBeGreaterThan(0);
    expect(out.turnsToWin).toBeNull(); // persona never won → no paired runs survive
  });
});

describe('config invariants — AXES is the single source of truth', () => {
  it('every PERSONA_SIGNATURES axis is an AXES key with a direction and a DEFAULT_MDE entry', () => {
    // If this fails, the offending persona/axis is named in the assertion's received value.
    for (const sig of Object.values(PERSONA_SIGNATURES)) {
      for (const { axis, direction } of sig.axes) {
        expect(AXES).toContain(axis);
        expect(['HIGHER', 'LOWER']).toContain(direction);
        expect(typeof DEFAULT_MDE[axis]).toBe('number');
      }
    }
  });

  it('reduceRun produces exactly the AXES key set', () => {
    const sample = {
      won: true,
      placement: 1,
      turnsToWin: 20,
      aggression: 4,
      captureEfficiency: 0.7,
      avgDiceReserve: 9,
      avgTerritory: 8,
      dicePerTerritory: 1.2,
      largestGroup: 6,
      kills: 2,
      survivalTurn: 20,
      zeroAttackTurnFrac: 0.1,
    };
    expect(Object.keys(reduceRun([sample])).sort()).toEqual([...AXES].sort());
  });
});

// --- §10.5 profile-pairing separation (Wave-0 item 3) ---

/** Per-run records where only the named axes carry the given arrays; the rest are null. */
const runsOf = axisArrays => {
  const len = Object.values(axisArrays)[0].length;
  return Array.from({ length: len }, (_, i) =>
    Object.fromEntries(AXES.map(a => [a, axisArrays[a] ? axisArrays[a][i] : null]))
  );
};

describe('separation registry — the pre-registered §10.5 axes', () => {
  it('SEPARATION_AXES is exactly the four registered pairwise axes, in spec order', () => {
    expect(SEPARATION_AXES).toEqual(['aggression', 'turnsToWin', 'avgPlacement', 'kills']);
  });

  it('the three absolute axes carry the calibrated DEFAULT_MDE values (0.3 / 5.0 / 0.4)', () => {
    expect(DEFAULT_MDE.aggression).toBe(0.3);
    expect(DEFAULT_MDE.turnsToWin).toBe(5.0);
    expect(DEFAULT_MDE.avgPlacement).toBe(0.4);
  });

  it('KILLS_MDE_FRACTION is the §10.3 15% relative bar', () => {
    expect(KILLS_MDE_FRACTION).toBe(0.15);
  });

  it('SHIPPED_BASE is Conqueror ([D-27]/[D-31]) — the ship gate unions it into the roster', () => {
    expect(SHIPPED_BASE).toBe('Conqueror');
    // The base deliberately has NO signature entry (it is what personas are judged against),
    // which is exactly why the ship gate cannot key on PERSONA_SIGNATURES alone.
    expect(PERSONA_SIGNATURES[SHIPPED_BASE]).toBeUndefined();
  });
});

describe('killsPairMde — the §10.3 relative kills bar', () => {
  it('is 15% of the LOWER side over the paired runs (comparator = the exceeded side)', () => {
    // a mean 2.0, b mean 1.0 → comparator 1.0 → MDE 0.15 (order-symmetric).
    const a = [2.0, 2.1, 1.9, 2.0];
    const b = [1.0, 1.05, 0.95, 1.0];
    expect(killsPairMde(a, b)).toEqual({ mde: 0.15, comparatorMean: 1.0 });
    expect(killsPairMde(b, a)).toEqual({ mde: 0.15, comparatorMean: 1.0 });
  });

  it('reproduces the §10.3 worked number: 15% of ~1.87 ≈ 0.28', () => {
    const { mde } = killsPairMde([2.2, 2.1], [1.86, 1.88]);
    expect(mde).toBeCloseTo(0.2805, 4);
  });

  it('comparator means over the ALIGNED runs only (null runs dropped from both sides)', () => {
    // Index 1 is null on side a → dropped from both, so b's kept mean is (1+3)/2 = 2.
    const { mde, comparatorMean } = killsPairMde([5, null, 5], [1, 100, 3]);
    expect(comparatorMean).toBe(2);
    expect(mde).toBeCloseTo(0.3, 12);
  });

  it('fails CLOSED (mde null) when the comparator never kills — a ~0 bar would be a bare significance test', () => {
    expect(killsPairMde([2, 2, 2], [0, 0, 0])).toEqual({ mde: null, comparatorMean: 0 });
  });

  it('fails CLOSED (mde null) with fewer than 2 paired runs', () => {
    expect(killsPairMde([2, null], [null, 1])).toEqual({ mde: null, comparatorMean: null });
  });
});

describe('separationPair — paired-diff CI with MDE, never marginal-CI overlap', () => {
  // A pair that clearly separates on aggression: Δ ≈ +0.55, tight CI above 0, ≥ MDE 0.3.
  const A_AGG = [3.0, 3.2, 2.9, 3.1];
  const B_AGG = [2.5, 2.55, 2.45, 2.5];

  it('separates on an axis when |Δ| ≥ MDE AND the paired CI excludes 0 (either direction)', () => {
    const res = separationPair(
      runsOf({ aggression: A_AGG }),
      runsOf({ aggression: B_AGG }),
      DEFAULT_MDE
    );
    expect(res.separated).toBe(true);
    expect(res.onAxes).toEqual(['aggression']);
    const agg = res.axes.find(d => d.axis === 'aggression');
    expect(agg.delta).toBeCloseTo(0.55, 12);
    expect(agg.lo).toBeGreaterThan(0);
    expect(agg.meetsMde).toBe(true);
    expect(agg.sig).toBe(true);
    expect(agg.mdeBasis).toBe('absolute');
  });

  it('direction does not matter: a LOWER verdict separates too', () => {
    const res = separationPair(
      runsOf({ aggression: B_AGG }),
      runsOf({ aggression: A_AGG }),
      DEFAULT_MDE
    );
    const agg = res.axes.find(d => d.axis === 'aggression');
    expect(agg.verdict).toBe('LOWER');
    expect(agg.separated).toBe(true);
  });

  it('a significant but sub-MDE Δ does NOT separate (the trivially-significant guard)', () => {
    // Δ = 0.2 with near-zero spread: CI excludes 0, but 0.2 < MDE 0.3.
    const res = separationPair(
      runsOf({ aggression: [3.0, 3.01, 2.99, 3.0] }),
      runsOf({ aggression: [2.8, 2.8, 2.8, 2.81] }),
      DEFAULT_MDE
    );
    const agg = res.axes.find(d => d.axis === 'aggression');
    expect(agg.sig).toBe(true);
    expect(agg.meetsMde).toBe(false);
    expect(agg.separated).toBe(false);
    expect(res.separated).toBe(false);
  });

  it('a large but non-significant Δ does NOT separate (CI straddles 0)', () => {
    // Mean Δ 0.5 but hugely noisy diffs → CI spans 0.
    const res = separationPair(
      runsOf({ aggression: [5.0, 1.0, 4.0, 2.0] }),
      runsOf({ aggression: [2.0, 4.0, 1.0, 3.0] }),
      DEFAULT_MDE
    );
    const agg = res.axes.find(d => d.axis === 'aggression');
    expect(agg.meetsMde).toBe(true);
    expect(agg.sig).toBe(false);
    expect(agg.separated).toBe(false);
  });

  it('kills separates at the relative §10.3 bar with the comparator recorded', () => {
    const res = separationPair(
      runsOf({ kills: [2.0, 2.1, 1.9, 2.0] }),
      runsOf({ kills: [1.0, 1.05, 0.95, 1.0] }),
      DEFAULT_MDE
    );
    const k = res.axes.find(d => d.axis === 'kills');
    expect(k.mdeBasis).toBe('relative');
    expect(k.mde).toBeCloseTo(0.15, 12);
    expect(k.comparatorMean).toBe(1.0);
    expect(k.separated).toBe(true);
    expect(res.onAxes).toEqual(['kills']);
  });

  it('an uncalibrated relative kills bar (comparator ≈ 0) fails closed even on a huge significant Δ', () => {
    const res = separationPair(
      runsOf({ kills: [3.0, 3.1, 2.9, 3.0] }),
      runsOf({ kills: [0, 0, 0, 0] }),
      DEFAULT_MDE
    );
    const k = res.axes.find(d => d.axis === 'kills');
    expect(k.sig).toBe(true); // the CI excludes 0 by a mile...
    expect(k.mde).toBeNull(); // ...but there is no calibrated bar to clear
    expect(k.meetsMde).toBe(false);
    expect(k.separated).toBe(false);
  });

  it('relativeKills:false reverts kills to the absolute MDE from the map', () => {
    const res = separationPair(
      runsOf({ kills: [2.0, 2.1, 1.9, 2.0] }),
      runsOf({ kills: [1.0, 1.05, 0.95, 1.0] }),
      { ...DEFAULT_MDE, kills: 1.5 },
      { relativeKills: false }
    );
    const k = res.axes.find(d => d.axis === 'kills');
    expect(k.mdeBasis).toBe('absolute');
    expect(k.mde).toBe(1.5);
    expect(k.meetsMde).toBe(false); // Δ = 1.0 < 1.5
    expect(k.separated).toBe(false);
  });

  it('an all-null axis (e.g. turnsToWin with no wins) reads "no data" and cannot separate — but other axes still can', () => {
    const res = separationPair(
      runsOf({ aggression: A_AGG }), // turnsToWin all null via runsOf
      runsOf({ aggression: B_AGG }),
      DEFAULT_MDE
    );
    const ttw = res.axes.find(d => d.axis === 'turnsToWin');
    expect(ttw.delta).toBeNull();
    expect(ttw.separated).toBe(false);
    expect(res.separated).toBe(true); // aggression carried the pair
    expect(res.comparable).toBe(true);
  });

  it('comparable=false when NO registered axis has paired data', () => {
    const res = separationPair(runsOf({ winPct: [1, 2] }), runsOf({ winPct: [1, 2] }), DEFAULT_MDE);
    expect(res.comparable).toBe(false);
    expect(res.separated).toBe(false);
  });

  it('throws on a missing absolute MDE even when the axis has no data (config error, not data-dependent)', () => {
    const noMde = { ...DEFAULT_MDE };
    delete noMde.avgPlacement;
    expect(() =>
      separationPair(runsOf({ aggression: A_AGG }), runsOf({ aggression: B_AGG }), noMde)
    ).toThrow(/no MDE registered for axis "avgPlacement"/);
  });
});

describe('assertPairableReports — the §10.5 identical-field/seeds contract', () => {
  const CONFIG = {
    runs: 3,
    games: 2,
    stride: 1_000_000,
    rotations: 3,
    fieldSize: 3,
    opponents: ['Default', 'Example'],
    opponentSpecs: [
      { name: 'Default', weightsPath: null },
      { name: 'Example', weightsPath: null },
    ],
    quarantine: { on: true },
    gitSha: 'abc1234',
    generatedAt: '2026-07-05T00:00:00.000Z',
  };
  // perRun length always tracks config.runs, so a config override like runs:4 still yields a
  // SHAPE-valid report — the cross-report mismatch check is what must fire, not the shape check.
  const mkReport = (names, over = {}) => {
    const config = { ...CONFIG, ...over };
    return {
      config,
      bots: names.map(name => ({
        name,
        perRun: Array.from({ length: config.runs }, () => reduceShape()),
      })),
    };
  };

  it('accepts a single well-formed report (no drift possible)', () => {
    expect(assertPairableReports([{ path: 'a.json', report: mkReport(['X', 'Y']) }])).toEqual({
      shaDrift: null,
    });
  });

  it('accepts two reports with identical config + SHA and disjoint bots', () => {
    const res = assertPairableReports([
      { path: 'a.json', report: mkReport(['X']) },
      { path: 'b.json', report: mkReport(['Y']) },
    ]);
    expect(res.shaDrift).toBeNull();
  });

  it('throws when a bot has no perRun arrays (pre-separation report format)', () => {
    const r = mkReport(['X']);
    delete r.bots[0].perRun;
    expect(() => assertPairableReports([{ path: 'a.json', report: r }])).toThrow(
      /no per-run arrays/
    );
  });

  it('throws when perRun length disagrees with config.runs (truncated/corrupt report)', () => {
    const r = mkReport(['X']);
    r.bots[0].perRun = r.bots[0].perRun.slice(0, 2);
    expect(() => assertPairableReports([{ path: 'a.json', report: r }])).toThrow(
      /no per-run arrays/
    );
  });

  it('throws its own message on a malformed perRun ELEMENT (null/array) — not a downstream TypeError', () => {
    const r = mkReport(['X']);
    r.bots[0].perRun = [null, null, null]; // right length, corrupt entries
    expect(() => assertPairableReports([{ path: 'a.json', report: r }])).toThrow(
      /malformed bots\[\]\.perRun entry/
    );
    const r2 = mkReport(['X']);
    r2.bots[0].perRun[1] = [1, 2, 3]; // an array is not a Record<axis, number|null>
    expect(() => assertPairableReports([{ path: 'a.json', report: r2 }])).toThrow(
      /malformed bots\[\]\.perRun entry/
    );
  });

  it('throws when config.opponentSpecs is missing (pre-separation format)', () => {
    const r = mkReport(['X']);
    delete r.config.opponentSpecs;
    expect(() => assertPairableReports([{ path: 'a.json', report: r }])).toThrow(
      /opponentSpecs missing/
    );
  });

  it('throws when config.runs is below 2 or non-integer (pairing needs >= 2 seed blocks)', () => {
    // A `--runs 1` profile can't be paired: every axis has n<2 and degrades to non-comparable.
    // Fail loud at the contract instead of silently producing an all-incomparable matrix.
    expect(() =>
      assertPairableReports([{ path: 'a.json', report: mkReport(['X'], { runs: 1 }) }])
    ).toThrow(/runs is not an integer >= 2/);
    expect(() =>
      assertPairableReports([{ path: 'a.json', report: mkReport(['X'], { runs: 2.5 }) }])
    ).toThrow(/runs is not an integer >= 2/);
  });

  it('throws on a config mismatch for every seed/field-defining key', () => {
    const cases = [
      ['runs', 4],
      ['games', 9],
      ['stride', 2_000_000],
      ['rotations', 4],
      ['fieldSize', 4],
      ['opponents', ['Example', 'Default']], // same set, different ORDER — seats differ
    ];
    for (const [key, value] of cases) {
      expect(() =>
        assertPairableReports([
          { path: 'a.json', report: mkReport(['X']) },
          { path: 'b.json', report: mkReport(['Y'], { [key]: value }) },
        ])
      ).toThrow(new RegExp(`config mismatch on "${key}"`));
    }
  });

  it('throws on differing quarantine policy (changes which games each side kept)', () => {
    expect(() =>
      assertPairableReports([
        { path: 'a.json', report: mkReport(['X']) },
        { path: 'b.json', report: mkReport(['Y'], { quarantine: { on: false } }) },
      ])
    ).toThrow(/quarantine\.on/);
  });

  it('throws when opponent NAMES match but a weightsPath differs — same names, different field', () => {
    expect(() =>
      assertPairableReports([
        { path: 'a.json', report: mkReport(['X']) },
        {
          path: 'b.json',
          report: mkReport(['Y'], {
            opponentSpecs: [
              { name: 'Default', weightsPath: null },
              { name: 'Example', weightsPath: 'ml/runs/x/eval-5M.weights.js' },
            ],
          }),
        },
      ])
    ).toThrow(/config mismatch on "opponentSpecs"/);
  });

  it('pairs reports differing only in mde/control/reference (deliberately excluded from identity)', () => {
    const res = assertPairableReports([
      { path: 'a.json', report: mkReport(['X']) },
      {
        path: 'b.json',
        report: mkReport(['Y'], {
          mde: { kills: { rule: 'absolute', value: 0.5 } },
          control: 'Defensive',
          reference: 'Example',
        }),
      },
    ]);
    expect(res.shaDrift).toBeNull();
  });

  it('throws when the same bot name appears in two reports (ambiguous arrays)', () => {
    expect(() =>
      assertPairableReports([
        { path: 'a.json', report: mkReport(['X', 'Y']) },
        { path: 'b.json', report: mkReport(['Y']) },
      ])
    ).toThrow(/"Y" appears in both a\.json and b\.json/);
  });

  it('returns shaDrift (not a throw) on differing or missing SHAs across >1 report — a CLI policy call', () => {
    const drift = assertPairableReports([
      { path: 'a.json', report: mkReport(['X']) },
      { path: 'b.json', report: mkReport(['Y'], { gitSha: 'fff9999' }) },
    ]);
    expect(drift.shaDrift).toMatch(/a\.json: abc1234.*b\.json: fff9999/);
    const missing = assertPairableReports([
      { path: 'a.json', report: mkReport(['X'], { gitSha: null }) },
      { path: 'b.json', report: mkReport(['Y'], { gitSha: null }) },
    ]);
    expect(missing.shaDrift).toMatch(/unknown/);
  });

  it('an IDENTICAL -dirty stamp still reads as drift — two dirty trees are not known behavior-identical', () => {
    const drift = assertPairableReports([
      { path: 'a.json', report: mkReport(['X'], { gitSha: 'abc1234-dirty' }) },
      { path: 'b.json', report: mkReport(['Y'], { gitSha: 'abc1234-dirty' }) },
    ]);
    expect(drift.shaDrift).toMatch(/abc1234-dirty/);
    // A single dirty report has nothing to pair across — no drift concern.
    const single = assertPairableReports([
      { path: 'a.json', report: mkReport(['X', 'Y'], { gitSha: 'abc1234-dirty' }) },
    ]);
    expect(single.shaDrift).toBeNull();
  });
});
