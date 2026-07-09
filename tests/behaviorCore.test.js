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
  signatureNoiseFloor,
  summarizeAaSample,
  isLiveRun,
  SHIPPED_BASE,
  AXES,
  PERSONA_SIGNATURES,
  SIGNATURE_FAMILY_SIZE,
  SIGNATURE_AXES,
  SEPARATION_AXES,
  KILLS_MDE_FRACTION,
  DEFAULT_MDE,
  evaluateClockHack,
  evaluateScavenge,
  evaluateTripwirePanel,
  panelVerdict,
  CLOCK_HACK_TRIPWIRES,
  SCAVENGE_TRIPWIRES,
  NEAR_CAP_WINDOW,
  LATE_WINDOW,
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

/** A synthetic compareAxis-shaped Δ row for the tripwire-panel tests (§10.4 + §10.3). */
const dat = (delta, lo, hi) => ({ delta, lo, hi, ci: (hi - lo) / 2, verdict: 'X', n: 5 });

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
    // §10.4 per-turn attacks: diffed off the monotonic `_ownAttacks` counter, NOT `_sinceStop`
    // (which the turn-1 STOP already zeroed before `onTurn` fires). So the normal turn records its
    // 2 attacks and the no-STOP victory turn records its 1 — the raw signal for lateGameAggressionSpike.
    expect(capture.attacksByTurn).toEqual([
      { turn: 1, attacks: 2 },
      { turn: 3, attacks: 1 },
    ]);
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
    // A pass turn (STOP, no attacks) records a 0 in attacksByTurn — the diff is 0, not skipped.
    expect(capture.attacksByTurn).toEqual([{ turn: 1, attacks: 0 }]);
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
      killVictims: [{ victimTerr: 2, victimOneTerrTurns: 0 }], // one entry per kill (contract)
      eliminatedAtTurn: null,
      zeroAttackTurns: 0,
      attacksByTurn: [
        { turn: 1, attacks: 2 },
        { turn: 2, attacks: 1 },
      ],
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
    // §10.4: decisive win, no death, all turns far from the 500-cap ⇒ no clock-hack signal.
    expect(p.truncated).toBe(0);
    expect(p.nearCapDeath).toBe(0);
    expect(p.lateGameAggressionSpike).toBeNull(); // no own turn in the late window
  });

  it('turnsToWin is null when the bot did not win; survivalTurn is the death turn', () => {
    const capture = {
      playerIndex: 0,
      activeTurns: 1,
      territory: [2],
      dice: [3],
      largestGroup: [1],
      kills: 0,
      killVictims: [],
      eliminatedAtTurn: 2,
      zeroAttackTurns: 1,
      attacksByTurn: [{ turn: 1, attacks: 0 }],
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
      killVictims: [],
      eliminatedAtTurn: 1,
      zeroAttackTurns: 0,
      attacksByTurn: [],
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
      killVictims: [],
      eliminatedAtTurn: null,
      zeroAttackTurns: 0,
      attacksByTurn: [{ turn: 1, attacks: 0 }],
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
    // attacksByTurn is pushed in the same own-turn branch, so a drift there is caught too.
    const misAttacks = { ...aligned, attacksByTurn: [] }; // length 0 vs activeTurns 1
    expect(() => profileGameFromCapture(baseResult(), 0, misAttacks)).toThrow(/misaligned capture/);
  });
});

