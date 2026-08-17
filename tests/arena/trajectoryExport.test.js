import {
  OBSERVATION_SCHEMA_VERSION,
  STOP,
  isStopMove,
  createTrajectoryRecorder,
  trajectoryFromReplay,
  trajectoryStepFromReplay,
  serializeTrajectory,
  deserializeTrajectory,
} from '../../src/arena/trajectoryExport.js';
import {
  createReplayFromState,
  replayToState,
  getReplayLength,
  REPLAY_VERSION,
} from '../../src/arena/replayFormat.js';
import { createGame } from '../../src/engine/GameRunner.js';
import { applyAction, getValidMoves } from '../../src/engine/StateManager.js';
import { ACTION_TYPES, GAME_PHASES } from '../../src/engine/constants.js';
import { runMatch } from '../../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../../src/arena/builtInBots.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Drive a short deterministic game (no bots / no Math.random) and return a
 * trajectory record built from its history. The action list mixes ATTACK and
 * END_TURN so re-derivation is exercised on both step kinds.
 */
function buildRecord(seed = 7) {
  let state = createGame({ seed, playerCount: 3 });
  for (let t = 0; t < 8 && state.phase !== GAME_PHASES.GAME_OVER; t++) {
    const moves = getValidMoves(state);
    if (moves.length > 0) {
      state = applyAction(state, {
        type: ACTION_TYPES.ATTACK,
        from: moves[0].from,
        to: moves[0].to,
      });
    }
    if (state.phase === GAME_PHASES.GAME_OVER) break;
    state = applyAction(state, { type: ACTION_TYPES.END_TURN });
  }

  const replay = createReplayFromState(state, {
    bots: ['A', 'B', 'C'],
    winner: state.winner,
    turnCount: state.turnNumber,
  });
  /*
   * A real trajectory record carries the terminal reward label (placements) that
   * toRecord adds beyond a plain replay; include a valid permutation so the record
   * passes deserializeTrajectory's reward-label validation.
   */
  return {
    ...replay,
    observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
    metadata: { ...replay.metadata, placements: [0, 1, 2] },
  };
}

describe('isStopMove', () => {
  it('is true for the STOP singleton and for a rehydrated END_TURN (round-trip safe)', () => {
    expect(isStopMove(STOP)).toBe(true);
    // A deserialized record's END_TURN is a fresh object, not the singleton.
    expect(isStopMove({ type: 'END_TURN' })).toBe(true);
  });

  it('is false for an attack move and for nullish input', () => {
    expect(isStopMove({ from: 2, to: 3 })).toBe(false);
    expect(isStopMove(undefined)).toBe(false);
    expect(isStopMove(null)).toBe(false);
  });
});

