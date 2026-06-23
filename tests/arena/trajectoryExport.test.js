import {
  OBSERVATION_SCHEMA_VERSION,
  STOP,
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
  return { ...replay, observationSchemaVersion: OBSERVATION_SCHEMA_VERSION };
}

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