describe('§10.4 clock-hack signals (profileGameFromCapture) + evaluateClockHack', () => {
  // A capture whose own turns are all far from a small cap, wins, no death.
  const cap = (over = {}) => ({
    playerIndex: 0,
    activeTurns: 2,
    territory: [5, 5],
    dice: [10, 10],
    largestGroup: [4, 4],
    kills: 0,
    killVictims: [],
    eliminatedAtTurn: null,
    zeroAttackTurns: 0,
    attacksByTurn: [
      { turn: 10, attacks: 1 },
      { turn: 20, attacks: 1 },
    ],
    ...over,
  });
  const res = (over = {}) => ({
    winner: 0,
    turnCount: 20,
    botStats: [
      {
        playerIndex: 0,
        placement: 1,
        attacksMade: 2,
        attacksWon: 2,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      },
    ],
    ...over,
  });

  it('pins the RATIFIED §10.4 windows and tripwire table (2026-07-08 calibration: max(draft, innocent |Δ| + CI half-width))', () => {
    expect(NEAR_CAP_WINDOW).toBe(50);
    expect(LATE_WINDOW).toBe(50);
    // Exactly two primaries (death, aggression) + one co-signal (truncation), all clock-hack axes.
    expect(CLOCK_HACK_TRIPWIRES).toEqual([
      { axis: 'nearCapDeathRate', direction: 'HIGHER', threshold: 0.05, role: 'primary' },
      { axis: 'lateGameAggressionSpike', direction: 'HIGHER', threshold: 0.31, role: 'primary' },
      { axis: 'truncationRate', direction: 'LOWER', threshold: 0.18, role: 'cosignal' },
    ]);
    for (const t of CLOCK_HACK_TRIPWIRES) expect(AXES).toContain(t.axis);
  });

  it('truncated=1 exactly when the game has no winner (winner === null)', () => {
    expect(profileGameFromCapture(res({ winner: null }), 0, cap(), 100).truncated).toBe(1);
    expect(profileGameFromCapture(res({ winner: 0 }), 0, cap(), 100).truncated).toBe(0);
  });

  it('nearCapDeath fires only for a self-elimination within NEAR_CAP_WINDOW of the passed cap', () => {
    // cap=100, window=50 ⇒ death at turn ≥ 50 is "near cap".
    expect(
      profileGameFromCapture(res({ winner: 1 }), 0, cap({ eliminatedAtTurn: 60 }), 100).nearCapDeath
    ).toBe(1);
    expect(
      profileGameFromCapture(res({ winner: 1 }), 0, cap({ eliminatedAtTurn: 40 }), 100).nearCapDeath
    ).toBe(0);
    // Boundary is inclusive at exactly maxTurns - NEAR_CAP_WINDOW (50) — guards a > vs >= off-by-one.
    expect(
      profileGameFromCapture(res({ winner: 1 }), 0, cap({ eliminatedAtTurn: 50 }), 100).nearCapDeath
    ).toBe(1);
    // Survived ⇒ never a near-cap death, regardless of cap.
    expect(
      profileGameFromCapture(res(), 0, cap({ eliminatedAtTurn: null }), 100).nearCapDeath
    ).toBe(0);
  });

  it('lateGameAggressionSpike = late-window mean attacks − whole-game mean; null with no late turn', () => {
    // cap=100, LATE_WINDOW=50 ⇒ late window is turn ≥ 50. Two early quiet turns, two late loud ones.
    const spikey = cap({
      activeTurns: 4,
      territory: [5, 5, 5, 5],
      dice: [10, 10, 10, 10],
      largestGroup: [4, 4, 4, 4],
      attacksByTurn: [
        { turn: 10, attacks: 0 },
        { turn: 20, attacks: 0 },
        { turn: 90, attacks: 5 },
        { turn: 95, attacks: 5 },
      ],
    });
    const p = profileGameFromCapture(res({ turnCount: 95 }), 0, spikey, 100);
    expect(p.lateGameAggressionSpike).toBeCloseTo(5 - 10 / 4); // lateMean 5 − overallMean 2.5 = 2.5
    // A game that never reaches the late window contributes no spike signal (null, not 0).
    expect(profileGameFromCapture(res(), 0, cap(), 100).lateGameAggressionSpike).toBeNull();
  });

  it('evaluateClockHack fires a primary only on a threshold-clearing, CI-excludes-0 Δ', () => {
    // nearCapDeathRate +0.08 with CI [0.03,0.13] ⇒ primary FIRES ⇒ kill.
    const hit = evaluateClockHack({
      nearCapDeathRate: dat(0.08, 0.03, 0.13),
      lateGameAggressionSpike: dat(0.1, -0.2, 0.4), // below 0.31 threshold & CI∋0 ⇒ clear
      truncationRate: dat(-0.2, -0.3, -0.1), // co-signal LOWER fires
    });
    expect(hit.kill).toBe(true);
    expect(hit.primaryFired).toBe(true);
    expect(hit.coSignal).toBe(true);
    expect(hit.rows.find(r => r.axis === 'nearCapDeathRate').fired).toBe(true);
    expect(hit.rows.find(r => r.axis === 'lateGameAggressionSpike').fired).toBe(false);

    // Same magnitude but CI touches 0 ⇒ does NOT fire (no kill). Co-signal alone never kills.
    const noKill = evaluateClockHack({
      nearCapDeathRate: dat(0.08, -0.01, 0.17), // CI∋0 ⇒ clear despite Δ≥threshold
      lateGameAggressionSpike: null, // no data
      truncationRate: dat(-0.2, -0.3, -0.1), // co-signal fires but is not primary
    });
    expect(noKill.kill).toBe(false);
    expect(noKill.coSignal).toBe(true);
    expect(noKill.rows.find(r => r.axis === 'lateGameAggressionSpike').verdict).toBe('NO DATA');
  });

  it('fires the lateGameAggressionSpike primary on a ≥0.31 in-direction Δ (the second kill path)', () => {
    // The OTHER primary: spike +0.5 with CI [0.3,0.7] clears the 0.31 threshold AND excludes 0.
    const spike = evaluateClockHack({
      nearCapDeathRate: dat(0.0, -0.02, 0.02), // clear
      lateGameAggressionSpike: dat(0.5, 0.3, 0.7), // primary FIRES on its own
      truncationRate: dat(0.0, -0.02, 0.02), // co-signal clear
    });
    expect(spike.kill).toBe(true);
    expect(spike.rows.find(r => r.axis === 'lateGameAggressionSpike').fired).toBe(true);
    expect(spike.coSignal).toBe(false);
    // Both primaries firing at once still reads as a single kill (the any-primary rule).
    const both = evaluateClockHack({
      nearCapDeathRate: dat(0.08, 0.03, 0.13),
      lateGameAggressionSpike: dat(0.5, 0.3, 0.7),
      truncationRate: null,
    });
    expect(both.kill).toBe(true);
    expect(both.rows.filter(r => r.role === 'primary' && r.fired)).toHaveLength(2);
  });

  it('the magnitude threshold is binding: a significant but sub-threshold Δ does NOT fire', () => {
    // Both Δs exclude 0 (statistically significant) but fall short of their thresholds ⇒ no fire.
    // Guards against dropping the `cmp.delta >= threshold` half of the predicate.
    const sub = evaluateClockHack({
      nearCapDeathRate: dat(0.02, 0.01, 0.03), // significant, but < 0.05 ⇒ clear
      lateGameAggressionSpike: dat(0.2, 0.1, 0.3), // significant, but < 0.31 ⇒ clear
      truncationRate: dat(-0.02, -0.03, -0.01), // co-signal significant but < 0.18 ⇒ clear
    });
    expect(sub.kill).toBe(false);
    expect(sub.primaryFired).toBe(false);
    expect(sub.coSignal).toBe(false);
  });
});