describe('trajectoryFromReplay', () => {
  it('produces one fat step per recorded action', () => {
    const record = buildRecord();
    const steps = trajectoryFromReplay(record);
    expect(steps).toHaveLength(record.actions.length);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('aligns each step with its action and decision player', () => {
    const record = buildRecord();
    const steps = trajectoryFromReplay(record);

    steps.forEach((step, i) => {
      const action = record.actions[i];

      // Observation is for the deciding player; legalMoves always ends with STOP.
      expect(step.observation.myPlayer).toBe(step.playerId);
      expect(step.legalMoves[step.legalMoves.length - 1]).toBe(STOP);

      if (action.type === ACTION_TYPES.ATTACK) {
        expect(step.chosenMove).toEqual({ from: action.from, to: action.to });
        // The chosen attack must appear among the legal attacks.
        expect(step.legalMoves.some(m => m.from === action.from && m.to === action.to)).toBe(true);
        expect(typeof step.outcome.won).toBe('boolean');
      } else {
        expect(step.chosenMove).toBe(STOP);
        expect(step.outcome).toBeNull();
      }
    });
  });

  it('matches trajectoryStepFromReplay step-for-step (incremental vs from-scratch reconstruction agree)', () => {
    const record = buildRecord();
    const steps = trajectoryFromReplay(record);
    steps.forEach((step, i) => {
      expect(trajectoryStepFromReplay(record, i)).toEqual(step);
    });
  });

  it('is deterministic for a fixed seed', () => {
    expect(trajectoryFromReplay(buildRecord(11))).toEqual(trajectoryFromReplay(buildRecord(11)));
  });
});

describe('trajectoryStepFromReplay', () => {
  it('throws for an out-of-range index', () => {
    const record = buildRecord();
    expect(() => trajectoryStepFromReplay(record, -1)).toThrow(/out of range/);
    expect(() => trajectoryStepFromReplay(record, record.actions.length)).toThrow(/out of range/);
  });
});

describe('createTrajectoryRecorder', () => {
  it('records a lean action list and fat steps from per-step callbacks', () => {
    const rec = createTrajectoryRecorder();
    rec.onStep({
      playerId: 0,
      turnNumber: 1,
      observation: { myPlayer: 0 },
      legalMoves: [{ from: 2, to: 3 }, STOP],
      chosenMove: { from: 2, to: 3 },
      outcome: { won: true },
    });
    rec.onStep({
      playerId: 0,
      turnNumber: 1,
      observation: { myPlayer: 0 },
      legalMoves: [STOP],
      chosenMove: STOP,
      outcome: null,
    });

    expect(rec.actions).toEqual([{ type: 'ATTACK', from: 2, to: 3 }, { type: 'END_TURN' }]);
    expect(rec.fatSteps).toHaveLength(2);
    expect(rec.fatSteps[0].outcome).toEqual({ won: true });
  });

  it('toRecord stamps both versions and carries the terminal reward label', () => {
    const rec = createTrajectoryRecorder();
    rec.onStep({
      playerId: 0,
      turnNumber: 1,
      observation: {},
      legalMoves: [STOP],
      chosenMove: STOP,
      outcome: null,
    });
    rec.finalize({ winner: 0, placements: [0, 2, 1], turnCount: 5 });

    const out = rec.toRecord({
      config: {
        seed: 1,
        playerCount: 3,
        mapWidth: 28,
        mapHeight: 32,
        maxAreas: 32,
        dicePerArea: 3,
      },
      botNames: ['A', 'B', 'C'],
    });

    expect(out.version).toBe(REPLAY_VERSION);
    expect(out.observationSchemaVersion).toBe(OBSERVATION_SCHEMA_VERSION);
    expect(out.config.dicePerArea).toBe(3);
    expect(out.actions).toEqual([{ type: 'END_TURN' }]);
    expect(out.metadata.winner).toBe(0);
    expect(out.metadata.placements).toEqual([0, 2, 1]);
    expect(out.metadata.bots).toEqual(['A', 'B', 'C']);
  });

  it('toRecord throws if finalize() was not called (guards against a falsely-null reward)', () => {
    const rec = createTrajectoryRecorder();
    rec.onStep({
      playerId: 0,
      turnNumber: 1,
      observation: {},
      legalMoves: [STOP],
      chosenMove: STOP,
      outcome: null,
    });
    expect(() =>
      rec.toRecord({
        config: {
          seed: 1,
          playerCount: 3,
          mapWidth: 28,
          mapHeight: 32,
          maxAreas: 32,
          dicePerArea: 3,
        },
        botNames: ['A', 'B', 'C'],
      })
    ).toThrow(/before finalize/);
  });
});

describe('serializeTrajectory / deserializeTrajectory', () => {
  it('round-trips a record on a single JSONL line', () => {
    const record = buildRecord();
    const line = serializeTrajectory(record);
    expect(line).not.toContain('\n');
    expect(deserializeTrajectory(line)).toEqual(record);
  });

  it('rejects an unsupported replay version', () => {
    const record = buildRecord();
    expect(() => deserializeTrajectory(serializeTrajectory({ ...record, version: 999 }))).toThrow(
      /Unsupported trajectory replay version/
    );
  });

  it('rejects an unsupported observation schema version', () => {
    const record = buildRecord();
    expect(() =>
      deserializeTrajectory(serializeTrajectory({ ...record, observationSchemaVersion: 999 }))
    ).toThrow(/observation schema version/);
  });

  it('rejects records missing required fields', () => {
    expect(() =>
      deserializeTrajectory(
        JSON.stringify({
          version: REPLAY_VERSION,
          observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
        })
      )
    ).toThrow(/missing required fields/);
  });

  it('rejects malformed JSON', () => {
    expect(() => deserializeTrajectory('{not json')).toThrow(/malformed JSON/);
  });

  it('rejects a non-object JSON value', () => {
    expect(() => deserializeTrajectory('null')).toThrow(/not an object/);
    expect(() => deserializeTrajectory('5')).toThrow(/not an object/);
  });

  it('rejects a record with a non-numeric seed', () => {
    const record = buildRecord();
    const bad = { ...record, config: { ...record.config, seed: 'oops' } };
    expect(() => deserializeTrajectory(serializeTrajectory(bad))).toThrow(/seed/);
  });

  it('rejects a malformed action, naming its index', () => {
    const record = buildRecord();

    const badType = { ...record, actions: [...record.actions, { type: 'WOBBLE' }] };
    expect(() => deserializeTrajectory(serializeTrajectory(badType))).toThrow(/invalid type/);

    const badAttack = { ...record, actions: [...record.actions, { type: 'ATTACK', from: 1 }] };
    expect(() => deserializeTrajectory(serializeTrajectory(badAttack))).toThrow(/invalid from\/to/);
  });
});

describe('live capture + round-trip (integration)', () => {
  /*
   * Seed-pure bots only — the 3 Math.random bots (default/example/adaptive) are
   * non-reproducible and would break determinism.
   */
  const SEED_PURE_IDS = ['ai_strategist', 'ai_expectimax', 'ai_defensive'];
  const bots = SEED_PURE_IDS.map(id => {
    const b = BUILT_IN_BOTS.find(x => x.id === id);
    return { name: b.name, fn: b.fn };
  });

  let result;
  let liveSteps;

  beforeAll(() => {
    liveSteps = [];
    // Training mode: recordHistory:false (history suppressed) + recordTrajectory.
    result = runMatch({
      bots,
      seed: 12345,
      recordHistory: false,
      recordTrajectory: true,
      onStep: step => liveSteps.push(step),
    });
  });

  it('captures a non-empty lean action list even though state.history is suppressed', () => {
    // The crux: createReplay-from-history would yield nothing here.
    expect(result.finalState.history).toHaveLength(0);
    expect(result.trajectory.actions.length).toBeGreaterThan(0);
    expect(result.trajectory.observationSchemaVersion).toBe(OBSERVATION_SCHEMA_VERSION);
    expect(result.trajectory.metadata.placements).toEqual(result.placements);
  });

  it('records handicap: null — self-play corpora are never luck-handicapped (#179)', () => {
    /*
     * A trajectory is re-derived by feeding its config straight to createGame, so a
     * handicap in the corpus would silently train the net on tilted battle odds.
     * runMatch never sets one; this pins that the recorded config says so explicitly.
     */
    expect(result.trajectory.config.handicap).toBeNull();
    expect(result.finalState.config.handicap).toBeNull();
  });

  it('the lean record replays to an identical final state', () => {
    const replayed = replayToState(result.trajectory, getReplayLength(result.trajectory));
    expect(replayed.winner).toBe(result.finalState.winner);
    expect(replayed.turnNumber).toBe(result.finalState.turnNumber);
    expect(replayed.areas.map(a => [a.owner, a.dice])).toEqual(
      result.finalState.areas.map(a => [a.owner, a.dice])
    );
  });

  it('every fat step is replay-derivable: createBotState(replayToState(replay,i)) === live observation', () => {
    const rederived = trajectoryFromReplay(result.trajectory);
    expect(rederived).toHaveLength(liveSteps.length);
    // Whole-step equality (observation, legalMoves, chosenMove, outcome, playerId, turnNumber).
    expect(rederived).toEqual(liveSteps);
  });

  it('contains both ATTACK and STOP decisions', () => {
    const stops = liveSteps.filter(s => s.chosenMove === STOP);
    const attacks = liveSteps.filter(s => s.chosenMove !== STOP);
    expect(stops.length).toBeGreaterThan(0);
    expect(attacks.length).toBeGreaterThan(0);
    // Every step's legal set ends with STOP (end-turn is always available).
    expect(liveSteps.every(s => s.legalMoves[s.legalMoves.length - 1] === STOP)).toBe(true);
  });

  it('ends on the game-deciding ATTACK with no trailing STOP (GAME_OVER suppresses the end-turn step)', () => {
    /*
     * matchRunner gates the turn-end STOP on `phase !== GAME_OVER`, so the winning
     * attack — which itself flips the phase to GAME_OVER — must be the final recorded
     * decision, with NO STOP after it. Asserting this directly (rather than relying on
     * the seed happening to end on an attack) locks in that invariant against future
     * seed/RNG drift; if seed 12345 ever ends in a stalemate this fails loudly.
     */
    expect(result.finalState.winner).not.toBeNull();

    const lastStep = liveSteps[liveSteps.length - 1];
    expect(isStopMove(lastStep.chosenMove)).toBe(false);
    expect(lastStep.outcome).toEqual({ won: true });
    expect(result.trajectory.actions[result.trajectory.actions.length - 1].type).toBe(
      ACTION_TYPES.ATTACK
    );

    /*
     * Each STOP fat step corresponds to exactly one END_TURN in the lean action list
     * (the winning turn contributes an ATTACK, not an END_TURN) — fat STOPs ≡ lean END_TURNs.
     */
    const stopCount = liveSteps.filter(s => isStopMove(s.chosenMove)).length;
    const endTurnActions = result.trajectory.actions.filter(
      a => a.type === ACTION_TYPES.END_TURN
    ).length;
    expect(endTurnActions).toBe(stopCount);
  });

  it('serializes to a JSONL line that round-trips back to a replayable record', () => {
    const line = serializeTrajectory(result.trajectory);
    expect(line).not.toContain('\n');

    const back = deserializeTrajectory(line);
    expect(back).toEqual(result.trajectory);

    // The round-tripped record still replays to the same final state.
    const replayed = replayToState(back, getReplayLength(back));
    expect(replayed.winner).toBe(result.finalState.winner);
  });
});

describe('committed sample .jsonl fixture', () => {
  /*
   * tests/fixtures/trajectories/sample.jsonl — 3 trajectories (seeds 1/2/3,
   * Strategist+Expectimax+Defensive). A replay is self-contained (seed + recorded
   * actions, re-applied by the engine, not the bots), so this fixture is stable
   * across bot tuning and only depends on engine determinism.
   */
  const path = fileURLToPath(new URL('../fixtures/trajectories/sample.jsonl', import.meta.url));
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0);

  it('has multiple records, one per line', () => {
    expect(lines.length).toBeGreaterThan(1);
  });

  it('every line deserializes and replays to a state consistent with its metadata', () => {
    for (const line of lines) {
      const record = deserializeTrajectory(line);
      const final = replayToState(record, getReplayLength(record));
      expect(final.winner).toBe(record.metadata.winner);
      // The fat trajectory is fully re-derivable from each lean record.
      const steps = trajectoryFromReplay(record);
      expect(steps).toHaveLength(record.actions.length);
    }
  });
});

describe('misbehaving bots & onStep wiring (D-14 / coverage gaps)', () => {
  const strat = BUILT_IN_BOTS.find(b => b.id === 'ai_strategist');
  const def = BUILT_IN_BOTS.find(b => b.id === 'ai_defensive');
  const opponent = { name: strat.name, fn: strat.fn };

  // Seed-pure (no Math.random) misbehaving bots, so the match stays deterministic.
  const throwingBot = {
    name: 'Thrower',
    fn: () => {
      throw new Error('boom');
    },
  };
  const invalidBot = { name: 'Invalid', fn: () => ({ from: -1, to: -1 }) };

  it.each([
    ['bot errors', throwingBot],
    ['repeated invalid moves', invalidBot],
  ])(
    'records only STOP steps for a bot that exits on %s — never a phantom ATTACK (D-14)',
    (_label, badBot) => {
      const steps = [];
      const result = runMatch({
        bots: [opponent, badBot],
        seed: 4242,
        recordTrajectory: true,
        onStep: s => steps.push(s),
      });

      // The misbehaving bot is player index 1; it takes turns until eliminated.
      const badSteps = steps.filter(s => s.playerId === 1);
      expect(badSteps.length).toBeGreaterThan(0);
      /*
       * Every recorded decision for it is a STOP — no applied ATTACK ever reaches the
       * action list (rejected/errored moves are skipped before applyAction).
       */
      expect(badSteps.every(s => s.chosenMove === STOP)).toBe(true);

      /*
       * And the lean record stays faithful: re-derivation reproduces live capture
       * step-for-step despite the misbehavior ("one fat step per applied action").
       */
      expect(trajectoryFromReplay(result.trajectory)).toEqual(steps);
    }
  );

  it('fires onStep independently of recordTrajectory (and returns no trajectory)', () => {
    const steps = [];
    const result = runMatch({
      bots: [opponent, { name: def.name, fn: def.fn }],
      seed: 77,
      onStep: s => steps.push(s),
    });

    expect(steps.length).toBeGreaterThan(0);
    expect(result.trajectory).toBeUndefined();
  });
});

describe('stalemate / null-winner terminal label', () => {
  /*
   * Two passive bots that never attack → no eliminations → the match stalemates at
   * maxTurns with winner === null. The terminal reward label (the only thing that makes
   * a trajectory more than a replay) must still be a *valid* label for a stalemate —
   * winner:null with a full placements permutation — distinguishable from an
   * unfinalized/poisoned record, and it must survive the deserialize boundary.
   */
  const passiveA = { name: 'PassiveA', fn: () => null };
  const passiveB = { name: 'PassiveB', fn: () => null };

  it('records winner:null with a full placements permutation, and round-trips through validation', () => {
    const steps = [];
    const result = runMatch({
      bots: [passiveA, passiveB],
      seed: 999,
      maxTurns: 4,
      recordTrajectory: true,
      onStep: s => steps.push(s),
    });

    expect(result.winner).toBeNull();
    expect(result.trajectory.metadata.winner).toBeNull();

    /*
     * placements is a real, full permutation of player indices — NOT null — so a
     * stalemate is a usable training label, not an ambiguous "unfinalized" sentinel.
     */
    const { placements } = result.trajectory.metadata;
    expect([...placements].sort((a, b) => a - b)).toEqual([0, 1]);

    // Passive bots only ever STOP; the lean action list is all END_TURN.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every(s => s.chosenMove === STOP)).toBe(true);
    expect(result.trajectory.actions.every(a => a.type === ACTION_TYPES.END_TURN)).toBe(true);

    /*
     * The null-winner record passes the deserialize boundary (winner:null is allowed)
     * and re-derives the live capture step-for-step.
     */
    const back = deserializeTrajectory(serializeTrajectory(result.trajectory));
    expect(back.metadata.winner).toBeNull();
    expect(trajectoryFromReplay(back)).toEqual(steps);
  });
});

describe('deserializeTrajectory reward-label & config validation (boundary hardening)', () => {
  it('rejects a null placements reward label', () => {
    const record = buildRecord();
    const bad = { ...record, metadata: { ...record.metadata, placements: null } };
    expect(() => deserializeTrajectory(serializeTrajectory(bad))).toThrow(/placements/);
  });

  it('rejects a placements array of the wrong length', () => {
    const record = buildRecord();
    const bad = { ...record, metadata: { ...record.metadata, placements: [0, 1] } };
    expect(() => deserializeTrajectory(serializeTrajectory(bad))).toThrow(/placements/);
  });

  it('rejects a placements array that is not a permutation (duplicate/out-of-range index)', () => {
    const record = buildRecord();
    const dup = { ...record, metadata: { ...record.metadata, placements: [0, 0, 1] } };
    expect(() => deserializeTrajectory(serializeTrajectory(dup))).toThrow(/permutation/);
    const oob = { ...record, metadata: { ...record.metadata, placements: [0, 1, 9] } };
    expect(() => deserializeTrajectory(serializeTrajectory(oob))).toThrow(/permutation/);
  });

  it('rejects an out-of-range winner but accepts null (stalemate)', () => {
    const record = buildRecord();
    const bad = { ...record, metadata: { ...record.metadata, winner: 9 } };
    expect(() => deserializeTrajectory(serializeTrajectory(bad))).toThrow(/winner/);

    const stalemate = { ...record, metadata: { ...record.metadata, winner: null } };
    expect(() => deserializeTrajectory(serializeTrajectory(stalemate))).not.toThrow();
  });

  it('rejects an invalid playerCount', () => {
    const record = buildRecord();
    const bad = { ...record, config: { ...record.config, playerCount: 1 } };
    expect(() => deserializeTrajectory(serializeTrajectory(bad))).toThrow(/playerCount/);
  });

  it('rejects a non-positive map/dice dimension', () => {
    const record = buildRecord();
    const bad = { ...record, config: { ...record.config, maxAreas: 0 } };
    expect(() => deserializeTrajectory(serializeTrajectory(bad))).toThrow(/maxAreas/);
  });
});
