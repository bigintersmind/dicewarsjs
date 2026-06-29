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
  AXES,
  PERSONA_SIGNATURES,
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