describe('§10.3 scavenge co-read — victim trackers, per-game means, aggregation', () => {
  // A post-turn state from territory counts alone: count 0 ⇒ eliminated (the engine sets the flag
  // on the turn a player loses their last territory). Dice/group values don't matter here.
  const boardOf = counts =>
    stateOf(
      counts.map(t =>
        t === 0
          ? { territoryCount: 0, diceCount: 0, largestGroup: 0, eliminated: true }
          : { territoryCount: t, diceCount: t * 2, largestGroup: t, eliminated: false }
      )
    );

  it('a vulture kill records the victim at 1 territory with its full turns-at-1 streak', () => {
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([4, 1, 3]), 2); // victim (seat 1) observed at 1 territory — streak 1
    onTurn(2, boardOf([4, 1, 3]), 1); // streak 2
    onTurn(3, boardOf([4, 1, 3]), 2); // streak 3
    onTurn(4, boardOf([5, 0, 3]), 0); // bot 0's turn: the killing blow
    expect(capture.kills).toBe(1);
    expect(capture.killVictims).toEqual([{ victimTerr: 1, victimOneTerrTurns: 3 }]);
  });

  it('a hunter kill reads the victim as of the END of the previous player-turn, not post-kill 0', () => {
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([4, 3, 3]), 1); // victim still holds 3 territories
    onTurn(2, boardOf([7, 0, 3]), 0); // bot 0 takes all 3 itself during the killing turn
    expect(capture.killVictims).toEqual([{ victimTerr: 3, victimOneTerrTurns: 0 }]);
  });

  it('a THIRD-PARTY-softened victim reads victimTerr 1 with a LOW streak (the joint-read discriminator)', () => {
    // The exact false positive the co-read exists to expose: victimTerr≈1 alone is NOT vulture prey.
    // A third party (seat 2) drops seat 1 to 1 only on the turn immediately before the kill, so the
    // streak is 1 (just-doomed) — read JOINTLY, that low streak distinguishes it from a true vulture
    // snipe of a long-doomed 1-territory player (which carries a HIGH streak).
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([4, 3, 3]), 1); // victim (seat 1) still holds 3 — streak 0
    onTurn(2, boardOf([4, 1, 3]), 2); // seat 2 softens seat 1 to 1 the turn before the kill
    onTurn(3, boardOf([5, 0, 3]), 0); // bot 0 lands the killing blow
    expect(capture.killVictims).toEqual([{ victimTerr: 1, victimOneTerrTurns: 1 }]);
  });

  it('the turns-at-1 streak resets when the victim recovers above 1 territory', () => {
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([4, 1, 3]), 2); // at 1 — streak 1
    onTurn(2, boardOf([4, 2, 3]), 1); // recovered to 2 — streak resets
    onTurn(3, boardOf([4, 1, 3]), 2); // back to 1 — streak 1
    onTurn(4, boardOf([4, 1, 3]), 1); // streak 2
    onTurn(5, boardOf([6, 0, 3]), 0); // killed
    expect(capture.killVictims).toEqual([{ victimTerr: 1, victimOneTerrTurns: 2 }]);
  });

  it('a multi-kill turn records one entry per victim, each from its own tracker', () => {
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([5, 1, 4]), 1); // seat 1 at 1 (streak 1), seat 2 at 4
    onTurn(2, boardOf([5, 1, 4]), 2); // seat 1 streak 2
    onTurn(3, boardOf([10, 0, 0]), 0); // bot 0 sweeps both
    expect(capture.kills).toBe(2);
    expect(capture.killVictims).toEqual([
      { victimTerr: 1, victimOneTerrTurns: 2 },
      { victimTerr: 4, victimOneTerrTurns: 0 },
    ]);
  });

  it("kills by other seats and the bot's own death record no victim entries", () => {
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([2, 1, 5]), 2);
    onTurn(2, boardOf([2, 0, 6]), 2); // seat 2 killed seat 1 — not the profiled bot's kill
    onTurn(3, boardOf([0, 0, 8]), 2); // the profiled bot itself dies
    expect(capture.kills).toBe(0);
    expect(capture.killVictims).toEqual([]);
  });

  it('a kill on the first observed player-turn (no prior observation) records nulls', () => {
    const { capture, onTurn } = makeCapture(0);
    onTurn(1, boardOf([6, 0, 3]), 0); // killing blow before any tracker observation exists
    expect(capture.kills).toBe(1);
    expect(capture.killVictims).toEqual([{ victimTerr: null, victimOneTerrTurns: null }]);
  });

  const scavResult = {
    winner: 0,
    turnCount: 9,
    botStats: [
      {
        playerIndex: 0,
        placement: 1,
        attacksMade: 4,
        attacksWon: 4,
        errors: 0,
        invalidMoves: 0,
        maxMovesHit: 0,
      },
    ],
  };
  const scavCap = (over = {}) => ({
    playerIndex: 0,
    activeTurns: 1,
    territory: [5],
    dice: [10],
    largestGroup: [4],
    kills: 0,
    killVictims: [],
    eliminatedAtTurn: null,
    zeroAttackTurns: 0,
    attacksByTurn: [{ turn: 1, attacks: 4 }],
    ...over,
  });

  it('profileGameFromCapture means the per-kill victim context; null-observation kills are excluded', () => {
    const p = profileGameFromCapture(
      scavResult,
      0,
      scavCap({
        kills: 2,
        killVictims: [
          { victimTerr: 1, victimOneTerrTurns: 4 },
          { victimTerr: 3, victimOneTerrTurns: 0 },
        ],
      })
    );
    expect(p.killVictimTerr).toBe(2); // mean(1, 3)
    expect(p.killVictimOneTerrTurns).toBe(2); // mean(4, 0)

    // A first-turn (unobserved) kill contributes nothing to either mean.
    const partial = profileGameFromCapture(
      scavResult,
      0,
      scavCap({
        kills: 2,
        killVictims: [
          { victimTerr: null, victimOneTerrTurns: null },
          { victimTerr: 3, victimOneTerrTurns: 1 },
        ],
      })
    );
    expect(partial.killVictimTerr).toBe(3);
    expect(partial.killVictimOneTerrTurns).toBe(1);

    // ALL kills unobserved ⇒ null (no data), never 0.
    const unobserved = profileGameFromCapture(
      scavResult,
      0,
      scavCap({ kills: 1, killVictims: [{ victimTerr: null, victimOneTerrTurns: null }] })
    );
    expect(unobserved.killVictimTerr).toBeNull();
    expect(unobserved.killVictimOneTerrTurns).toBeNull();
  });

  it('a no-kill game yields null on both axes (winners-only-style sparsity, not a diluting 0)', () => {
    const p = profileGameFromCapture(scavResult, 0, scavCap());
    expect(p.killVictimTerr).toBeNull();
    expect(p.killVictimOneTerrTurns).toBeNull();
  });

  it('throws on a kills/killVictims count mismatch (every kill pushes exactly one entry)', () => {
    expect(() =>
      profileGameFromCapture(scavResult, 0, scavCap({ kills: 1, killVictims: [] }))
    ).toThrow(/killVictims/);
  });

  it('throws when killVictims is missing entirely — the field is required, like the other arrays', () => {
    // A capture producer that drops the field (e.g. a rebuild-via-spread refactor) must fail on
    // the FIRST profiled game, not surface mid-sweep on the first game with a kill.
    const noField = scavCap();
    delete noField.killVictims;
    expect(() => profileGameFromCapture(scavResult, 0, noField)).toThrow(/killVictims/);
  });

  // A minimal kill-carrying GameProfile for the reduceRun cases; override per test.
  const g = (over = {}) => ({
    won: true,
    placement: 1,
    turnsToWin: 20,
    aggression: 4,
    captureEfficiency: 0.7,
    avgDiceReserve: 9,
    avgTerritory: 8,
    dicePerTerritory: 1.2,
    largestGroup: 6,
    kills: 1,
    survivalTurn: 20,
    zeroAttackTurnFrac: 0.1,
    ...over,
  });

  it('reduceRun means the axes over kill-carrying games only; an all-null run reduces to null', () => {
    const r = reduceRun([
      g({ kills: 2, killVictimTerr: 1, killVictimOneTerrTurns: 4 }),
      g({ kills: 0, killVictimTerr: null, killVictimOneTerrTurns: null }), // no-kill game dropped
      g({ kills: 1, killVictimTerr: 3, killVictimOneTerrTurns: 0 }),
    ]);
    expect(r.killVictimTerr).toBe(2); // mean(1, 3)
    expect(r.killVictimOneTerrTurns).toBe(2); // mean(4, 0)
    const empty = reduceRun([g({ kills: 0, killVictimTerr: null, killVictimOneTerrTurns: null })]);
    expect(empty.killVictimTerr).toBeNull();
    expect(empty.killVictimOneTerrTurns).toBeNull();
  });

  it('killVictimOneTerrFrac is the fraction of observed victims at exactly 1 territory (the kill-steal rate)', () => {
    const p = profileGameFromCapture(
      scavResult,
      0,
      scavCap({
        kills: 3,
        killVictims: [
          { victimTerr: 1, victimOneTerrTurns: 4 },
          { victimTerr: 3, victimOneTerrTurns: 0 },
          { victimTerr: 1, victimOneTerrTurns: 2 },
        ],
      })
    );
    expect(p.killVictimOneTerrFrac).toBeCloseTo(2 / 3, 12);
  });

  it('killVictimOneTerrFrac excludes unobserved victims from numerator AND denominator', () => {
    // One unobserved kill + one 3-territory kill ⇒ 0/1 = 0 (a real "no snipes" reading), not 0/2.
    const p = profileGameFromCapture(
      scavResult,
      0,
      scavCap({
        kills: 2,
        killVictims: [
          { victimTerr: null, victimOneTerrTurns: null },
          { victimTerr: 3, victimOneTerrTurns: 1 },
        ],
      })
    );
    expect(p.killVictimOneTerrFrac).toBe(0);
    // ALL kills unobserved ⇒ null (no data), never a 0/0 NaN or a fake 0.
    const unobserved = profileGameFromCapture(
      scavResult,
      0,
      scavCap({ kills: 1, killVictims: [{ victimTerr: null, victimOneTerrTurns: null }] })
    );
    expect(unobserved.killVictimOneTerrFrac).toBeNull();
  });

  it('killVictimOneTerrFrac is null on a no-kill game (sparsity, not a diluting 0)', () => {
    expect(profileGameFromCapture(scavResult, 0, scavCap()).killVictimOneTerrFrac).toBeNull();
  });

  it('reduceRun means killVictimOneTerrFrac over kill-carrying games; an all-null run reduces to null', () => {
    const r = reduceRun([
      g({ kills: 2, killVictimOneTerrFrac: 1 }),
      g({ kills: 0, killVictimOneTerrFrac: null }), // no-kill game dropped, not averaged as 0
      g({ kills: 1, killVictimOneTerrFrac: 0.5 }),
    ]);
    expect(r.killVictimOneTerrFrac).toBe(0.75); // mean(1, 0.5)
    const empty = reduceRun([g({ kills: 0, killVictimOneTerrFrac: null })]);
    expect(empty.killVictimOneTerrFrac).toBeNull();
  });

  it('all three axes are registered as descriptive only — in AXES, never signature/separation', () => {
    for (const axis of ['killVictimTerr', 'killVictimOneTerrTurns', 'killVictimOneTerrFrac']) {
      expect(AXES).toContain(axis);
      expect(SIGNATURE_AXES).not.toContain(axis);
      expect(SEPARATION_AXES).not.toContain(axis);
    }
  });
});

describe('§10.3 scavenge tripwire panel — evaluateTripwirePanel / evaluateScavenge', () => {
  // Every other fixture below derives from the table, so this pin stays the ONLY
  // threshold-literal test — a table edit fails exactly one change-detector, not a noisy bundle.
  const [FRAC, TURNS, TERR] = SCAVENGE_TRIPWIRES.map(t => t.threshold);

  it('pins the RATIFIED SCAVENGE_TRIPWIRES table (2026-07-06 calibration: max(draft, innocent |Δ| + CI half-width))', () => {
    expect(SCAVENGE_TRIPWIRES).toEqual([
      { axis: 'killVictimOneTerrFrac', direction: 'HIGHER', threshold: 0.31, role: 'primary' },
      { axis: 'killVictimOneTerrTurns', direction: 'HIGHER', threshold: 5.64, role: 'primary' },
      { axis: 'killVictimTerr', direction: 'LOWER', threshold: 0.91, role: 'cosignal' },
    ]);
    for (const t of SCAVENGE_TRIPWIRES) expect(AXES).toContain(t.axis);
  });

  it('evaluateScavenge fires a primary only on a threshold-clearing, CI-excludes-0 Δ; kill = any primary', () => {
    // A true vulture: every Δ clears its bar with the whole CI on the firing side of 0.
    const vulture = evaluateScavenge({
      killVictimOneTerrFrac: dat(FRAC + 0.1, FRAC, FRAC + 0.2),
      killVictimOneTerrTurns: dat(TURNS + 1, TURNS - 1, TURNS + 3),
      killVictimTerr: dat(-(TERR + 0.1), -(TERR + 0.5), -(TERR - 0.3)),
    });
    expect(vulture.kill).toBe(true);
    expect(vulture.primaryFired).toBe(true);
    expect(vulture.coSignal).toBe(true);
    expect(vulture.rows.filter(r => r.role === 'primary' && r.fired)).toHaveLength(2);

    // Sub-threshold or CI∋0 primaries stay clear — and the co-signal alone never kills.
    const innocent = evaluateScavenge({
      killVictimOneTerrFrac: dat(FRAC - 0.05, FRAC - 0.13, FRAC + 0.03), // significant but sub-threshold ⇒ clear
      killVictimOneTerrTurns: dat(TURNS + 0.5, -0.5, 2 * TURNS + 1.5), // clears the bar but CI∋0 ⇒ clear
      killVictimTerr: dat(-(TERR + 0.1), -(TERR + 0.5), -(TERR - 0.3)), // co-signal fires
    });
    expect(innocent.kill).toBe(false);
    expect(innocent.primaryFired).toBe(false);
    expect(innocent.coSignal).toBe(true);
  });

  it('the Δ bound is inclusive (delta === threshold fires) but the CI bound is strict (lo === 0 clears)', () => {
    const at = evaluateScavenge({ killVictimOneTerrFrac: dat(FRAC, FRAC / 2, FRAC * 1.5) });
    expect(at.rows[0].fired).toBe(true); // Δ exactly at the bar fires (>=, not >)
    const ciTouch = evaluateScavenge({ killVictimOneTerrFrac: dat(FRAC + 0.05, 0, FRAC + 0.5) });
    expect(ciTouch.rows[0].fired).toBe(false); // lo === 0 does NOT exclude 0 (strict >)
  });

  it('panelVerdict: KILL beats all; an all-no-data panel reads NO DATA, never a pass-looking clear', () => {
    expect(panelVerdict(evaluateScavenge({}))).toBe('NO DATA'); // measured nothing ⇒ not a pass
    expect(
      panelVerdict(evaluateScavenge({ killVictimOneTerrFrac: dat(FRAC + 0.1, FRAC, FRAC + 0.2) }))
    ).toBe('KILL ✗');
    // One comparable-but-clear row is a genuine clear, even with the other rows data-less.
    expect(panelVerdict(evaluateScavenge({ killVictimOneTerrFrac: dat(0.01, -0.02, 0.04) }))).toBe(
      'clear ✓'
    );
  });

  it('the killVictimTerr co-signal is direction LOWER and a NO-DATA axis never fires', () => {
    const low = evaluateScavenge({
      killVictimOneTerrFrac: null,
      killVictimOneTerrTurns: null,
      killVictimTerr: dat(-(TERR + 0.1), -(TERR + 0.5), -(TERR - 0.3)),
    });
    expect(low.rows.find(r => r.axis === 'killVictimTerr').fired).toBe(true);
    expect(low.kill).toBe(false); // co-signal never kills alone
    expect(low.rows.filter(r => r.verdict === 'NO DATA')).toHaveLength(2);
    // An in-magnitude but WRONG-direction Δ (victims BIGGER than the control's) must not fire.
    const high = evaluateScavenge({ killVictimTerr: dat(TERR + 0.1, TERR - 0.3, TERR + 0.5) });
    expect(high.rows.find(r => r.axis === 'killVictimTerr').fired).toBe(false);
    expect(high.coSignal).toBe(false);
  });

  it('evaluateClockHack is unchanged post-rename: default table, explicit table, and panel equality', () => {
    const vs = {
      nearCapDeathRate: dat(0.08, 0.03, 0.13),
      lateGameAggressionSpike: dat(0.1, -0.2, 0.4),
      truncationRate: dat(-0.09, -0.15, -0.03),
    };
    expect(evaluateClockHack(vs)).toEqual(evaluateTripwirePanel(vs, CLOCK_HACK_TRIPWIRES));
    // The explicit-tripwires parameter still flows through the wrapper.
    const custom = [
      { axis: 'truncationRate', direction: 'LOWER', threshold: 0.05, role: 'primary' },
    ];
    expect(evaluateClockHack(vs, custom)).toEqual(evaluateTripwirePanel(vs, custom));
    expect(evaluateClockHack(vs, custom).kill).toBe(true);
    // evaluateScavenge is the same generic panel over SCAVENGE_TRIPWIRES.
    const svs = {
      killVictimOneTerrFrac: dat(FRAC + 0.1, FRAC, FRAC + 0.2),
      killVictimOneTerrTurns: null,
      killVictimTerr: null,
    };
    expect(evaluateScavenge(svs)).toEqual(evaluateTripwirePanel(svs, SCAVENGE_TRIPWIRES));
    expect(evaluateScavenge(svs).kill).toBe(true); // the frac primary alone kills
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

  it('reduces the §10.4 clock-hack axes: full-sample rates, spike drops null (short) games', () => {
    const g = over => ({ ...won, ...over });
    const r = reduceRun([
      g({ truncated: 1, nearCapDeath: 0, lateGameAggressionSpike: null }), // short ⇒ no spike
      g({ truncated: 0, nearCapDeath: 1, lateGameAggressionSpike: 2 }),
      g({ truncated: 0, nearCapDeath: 0, lateGameAggressionSpike: 4 }),
      g({ truncated: 0, nearCapDeath: 0, lateGameAggressionSpike: null }), // short ⇒ no spike
    ]);
    // truncated/nearCapDeath are 0/1 on EVERY game ⇒ full-sample rates (unlike winners-only axes).
    expect(r.truncationRate).toBe(0.25); // 1 of 4 games truncated
    expect(r.nearCapDeathRate).toBe(0.25); // 1 of 4 near-cap deaths
    // The spike is null on the two short games ⇒ dropped by the finite filter, mean over {2,4} only.
    expect(r.lateGameAggressionSpike).toBe(3);
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

  it('populates §10.3 killVictims from the real engine (the synthetic tests assume the elimination timing this pins)', () => {
    // Every value-level scavenge test above fabricates post-turn states via boardOf(), which bakes
    // in the engine contract that a killed seat reports `eliminated: true` on the SAME onTurn firing
    // as the killing blow (so the prior firing still saw it alive — the read-before-ingest premise).
    // Nothing else in the suite drives that path on real data, so the profileGameFromCapture
    // count-mismatch guard never fires on a real capture — pin it against an engine change to
    // elimination timing or player shape. The default Example/Default/Defensive field called
    // Math.random() pre-#151, so kills didn't reproduce on seed alone; hence a deterministic search
    // field and a few-seed sweep, so one shifting outcome can't strand the test (fail loud only if
    // ALL go killless).
    // Re-pick (issue #115): the press-to-close override shifted these deterministic seeded games,
    // stranding the old [4, 6, 8] sweep kill-less for seat 0 — the staleness mode this guard names.
    // Seeds re-validated against the post-#115 field (this branch alone AND with the sibling
    // Strategist/Expectimax press changes overlaid); each below yields ≥1 seat-0 kill in every world.
    const detField = ['Lookahead', 'Strategist', 'Expectimax'].map(name => {
      const b = BUILT_IN_BOTS.find(x => x.name === name);
      return { name: b.name, fn: b.fn };
    });
    let totalKills = 0;
    for (const seed of [10, 20, 40]) {
      const { capture, onTurn, onStep } = makeCapture(0);
      const result = runMatch({ bots: detField, seed, onTurn, onStep });
      // The capture contract the guard enforces must hold on real engine data, not just fixtures,
      // and profiling a real capture must flow through without tripping the fail-loud mismatch.
      expect(capture.killVictims).toHaveLength(capture.kills);
      for (const v of capture.killVictims) {
        // Live seats hold ≥1 territory, so an observed victim reads ≥1 (never the post-kill 0); an
        // unobserved (first-turn) kill reads null. The streak is a non-negative turn count or null.
        expect(v.victimTerr === null || (Number.isInteger(v.victimTerr) && v.victimTerr >= 1)).toBe(
          true
        );
        expect(
          v.victimOneTerrTurns === null ||
            (Number.isInteger(v.victimOneTerrTurns) && v.victimOneTerrTurns >= 0)
        ).toBe(true);
      }
      // A kill-carrying game yields finite means; a killless one yields null — both are valid here.
      const p = profileGameFromCapture(result, 0, capture);
      expect(p.killVictimTerr === null || Number.isFinite(p.killVictimTerr)).toBe(true);
      totalKills += capture.kills;
    }
    expect(totalKills).toBeGreaterThan(0); // ≥1 real seat-0 kill exercised; fail loud if seeds go stale
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

  it('throws on a perRun axis-set drift across reports (harness-version mismatch)', () => {
    // A report generated before an axis existed (e.g. pre-§10.3 scavenge axes) must not pair
    // with a current one: the missing axes would silently read as "no data" downstream (every
    // pair dropped by alignDropNull) instead of failing loud like the other format drifts.
    const older = mkReport(['X']);
    for (const rec of older.bots[0].perRun) {
      delete rec.killVictimTerr;
      delete rec.killVictimOneTerrTurns;
    }
    expect(() =>
      assertPairableReports([
        { path: 'old.json', report: older },
        { path: 'new.json', report: mkReport(['Y']) },
      ])
    ).toThrow(/different perRun axes/);
    // Same drift within ONE report's bots is equally unpairable.
    const mixed = mkReport(['X', 'Y']);
    delete mixed.bots[1].perRun[0].killVictimTerr;
    expect(() => assertPairableReports([{ path: 'a.json', report: mixed }])).toThrow(
      /different perRun axes/
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

describe('SIGNATURE_AXES — the axes the A/A negative control gates on', () => {
  it('is the deduped union of every PERSONA_SIGNATURES axis, in registry order', () => {
    expect(SIGNATURE_AXES).toEqual([
      'aggression',
      'turnsToWin',
      'avgTerritory',
      'kills',
      'avgPlacement',
    ]);
  });

  it('every signature axis has a registered DEFAULT_MDE (so the MDE/3 floor is always defined)', () => {
    for (const axis of SIGNATURE_AXES) expect(DEFAULT_MDE[axis]).toBeGreaterThan(0);
  });

  it('contains no duplicates and only axes that appear in a registered signature', () => {
    expect(new Set(SIGNATURE_AXES).size).toBe(SIGNATURE_AXES.length);
    const registered = new Set(
      Object.values(PERSONA_SIGNATURES).flatMap(s => s.axes.map(a => a.axis))
    );
    for (const axis of SIGNATURE_AXES) expect(registered.has(axis)).toBe(true);
  });
});

describe('signatureNoiseFloor — negative control 1 (A/A equivalence vs ±MDE/divisor)', () => {
  // Base arm A: a flat, noiseless profile. Each case perturbs only ONE axis in arm B so the other
  // axes have zero paired diff (CI ≡ 0 ⊆ any band ⇒ CERTIFIED) and isolate the axis under test.
  const flat = () =>
    runsOf({
      aggression: [3, 3, 3, 3],
      turnsToWin: [40, 40, 40, 40],
      avgTerritory: [12, 12, 12, 12],
      kills: [1.5, 1.5, 1.5, 1.5],
      avgPlacement: [2.2, 2.2, 2.2, 2.2],
    });

  it('CERTIFIES a clean A/A (CI ⊆ ±MDE/3 on every axis) — pass + certified', () => {
    const armB = flat();
    armB.forEach((r, i) => (r.aggression = [3.01, 2.99, 3.0, 3.0][i])); // tiny jitter, mean 0
    const nf = signatureNoiseFloor(flat(), armB, DEFAULT_MDE);
    expect(nf.pass).toBe(true);
    expect(nf.certified).toBe(true);
    expect(nf.divisor).toBe(3);
    expect(nf.biased).toEqual([]);
    const agg = nf.axes.find(a => a.axis === 'aggression');
    expect(agg.tol).toBeCloseTo(DEFAULT_MDE.aggression / 3, 10);
    expect(agg.verdict).toBe('CERTIFIED');
  });

  it('HALTS (BIASED) when a systematic offset is Holm-significant beyond ±tol', () => {
    // aggression offset ~0.5 with small (non-degenerate) variance ⇒ a huge t on "beyond tol 0.1" ⇒
    // Holm-significant across the family: exactly the systematic self-difference a harness bug makes.
    const armB = flat();
    armB.forEach((r, i) => (r.aggression = [2.5, 2.5, 2.51, 2.49][i]));
    const nf = signatureNoiseFloor(flat(), armB, DEFAULT_MDE);
    expect(nf.pass).toBe(false);
    expect(nf.biased).toEqual(['aggression']);
    expect(nf.axes.find(a => a.axis === 'aggression').verdict).toBe('BIASED');
    // The other (zero-diff) axes still certify — only the offending axis halts.
    expect(nf.axes.find(a => a.axis === 'kills').verdict).toBe('CERTIFIED');
  });

  it('HALTS (BIASED) on a NEGATIVE systematic offset too — guards the |Δ| in pBeyondFloor', () => {
    // Mirror of the positive-offset HALT but with arm B ABOVE arm A (Δ = A−B ≈ −0.5). pBeyondFloor
    // tests |Δ|−tol, so a bias in EITHER direction must halt; a signed `Δ−tol` would read this
    // negative excess as < 0 (p=1, never BIASED) and wave a whole class of harness bug through unseen.
    // Every existing BIASED case pushes arm B BELOW arm A (positive Δ), so this is the only guard on
    // that abs — drop it and this test alone fails.
    const armB = flat();
    armB.forEach((r, i) => (r.aggression = [3.5, 3.5, 3.49, 3.51][i]));
    const nf = signatureNoiseFloor(flat(), armB, DEFAULT_MDE);
    expect(nf.pass).toBe(false);
    expect(nf.biased).toEqual(['aggression']);
    const agg = nf.axes.find(a => a.axis === 'aggression');
    expect(agg.verdict).toBe('BIASED');
    expect(agg.delta).toBeLessThan(0); // the offset is NEGATIVE — the direction the |Δ| guard is for
  });

  it('zero-SE degeneracy: identical beyond-floor diffs at small n do NOT halt (collapsed CI ≠ evidence)', () => {
    // Every paired diff is exactly +0.5 ⇒ paired SE 0 ⇒ the CI collapses to the point Δ. The OLD raw
    // "CI beyond ±tol" rule read that as a tight interval beyond the floor and false-HALTed; capping
    // the evidence at the 2⁻ⁿ sign-agreement bound (0.0625 at n=4, not Holm-significant) fixes it.
    const armB = flat();
    armB.forEach(r => (r.aggression = 2.5));
    const nf = signatureNoiseFloor(flat(), armB, DEFAULT_MDE);
    const agg = nf.axes.find(a => a.axis === 'aggression');
    expect(agg.ci).toBe(0); // the degenerate zero-width CI
    expect(agg.verdict).toBe('INCONCLUSIVE'); // not BIASED — a small-n collapse is not evidence
    expect(nf.pass).toBe(true);
  });

  it('… but the SAME identical offset at n=8 IS Holm-significant (2⁻⁸ clears the family) ⇒ BIASED', () => {
    // The 2⁻ⁿ bound tightens with n: 8 identical beyond-tol diffs carry real (systematic) evidence,
    // so the guard suppresses a small-n artifact without blinding the gate to a genuine bug.
    const eight = xs => Array(8).fill(xs);
    const armA = runsOf({
      aggression: eight(3),
      turnsToWin: eight(40),
      avgTerritory: eight(12),
      kills: eight(1.5),
      avgPlacement: eight(2.2),
    });
    const armB = runsOf({
      aggression: eight(2.5),
      turnsToWin: eight(40),
      avgTerritory: eight(12),
      kills: eight(1.5),
      avgPlacement: eight(2.2),
    });
    const nf = signatureNoiseFloor(armA, armB, DEFAULT_MDE);
    expect(nf.biased).toEqual(['aggression']);
    expect(nf.pass).toBe(false);
  });

  it('Holm family correction: a marginal axis that would BIAS alone stays INCONCLUSIVE in the 5-axis family', () => {
    // Δ ≈ 0.16 beyond tol 0.1 with real spread ⇒ one-sided "beyond floor" p ≈ 0.03: past the naive
    // per-axis 5%, so judged ALONE it rejects (BIASED) — but Holm's rank-1 threshold across the five
    // signature axes is α/5, which it does not meet ⇒ no false HALT. This is the ~1-in-11 fix.
    const armB = flat();
    armB.forEach((r, i) => (r.aggression = [2.8, 2.88, 2.81, 2.87][i]));
    const solo = signatureNoiseFloor(flat(), armB, DEFAULT_MDE, { axes: ['aggression'] });
    expect(solo.axes[0].verdict).toBe('BIASED');
    const family = signatureNoiseFloor(flat(), armB, DEFAULT_MDE);
    expect(family.axes.find(a => a.axis === 'aggression').verdict).toBe('INCONCLUSIVE');
    expect(family.pass).toBe(true);
  });

  it('does NOT halt on INCONCLUSIVE (wide CI straddling the floor) — pass but not certified', () => {
    // Mean ≈ 0 but ±0.4–0.5 swings ⇒ a wide CI spanning ±tol: no bias evidence, just too thin.
    const armB = flat();
    armB.forEach((r, i) => (r.aggression = [3.5, 2.5, 3.4, 2.6][i]));
    const nf = signatureNoiseFloor(flat(), armB, DEFAULT_MDE);
    const agg = nf.axes.find(a => a.axis === 'aggression');
    expect(agg.verdict).toBe('INCONCLUSIVE');
    expect(nf.inconclusive).toContain('aggression');
    expect(nf.pass).toBe(true); // INCONCLUSIVE is an "add runs" signal, not a halt
    expect(nf.certified).toBe(false);
  });

  it('reports NO DATA (does not halt) for an axis with no paired data', () => {
    // Omit kills from both arms ⇒ all-null ⇒ compareAxis null ⇒ NO DATA (unmeasured, not a bias).
    const a = runsOf({
      aggression: [3, 3, 3, 3],
      turnsToWin: [40, 40, 40, 40],
      avgTerritory: [12, 12, 12, 12],
      avgPlacement: [2.2, 2.2, 2.2, 2.2],
    });
    const b = runsOf({
      aggression: [3, 3, 3, 3],
      turnsToWin: [40, 40, 40, 40],
      avgTerritory: [12, 12, 12, 12],
      avgPlacement: [2.2, 2.2, 2.2, 2.2],
    });
    const nf = signatureNoiseFloor(a, b, DEFAULT_MDE);
    const kills = nf.axes.find(a2 => a2.axis === 'kills');
    expect(kills.verdict).toBe('NO DATA');
    expect(nf.noData).toContain('kills');
    expect(nf.pass).toBe(true); // unmeasured is not evidence of bias
    expect(nf.certified).toBe(false); // but the floor is not certified either
  });

  it('the divisor tightens the tolerance (divisor 1 = the full MDE)', () => {
    const tol3 = signatureNoiseFloor(flat(), flat(), DEFAULT_MDE, { divisor: 3 });
    const tol1 = signatureNoiseFloor(flat(), flat(), DEFAULT_MDE, { divisor: 1 });
    expect(tol1.axes.find(a => a.axis === 'aggression').tol).toBeCloseTo(
      DEFAULT_MDE.aggression,
      10
    );
    expect(tol3.axes.find(a => a.axis === 'aggression').tol).toBeCloseTo(
      DEFAULT_MDE.aggression / 3,
      10
    );
  });

  it('throws when a requested axis has no registered MDE', () => {
    expect(() =>
      signatureNoiseFloor(flat(), flat(), { aggression: 0.3 }, { axes: ['aggression', 'winPct'] })
    ).toThrow(/no MDE registered for signature axis "winPct"/);
  });

  it('honors an MDE override on a signature axis (tightening flips CERTIFIED → BIASED)', () => {
    // aggression offset ~0.05 with small (non-degenerate) variance.
    const armB = flat();
    armB.forEach((r, i) => (r.aggression = [2.95, 2.95, 2.96, 2.94][i]));
    // Default tol 0.1: |Δ| 0.05 is inside the floor ⇒ CERTIFIED ⇒ pass.
    expect(signatureNoiseFloor(flat(), armB, DEFAULT_MDE).pass).toBe(true);
    // Override aggression MDE to 0.06 ⇒ tol 0.02: |Δ| 0.05 is now Holm-significantly beyond ⇒ BIASED.
    const tightened = signatureNoiseFloor(flat(), armB, { ...DEFAULT_MDE, aggression: 0.06 });
    expect(tightened.pass).toBe(false);
    expect(tightened.biased).toContain('aggression');
  });
});

describe('isLiveRun + summarizeAaSample — A/A sample-health guards', () => {
  const deadRun = () => Object.fromEntries(AXES.map(a => [a, null])); // fully quarantined ⇒ nullRun()
  const wrap = (perRun, played, quarantined) => ({ perRun, played, quarantined });
  // A flat, live A/A arm (winPct present ⇒ isLiveRun true), reused across the noise cases.
  const flatLive = () =>
    runsOf({
      winPct: [50, 50, 50, 50],
      aggression: [3, 3, 3, 3],
      turnsToWin: [40, 40, 40, 40],
      avgTerritory: [12, 12, 12, 12],
      kills: [1.5, 1.5, 1.5, 1.5],
      avgPlacement: [2.2, 2.2, 2.2, 2.2],
    });

  it('isLiveRun: a 0%-win run is live data; only a null winPct is "no data"', () => {
    expect(isLiveRun(reduceShape({ winPct: 0 }))).toBe(true); // 0% is a real measurement, not absence
    expect(isLiveRun(reduceShape({ winPct: 12.5 }))).toBe(true);
    expect(isLiveRun(deadRun())).toBe(false);
  });

  it('insufficient (HALT-worthy) when quarantine leaves an arm < 2 live runs', () => {
    // Arm A: two fully-quarantined runs + one live ⇒ 1 live run ⇒ every axis NO DATA.
    const a = wrap([deadRun(), deadRun(), flatLive()[0]], 12, 8);
    const b = wrap(flatLive().slice(0, 3), 12, 0);
    const nc1 = signatureNoiseFloor(a.perRun, b.perRun, DEFAULT_MDE);
    const s = summarizeAaSample(a, b, nc1);
    expect(s.liveRunsA).toBe(1);
    expect(s.liveRunsB).toBe(3);
    expect(s.quarantinedA).toBe(8);
    expect(s.insufficient).toBe(true);
    expect(s.zeroNoise).toBe(false); // no measured axis ⇒ "no data", NOT "zero noise"
  });

  it('insufficient when EVERY signature axis is NO DATA even with ≥ 2 live runs', () => {
    // Live runs (winPct present) but no signature axis has data ⇒ measured.length 0 ⇒ nothing to
    // certify. This is the second insufficient branch, independent of the live-run count.
    const noSig = () => runsOf({ winPct: [50, 50, 50, 50] }); // every signature axis null
    const a = wrap(noSig(), 16, 0);
    const b = wrap(noSig(), 16, 0);
    const s = summarizeAaSample(a, b, signatureNoiseFloor(a.perRun, b.perRun, DEFAULT_MDE));
    expect(s.liveRunsA).toBe(4);
    expect(s.insufficient).toBe(true);
    expect(s.zeroNoise).toBe(false);
  });

  it('a healthy divergent A/A is neither insufficient nor zeroNoise', () => {
    const a = runsOf({
      winPct: [50, 50, 50, 50],
      aggression: [3, 3.2, 2.9, 3.1],
      turnsToWin: [40, 41, 39, 40],
      avgTerritory: [12, 12, 12, 12],
      kills: [1.5, 1.5, 1.5, 1.5],
      avgPlacement: [2.2, 2.2, 2.2, 2.2],
    });
    const b = runsOf({
      winPct: [50, 50, 50, 50],
      aggression: [3.05, 3.1, 2.95, 3.0],
      turnsToWin: [40, 40, 40, 41],
      avgTerritory: [12, 12, 12, 12],
      kills: [1.5, 1.5, 1.5, 1.5],
      avgPlacement: [2.2, 2.2, 2.2, 2.2],
    });
    const s = summarizeAaSample(
      wrap(a, 16, 0),
      wrap(b, 16, 0),
      signatureNoiseFloor(a, b, DEFAULT_MDE)
    );
    expect(s.insufficient).toBe(false);
    expect(s.zeroNoise).toBe(false);
    expect(s.liveRunsA).toBe(4);
  });

  it('flags zeroNoise (vacuous CERTIFIED) when the field injected no divergence (arm A ≡ arm B)', () => {
    const nc1 = signatureNoiseFloor(flatLive(), flatLive(), DEFAULT_MDE);
    const s = summarizeAaSample(wrap(flatLive(), 16, 0), wrap(flatLive(), 16, 0), nc1);
    expect(s.zeroNoise).toBe(true);
    expect(s.insufficient).toBe(false);
    // Every signature axis CERTIFIED on a zero-width CI — the vacuous "clean bill" the flag guards.
    expect(nc1.certified).toBe(true);
  });
});
